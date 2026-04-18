import type { ExtensionSettings, IndexingMode, NormalizedMessage, NormalizedSessionSnapshot } from "./types";

const SENTENCE_BOUNDARY_RE = /(?<=[.!?])\s+/;
const WORDS_SPLIT_RE = /[,\n]/;

export type IndexingDecision = {
  shouldIndex: boolean;
  matchedTriggerWord?: string;
  matchedBlacklistWord?: string;
  reason: string;
  probeText: string;
};

export function normalizeRuleWords(input: string[] | string | undefined): string[] {
  const values = Array.isArray(input) ? input : typeof input === "string" ? input.split(WORDS_SPLIT_RE) : [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const cleaned = normalizeWhitespace(value).toLowerCase();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    normalized.push(cleaned);
  }

  return normalized;
}

export function indexingRulesFingerprint(settings: ExtensionSettings): string {
  return JSON.stringify({
    indexingMode: settings.indexingMode,
    triggerWords: normalizeRuleWords(settings.triggerWords),
    blacklistWords: normalizeRuleWords(settings.blacklistWords),
    discardWordsEnabled: settings.discardWordsEnabled !== false,
    discardWords: normalizeRuleWords(settings.discardWords ?? [])
  });
}

export type DiscardWordDecision = {
  matched: boolean;
  matchedWord?: string;
  probeText: string;
  reason: string;
};

export function evaluateDiscardWords(
  settings: ExtensionSettings,
  snapshot: Pick<NormalizedSessionSnapshot, "messages">
): DiscardWordDecision {
  const probeText = buildIndexingProbeText(snapshot.messages);
  if (settings.discardWordsEnabled === false) {
    return { matched: false, probeText, reason: "Discard words are disabled." };
  }
  const discardWords = normalizeRuleWords(settings.discardWords ?? []);
  if (!discardWords.length) {
    return { matched: false, probeText, reason: "No discard words configured." };
  }
  const matched = discardWords.find((word) => matchesRuleWord(probeText, word));
  if (!matched) {
    return { matched: false, probeText, reason: "Opening request did not match any discard word." };
  }
  return {
    matched: true,
    matchedWord: matched,
    probeText,
    reason: `Routed to Discarded because discard word '${matched}' matched the opening request.`
  };
}

export function evaluateIndexingRules(
  settings: ExtensionSettings,
  snapshot: Pick<NormalizedSessionSnapshot, "messages">
): IndexingDecision {
  const probeText = buildIndexingProbeText(snapshot.messages);
  const blacklistWords = normalizeRuleWords(settings.blacklistWords);
  const matchedBlacklistWord = blacklistWords.find((word) => matchesRuleWord(probeText, word));
  if (matchedBlacklistWord) {
    return {
      shouldIndex: false,
      matchedBlacklistWord,
      reason: `Skipped because blacklist rule '${matchedBlacklistWord}' matched the opening request.`,
      probeText
    };
  }

  if (settings.indexingMode === "trigger_word") {
    const triggerWords = normalizeRuleWords(settings.triggerWords);
    const matchedTriggerWord = triggerWords.find((word) => matchesRuleWord(probeText, word));
    if (!matchedTriggerWord) {
      return {
        shouldIndex: false,
        reason: `Skipped because none of the trigger words matched the opening request: ${triggerWords.join(", ") || "none"}.`,
        probeText
      };
    }
    return {
      shouldIndex: true,
      matchedTriggerWord,
      reason: `Indexed because trigger word '${matchedTriggerWord}' matched the opening request.`,
      probeText
    };
  }

  return {
    shouldIndex: true,
    reason: "Indexed because trigger-word gating is disabled.",
    probeText
  };
}

export function buildIndexingProbeText(messages: NormalizedMessage[]): string {
  const openingUserMessages = messages
    .filter((message) => message.role === "user")
    .map((message) => normalizeWhitespace(message.content))
    .filter(Boolean)
    .slice(0, 2);

  const combined = normalizeWhitespace(openingUserMessages.join(" "));
  if (!combined) {
    return "";
  }

  const sentences = combined
    .split(SENTENCE_BOUNDARY_RE)
    .map((segment) => normalizeWhitespace(segment))
    .filter(Boolean);

  const leading = normalizeWhitespace(sentences.slice(0, 2).join(" "));
  if (leading) {
    return leading.slice(0, 320);
  }

  return combined.slice(0, 320);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function matchesRuleWord(text: string, rule: string): boolean {
  if (!text || !rule) {
    return false;
  }

  const normalizedText = normalizeWhitespace(text).toLowerCase();
  const normalizedRule = normalizeWhitespace(rule).toLowerCase();
  if (!normalizedText || !normalizedRule) {
    return false;
  }

  if (/\s/.test(normalizedRule)) {
    return normalizedText.includes(normalizedRule);
  }

  const escaped = escapeRegExp(normalizedRule);
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(normalizedText);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function describeIndexingMode(mode: IndexingMode): string {
  return mode === "trigger_word" ? "Trigger word required" : "Index everything";
}
