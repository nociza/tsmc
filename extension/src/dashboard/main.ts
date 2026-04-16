import "./styles.css";

import {
  fetchDashboardSummary,
  fetchGraphEdges,
  fetchGraphNodes,
  fetchSession,
  fetchSessions,
  fetchSystemStatus
} from "../background/backend";
import type {
  BackendDashboardSummary,
  BackendGraphEdge,
  BackendGraphNode,
  BackendSessionListItem,
  BackendSessionRead,
  BackendSystemStatus,
  ExtensionSettings,
  ProviderName,
  ProviderDriftAlert,
  RuntimeMessage,
  SessionCategoryName,
  SyncStatus
} from "../shared/types";

const numberFormatter = new Intl.NumberFormat();
const percentFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});
const compactDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
});

const categoryPalette: Record<SessionCategoryName, { color: string; tone: string }> = {
  factual: { color: "#0b8c88", tone: "rgba(11, 140, 136, 0.14)" },
  ideas: { color: "#dd8a3b", tone: "rgba(221, 138, 59, 0.14)" },
  journal: { color: "#6b7bc6", tone: "rgba(107, 123, 198, 0.14)" },
  todo: { color: "#bd5d38", tone: "rgba(189, 93, 56, 0.14)" }
};

const categoryOrder: SessionCategoryName[] = ["factual", "ideas", "journal", "todo"];
const categoryLabels: Record<SessionCategoryName, string> = {
  factual: "Factual",
  ideas: "Ideas",
  journal: "Journal",
  todo: "To-Do"
};
const providerLabels: Record<ProviderName, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  grok: "Grok"
};

type DashboardRouteState = {
  category: SessionCategoryName | null;
  view: "overview" | "notes" | "processing";
  focus: "triplets" | null;
};

const backendAlert = document.querySelector<HTMLDivElement>("#backend-alert");
const backendAlertMessage = document.querySelector<HTMLParagraphElement>("#backend-alert-message");
const refreshDashboardButton = document.querySelector<HTMLButtonElement>("#refresh-dashboard");
const openOptionsButton = document.querySelector<HTMLButtonElement>("#open-options");

const metricSessions = document.querySelector<HTMLParagraphElement>("#metric-sessions");
const metricMessages = document.querySelector<HTMLParagraphElement>("#metric-messages");
const metricSyncEvents = document.querySelector<HTMLParagraphElement>("#metric-sync-events");
const metricTriplets = document.querySelector<HTMLParagraphElement>("#metric-triplets");
const metricEntities = document.querySelector<HTMLParagraphElement>("#metric-entities");
const metricEdges = document.querySelector<HTMLParagraphElement>("#metric-edges");
const metricCardSessions = document.querySelector<HTMLElement>("#metric-card-sessions");
const metricCardMessages = document.querySelector<HTMLElement>("#metric-card-messages");
const metricCardTriplets = document.querySelector<HTMLElement>("#metric-card-triplets");

const latestSyncAt = document.querySelector<HTMLParagraphElement>("#latest-sync-at");
const healthBackendUrl = document.querySelector<HTMLParagraphElement>("#health-backend-url");
const healthBackendStatus = document.querySelector<HTMLParagraphElement>("#health-backend-status");
const healthLastSuccess = document.querySelector<HTMLParagraphElement>("#health-last-success");
const healthLastSession = document.querySelector<HTMLParagraphElement>("#health-last-session");
const healthHistorySync = document.querySelector<HTMLParagraphElement>("#health-history-sync");
const healthProcessing = document.querySelector<HTMLParagraphElement>("#health-processing");
const healthProcessingPending = document.querySelector<HTMLParagraphElement>("#health-processing-pending");
const healthProviders = document.querySelector<HTMLParagraphElement>("#health-providers");
const healthActiveTokens = document.querySelector<HTMLParagraphElement>("#health-active-tokens");
const healthGraphCoverage = document.querySelector<HTMLParagraphElement>("#health-graph-coverage");
const healthLastError = document.querySelector<HTMLParagraphElement>("#health-last-error");
const healthProviderDriftCard = document.querySelector<HTMLDivElement>("#health-provider-drift-card");
const healthProviderDrift = document.querySelector<HTMLParagraphElement>("#health-provider-drift");

const categoryDonut = document.querySelector<HTMLDivElement>("#category-donut");
const categoryDonutTotal = document.querySelector<HTMLElement>("#category-donut-total");
const categoryTotalLabel = document.querySelector<HTMLParagraphElement>("#category-total-label");
const categoryList = document.querySelector<HTMLDivElement>("#category-list");
const derivedMetrics = document.querySelector<HTMLDivElement>("#derived-metrics");
const categoryExplorer = document.querySelector<HTMLDivElement>("#category-explorer");
const explorerTitle = document.querySelector<HTMLHeadingElement>("#explorer-title");
const explorerSubtitle = document.querySelector<HTMLParagraphElement>("#explorer-subtitle");
const explorerClearButton = document.querySelector<HTMLButtonElement>("#explorer-clear");
const noteMap = document.querySelector<HTMLDivElement>("#note-map");
const explorerNoteTitle = document.querySelector<HTMLHeadingElement>("#explorer-note-title");
const explorerNoteMeta = document.querySelector<HTMLParagraphElement>("#explorer-note-meta");
const explorerNoteSummary = document.querySelector<HTMLParagraphElement>("#explorer-note-summary");
const explorerOpenSource = document.querySelector<HTMLButtonElement>("#explorer-open-source");
const explorerNoteList = document.querySelector<HTMLDivElement>("#explorer-note-list");

const graphSummary = document.querySelector<HTMLParagraphElement>("#graph-summary");
const topEntities = document.querySelector<HTMLDivElement>("#top-entities");

const systemSummary = document.querySelector<HTMLParagraphElement>("#system-summary");
const systemVaultRoot = document.querySelector<HTMLParagraphElement>("#system-vault-root");
const systemMarkdownRoot = document.querySelector<HTMLParagraphElement>("#system-markdown-root");
const systemTodoPath = document.querySelector<HTMLParagraphElement>("#system-todo-path");
const systemAuthMode = document.querySelector<HTMLParagraphElement>("#system-auth-mode");
const systemGitStatus = document.querySelector<HTMLParagraphElement>("#system-git-status");
const systemPublicUrl = document.querySelector<HTMLParagraphElement>("#system-public-url");

let currentSettings: ExtensionSettings | null = null;
let currentStatus: SyncStatus | null = null;
let currentSummary: BackendDashboardSummary | null = null;
let currentSystem: BackendSystemStatus | null = null;
let currentNodes: BackendGraphNode[] = [];
let currentEdges: BackendGraphEdge[] = [];
let loadPromise: Promise<void> | null = null;
let loadQueued = false;
let currentRouteState: DashboardRouteState = readRouteState();
let selectedExplorerSessionId: string | null = null;
let selectedExplorerDetail: BackendSessionRead | null = null;
let explorerSyncToken = 0;
const sessionListCache = new Map<string, BackendSessionListItem[]>();
const sessionDetailCache = new Map<string, BackendSessionRead>();

function formatNumber(value: number | undefined | null): string {
  return numberFormatter.format(value ?? 0);
}

function readRouteState(): DashboardRouteState {
  const params = new URLSearchParams(window.location.search);
  const rawCategory = params.get("category");
  const rawView = params.get("view");
  const rawFocus = params.get("focus");

  const category = categoryOrder.includes(rawCategory as SessionCategoryName) ? (rawCategory as SessionCategoryName) : null;
  const view =
    rawView === "notes" || rawView === "processing" ? rawView : category ? "notes" : "overview";
  const focus = rawFocus === "triplets" ? "triplets" : null;

  return {
    category,
    view,
    focus
  };
}

function applyRouteState(nextState: Partial<DashboardRouteState>, push = true): void {
  currentRouteState = {
    ...currentRouteState,
    ...nextState
  };

  if (currentRouteState.view !== "notes") {
    currentRouteState.category = null;
    currentRouteState.focus = null;
  }

  const url = new URL(window.location.href);
  url.searchParams.delete("category");
  url.searchParams.delete("view");
  url.searchParams.delete("focus");

  if (currentRouteState.category) {
    url.searchParams.set("category", currentRouteState.category);
  }
  if (currentRouteState.view !== "overview" || currentRouteState.category) {
    url.searchParams.set("view", currentRouteState.view);
  }
  if (currentRouteState.focus) {
    url.searchParams.set("focus", currentRouteState.focus);
  }

  if (push) {
    window.history.pushState(null, "", url);
  } else {
    window.history.replaceState(null, "", url);
  }

  renderCategoryMix(currentSummary ?? undefined);
  void syncExplorer();

  if (currentRouteState.view !== "overview") {
    requestAnimationFrame(() => {
      categoryExplorer?.scrollIntoView({
        behavior: push ? "smooth" : "auto",
        block: "start"
      });
    });
  }
}

function attachClickable(node: HTMLElement | null, onActivate: () => void): void {
  if (!node) {
    return;
  }

  node.addEventListener("click", onActivate);
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    onActivate();
  });
}

function sessionCacheKey(category: SessionCategoryName | null): string {
  return category ?? "*";
}

function resetExplorerSelection(): void {
  selectedExplorerSessionId = null;
  selectedExplorerDetail = null;
}

function sessionDisplayTitle(session: BackendSessionListItem | BackendSessionRead): string {
  return session.title?.trim() || `${providerLabels[session.provider]} · ${session.external_session_id}`;
}

function formatRelativeSessionDate(value?: string | null): string {
  if (!value) {
    return "No timestamp";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return compactDateFormatter.format(date);
}

function formatDate(value?: string | null, fallback = "No data yet"): string {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatBackendStatus(status: SyncStatus): string {
  if (status.backendValidationError) {
    return status.backendValidationError;
  }

  if (status.backendValidatedAt && status.backendVersion) {
    return `${status.backendProduct ?? "savemycontext"} ${status.backendVersion} (${status.backendAuthMode ?? "unknown"})`;
  }

  return "Checking…";
}

function formatHistorySync(settings: ExtensionSettings, status: SyncStatus): string {
  if (!settings.autoSyncHistory) {
    return "Disabled";
  }

  if (status.historySyncInProgress) {
    const provider = status.historySyncProvider ?? "";
    const progress =
      typeof status.historySyncTotalCount === "number"
        ? ` ${status.historySyncProcessedCount ?? 0}/${status.historySyncTotalCount}`
        : "";
    const skipped =
      typeof status.historySyncSkippedCount === "number" && status.historySyncSkippedCount > 0
        ? ` (${status.historySyncSkippedCount} skipped)`
        : "";
    return `Running ${provider}${progress}${skipped}`.trim();
  }

  if (status.historySyncLastCompletedAt) {
    const count =
      typeof status.historySyncLastConversationCount === "number"
        ? `, ${status.historySyncLastConversationCount} conversations`
        : "";
    return `${status.historySyncLastResult ?? "success"} ${formatDate(status.historySyncLastCompletedAt)}${count}`;
  }

  return "Idle";
}

function formatProcessing(status: SyncStatus): string {
  if (status.processingInProgress) {
    const provider = status.processingProvider ?? "provider";
    const processed = typeof status.processingProcessedCount === "number" ? `, ${status.processingProcessedCount} done` : "";
    return `Running ${provider}${processed}`;
  }

  if (status.processingLastError) {
    return `Failed: ${status.processingLastError}`;
  }

  if (status.processingMode === "immediate") {
    return status.processingWorkerModel
      ? `Immediate backend processing (${status.processingWorkerModel})`
      : "Immediate backend processing";
  }

  if (status.processingMode === "disabled") {
    return "Experimental browser automation is disabled";
  }

  if (status.processingWorkerModel) {
    return `Manual browser worker (${status.processingWorkerModel})`;
  }

  return "Unavailable";
}

function formatProviderDriftAlert(alert?: ProviderDriftAlert | null): string {
  if (!alert) {
    return "None";
  }

  const headline = `${alert.provider}: ${alert.message}`;
  const evidence = alert.evidence ? ` Evidence: ${alert.evidence}` : "";
  return `${headline} ${formatDate(alert.detectedAt)}.${evidence}`.trim();
}

function providerList(settings: ExtensionSettings): string {
  const enabled = Object.entries(settings.enabledProviders)
    .filter(([, isEnabled]) => isEnabled)
    .map(([provider]) => provider);
  return enabled.length ? enabled.join(", ") : "None enabled";
}

function categoryCounts(summary: BackendDashboardSummary): Map<SessionCategoryName, number> {
  return new Map(
    summary.categories.map((item) => [item.category, item.count] satisfies [SessionCategoryName, number])
  );
}

function totalIndexedSessions(summary: BackendDashboardSummary): number {
  return summary.categories.reduce((total, item) => total + item.count, 0);
}

function renderAlert(message: string | null): void {
  if (!backendAlert || !backendAlertMessage) {
    return;
  }

  backendAlert.hidden = !message;
  backendAlertMessage.textContent = message ?? "";
}

function renderMetrics(summary?: BackendDashboardSummary, nodes: BackendGraphNode[] = [], edges: BackendGraphEdge[] = []): void {
  if (metricSessions) {
    metricSessions.textContent = formatNumber(summary?.total_sessions);
  }
  if (metricMessages) {
    metricMessages.textContent = formatNumber(summary?.total_messages);
  }
  if (metricSyncEvents) {
    metricSyncEvents.textContent = formatNumber(summary?.total_sync_events);
  }
  if (metricTriplets) {
    metricTriplets.textContent = formatNumber(summary?.total_triplets);
  }
  if (metricEntities) {
    metricEntities.textContent = formatNumber(nodes.length);
  }
  if (metricEdges) {
    metricEdges.textContent = formatNumber(edges.length);
  }
}

function renderHealth(
  settings: ExtensionSettings,
  status: SyncStatus,
  summary?: BackendDashboardSummary,
  nodes: BackendGraphNode[] = [],
  edges: BackendGraphEdge[] = []
): void {
  if (latestSyncAt) {
    latestSyncAt.textContent = `Latest corpus sync: ${formatDate(summary?.latest_sync_at, "No data yet")}`;
  }
  if (healthBackendUrl) {
    const suffix = status.backendVersion ? ` (${status.backendVersion})` : "";
    healthBackendUrl.textContent = `${settings.backendUrl}${suffix}`;
  }
  if (healthBackendStatus) {
    healthBackendStatus.textContent = formatBackendStatus(status);
  }
  if (healthLastSuccess) {
    healthLastSuccess.textContent = formatDate(status.lastSuccessAt, "No sync yet");
  }
  if (healthLastSession) {
    healthLastSession.textContent = status.lastSessionKey ?? "n/a";
  }
  if (healthHistorySync) {
    healthHistorySync.textContent = formatHistorySync(settings, status);
  }
  if (healthProcessing) {
    healthProcessing.textContent = formatProcessing(status);
  }
  if (healthProcessingPending) {
    healthProcessingPending.textContent =
      typeof status.processingPendingCount === "number" ? String(status.processingPendingCount) : "0";
  }
  if (healthProviders) {
    healthProviders.textContent = providerList(settings);
  }
  if (healthActiveTokens) {
    healthActiveTokens.textContent = formatNumber(summary?.active_tokens);
  }
  if (healthGraphCoverage) {
    healthGraphCoverage.textContent = `${formatNumber(nodes.length)} entities, ${formatNumber(edges.length)} edges`;
  }
  if (healthLastError) {
    healthLastError.textContent = status.processingLastError ?? status.historySyncLastError ?? status.lastError ?? "None";
  }
  if (healthProviderDriftCard && healthProviderDrift) {
    healthProviderDriftCard.hidden = !status.providerDriftAlert;
    healthProviderDrift.textContent = formatProviderDriftAlert(status.providerDriftAlert);
  }
}

function createMetricPill(label: string, value: string): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "derived-card";

  const title = document.createElement("p");
  title.className = "derived-label";
  title.textContent = label;

  const content = document.createElement("p");
  content.className = "derived-value";
  content.textContent = value;

  wrapper.append(title, content);
  return wrapper;
}

function renderDerivedMetrics(summary?: BackendDashboardSummary): void {
  if (!derivedMetrics) {
    return;
  }

  derivedMetrics.replaceChildren();

  if (!summary || summary.total_sessions === 0) {
    derivedMetrics.append(createMetricPill("Messages per session", "0.0"));
    derivedMetrics.append(createMetricPill("Triplets per session", "0.0"));
    derivedMetrics.append(createMetricPill("Sync events per session", "0.0"));
    return;
  }

  derivedMetrics.append(
    createMetricPill("Messages per session", decimalFormatter.format(summary.total_messages / summary.total_sessions))
  );
  derivedMetrics.append(
    createMetricPill("Triplets per session", decimalFormatter.format(summary.total_triplets / summary.total_sessions))
  );
  derivedMetrics.append(
    createMetricPill("Sync events per session", decimalFormatter.format(summary.total_sync_events / summary.total_sessions))
  );
}

async function loadExplorerSessions(
  settings: ExtensionSettings,
  category: SessionCategoryName | null
): Promise<BackendSessionListItem[]> {
  const cacheKey = sessionCacheKey(category);
  const cached = sessionListCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const sessions = await fetchSessions(settings, category ? { category } : undefined);
  sessionListCache.set(cacheKey, sessions);
  return sessions;
}

async function loadExplorerDetail(settings: ExtensionSettings, sessionId: string): Promise<BackendSessionRead> {
  const cached = sessionDetailCache.get(sessionId);
  if (cached) {
    return cached;
  }

  const detail = await fetchSession(settings, sessionId);
  sessionDetailCache.set(sessionId, detail);
  return detail;
}

function sessionPreview(detail: BackendSessionRead | null, session: BackendSessionListItem): string {
  if (detail?.classification_reason) {
    return detail.classification_reason;
  }
  if (detail?.journal_entry) {
    return detail.journal_entry.slice(0, 220);
  }
  if (detail?.todo_summary) {
    return detail.todo_summary.slice(0, 220);
  }
  if (detail?.idea_summary && typeof detail.idea_summary["core_idea"] === "string") {
    return String(detail.idea_summary["core_idea"]).slice(0, 220);
  }
  if (detail?.triplets.length) {
    const triplet = detail.triplets[0];
    return `${triplet.subject} -> ${triplet.predicate} -> ${triplet.object}`;
  }
  if (detail?.messages.length) {
    return detail.messages[0].content.slice(0, 220);
  }
  if (session.share_post) {
    return session.share_post.slice(0, 220);
  }
  return "No extracted note content yet.";
}

function renderExplorerDetail(session: BackendSessionListItem | null, detail: BackendSessionRead | null, pending = false): void {
  if (!explorerNoteTitle || !explorerNoteMeta || !explorerNoteSummary || !explorerOpenSource) {
    return;
  }

  if (!session) {
    explorerNoteTitle.textContent = "Choose a note";
    explorerNoteMeta.textContent = "Use the category map to inspect one session at a time.";
    explorerNoteSummary.textContent = "Session summaries, paths, and extracted structure appear here.";
    explorerOpenSource.hidden = true;
    explorerOpenSource.onclick = null;
    return;
  }

  explorerNoteTitle.textContent = sessionDisplayTitle(session);
  const messageCount = detail?.messages.length;
  const tripletCount = detail?.triplets.length;
  const metaBits = [
    providerLabels[session.provider],
    formatRelativeSessionDate(session.updated_at),
    typeof messageCount === "number" ? `${formatNumber(messageCount)} messages` : null,
    typeof tripletCount === "number" ? `${formatNumber(tripletCount)} facts` : null
  ].filter(Boolean);
  explorerNoteMeta.textContent = metaBits.join(" · ");

  if (pending) {
    explorerNoteSummary.textContent = "Loading session detail…";
  } else {
    const preview = sessionPreview(detail, session);
    const markdownPath = session.markdown_path ? `\n\nPath: ${session.markdown_path}` : "";
    explorerNoteSummary.textContent = `${preview}${markdownPath}`;
  }

  if (detail?.source_url) {
    explorerOpenSource.hidden = false;
    explorerOpenSource.onclick = () => {
      void chrome.tabs.create({ url: detail.source_url! });
    };
  } else {
    explorerOpenSource.hidden = true;
    explorerOpenSource.onclick = null;
  }
}

function renderExplorerList(
  sessions: BackendSessionListItem[],
  selectedSessionId: string | null,
  onSelect: (sessionId: string) => void,
  emptyMessage = "No notes match this view yet."
): void {
  if (!explorerNoteList) {
    return;
  }

  explorerNoteList.replaceChildren();
  const visibleSessions = sessions.slice(0, 24);

  if (!visibleSessions.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = emptyMessage;
    explorerNoteList.append(empty);
    return;
  }

  for (const session of visibleSessions) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "explorer-list-item";
    item.dataset.active = String(session.id === selectedSessionId);
    item.setAttribute("aria-pressed", String(session.id === selectedSessionId));

    const title = document.createElement("span");
    title.className = "explorer-list-title";
    title.textContent = sessionDisplayTitle(session);

    const meta = document.createElement("span");
    meta.className = "explorer-list-meta";
    meta.textContent = `${providerLabels[session.provider]} · ${formatRelativeSessionDate(session.updated_at)}`;

    item.append(title, meta);
    item.addEventListener("click", () => onSelect(session.id));
    explorerNoteList.append(item);
  }

  if (sessions.length > visibleSessions.length) {
    const more = document.createElement("p");
    more.className = "empty-state";
    more.textContent = `Showing ${formatNumber(visibleSessions.length)} of ${formatNumber(sessions.length)} notes in this view.`;
    explorerNoteList.append(more);
  }
}

function renderNoteMap(
  sessions: BackendSessionListItem[],
  selectedSessionId: string | null,
  onSelect: (sessionId: string) => void,
  emptyMessage = "No notes match this category yet."
): void {
  if (!noteMap) {
    return;
  }

  noteMap.replaceChildren();

  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = emptyMessage;
    noteMap.append(empty);
    return;
  }

  const providers: ProviderName[] = ["chatgpt", "gemini", "grok"];

  for (const provider of providers) {
    const providerSessions = sessions
      .filter((session) => session.provider === provider)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));

    if (!providerSessions.length) {
      continue;
    }

    const lane = document.createElement("section");
    lane.className = "note-lane";

    const heading = document.createElement("div");
    heading.className = "note-lane-heading";

    const label = document.createElement("span");
    label.className = "note-lane-label";
    label.textContent = providerLabels[provider];

    const count = document.createElement("span");
    count.className = "note-lane-count";
    count.textContent = formatNumber(providerSessions.length);

    heading.append(label, count);

    const dots = document.createElement("div");
    dots.className = "note-dot-grid";

    for (const session of providerSessions) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "note-dot";
      dot.dataset.provider = provider;
      dot.dataset.active = String(session.id === selectedSessionId);
      dot.setAttribute("aria-pressed", String(session.id === selectedSessionId));
      dot.title = `${sessionDisplayTitle(session)} · ${formatRelativeSessionDate(session.updated_at)}`;
      dot.setAttribute("aria-label", dot.title);
      dot.addEventListener("click", () => onSelect(session.id));
      dots.append(dot);
    }

    lane.append(heading, dots);
    noteMap.append(lane);
  }
}

async function syncExplorer(): Promise<void> {
  if (!categoryExplorer || !explorerTitle || !explorerSubtitle) {
    return;
  }

  const syncToken = ++explorerSyncToken;
  const shouldShowExplorer = currentRouteState.view === "notes" || currentRouteState.view === "processing";
  categoryExplorer.hidden = !shouldShowExplorer;
  explorerClearButton && (explorerClearButton.hidden = !shouldShowExplorer);

  if (!shouldShowExplorer) {
    return;
  }

  if (currentRouteState.view === "processing") {
    explorerTitle.textContent = "Processing Queue";
    explorerSubtitle.textContent = "Queued AI jobs and processing health are shown in the capture panel above.";
    renderNoteMap([], null, () => undefined, "Open the capture health section above to review processing state.");
    renderExplorerList([], null, () => undefined, "No note list for processing mode.");
    renderExplorerDetail(null, null);
    return;
  }

  const category = currentRouteState.category;
  explorerTitle.textContent = category ? `${categoryLabels[category]} Notes` : "All Indexed Notes";

  if (!currentSettings || currentStatus?.backendValidationError) {
    explorerSubtitle.textContent = currentStatus?.backendValidationError ?? "Waiting for backend data.";
    renderNoteMap([], null, () => undefined, "Connect the backend to load indexed notes.");
    renderExplorerList([], null, () => undefined, "Connect the backend to load indexed notes.");
    renderExplorerDetail(null, null);
    return;
  }

  explorerSubtitle.textContent =
    currentRouteState.focus === "triplets" && category === "factual"
      ? "Factual notes grouped by provider. Select a note to inspect extracted facts and session detail."
      : category
        ? `Every note classified as ${categoryLabels[category].toLowerCase()}, grouped by provider.`
        : "All indexed notes grouped by provider. Select a category chip or stat to focus this map.";

  let sessions: BackendSessionListItem[];
  try {
    sessions = await loadExplorerSessions(currentSettings, category);
  } catch (error) {
    if (syncToken !== explorerSyncToken) {
      return;
    }
    const message = error instanceof Error ? error.message : "Could not load notes for this view.";
    explorerSubtitle.textContent = message;
    renderNoteMap([], null, () => undefined, "Could not load notes for this view.");
    renderExplorerList([], null, () => undefined, "Could not load notes for this view.");
    renderExplorerDetail(null, null);
    return;
  }

  if (syncToken !== explorerSyncToken) {
    return;
  }

  const sortedSessions = [...sessions].sort((left, right) => right.updated_at.localeCompare(left.updated_at));

  if (!sortedSessions.length) {
    renderNoteMap([], null, () => undefined, "No indexed notes match this view yet.");
    renderExplorerList([], null, () => undefined, "No indexed notes match this view yet.");
    renderExplorerDetail(null, null);
    return;
  }

  if (!selectedExplorerSessionId || !sortedSessions.some((session) => session.id === selectedExplorerSessionId)) {
    selectedExplorerSessionId = sortedSessions[0].id;
    selectedExplorerDetail = null;
  }

  const selectSession = (sessionId: string): void => {
    resetExplorerSelection();
    selectedExplorerSessionId = sessionId;
    void syncExplorer();
  };

  renderNoteMap(sortedSessions, selectedExplorerSessionId, selectSession);
  renderExplorerList(sortedSessions, selectedExplorerSessionId, selectSession);

  const selectedSession = sortedSessions.find((session) => session.id === selectedExplorerSessionId) ?? sortedSessions[0];
  renderExplorerDetail(selectedSession, selectedExplorerDetail, true);

  try {
    selectedExplorerDetail = await loadExplorerDetail(currentSettings, selectedSession.id);
  } catch {
    selectedExplorerDetail = null;
  }

  if (syncToken !== explorerSyncToken) {
    return;
  }

  renderExplorerDetail(selectedSession, selectedExplorerDetail, false);
}

function renderCategoryMix(summary?: BackendDashboardSummary): void {
  const counts = summary ? categoryCounts(summary) : new Map<SessionCategoryName, number>();
  const total = summary ? totalIndexedSessions(summary) : 0;

  if (categoryDonutTotal) {
    categoryDonutTotal.textContent = formatNumber(total);
  }
  if (categoryTotalLabel) {
    categoryTotalLabel.textContent = `${formatNumber(total)} indexed sessions`;
  }
  if (categoryDonut) {
    if (!total) {
      categoryDonut.style.setProperty("--donut-fill", "rgba(17, 38, 58, 0.08) 0deg 360deg");
    } else {
      let offset = 0;
      const slices: string[] = [];
      for (const category of categoryOrder) {
        const value = counts.get(category) ?? 0;
        if (!value) {
          continue;
        }
        const start = (offset / total) * 360;
        offset += value;
        const end = (offset / total) * 360;
        slices.push(`${categoryPalette[category].color} ${start}deg ${end}deg`);
      }
      categoryDonut.style.setProperty("--donut-fill", slices.join(", "));
    }
  }

  if (!categoryList) {
    return;
  }

  categoryList.replaceChildren();
  for (const category of categoryOrder) {
    const count = counts.get(category) ?? 0;
    const ratio = total ? count / total : 0;

    const item = document.createElement("button");
    item.type = "button";
    item.className = "category-item category-link";
    item.dataset.active = String(currentRouteState.view === "notes" && currentRouteState.category === category);
    item.setAttribute("aria-pressed", item.dataset.active);
    item.style.setProperty("--category-accent", categoryPalette[category].color);
    item.addEventListener("click", () => {
      resetExplorerSelection();
      applyRouteState({ view: "notes", category, focus: null });
    });

    const heading = document.createElement("div");
    heading.className = "category-heading";

    const label = document.createElement("span");
    label.className = "category-name";
    label.textContent = categoryLabels[category];

    const value = document.createElement("span");
    value.className = "category-value";
    value.textContent = `${formatNumber(count)} · ${percentFormatter.format(ratio * 100)}%`;

    const bar = document.createElement("div");
    bar.className = "category-bar";
    bar.style.background = categoryPalette[category].tone;

    const fill = document.createElement("div");
    fill.className = "category-bar-fill";
    fill.style.width = `${Math.max(ratio * 100, count ? 8 : 0)}%`;
    fill.style.background = categoryPalette[category].color;

    heading.append(label, value);
    bar.append(fill);
    item.append(heading, bar);
    categoryList.append(item);
  }

  renderDerivedMetrics(summary);
}

function renderGraph(nodes: BackendGraphNode[], edges: BackendGraphEdge[]): void {
  if (graphSummary) {
    const maxDegree = nodes[0]?.degree ?? 0;
    graphSummary.textContent = `${formatNumber(nodes.length)} entities, ${formatNumber(edges.length)} edges, strongest node degree ${formatNumber(maxDegree)}`;
  }

  if (!topEntities) {
    return;
  }

  topEntities.replaceChildren();
  const rankedNodes = [...nodes].sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label)).slice(0, 6);
  const maxDegree = rankedNodes[0]?.degree ?? 0;

  if (!rankedNodes.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No entities yet. Sync a factual conversation to populate the graph.";
    topEntities.append(empty);
    return;
  }

  for (const node of rankedNodes) {
    const item = document.createElement("div");
    item.className = "entity-item";

    const heading = document.createElement("div");
    heading.className = "entity-heading";

    const label = document.createElement("span");
    label.className = "entity-name";
    label.textContent = node.label;

    const value = document.createElement("span");
    value.className = "entity-degree";
    value.textContent = `${formatNumber(node.degree)} links`;

    const bar = document.createElement("div");
    bar.className = "entity-bar";

    const fill = document.createElement("div");
    fill.className = "entity-bar-fill";
    fill.style.width = `${maxDegree ? Math.max((node.degree / maxDegree) * 100, 12) : 0}%`;

    heading.append(label, value);
    bar.append(fill);
    item.append(heading, bar);
    topEntities.append(item);
  }
}

function renderSystem(system?: BackendSystemStatus): void {
  if (systemSummary) {
    systemSummary.textContent = system
      ? `${system.product} ${system.version} · ${system.git_available ? "git available" : "git unavailable"}`
      : "Backend storage data unavailable";
  }
  if (systemVaultRoot) {
    systemVaultRoot.textContent = system?.vault_root ?? "Unavailable";
  }
  if (systemMarkdownRoot) {
    systemMarkdownRoot.textContent = system?.markdown_root ?? "Unavailable";
  }
  if (systemTodoPath) {
    systemTodoPath.textContent = system?.todo_list_path ?? "Unavailable";
  }
  if (systemAuthMode) {
    systemAuthMode.textContent = system?.auth_mode ?? "Unavailable";
  }
  if (systemGitStatus) {
    systemGitStatus.textContent = system
      ? system.git_versioning_enabled
        ? system.git_available
          ? "Enabled and available"
          : "Enabled in config, but git is unavailable"
        : "Disabled"
      : "Unavailable";
  }
  if (systemPublicUrl) {
    systemPublicUrl.textContent = system?.public_url ?? "Not configured";
  }
}

async function sendMessage<TResponse>(message: RuntimeMessage): Promise<TResponse> {
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
}

async function load(): Promise<void> {
  if (loadPromise) {
    loadQueued = true;
    return loadPromise;
  }

  loadPromise = (async () => {
    do {
      loadQueued = false;
      refreshDashboardButton?.setAttribute("disabled", "true");
      renderAlert(null);
      const previousBackendUrl = currentSettings?.backendUrl ?? null;

      const [settings, status] = await Promise.all([
        sendMessage<ExtensionSettings>({ type: "GET_SETTINGS" }),
        sendMessage<SyncStatus>({ type: "GET_STATUS" })
      ]);
      currentSettings = settings;
      currentStatus = status;
      const backendChanged = previousBackendUrl !== settings.backendUrl;

      if (backendChanged) {
        currentSummary = null;
        currentSystem = null;
        currentNodes = [];
        currentEdges = [];
        sessionListCache.clear();
        sessionDetailCache.clear();
        resetExplorerSelection();
      }

      renderHealth(settings, status, currentSummary ?? undefined, currentNodes, currentEdges);
      renderMetrics(currentSummary ?? undefined, currentNodes, currentEdges);
      renderCategoryMix(currentSummary ?? undefined);
      renderGraph(currentNodes, currentEdges);
      renderSystem(currentSystem ?? undefined);
      void syncExplorer();

      if (status.backendValidationError) {
        currentSummary = null;
        currentSystem = null;
        currentNodes = [];
        currentEdges = [];
        sessionListCache.clear();
        sessionDetailCache.clear();
        resetExplorerSelection();
        renderHealth(settings, status);
        renderMetrics();
        renderCategoryMix();
        renderGraph([], []);
        renderSystem();
        void syncExplorer();
        renderAlert(status.backendValidationError);
        continue;
      }

      try {
        const [summary, system, nodes, edges] = await Promise.all([
          fetchDashboardSummary(settings),
          fetchSystemStatus(settings),
          fetchGraphNodes(settings),
          fetchGraphEdges(settings)
        ]);
        currentSummary = summary;
        currentSystem = system;
        currentNodes = nodes;
        currentEdges = edges;
        renderHealth(settings, status, summary, nodes, edges);
        renderMetrics(summary, nodes, edges);
        renderCategoryMix(summary);
        renderGraph(nodes, edges);
        renderSystem(system);
        await syncExplorer();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        renderAlert(message);
      } finally {
        refreshDashboardButton?.removeAttribute("disabled");
      }
    } while (loadQueued);
  })();

  try {
    await loadPromise;
  } finally {
    loadPromise = null;
    refreshDashboardButton?.removeAttribute("disabled");
  }
}

refreshDashboardButton?.addEventListener("click", () => {
  void load();
});

openOptionsButton?.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

attachClickable(metricCardSessions, () => {
  resetExplorerSelection();
  applyRouteState({ view: "notes", category: null, focus: null });
});

attachClickable(metricCardMessages, () => {
  resetExplorerSelection();
  applyRouteState({ view: "notes", category: null, focus: null });
});

attachClickable(metricCardTriplets, () => {
  resetExplorerSelection();
  applyRouteState({ view: "notes", category: "factual", focus: "triplets" });
});

explorerClearButton?.addEventListener("click", () => {
  resetExplorerSelection();
  applyRouteState({ view: "overview", category: null, focus: null });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" && areaName !== "sync") {
    return;
  }

  if (changes["savemycontext.status"]?.newValue && currentSettings) {
    currentStatus = changes["savemycontext.status"].newValue as SyncStatus;
    renderHealth(currentSettings, currentStatus, currentSummary ?? undefined, currentNodes, currentEdges);
    void syncExplorer();
  }

  if (changes["savemycontext.settings"] || changes["savemycontext.settings.cache"] || changes["savemycontext.settings.secrets"]) {
    void load();
  }
});

window.addEventListener("popstate", () => {
  currentRouteState = readRouteState();
  resetExplorerSelection();
  renderCategoryMix(currentSummary ?? undefined);
  void syncExplorer();
});

void load();
