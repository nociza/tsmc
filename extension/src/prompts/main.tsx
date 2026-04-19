import { type ReactNode, useEffect, useMemo, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Layers, LoaderCircle, RotateCcw, Save, SlidersHorizontal } from "lucide-react";

import {
  fetchPiles,
  fetchPromptTemplates,
  resetPromptTemplate,
  updatePile,
  updatePromptTemplate,
  type PileUpdatePayload,
  type PromptTemplateUpdatePayload
} from "../background/backend";
import type { BackendPileRead, BackendPromptTemplateRead, ExtensionSettings } from "../shared/types";
import { mountApp } from "../ui/boot";
import { Button } from "../ui/components/button";
import { useExtensionBootstrap } from "../ui/lib/runtime";
import { cn } from "../ui/lib/utils";

function promptGroupLabel(group: string): string {
  if (group === "pipeline") {
    return "Pipeline";
  }
  if (group === "capture") {
    return "Capture";
  }
  if (group === "worker") {
    return "Worker";
  }
  return group;
}

function pileKindLabel(pile: BackendPileRead): string {
  return pile.kind === "user_defined" ? "Custom" : "Built-in";
}

function promptPreview(value: string, maxChars = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars).trim()}...`;
}

function pipelinePromptAddendum(pile: BackendPileRead): string {
  const config = pile.pipeline_config as Record<string, unknown>;
  const pipelineValue = config?.pipeline_prompt_addendum;
  if (typeof pipelineValue === "string") {
    return pipelineValue;
  }
  const legacyValue = config?.custom_prompt_addendum;
  return typeof legacyValue === "string" ? legacyValue : "";
}

function autoDiscardCategories(pile: BackendPileRead): string {
  const config = pile.pipeline_config as Record<string, unknown>;
  const rawValue = config?.auto_discard_categories;
  return Array.isArray(rawValue) ? rawValue.join(", ") : "";
}

function App() {
  const { settings, status, loading, error } = useExtensionBootstrap();
  const queryClient = useQueryClient();
  const [surfaceError, setSurfaceError] = useState<string | null>(null);

  const promptsQuery = useQuery({
    queryKey: ["prompt-templates", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchPromptTemplates(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const pilesQuery = useQuery({
    queryKey: ["piles", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchPiles(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const updatePromptMutation = useMutation({
    mutationFn: ({ key, payload }: { key: string; payload: PromptTemplateUpdatePayload }) =>
      updatePromptTemplate(settings as ExtensionSettings, key, payload),
    onSuccess: () => {
      setSurfaceError(null);
      void queryClient.invalidateQueries({ queryKey: ["prompt-templates"] });
    },
    onError: (mutationError: unknown) => {
      setSurfaceError(mutationError instanceof Error ? mutationError.message : "Prompt update failed.");
    }
  });

  const resetPromptMutation = useMutation({
    mutationFn: (key: string) => resetPromptTemplate(settings as ExtensionSettings, key),
    onSuccess: () => {
      setSurfaceError(null);
      void queryClient.invalidateQueries({ queryKey: ["prompt-templates"] });
    },
    onError: (mutationError: unknown) => {
      setSurfaceError(mutationError instanceof Error ? mutationError.message : "Prompt reset failed.");
    }
  });

  const updatePileMutation = useMutation({
    mutationFn: ({ slug, payload }: { slug: string; payload: PileUpdatePayload }) =>
      updatePile(settings as ExtensionSettings, slug, payload),
    onSuccess: () => {
      setSurfaceError(null);
      void queryClient.invalidateQueries({ queryKey: ["piles"] });
    },
    onError: (mutationError: unknown) => {
      setSurfaceError(mutationError instanceof Error ? mutationError.message : "Pile update failed.");
    }
  });

  const promptsByGroup = useMemo(() => {
    const grouped = new Map<string, BackendPromptTemplateRead[]>();
    for (const template of promptsQuery.data ?? []) {
      const existing = grouped.get(template.group) ?? [];
      existing.push(template);
      grouped.set(template.group, existing);
    }
    return [...grouped.entries()];
  }, [promptsQuery.data]);

  const piles = useMemo(() => {
    const rows = [...(pilesQuery.data ?? [])];
    rows.sort((left, right) => {
      if (left.kind === right.kind) {
        return left.sort_order - right.sort_order || left.name.localeCompare(right.name);
      }
      return left.kind === "user_defined" ? 1 : -1;
    });
    return rows;
  }, [pilesQuery.data]);

  const busyKey = updatePromptMutation.variables?.key ?? updatePileMutation.variables?.slug ?? null;

  return (
    <div className="mx-auto max-w-[1080px] px-6 py-10 sm:px-10">
      <header className="mb-8 flex items-start justify-between gap-6">
        <div className="flex items-start gap-4">
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
          <div>
            <p className="eyebrow">Configuration</p>
            <h1 className="display-serif text-[34px] font-semibold leading-[1.05] text-[var(--color-ink)]">
              Prompts
            </h1>
            <p className="mt-2 max-w-[68ch] text-[14px] leading-relaxed text-[var(--color-ink-soft)]">
              Global templates shape the built-in pipelines. Category and pile instructions tune how each pile gets
              routed and processed. Saving changes requires an admin token.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              window.location.href = chrome.runtime.getURL("piles.html");
            }}
          >
            <Layers className="h-3.5 w-3.5" />
            Piles
          </Button>
        </div>
      </header>

      {error ? (
        <div className="mb-6 rounded-[12px] border border-[rgba(193,90,64,0.35)] bg-[rgba(193,90,64,0.08)] px-4 py-3 text-sm text-[#8a3b27]">
          {error}
        </div>
      ) : null}

      {surfaceError ? (
        <div className="mb-6 rounded-[12px] border border-[rgba(193,90,64,0.35)] bg-[rgba(193,90,64,0.08)] px-4 py-3 text-sm text-[#8a3b27]">
          {surfaceError}
        </div>
      ) : null}

      {status?.backendValidationError ? (
        <div className="mb-6 rounded-[12px] border border-[rgba(193,90,64,0.35)] bg-[rgba(193,90,64,0.08)] px-4 py-3 text-sm text-[#8a3b27]">
          <strong>Backend unavailable.</strong> {status.backendValidationError}
        </div>
      ) : null}

      {loading || promptsQuery.isLoading || pilesQuery.isLoading ? (
        <div className="mb-6 flex items-center gap-2 text-sm text-[var(--color-ink-subtle)]">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading prompt controls…
        </div>
      ) : null}

      <section className="mb-10">
        <div className="mb-4">
          <p className="eyebrow">Global</p>
          <h2 className="display-serif text-[22px] font-semibold text-[var(--color-ink)]">Pipeline templates</h2>
          <p className="mt-1 text-[14px] text-[var(--color-ink-soft)]">
            These templates affect the shared classification and extraction flows across the whole vault.
          </p>
        </div>

        <div className="space-y-6">
          {promptsByGroup.map(([group, templates]) => (
            <div key={group}>
              <div className="mb-3 flex items-center gap-2">
                <span className="eyebrow">{promptGroupLabel(group)}</span>
                <span className="h-px flex-1 bg-[var(--color-line)]" />
              </div>
              <div className="space-y-3">
                {templates.map((template) => (
                  <PromptTemplateCard
                    key={template.key}
                    template={template}
                    busy={
                      updatePromptMutation.isPending && busyKey === template.key
                        ? "saving"
                        : resetPromptMutation.isPending && resetPromptMutation.variables === template.key
                          ? "resetting"
                          : null
                    }
                    onSave={(payload) => updatePromptMutation.mutate({ key: template.key, payload })}
                    onReset={() => resetPromptMutation.mutate(template.key)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-4">
          <p className="eyebrow">Per pile</p>
          <h2 className="display-serif text-[22px] font-semibold text-[var(--color-ink)]">Category instructions</h2>
          <p className="mt-1 text-[14px] text-[var(--color-ink-soft)]">
            Use pile descriptions to steer routing. Use pipeline instructions to nudge the extraction step for that
            specific pile only.
          </p>
        </div>

        <div className="space-y-3">
          {piles.map((pile) => (
            <PilePromptCard
              key={pile.id}
              pile={pile}
              busy={updatePileMutation.isPending && busyKey === pile.slug}
              onSave={(payload) => updatePileMutation.mutate({ slug: pile.slug, payload })}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function PromptTemplateCard({
  template,
  busy,
  onSave,
  onReset
}: {
  template: BackendPromptTemplateRead;
  busy: "saving" | "resetting" | null;
  onSave: (payload: PromptTemplateUpdatePayload) => void;
  onReset: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(template.system_prompt);
  const [userPrompt, setUserPrompt] = useState(template.user_prompt);

  useEffect(() => {
    setSystemPrompt(template.system_prompt);
    setUserPrompt(template.user_prompt);
  }, [template.system_prompt, template.user_prompt]);

  return (
    <div className="surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="display-serif text-[18px] font-semibold text-[var(--color-ink)]">{template.title}</span>
            <span className="rounded-full border border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-subtle)]">
              {promptGroupLabel(template.group)}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]",
                template.has_override
                  ? "bg-[rgba(15,138,132,0.12)] text-[var(--color-accent)]"
                  : "bg-[var(--color-paper-sunken)] text-[var(--color-ink-subtle)]"
              )}
            >
              {template.has_override ? "Override" : "Default"}
            </span>
            <code className="rounded bg-[var(--color-paper-sunken)] px-1.5 py-0.5 text-[11px] text-[var(--color-ink-soft)]">
              {template.key}
            </code>
          </div>
          <p className="mt-1 text-[13px] leading-5 text-[var(--color-ink-soft)]">{template.description}</p>
          {template.variables.length ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {template.variables.map((variable) => (
                <span
                  key={variable.name}
                  className="rounded-full border border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-2 py-0.5 text-[11px] text-[var(--color-ink-soft)]"
                  title={variable.description}
                >
                  {`{{${variable.name}}}`}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {template.has_override ? (
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={onReset}>
              {busy === "resetting" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              Reset
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => setEditing((current) => !current)}>
            <SlidersHorizontal className="h-3.5 w-3.5" />
            {editing ? "Close" : "Edit"}
          </Button>
        </div>
      </div>

      {!editing ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <PromptPreviewBlock label="System" value={template.system_prompt} />
          <PromptPreviewBlock label="User" value={template.user_prompt} />
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <Field
            label="System prompt"
            hint="Shared instruction block for this template."
          >
            <textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              rows={5}
              className="w-full rounded-[10px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-sm text-[var(--color-ink)]"
            />
          </Field>
          <Field
            label="User prompt"
            hint="Task input block. Keep listed variables if the template still needs them."
          >
            <textarea
              value={userPrompt}
              onChange={(event) => setUserPrompt(event.target.value)}
              rows={10}
              className="w-full rounded-[10px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-sm text-[var(--color-ink)]"
            />
          </Field>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                setSystemPrompt(template.system_prompt);
                setUserPrompt(template.user_prompt);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy !== null}
              onClick={() => onSave({ system_prompt: systemPrompt, user_prompt: userPrompt })}
            >
              {busy === "saving" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PromptPreviewBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-4 py-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-subtle)]">
        {label}
      </div>
      <p className="text-[12px] leading-5 text-[var(--color-ink-soft)]">{promptPreview(value)}</p>
    </div>
  );
}

function PilePromptCard({
  pile,
  busy,
  onSave
}: {
  pile: BackendPileRead;
  busy: boolean;
  onSave: (payload: PileUpdatePayload) => void;
}) {
  const [description, setDescription] = useState(pile.description ?? "");
  const [promptAddendum, setPromptAddendum] = useState(pipelinePromptAddendum(pile));
  const [discardCategories, setDiscardCategories] = useState(autoDiscardCategories(pile));

  useEffect(() => {
    setDescription(pile.description ?? "");
    setPromptAddendum(pipelinePromptAddendum(pile));
    setDiscardCategories(autoDiscardCategories(pile));
  }, [pile]);

  function buildPayload(): PileUpdatePayload {
    const pipelineConfig: Record<string, unknown> = {
      ...(pile.pipeline_config ?? {}),
      pipeline_prompt_addendum: promptAddendum.trim() || null,
      custom_prompt_addendum: promptAddendum.trim() || null
    };
    if (pile.slug === "discarded") {
      pipelineConfig.auto_discard_categories = discardCategories
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean);
    }
    return {
      description,
      pipeline_config: pipelineConfig
    };
  }

  return (
    <div className="surface p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="display-serif text-[18px] font-semibold text-[var(--color-ink)]">{pile.name}</span>
            <span className="rounded-full border border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-subtle)]">
              {pileKindLabel(pile)}
            </span>
            <code className="rounded bg-[var(--color-paper-sunken)] px-1.5 py-0.5 text-[11px] text-[var(--color-ink-soft)]">
              {pile.slug}
            </code>
          </div>
          <p className="mt-1 text-[13px] leading-5 text-[var(--color-ink-soft)]">
            Routing uses the pile description. Extraction uses the pipeline instructions below.
          </p>
        </div>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => onSave(buildPayload())}>
          {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Routing description"
          hint="How the classifier should think about this pile when choosing a destination."
        >
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={5}
            className="w-full rounded-[10px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-sm text-[var(--color-ink)]"
          />
        </Field>
        <Field
          label="Pipeline instructions"
          hint="Extra instructions appended only when this pile's extraction step runs."
        >
          <textarea
            value={promptAddendum}
            onChange={(event) => setPromptAddendum(event.target.value)}
            rows={5}
            placeholder={
              pile.kind === "user_defined"
                ? "Prefer terse summaries. Focus on decisions and citations."
                : "Keep only grounded details. Prefer concise output."
            }
            className="w-full rounded-[10px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-sm text-[var(--color-ink)]"
          />
        </Field>
      </div>

      {pile.slug === "discarded" ? (
        <div className="mt-4">
          <Field
            label="Auto-discard categories"
            hint="Comma- or newline-separated categories that should route into Discarded."
          >
            <textarea
              value={discardCategories}
              onChange={(event) => setDiscardCategories(event.target.value)}
              rows={3}
              className="w-full rounded-[10px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-sm text-[var(--color-ink)]"
            />
          </Field>
        </div>
      ) : null}
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
  children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-2 text-[13px] font-semibold text-[var(--color-ink)]">{label}</div>
      {children}
      {hint ? <div className="mt-2 text-[12px] leading-5 text-[var(--color-ink-subtle)]">{hint}</div> : null}
    </label>
  );
}

mountApp(<App />);
