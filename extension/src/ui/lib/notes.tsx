import type { ReactNode } from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { categoryLabels, formatCompactDate, providerLabels, titleFromSession } from "../../shared/explorer";
import type { BackendSessionNoteRead } from "../../shared/types";

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
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
    <section className="rounded-[8px] border border-zinc-200 bg-zinc-50/70 p-4">
      <h3 className="mb-3 text-sm font-semibold text-zinc-900">{title}</h3>
      <div className="space-y-3 text-sm leading-6 text-zinc-700">{children}</div>
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
        <li key={item}>{item}</li>
      ))}
    </ul>
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
      <NoteSection title="Summary">
        <p>
          {titleFromSession(note)} · {providerLabels[note.provider]} · {categoryLabels[note.category ?? "factual"]} ·{" "}
          {formatCompactDate(note.updated_at)}
        </p>
      </NoteSection>

      {note.category === "factual" ? (
        <>
          {note.classification_reason ? (
            <NoteSection title="Classification">
              <p>{note.classification_reason}</p>
            </NoteSection>
          ) : null}
          {note.triplets.length ? (
            <NoteSection title="Fact Triplets">
              <NoteList
                items={(compact ? note.triplets.slice(0, 5) : note.triplets).map(
                  (triplet) => `${triplet.subject} | ${triplet.predicate} | ${triplet.object}`
                )}
              />
            </NoteSection>
          ) : null}
          {note.related_entities.length ? (
            <NoteSection title="Related Entities">
              <div className="flex flex-wrap gap-2">
                {(compact ? note.related_entities.slice(0, 8) : note.related_entities).map((entity) => (
                  <span
                    key={entity}
                    className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700"
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
              <article key={message.id} className="rounded-[8px] border border-zinc-200 bg-white p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-zinc-500">
                  {message.role} · {formatCompactDate(message.occurred_at ?? message.created_at)}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-700">{message.content}</p>
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
    return <p className="text-sm leading-6 text-zinc-500">No transcript messages were stored for this note.</p>;
  }

  return (
    <div className="space-y-3">
      {note.messages.map((message) => (
        <article
          key={message.id}
          className="rounded-[8px] border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgba(17,24,39,0.03)]"
        >
          <div className="mb-2 flex items-center justify-between gap-4 text-xs font-semibold uppercase tracking-[0.08em] text-zinc-500">
            <span>{message.role}</span>
            <span>{formatCompactDate(message.occurred_at ?? message.created_at)}</span>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-700">{message.content}</p>
        </article>
      ))}
    </div>
  );
}

export function MarkdownView({ note }: { note: BackendSessionNoteRead }) {
  const source = note.raw_markdown?.trim() || "No markdown file is available for this note yet.";
  return (
    <div className="note-prose rounded-[8px] border border-zinc-200 bg-white p-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  );
}
