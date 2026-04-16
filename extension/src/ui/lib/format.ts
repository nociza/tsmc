import { titleFromSession } from "../../shared/explorer";
import type {
  BackendDashboardSummary,
  ExtensionSettings,
  ProviderDriftAlert,
  ProviderName,
  SyncStatus
} from "../../shared/types";

const numberFormatter = new Intl.NumberFormat();
const percentFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compactDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
});

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export const providerLabels: Record<ProviderName, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  grok: "Grok"
};

export function formatNumber(value?: number | null): string {
  return numberFormatter.format(value ?? 0);
}

export function formatPercent(value: number): string {
  return percentFormatter.format(value);
}

export function formatCompactDate(value?: string | null, fallback = "No data"): string {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return compactDateFormatter.format(date);
}

export function formatLongDate(value?: string | null, fallback = "No data"): string {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function formatBackendLabel(settings: ExtensionSettings): string {
  try {
    const parsed = new URL(settings.backendUrl);
    const location =
      parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]"
        ? "Local"
        : "Remote";
    return `${location} · ${parsed.host}`;
  } catch {
    return settings.backendUrl;
  }
}

export function formatBackendStatus(status: SyncStatus): string {
  if (status.backendValidationError) {
    return status.backendValidationError;
  }

  if (status.backendValidatedAt && status.backendVersion) {
    const authMode =
      status.backendAuthMode === "bootstrap_local"
        ? "local"
        : status.backendAuthMode === "app_token"
          ? "token"
          : status.backendAuthMode ?? "auth";
    return `v${status.backendVersion} · ${authMode}`;
  }

  return "Checking connection";
}

export function formatHistorySync(settings: ExtensionSettings, status: SyncStatus): string {
  if (!settings.autoSyncHistory) {
    return "Auto history sync is off.";
  }

  if (status.historySyncInProgress) {
    const provider = status.historySyncProvider ? `${providerLabels[status.historySyncProvider]} ` : "";
    const progress =
      typeof status.historySyncTotalCount === "number"
        ? `${status.historySyncProcessedCount ?? 0}/${status.historySyncTotalCount}`
        : "";
    const skipped =
      typeof status.historySyncSkippedCount === "number" && status.historySyncSkippedCount > 0
        ? ` · ${status.historySyncSkippedCount} skipped`
        : "";
    return `Running ${provider}${progress}${skipped}`.trim();
  }

  if (status.historySyncLastCompletedAt) {
    const count =
      typeof status.historySyncLastConversationCount === "number"
        ? ` · ${status.historySyncLastConversationCount} conversations`
        : "";
    return `${status.historySyncLastResult ?? "success"} · ${formatCompactDate(status.historySyncLastCompletedAt)}${count}`;
  }

  return "Waiting for the next provider visit.";
}

export function formatProcessing(status: SyncStatus): string {
  if (status.processingInProgress) {
    const provider = status.processingProvider ? providerLabels[status.processingProvider] : "provider";
    const processed =
      typeof status.processingProcessedCount === "number" ? ` · ${status.processingProcessedCount} done` : "";
    return `Running ${provider}${processed}`;
  }

  if (status.processingLastError) {
    return `Failed: ${status.processingLastError}`;
  }

  if (status.processingMode === "immediate") {
    return status.processingWorkerModel ? `Immediate · ${status.processingWorkerModel}` : "Immediate processing";
  }

  if (status.processingMode === "disabled") {
    return "Browser automation is disabled.";
  }

  if (status.processingWorkerModel) {
    return `Manual · ${status.processingWorkerModel}`;
  }

  return "No AI worker configured.";
}

export function formatProcessingMode(status: SyncStatus): string {
  if (status.processingMode === "immediate") {
    return status.processingWorkerModel ? `Server · ${status.processingWorkerModel}` : "Server-side";
  }
  if (status.processingMode === "extension_browser") {
    return status.processingWorkerModel ? `Browser · ${status.processingWorkerModel}` : "Browser worker";
  }
  if (status.processingMode === "disabled") {
    return "Disabled";
  }
  return "Unavailable";
}

export function formatProviderDriftAlert(alert?: ProviderDriftAlert | null): string {
  if (!alert) {
    return "None";
  }
  const evidence = alert.evidence ? ` · ${alert.evidence}` : "";
  return `${providerLabels[alert.provider] ?? alert.provider}: ${alert.message} · ${formatCompactDate(alert.detectedAt)}${evidence}`;
}

export function nextActionText(
  settings: ExtensionSettings,
  status: SyncStatus,
  summary: BackendDashboardSummary | null
): string {
  if (status.backendValidationError) {
    return "Fix the backend connection in Settings.";
  }
  if (status.historySyncInProgress) {
    return "History sync is running now.";
  }
  if (status.processingInProgress) {
    return "AI processing is running now.";
  }
  if ((status.processingPendingCount ?? 0) > 0 && status.processingMode === "extension_browser") {
    return `Run ${status.processingPendingCount} queued AI job${status.processingPendingCount === 1 ? "" : "s"}.`;
  }
  if (!status.lastSuccessAt && settings.autoSyncHistory) {
    return "Open a supported provider tab to start capturing context.";
  }
  if ((summary?.total_sessions ?? 0) > 0) {
    return "Open a collection to inspect saved context.";
  }
  return "Save the current page or visit a provider conversation.";
}

export function formatIndexingStatus(status: SyncStatus): string {
  if (!status.lastSessionKey) {
    return "No captures yet";
  }

  const decision =
    status.lastIndexingDecision === "skipped"
      ? "Skipped"
      : status.lastIndexingDecision === "indexed"
        ? "Indexed"
        : "Captured";
  const extras = [decision];

  if (typeof status.lastSyncedMessageCount === "number" && status.lastSyncedMessageCount > 0) {
    extras.push(`${status.lastSyncedMessageCount} msgs`);
  }

  return extras.join(" · ");
}

export function connectionTone(status: SyncStatus): {
  label: string;
  tone: StatusTone;
} {
  if (status.backendValidationError) {
    return { label: "Needs attention", tone: "danger" };
  }
  if (status.historySyncInProgress || status.processingInProgress) {
    return { label: "Active", tone: "warning" };
  }
  if (status.backendValidatedAt && status.backendVersion) {
    return { label: "Connected", tone: "success" };
  }
  return { label: "Checking", tone: "neutral" };
}

export function historyTone(settings: ExtensionSettings, status: SyncStatus): {
  label: string;
  tone: StatusTone;
} {
  if (!settings.autoSyncHistory) {
    return { label: "Off", tone: "neutral" };
  }
  if (status.historySyncInProgress) {
    return { label: "Running", tone: "warning" };
  }
  if (status.historySyncLastResult === "failed" || status.historySyncLastResult === "unsupported") {
    return { label: "Alert", tone: "danger" };
  }
  if (status.historySyncLastCompletedAt) {
    return { label: "Ready", tone: "success" };
  }
  return { label: "Listening", tone: "info" };
}

export function processingTone(status: SyncStatus): {
  label: string;
  tone: StatusTone;
} {
  if (status.processingInProgress) {
    return { label: "Running", tone: "warning" };
  }
  if (status.processingLastError) {
    return { label: "Alert", tone: "danger" };
  }
  if (status.processingMode === "disabled") {
    return { label: "Off", tone: "neutral" };
  }
  if ((status.processingPendingCount ?? 0) > 0) {
    return { label: `${status.processingPendingCount} queued`, tone: "info" };
  }
  if (status.processingMode === "immediate" || status.processingMode === "extension_browser") {
    return { label: "Ready", tone: "success" };
  }
  return { label: "Unavailable", tone: "neutral" };
}

export function enabledProviderLabels(settings: ExtensionSettings): string[] {
  return (Object.keys(settings.enabledProviders) as ProviderName[])
    .filter((provider) => settings.enabledProviders[provider])
    .map((provider) => providerLabels[provider]);
}

export function processingButtonState(status: SyncStatus): {
  disabled: boolean;
  label: string;
  title: string;
} {
  if (status.processingInProgress) {
    return {
      disabled: true,
      label: "Running",
      title: "AI processing is already running."
    };
  }

  if (status.backendValidationError) {
    return {
      disabled: true,
      label: "Run queue",
      title: status.backendValidationError
    };
  }

  if (status.processingMode === "immediate") {
    return {
      disabled: true,
      label: "Run queue",
      title: "This backend uses immediate server-side processing."
    };
  }

  if (status.processingMode === "disabled") {
    return {
      disabled: true,
      label: "Run queue",
      title: "Browser automation is disabled."
    };
  }

  if (!status.processingPendingCount) {
    return {
      disabled: true,
      label: "Run queue",
      title: "There are no pending AI jobs right now."
    };
  }

  return {
    disabled: false,
    label: "Run queue",
    title: "Use your current signed-in provider tab to process queued SaveMyContext jobs."
  };
}

export function sessionPreviewTitle<TSession extends { title?: string | null; provider: ProviderName; external_session_id: string }>(
  session: TSession
): string {
  return titleFromSession(session);
}
