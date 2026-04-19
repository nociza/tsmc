import { useMemo, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, LoaderCircle, Plus, Save, SlidersHorizontal, Trash2 } from "lucide-react";

import {
  createPile,
  deletePile,
  fetchPiles,
  updatePile,
  type PileCreatePayload,
  type PileUpdatePayload
} from "../background/backend";
import type { BackendPileRead, ExtensionSettings } from "../shared/types";
import { mountApp } from "../ui/boot";
import { Button } from "../ui/components/button";
import { useExtensionBootstrap } from "../ui/lib/runtime";
import { cn } from "../ui/lib/utils";

const ALL_ATTRIBUTES: { id: string; label: string; description: string; group: "core" | "knowledge" | "task" }[] = [
  { id: "summary", label: "Summary", description: "Short neutral synopsis (always recommended).", group: "core" },
  {
    id: "chronological",
    label: "Chronological",
    description: "Sort and group by capture time. No extra LLM call.",
    group: "core"
  },
  {
    id: "queryable_qa",
    label: "Queryable Q&A",
    description: "Generate up to 4 Q/A pairs suitable for semantic search.",
    group: "knowledge"
  },
  {
    id: "knowledge_graph",
    label: "Knowledge graph",
    description: "Extract subject-predicate-object triplets for the shared graph.",
    group: "knowledge"
  },
  {
    id: "share_post",
    label: "Share post",
    description: "Tweet-sized shareable summary.",
    group: "core"
  },
  {
    id: "alternate_phrasings",
    label: "Alternate phrasings",
    description: "Up to 3 reworded restatements of the takeaway.",
    group: "core"
  },
  { id: "importance", label: "Importance", description: "Integer 1-5.", group: "task" },
  { id: "deadline", label: "Deadline", description: "ISO-8601 date if mentioned.", group: "task" },
  {
    id: "completion",
    label: "Completion",
    description: "open / in_progress / done.",
    group: "task"
  }
];

const ATTRIBUTE_LABEL: Record<string, string> = Object.fromEntries(
  ALL_ATTRIBUTES.map((attr) => [attr.id, attr.label])
);

const PILE_KIND_LABELS: Record<string, string> = {
  built_in_journal: "Built-in",
  built_in_factual: "Built-in",
  built_in_ideas: "Built-in",
  built_in_todo: "Built-in",
  built_in_discarded: "Built-in",
  user_defined: "Custom"
};

function isBuiltIn(pile: BackendPileRead): boolean {
  return pile.kind !== "user_defined";
}

function isDiscarded(pile: BackendPileRead): boolean {
  return pile.slug === "discarded";
}

function App() {
  const { settings, status, loading } = useExtensionBootstrap();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const pilesQuery = useQuery({
    queryKey: ["piles", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchPiles(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const updateMutation = useMutation({
    mutationFn: ({ slug, payload }: { slug: string; payload: PileUpdatePayload }) =>
      updatePile(settings as ExtensionSettings, slug, payload),
    onSuccess: () => {
      setEditing(null);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["piles"] });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : "Update failed.")
  });

  const createMutation = useMutation({
    mutationFn: (payload: PileCreatePayload) => createPile(settings as ExtensionSettings, payload),
    onSuccess: () => {
      setCreating(false);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["piles"] });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : "Create failed.")
  });

  const deleteMutation = useMutation({
    mutationFn: (slug: string) => deletePile(settings as ExtensionSettings, slug),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["piles"] });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : "Delete failed.")
  });

  const piles = pilesQuery.data ?? [];
  const builtIns = useMemo(() => piles.filter(isBuiltIn), [piles]);
  const userPiles = useMemo(() => piles.filter((pile) => !isBuiltIn(pile)), [piles]);

  return (
    <div className="app-page app-page--narrow">
      <header className="app-page-header">
        <div className="app-page-heading">
          <div className="app-page-mark">C</div>
          <div>
            <p className="eyebrow">Configuration</p>
            <h1 className="app-page-title">Piles</h1>
            <p className="app-page-copy">
              Piles decide where a session ends up and how it gets processed. The five built-in piles always exist;
              you can layer your own piles with their own attribute set on top. Each attribute drives one part of the
              LLM pipeline.
            </p>
          </div>
        </div>
        <div className="app-page-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              window.location.href = chrome.runtime.getURL("dashboard.html");
            }}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Dashboard
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              window.location.href = chrome.runtime.getURL("prompts.html");
            }}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Prompts
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setCreating(true);
              setEditing(null);
            }}
            disabled={loading || !settings || Boolean(status?.backendValidationError)}
          >
            <Plus className="h-3.5 w-3.5" />
            New pile
          </Button>
        </div>
      </header>

      {error ? (
        <div className="mb-6 rounded-[8px] border border-[rgba(193,90,64,0.35)] bg-[rgba(193,90,64,0.08)] px-4 py-3 text-sm text-[#8a3b27]">
          {error}
        </div>
      ) : null}

      {status?.backendValidationError ? (
        <div className="mb-6 rounded-[8px] border border-[rgba(193,90,64,0.35)] bg-[rgba(193,90,64,0.08)] px-4 py-3 text-sm text-[#8a3b27]">
          <strong>Backend unavailable.</strong> {status.backendValidationError}
        </div>
      ) : null}

      {pilesQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--color-ink-subtle)]">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading piles…
        </div>
      ) : null}

      {creating ? (
        <NewPileForm
          onCancel={() => {
            setCreating(false);
            setError(null);
          }}
          onSubmit={(payload) => createMutation.mutate(payload)}
          submitting={createMutation.isPending}
        />
      ) : null}

      <section className="mb-8">
        <h2 className="display-serif mb-3 text-[20px] font-semibold text-[var(--color-ink)]">Built-in</h2>
        <div className="space-y-3">
          {builtIns.map((pile) => (
            <PileCard
              key={pile.id}
              pile={pile}
              editing={editing === pile.slug}
              onStartEdit={() => {
                setEditing(pile.slug);
                setError(null);
              }}
              onCancel={() => setEditing(null)}
              onSave={(payload) => updateMutation.mutate({ slug: pile.slug, payload })}
              submitting={updateMutation.isPending && updateMutation.variables?.slug === pile.slug}
            />
          ))}
        </div>
      </section>

      <section>
        <h2 className="display-serif mb-3 text-[20px] font-semibold text-[var(--color-ink)]">Your piles</h2>
        {userPiles.length === 0 ? (
          <div className="rounded-[8px] border border-dashed border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-5 py-6 text-sm text-[var(--color-ink-soft)]">
            You don't have any custom piles yet. Use <strong>New pile</strong> above to add one. Custom piles get a
            folder under the vault and use the attribute pipeline.
          </div>
        ) : (
          <div className="space-y-3">
            {userPiles.map((pile) => (
              <PileCard
                key={pile.id}
                pile={pile}
                editing={editing === pile.slug}
                onStartEdit={() => {
                  setEditing(pile.slug);
                  setError(null);
                }}
                onCancel={() => setEditing(null)}
                onSave={(payload) => updateMutation.mutate({ slug: pile.slug, payload })}
                onDelete={() => {
                  if (confirm(`Soft-delete pile '${pile.slug}'? Existing sessions stay in place but the pile is hidden.`)) {
                    deleteMutation.mutate(pile.slug);
                  }
                }}
                submitting={updateMutation.isPending && updateMutation.variables?.slug === pile.slug}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function PileCard({
  pile,
  editing,
  onStartEdit,
  onCancel,
  onSave,
  onDelete,
  submitting
}: {
  pile: BackendPileRead;
  editing: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onSave: (payload: PileUpdatePayload) => void;
  onDelete?: () => void;
  submitting: boolean;
}) {
  const builtIn = isBuiltIn(pile);
  const discarded = isDiscarded(pile);

  const [description, setDescription] = useState(pile.description ?? "");
  const [folderLabel, setFolderLabel] = useState(pile.folder_label);
  const [attributes, setAttributes] = useState<string[]>(pile.attributes ?? []);
  const [autoDiscardCategories, setAutoDiscardCategories] = useState<string>(
    Array.isArray((pile.pipeline_config as Record<string, unknown>)?.auto_discard_categories)
      ? ((pile.pipeline_config as Record<string, unknown>).auto_discard_categories as string[]).join(", ")
      : ""
  );
  const [pipelinePromptAddendum, setPipelinePromptAddendum] = useState<string>(
    typeof (pile.pipeline_config as Record<string, unknown>)?.pipeline_prompt_addendum === "string"
      ? ((pile.pipeline_config as Record<string, unknown>).pipeline_prompt_addendum as string)
      : typeof (pile.pipeline_config as Record<string, unknown>)?.custom_prompt_addendum === "string"
        ? ((pile.pipeline_config as Record<string, unknown>).custom_prompt_addendum as string)
      : ""
  );

  function toggleAttribute(id: string): void {
    setAttributes((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]));
  }

  function buildPayload(): PileUpdatePayload {
    const payload: PileUpdatePayload = {
      description: description.trim() || undefined
    };
    if (!builtIn) {
      payload.folder_label = folderLabel.trim();
      payload.attributes = attributes;
    }
    const pipelineConfig: Record<string, unknown> = {
      ...(pile.pipeline_config ?? {}),
      pipeline_prompt_addendum: pipelinePromptAddendum.trim() || null,
      custom_prompt_addendum: pipelinePromptAddendum.trim() || null
    };
    if (discarded) {
      pipelineConfig.auto_discard_categories = autoDiscardCategories
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean);
    }
    payload.pipeline_config = pipelineConfig;
    return payload;
  }

  return (
    <div className="surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="display-serif text-[18px] font-semibold text-[var(--color-ink)]">{pile.name}</span>
            <span className="rounded-full border border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-subtle)]">
              {PILE_KIND_LABELS[pile.kind] ?? pile.kind}
            </span>
            <code className="rounded bg-[var(--color-paper-sunken)] px-1.5 py-0.5 text-[11px] text-[var(--color-ink-soft)]">
              {pile.slug}
            </code>
          </div>
          <p className="mt-1 text-[13px] leading-5 text-[var(--color-ink-soft)]">
            {pile.description ?? "No description."}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {pile.attributes.length === 0 ? (
              <span className="text-[11px] text-[var(--color-ink-subtle)]">No attributes</span>
            ) : (
              pile.attributes.map((attr) => (
                <span
                  key={attr}
                  className="rounded-full border border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-2 py-0.5 text-[11px] text-[var(--color-ink-soft)]"
                >
                  {ATTRIBUTE_LABEL[attr] ?? attr}
                </span>
              ))
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          {editing ? (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={submitting}
                onClick={() => onSave(buildPayload())}
              >
                {submitting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={onStartEdit}>
                Edit
              </Button>
              {onDelete ? (
                <Button variant="ghost" size="sm" onClick={onDelete}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {editing ? (
        <div className="mt-5 space-y-4">
          <Field label="Description">
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              className="w-full rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-sm text-[var(--color-ink)]"
            />
          </Field>

          {!builtIn ? (
            <Field
              label="Folder label"
              hint="The folder under SaveMyContext/ where this pile's notes live."
            >
              <input
                value={folderLabel}
                onChange={(event) => setFolderLabel(event.target.value)}
                className="input-paper"
              />
            </Field>
          ) : null}

          {!builtIn ? (
            <Field
              label="Attributes"
              hint="Each enabled attribute drives one piece of the LLM pipeline. 'Summary' is always implicitly on."
            >
              <div className="grid gap-2 sm:grid-cols-2">
                {ALL_ATTRIBUTES.map((attr) => (
                  <label
                    key={attr.id}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-[8px] border px-3 py-2 text-left transition",
                      attributes.includes(attr.id)
                        ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                        : "border-[var(--color-line)] bg-[var(--color-paper-raised)] hover:border-[var(--color-line-strong)]"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={attributes.includes(attr.id)}
                      onChange={() => toggleAttribute(attr.id)}
                      className="mt-1"
                    />
                    <div>
                      <div className="text-[13px] font-semibold text-[var(--color-ink)]">{attr.label}</div>
                      <div className="mt-0.5 text-[11.5px] text-[var(--color-ink-soft)]">{attr.description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </Field>
          ) : null}

          {discarded ? (
            <Field
              label="Auto-discard categories"
              hint="Comma- or newline-separated. The classifier sees these as descriptions of categories that should auto-route to Discarded."
            >
              <textarea
                value={autoDiscardCategories}
                onChange={(event) => setAutoDiscardCategories(event.target.value)}
                rows={3}
                placeholder="small talk, test sessions, debugging chat"
                className="w-full rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-sm text-[var(--color-ink)]"
              />
            </Field>
          ) : null}

          <Field
            label="Pipeline instructions (optional)"
            hint="Extra instructions appended when this pile's extraction step runs."
          >
            <textarea
              value={pipelinePromptAddendum}
              onChange={(event) => setPipelinePromptAddendum(event.target.value)}
              rows={2}
              className="w-full rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-sm text-[var(--color-ink)]"
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

function NewPileForm({
  onCancel,
  onSubmit,
  submitting
}: {
  onCancel: () => void;
  onSubmit: (payload: PileCreatePayload) => void;
  submitting: boolean;
}) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [folderLabel, setFolderLabel] = useState("");
  const [attributes, setAttributes] = useState<string[]>(["summary"]);

  function toggleAttribute(id: string): void {
    setAttributes((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]));
  }

  function handleSubmit(): void {
    const trimmedSlug = slug.trim().toLowerCase();
    if (!trimmedSlug || !name.trim()) {
      return;
    }
    onSubmit({
      slug: trimmedSlug,
      name: name.trim(),
      description: description.trim() || undefined,
      folder_label: folderLabel.trim() || undefined,
      attributes
    });
  }

  return (
    <div className="surface mb-6 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">New pile</p>
          <h2 className="display-serif mt-1 text-[20px] font-semibold text-[var(--color-ink)]">Create a custom pile</h2>
          <p className="mt-1 text-[13px] text-[var(--color-ink-soft)]">
            Pick the attributes you want the LLM pipeline to extract. Sessions you assign to this pile will run through
            those attribute extractors and write the results to the note's "Pile Outputs" section.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Slug" hint="URL-safe identifier. Lowercase, no spaces.">
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="research"
            className="input-paper"
          />
        </Field>
        <Field label="Name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Research"
            className="input-paper"
          />
        </Field>
      </div>

      <div className="mt-4">
        <Field label="Description">
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            placeholder="Long-form research notes that I want to share later."
            className="w-full rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-sm text-[var(--color-ink)]"
          />
        </Field>
      </div>

      <div className="mt-4">
        <Field label="Folder label" hint="Defaults to the pile name. Becomes a folder under SaveMyContext/.">
          <input
            value={folderLabel}
            onChange={(event) => setFolderLabel(event.target.value)}
            placeholder="Research"
            className="input-paper"
          />
        </Field>
      </div>

      <div className="mt-4">
        <Field
          label="Attributes"
          hint="Each enabled attribute adds a structured key to the note's pile outputs. 'Summary' is on by default."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {ALL_ATTRIBUTES.map((attr) => (
              <label
                key={attr.id}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-[8px] border px-3 py-2 text-left transition",
                  attributes.includes(attr.id)
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                    : "border-[var(--color-line)] bg-[var(--color-paper-raised)] hover:border-[var(--color-line-strong)]"
                )}
              >
                <input
                  type="checkbox"
                  checked={attributes.includes(attr.id)}
                  onChange={() => toggleAttribute(attr.id)}
                  className="mt-1"
                />
                <div>
                  <div className="text-[13px] font-semibold text-[var(--color-ink)]">{attr.label}</div>
                  <div className="mt-0.5 text-[11.5px] text-[var(--color-ink-soft)]">{attr.description}</div>
                </div>
              </label>
            ))}
          </div>
        </Field>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          disabled={submitting || !slug.trim() || !name.trim()}
        >
          {submitting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Create pile
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-[11.5px] text-[var(--color-ink-subtle)]">{hint}</p> : null}
    </div>
  );
}

mountApp(<App />);
