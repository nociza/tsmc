import "./styles.css";

import {
  fetchDashboardSummary,
  fetchGraphEdges,
  fetchGraphNodes,
  fetchSystemStatus
} from "../background/backend";
import type {
  BackendDashboardSummary,
  BackendGraphEdge,
  BackendGraphNode,
  BackendSystemStatus,
  ExtensionSettings,
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
let loadPromise: Promise<void> | null = null;
let loadQueued = false;

function formatNumber(value: number | undefined | null): string {
  return numberFormatter.format(value ?? 0);
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
    return `${status.backendProduct ?? "tsmc-server"} ${status.backendVersion} (${status.backendAuthMode ?? "unknown"})`;
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

    const item = document.createElement("div");
    item.className = "category-item";

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

      const [settings, status] = await Promise.all([
        sendMessage<ExtensionSettings>({ type: "GET_SETTINGS" }),
        sendMessage<SyncStatus>({ type: "GET_STATUS" })
      ]);
      currentSettings = settings;
      currentStatus = status;
      renderHealth(settings, status);
      renderMetrics();
      renderCategoryMix();
      renderGraph([], []);
      renderSystem();

      if (status.backendValidationError) {
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
        renderHealth(settings, status, summary, nodes, edges);
        renderMetrics(summary, nodes, edges);
        renderCategoryMix(summary);
        renderGraph(nodes, edges);
        renderSystem(system);
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" && areaName !== "sync") {
    return;
  }

  if (changes["tsmc.status"]?.newValue && currentSettings) {
    currentStatus = changes["tsmc.status"].newValue as SyncStatus;
    renderHealth(currentSettings, currentStatus);
  }

  if (changes["tsmc.settings"] || changes["tsmc.settings.cache"] || changes["tsmc.settings.secrets"]) {
    void load();
  }
});

void load();
