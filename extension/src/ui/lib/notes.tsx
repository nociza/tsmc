import type { ReactNode } from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { categoryLabels, formatCompactDate, providerLabels, titleFromSession } from "../../shared/explorer";
import type { BackendSessionNoteRead } from "../../shared/types";
import { IdeaFlow, type IdeaFlowData, type IdeaFlowOrigin } from "../components/idea-flow";

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function ideaFlowHasStructure(ideaSummary: Record<string, unknown>): boolean {
  if (typeof ideaSummary["core_idea"] === "string" && ideaSummary["core_idea"]) {
    return true;
  }
  const keys = ["reasoning_steps", "related_facts", "supports", "conflicts_with", "next_steps"] as const;
  return keys.some((key) => textList(ideaSummary[key]).length > 0);
}

function splitJournalEntry(value?: string | null): { body: string; actionItems: string[] } {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return { body: "", actionItems: [] };
  }

  const marker = "Action Items:";
  const index = normalized.indexOf(marker);
  if (index < 0) {
    return { body: normalized, actionItems: [] };
  }

  const body = normalized.slice(0, index).trim();
  const actionItems = normalized
    .slice(index + marker.length)
    .split("\n")
    .map((line) => line.replace(/^-+\s*/, "").trim())
    .filter(Boolean);

  return { body, actionItems };
}

function NoteSection({
  title,
  children
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)]/70 p-4">
      <h3 className="mb-3 text-sm font-semibold text-[var(--color-ink)]">{title}</h3>
      <div className="space-y-3 break-words text-sm leading-6 text-[var(--color-ink)]">{children}</div>
    </section>
  );
}

function NoteList({ items }: { items: string[] }) {
  if (!items.length) {
    return null;
  }

  return (
    <ul className="space-y-2 pl-5">
      {items.map((item) => (
        <li key={item} className="break-words">
          {item}
        </li>
      ))}
    </ul>
  );
}

function TripletList({
  items
}: {
  items: BackendSessionNoteRead["triplets"];
}) {
  if (!items.length) {
    return null;
  }

  return (
    <div className="space-y-2">
      {items.map((triplet) => (
        <div key={triplet.id} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-3">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(120px,auto)_minmax(0,1fr)]">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">Subject</div>
              <div className="mt-1 break-words text-sm text-[var(--color-ink)]">{triplet.subject}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">Relation</div>
              <div className="mt-1 break-words text-sm text-[var(--color-ink)]">{triplet.predicate}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">Object</div>
              <div className="mt-1 break-words text-sm text-[var(--color-ink)]">{triplet.object}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function NoteOverview({
  note,
  compact = false
}: {
  note: BackendSessionNoteRead;
  compact?: boolean;
}) {
  const ideaSummary = note.idea_summary ?? {};
  const journal = splitJournalEntry(note.journal_entry);
  const transcript = compact ? note.messages.slice(0, 4) : note.messages.slice(0, 6);

  return (
    <div className="space-y-4">
      {compact ? (
        <NoteSection title="Session">
          <p>
            {titleFromSession(note)} · {providerLabels[note.provider]} · {categoryLabels[note.category ?? "factual"]} ·{" "}
            {formatCompactDate(note.updated_at)}
          </p>
        </NoteSection>
      ) : null}

      {note.category === "factual" ? (
        <>
          {note.classification_reason ? (
            <NoteSection title="Classification">
              <p>{note.classification_reason}</p>
            </NoteSection>
          ) : null}
          {note.triplets.length ? (
            <NoteSection title="Fact Triplets">
              <TripletList items={compact ? note.triplets.slice(0, 5) : note.triplets} />
            </NoteSection>
          ) : null}
          {note.related_entities.length ? (
            <NoteSection title="Related Entities">
              <div className="flex flex-wrap gap-2">
                {(compact ? note.related_entities.slice(0, 8) : note.related_entities).map((entity) => (
                  <span
                    key={entity}
                    className="rounded-full border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink)]"
                  >
                    {entity}
                  </span>
                ))}
              </div>
            </NoteSection>
          ) : null}
        </>
      ) : null}

      {note.category === "ideas" ? (
        <>
          {ideaFlowHasStructure(ideaSummary) ? (
            <NoteSection title="Idea Flow">
              <IdeaFlow
                idea={ideaSummary as IdeaFlowData}
                origin={{
                  title: titleFromSession(note),
                  provider: providerLabels[note.provider],
                  occurredAt: formatCompactDate(note.updated_at),
                  participants: []
                } satisfies IdeaFlowOrigin}
                height={compact ? 360 : 520}
              />
            </NoteSection>
          ) : null}
          {typeof ideaSummary["core_idea"] === "string" ? (
            <NoteSection title="Core Idea">
              <p>{ideaSummary["core_idea"]}</p>
            </NoteSection>
          ) : null}
          {typeof ideaSummary["summary"] === "string" ? (
            <NoteSection title="Summary">
              <p>{ideaSummary["summary"]}</p>
            </NoteSection>
          ) : null}
          {textList(ideaSummary["pros"]).length ? (
            <NoteSection title="Pros">
              <NoteList items={textList(ideaSummary["pros"])} />
            </NoteSection>
          ) : null}
          {textList(ideaSummary["cons"]).length ? (
            <NoteSection title="Cons">
              <NoteList items={textList(ideaSummary["cons"])} />
            </NoteSection>
          ) : null}
          {textList(ideaSummary["next_steps"]).length ? (
            <NoteSection title="Next Steps">
              <NoteList items={textList(ideaSummary["next_steps"])} />
            </NoteSection>
          ) : null}
          {textList(ideaSummary["opportunities"]).length ? (
            <NoteSection title="Opportunities">
              <NoteList items={textList(ideaSummary["opportunities"])} />
            </NoteSection>
          ) : null}
        </>
      ) : null}

      {note.category === "journal" ? (
        <>
          {journal.body ? (
            <NoteSection title="Journal Entry">
              <p>{journal.body}</p>
            </NoteSection>
          ) : null}
          {journal.actionItems.length ? (
            <NoteSection title="Action Items">
              <NoteList items={journal.actionItems} />
            </NoteSection>
          ) : null}
        </>
      ) : null}

      {note.category === "todo" && note.todo_summary ? (
        <NoteSection title="To-Do Update">
          <p>{note.todo_summary}</p>
        </NoteSection>
      ) : null}

      {note.share_post && (!compact || note.category !== "ideas") ? (
        <NoteSection title="Share Post">
          <p>{note.share_post}</p>
        </NoteSection>
      ) : null}

      {!compact && transcript.length ? (
        <NoteSection title="Recent Transcript">
          <div className="space-y-3">
            {transcript.map((message) => (
              <article key={message.id} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
                  {message.role} · {formatCompactDate(message.occurred_at ?? message.created_at)}
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--color-ink)]">{message.content}</p>
              </article>
            ))}
          </div>
        </NoteSection>
      ) : null}
    </div>
  );
}

export function TranscriptView({ note }: { note: BackendSessionNoteRead }) {
  if (!note.messages.length) {
    return <p className="text-sm leading-6 text-[var(--color-ink-soft)]">No transcript messages were stored for this note.</p>;
  }

  return (
    <div className="space-y-3">
      {note.messages.map((message) => (
        <article
          key={message.id}
          className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-4 shadow-[0_1px_2px_rgba(17,24,39,0.03)]"
        >
          <div className="mb-2 flex items-center justify-between gap-4 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
            <span>{message.role}</span>
            <span>{formatCompactDate(message.occurred_at ?? message.created_at)}</span>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--color-ink)]">{message.content}</p>
        </article>
      ))}
    </div>
  );
}

export function MarkdownView({ note }: { note: BackendSessionNoteRead }) {
  const source = note.raw_markdown?.trim() || "No markdown file is available for this note yet.";
  return (
    <div className="note-prose rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  );
}
