import type { ActiveChatContextMessage, BackendSearchResult, ProviderName } from "../shared/types";

export interface ContextSuggestionContext {
  provider: ProviderName;
  title?: string;
  draftText: string;
  messages: ActiveChatContextMessage[];
}

interface ScoredSuggestion {
  result: BackendSearchResult;
  score: number;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "chat",
  "context",
  "current",
  "do",
  "for",
  "from",
  "get",
  "give",
  "has",
  "have",
  "how",
  "idea",
  "ideas",
  "in",
  "input",
  "into",
  "is",
  "it",
  "its",
  "just",
  "like",
  "make",
  "message",
  "need",
  "note",
  "notes",
  "not",
  "of",
  "on",
  "or",
  "our",
  "out",
  "page",
  "please",
  "prompt",
  "relevant",
  "should",
  "show",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "to",
  "use",
  "user",
  "want",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "your"
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function strongTerms(value: string): string[] {
  return tokenize(value).filter((token) => token.length >= 4 && !STOPWORDS.has(token));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function latestMessages(messages: ActiveChatContextMessage[], role?: ActiveChatContextMessage["role"], limit = 2) {
  const filtered = role ? messages.filter((message) => message.role === role) : messages;
  return filtered.slice(Math.max(filtered.length - limit, 0));
}

function phraseCandidates(value: string): string[] {
  const terms = strongTerms(value);
  const phrases: string[] = [];
  for (let index = 0; index < terms.length; index += 1) {
    if (terms[index] && terms[index].length >= 6) {
      phrases.push(terms[index]);
    }
    if (terms[index + 1]) {
      phrases.push(`${terms[index]} ${terms[index + 1]}`);
    }
    if (terms[index + 2]) {
      phrases.push(`${terms[index]} ${terms[index + 1]} ${terms[index + 2]}`);
    }
  }
  return unique(phrases);
}

function taskContext(context: ContextSuggestionContext): boolean {
  return /\b(todo|task|tasks|checklist|ship|deliver|plan|next steps?)\b/i.test(
    [context.draftText, ...context.messages.map((message) => message.content)].join("\n")
  );
}

export function buildContextSuggestionQueries(context: ContextSuggestionContext): string[] {
  const sources = [
    context.draftText,
    ...latestMessages(context.messages, "user", 2).map((message) => message.content),
    context.title ?? "",
    ...latestMessages(context.messages, "assistant", 1).map((message) => message.content)
  ].filter(Boolean);

  const candidates: Array<{ query: string; score: number }> = [];
  sources.forEach((source, sourceIndex) => {
    const phrases = phraseCandidates(source);
    phrases.forEach((phrase, phraseIndex) => {
      const tokenCount = phrase.split(" ").length;
      const score = (sources.length - sourceIndex) * 10 + tokenCount * 4 - phraseIndex;
      candidates.push({ query: phrase, score });
    });
  });

  return candidates
    .filter((candidate) => candidate.query.length >= 4)
    .sort((left, right) => right.score - left.score || right.query.length - left.query.length)
    .map((candidate) => candidate.query)
    .filter((query, index, values) => values.indexOf(query) === index)
    .slice(0, 6);
}

function resultIdentity(result: BackendSearchResult): string {
  if (result.entity_id) {
    return `entity:${result.entity_id.toLowerCase()}`;
  }
  if (result.source_id) {
    return `source:${result.source_id}`;
  }
  if (result.session_id) {
    return `session:${result.session_id}`;
  }
  if (result.markdown_path) {
    return `${result.kind}:${result.markdown_path}`;
  }
  return `${result.kind}:${result.title.toLowerCase()}`;
}

function phraseMatchCount(text: string, phrases: string[]): number {
  const lowered = text.toLowerCase();
  return phrases.filter((phrase) => phrase.includes(" ") && lowered.includes(phrase.toLowerCase())).length;
}

function scoreSuggestion(
  context: ContextSuggestionContext,
  result: BackendSearchResult,
  contextTerms: string[],
  phrases: string[]
): number {
  if (result.category === "journal") {
    return Number.NEGATIVE_INFINITY;
  }
  if (result.kind === "todo_list" && !taskContext(context)) {
    return Number.NEGATIVE_INFINITY;
  }

  const text = `${result.title} ${result.snippet}`.trim();
  const resultTerms = new Set(strongTerms(text));
  const sharedTerms = contextTerms.filter((term) => resultTerms.has(term));
  const phraseMatches = phraseMatchCount(text, phrases);
  const longestSharedTerm = sharedTerms.reduce((longest, term) => (term.length > longest.length ? term : longest), "");
  const entityTitle = result.kind === "entity" ? result.title.toLowerCase() : "";
  const entityTitleMatch = entityTitle ? contextTerms.includes(entityTitle) : false;

  if (!phraseMatches && sharedTerms.length < 2 && !(entityTitleMatch && longestSharedTerm.length >= 5)) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = sharedTerms.reduce((total, term) => total + Math.min(6, Math.max(2, Math.floor(term.length / 2))), 0);
  score += phraseMatches * 5;

  if (entityTitleMatch) {
    score += 4;
  }
  if (result.kind === "entity") {
    score += 2;
  }
  if (result.category === "factual") {
    score += 3;
  }
  if (result.category === "ideas") {
    score += 2;
  }
  if (result.kind === "source_capture") {
    score += 1;
  }
  if (result.category === "todo") {
    score += taskContext(context) ? 1 : -2;
  }

  return score;
}

export function rankContextualSuggestions(
  context: ContextSuggestionContext,
  results: BackendSearchResult[],
  limit = 3
): BackendSearchResult[] {
  const contextTerms = unique(
    strongTerms(
      [
        context.title ?? "",
        context.draftText,
        ...latestMessages(context.messages, "user", 3).map((message) => message.content),
        ...latestMessages(context.messages, "assistant", 1).map((message) => message.content)
      ].join("\n")
    )
  );
  if (contextTerms.length < 2) {
    return [];
  }

  const phrases = buildContextSuggestionQueries(context);
  const scored: ScoredSuggestion[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const identity = resultIdentity(result);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);

    const score = scoreSuggestion(context, result, contextTerms, phrases);
    if (!Number.isFinite(score) || score < 8) {
      continue;
    }
    scored.push({ result, score });
  }

  return scored
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.result.title.length - left.result.title.length ||
        left.result.title.localeCompare(right.result.title)
    )
    .slice(0, limit)
    .map((entry) => entry.result);
}
