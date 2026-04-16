import { useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { fetchSessionNote } from "../background/backend";
import {
  categoryLabels,
  categoryPageUrl,
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/components/card";
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
};

function readRouteState(): NoteRouteState {
  const params = new URLSearchParams(window.location.search);
  return {
    id: params.get("id"),
    category: params.get("category") ? parseCategory(params.get("category")) : null,
    q: params.get("q")?.trim() ?? "",
    provider: parseProvider(params.get("provider")),
    sort: parseSortMode(params.get("sort"))
  };
}

function backUrl(route: NoteRouteState): string {
  if (!route.category) {
    return chrome.runtime.getURL("dashboard.html");
  }

  return categoryPageUrl({
    category: route.category,
    q: route.q,
    provider: route.provider,
    sort: route.sort,
    note: route.id
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

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-4 sm:px-6 sm:py-6">
      <Card className="p-5">
        <CardHeader>
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">SaveMyContext</div>
            <CardTitle className="text-3xl leading-tight">{note ? titleFromSession(note) : "Reading note"}</CardTitle>
            <CardDescription>
              {note
                ? [
                    providerLabels[note.provider],
                    categoryLabels[note.category ?? route.category ?? "factual"],
                    formatLongDate(note.updated_at),
                    note.markdown_path ?? "No markdown path"
                  ].join(" · ")
                : "Loading saved note, transcript, and markdown."}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => (window.location.href = backUrl(route))}>
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            {note?.source_url ? (
              <Button variant="secondary" onClick={() => void chrome.tabs.create({ url: note.source_url! })}>
                <ExternalLink className="h-4 w-4" />
                Source
              </Button>
            ) : null}
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        {[
          { label: "Provider", value: note ? providerLabels[note.provider] : "—" },
          { label: "Category", value: note ? categoryLabels[note.category ?? route.category ?? "factual"] : "—" },
          { label: "Updated", value: note ? formatCompactDate(note.updated_at) : "—" },
          { label: "Words", value: note ? formatNumber(note.word_count) : "—" },
          { label: "Messages", value: note ? formatNumber(note.messages.length) : "—" },
          { label: "Facts", value: note ? formatNumber(note.triplets.length) : "—" }
        ].map((metric) => (
          <Card key={metric.label} className="p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">{metric.label}</div>
            <div className="mt-2 text-lg font-semibold text-zinc-950">{metric.value}</div>
          </Card>
        ))}
      </div>

      <Card className="p-5">
        <Tabs.Root value={currentTab} onValueChange={(value) => setCurrentTab(value as typeof currentTab)}>
          <CardHeader className="mb-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Reader</div>
              <CardTitle className="mt-1 text-lg">Structured note view</CardTitle>
            </div>
            <Tabs.List className="inline-flex rounded-[8px] border border-zinc-200 bg-zinc-50 p-1">
              {[
                { value: "overview", label: "Overview" },
                { value: "transcript", label: "Transcript" },
                { value: "markdown", label: "Markdown" }
              ].map((tab) => (
                <Tabs.Trigger
                  key={tab.value}
                  value={tab.value}
                  className="rounded-[6px] px-3 py-2 text-sm font-medium text-zinc-500 outline-none transition data-[state=active]:bg-white data-[state=active]:text-zinc-950 data-[state=active]:shadow-sm"
                >
                  {tab.label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </CardHeader>

          <CardContent>
            {loading || noteQuery.isLoading ? (
              <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-6 text-sm text-zinc-500">Loading note…</div>
            ) : note ? (
              <ScrollArea className="h-[720px] pr-4">
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
              <div className="rounded-[8px] border border-dashed border-zinc-200 bg-zinc-50 p-6 text-sm text-zinc-500">
                No note id was provided, or the note could not be loaded.
              </div>
            )}
          </CardContent>
        </Tabs.Root>
      </Card>

      {(status?.backendValidationError || error || noteQuery.error) ? (
        <div className="rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {status?.backendValidationError ||
            error ||
            (noteQuery.error instanceof Error ? noteQuery.error.message : "Could not load note.")}
        </div>
      ) : null}
    </div>
  );
}

mountApp(<App />);
