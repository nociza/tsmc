import { useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { fetchSessionNote } from "../background/backend";
import {
  categoryGlyphs,
  categoryLabels,
  categoryPageUrl,
  categoryPalette,
  formatCompactDate,
  formatLongDate,
  parseCategory,
  parseProvider,
  parseSortMode,
  providerLabels,
  titleFromSession,
  type CategorySortMode
} from "../shared/explorer";
import type { BackendSessionNoteRead, ExtensionSettings, ProviderName, SessionCategoryName } from "../shared/types";
import { mountApp } from "../ui/boot";
import { Button } from "../ui/components/button";
import { ScrollArea } from "../ui/components/scroll-area";
import { formatNumber } from "../ui/lib/format";
import { MarkdownView, NoteOverview, TranscriptView } from "../ui/lib/notes";
import { useExtensionBootstrap } from "../ui/lib/runtime";

type NoteRouteState = {
  id: string | null;
  category: SessionCategoryName | null;
  q: string;
  provider: ProviderName | null;
  sort: CategorySortMode;
  userCategory: string;
};

function readRouteState(): NoteRouteState {
  const params = new URLSearchParams(window.location.search);
  return {
    id: params.get("id"),
    category: params.get("category") ? parseCategory(params.get("category")) : null,
    q: params.get("q")?.trim() ?? "",
    provider: parseProvider(params.get("provider")),
    sort: parseSortMode(params.get("sort")),
    userCategory: params.get("userCategory")?.trim() ?? ""
  };
}

function backUrl(route: NoteRouteState): string {
  if (!route.category) return chrome.runtime.getURL("dashboard.html");
  return categoryPageUrl({
    category: route.category,
    q: route.q,
    provider: route.provider,
    sort: route.sort,
    note: route.id,
    userCategory: route.userCategory || null
  });
}

function App() {
  const { settings, status, loading, error } = useExtensionBootstrap();
  const [currentTab, setCurrentTab] = useState<"overview" | "transcript" | "markdown">("overview");
  const route = useMemo(readRouteState, []);

  const noteQuery = useQuery({
    queryKey: ["note-page", settings?.backendUrl, settings?.backendToken, route.id],
    queryFn: () => fetchSessionNote(settings as ExtensionSettings, route.id as string),
    enabled: Boolean(settings && !status?.backendValidationError && route.id)
  });

  const note = noteQuery.data as BackendSessionNoteRead | undefined;
  const category = note?.category ?? route.category ?? "factual";
  const accent = categoryPalette[category].accent;

  return (
    <div className="app-page app-page--reader">
      <div className="app-page-topbar">
        <Button variant="ghost" size="sm" onClick={() => (window.location.href = backUrl(route))}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
        {note?.source_url ? (
          <Button variant="secondary" size="sm" onClick={() => void chrome.tabs.create({ url: note.source_url! })}>
            <ExternalLink className="h-3.5 w-3.5" />
            Source
          </Button>
        ) : null}
      </div>

      <article className="surface overflow-hidden">
        <header className="relative border-b border-[var(--color-line)] px-8 py-8 sm:px-12 sm:py-10">
          <div
            className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full opacity-50"
            style={{ background: `radial-gradient(circle, ${accent}26, transparent 65%)` }}
          />

          <div className="flex items-center gap-2">
            <span
              className="inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold uppercase tracking-[0.08em]"
              style={{ backgroundColor: `${accent}1a`, color: accent }}
            >
              <span className="display-serif text-[13px] leading-none">{categoryGlyphs[category]}</span>
              {categoryLabels[category]}
            </span>
            {note ? (
              <span className="eyebrow">
                {providerLabels[note.provider]} · {formatLongDate(note.updated_at)}
              </span>
            ) : null}
          </div>

          <h1 className="display-serif mt-5 break-words text-[38px] font-semibold leading-[1.08] text-[var(--color-ink)] sm:text-[44px]">
            {note ? titleFromSession(note) : "Reading note"}
          </h1>

          {note ? (
            <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px] text-[var(--color-ink-soft)]">
              <span>{formatNumber(note.word_count)} words</span>
              <span className="h-1 w-1 rounded-full bg-[var(--color-ink-subtle)]" />
              <span>{formatNumber(note.messages.length)} messages</span>
              <span className="h-1 w-1 rounded-full bg-[var(--color-ink-subtle)]" />
              <span>{formatNumber(note.triplets.length)} facts</span>
              <span className="h-1 w-1 rounded-full bg-[var(--color-ink-subtle)]" />
              <span>Updated {formatCompactDate(note.updated_at)}</span>
            </div>
          ) : (
            <p className="mt-5 text-[14px] text-[var(--color-ink-soft)]">
              Loading saved note, transcript, and markdown.
            </p>
          )}
        </header>

        <Tabs.Root value={currentTab} onValueChange={(value) => setCurrentTab(value as typeof currentTab)}>
          <div className="border-b border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-8 sm:px-12">
            <Tabs.List className="flex gap-1">
              {[
                { value: "overview", label: "Overview" },
                { value: "transcript", label: "Transcript" },
                { value: "markdown", label: "Markdown" }
              ].map((tab) => (
                <Tabs.Trigger
                  key={tab.value}
                  value={tab.value}
                  className="relative -mb-px px-4 py-3 text-[13px] font-medium text-[var(--color-ink-soft)] outline-none transition data-[state=active]:text-[var(--color-ink)]"
                >
                  <span>{tab.label}</span>
                  <span
                    className="absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-opacity"
                    style={{
                      backgroundColor: accent,
                      opacity: currentTab === tab.value ? 1 : 0
                    }}
                  />
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </div>

          <div className="px-8 py-8 sm:px-12 sm:py-10">
            {loading || noteQuery.isLoading ? (
              <div className="rounded-[8px] bg-[var(--color-paper-sunken)] px-5 py-6 text-sm text-[var(--color-ink-soft)]">
                Loading note…
              </div>
            ) : note ? (
              <ScrollArea className="min-h-[420px] h-[min(72vh,820px)] pr-4">
                <Tabs.Content value="overview" className="outline-none">
                  <NoteOverview note={note} />
                </Tabs.Content>
                <Tabs.Content value="transcript" className="outline-none">
                  <TranscriptView note={note} />
                </Tabs.Content>
                <Tabs.Content value="markdown" className="outline-none">
                  <MarkdownView note={note} />
                </Tabs.Content>
              </ScrollArea>
            ) : (
              <div className="rounded-[8px] border border-dashed border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-5 py-6 text-sm text-[var(--color-ink-soft)]">
                No note id was provided, or the note could not be loaded.
              </div>
            )}
          </div>
        </Tabs.Root>
      </article>

      {status?.backendValidationError || error || noteQuery.error ? (
        <div className="mt-6 rounded-[8px] border border-[rgba(193,90,64,0.35)] bg-[rgba(193,90,64,0.08)] px-4 py-3 text-sm text-[#8a3b27]">
          {status?.backendValidationError ||
            error ||
            (noteQuery.error instanceof Error ? noteQuery.error.message : "Could not load note.")}
        </div>
      ) : null}
    </div>
  );
}

mountApp(<App />);
