import type {
  BackendCapabilities,
  BackendDashboardSummary,
  BackendGraphEdge,
  BackendGraphNode,
  BackendProcessingStatus,
  BackendSearchResponse,
  BackendSessionListItem,
  BackendSessionRead,
  BackendStorageSettings,
  BackendSystemStatus,
  ExtensionSettings,
  ProcessingCompleteResponse,
  ProcessingTaskResponse,
  ProviderName,
  SourceCapturePayload,
  SourceCaptureResponse
} from "../shared/types";

const REQUIRED_EXTENSION_SCOPES = ["ingest", "read"] as const;

function normalizeBackendUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/$/, "");
}

export function isLocalBackendUrl(candidate: URL): boolean {
  return candidate.hostname === "127.0.0.1" || candidate.hostname === "localhost" || candidate.hostname === "[::1]";
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return 0;
}

function authorizationHeader(token?: string): Record<string, string> {
  if (!token) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

function hasScope(scopes: string[], requiredScope: (typeof REQUIRED_EXTENSION_SCOPES)[number]): boolean {
  return scopes.includes("*") || scopes.includes(requiredScope);
}

function apiPrefix(capabilities?: BackendCapabilities): string {
  return capabilities?.api_prefix ?? "/api/v1";
}

function backendApiUrl(settings: ExtensionSettings, path: string, capabilities?: BackendCapabilities): string {
  return `${normalizeBackendUrl(settings.backendUrl)}${apiPrefix(capabilities)}${path}`;
}

async function fetchBackendJson<TResponse>(
  settings: ExtensionSettings,
  path: string,
  capabilities?: BackendCapabilities
): Promise<TResponse> {
  const response = await fetch(backendApiUrl(settings, path, capabilities), {
    headers: authorizationHeader(settings.backendToken)
  });
  if (!response.ok) {
    throw new Error(`Backend request failed with ${response.status}.`);
  }
  return (await response.json()) as TResponse;
}

export function buildBackendHeaders(settings: ExtensionSettings): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...authorizationHeader(settings.backendToken)
  };
}

export async function validateBackendConfiguration(settings: ExtensionSettings): Promise<{
  normalizedUrl: string;
  capabilities: BackendCapabilities;
}> {
  const normalizedUrl = normalizeBackendUrl(settings.backendUrl);
  const parsedUrl = new URL(normalizedUrl);
  const isLocal = isLocalBackendUrl(parsedUrl);
  if (!isLocal && parsedUrl.protocol !== "https:") {
    throw new Error("Remote backends must use https://.");
  }

  const capabilityResponse = await fetch(`${normalizedUrl}/api/v1/meta/capabilities`, {
    headers: authorizationHeader(settings.backendToken)
  });
  if (!capabilityResponse.ok) {
    throw new Error(`Compatibility check failed with ${capabilityResponse.status}.`);
  }

  const capabilities = (await capabilityResponse.json()) as BackendCapabilities;
  if (capabilities.product !== "savemycontext") {
    throw new Error("The configured backend is not a SaveMyContext server.");
  }

  const extensionVersion = chrome.runtime.getManifest().version;
  if (compareVersions(extensionVersion, capabilities.extension.min_version) < 0) {
    throw new Error(
      `This extension is too old for the backend. Minimum required version: ${capabilities.extension.min_version}.`
    );
  }

  if (!isLocal && capabilities.auth.mode !== "app_token") {
    throw new Error("Remote SaveMyContext backends must be provisioned with an app token first.");
  }

  if (capabilities.auth.mode === "app_token" && !settings.backendToken) {
    throw new Error("A backend app token with ingest and read scopes is required.");
  }

  if (settings.backendToken) {
    const verifyResponse = await fetch(`${normalizedUrl}${capabilities.auth.token_verify_path}`, {
      headers: authorizationHeader(settings.backendToken)
    });
    if (!verifyResponse.ok) {
      throw new Error("The backend token is invalid or missing required access.");
    }
    const verification = (await verifyResponse.json()) as { valid?: boolean; scopes?: string[] };
    if (!verification.valid) {
      throw new Error("The backend token is invalid.");
    }
    const scopes = Array.isArray(verification.scopes) ? verification.scopes : [];
    const missingScopes = REQUIRED_EXTENSION_SCOPES.filter((scope) => !hasScope(scopes, scope));
    if (missingScopes.length) {
      throw new Error(`The backend token is missing required scopes: ${missingScopes.join(", ")}.`);
    }
  }

  return {
    normalizedUrl,
    capabilities
  };
}

export async function fetchProcessingStatus(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendProcessingStatus> {
  const statusResponse = await fetch(backendApiUrl(settings, "/processing/status", capabilities), {
    headers: authorizationHeader(settings.backendToken)
  });
  if (!statusResponse.ok) {
    throw new Error(`Processing status check failed with ${statusResponse.status}.`);
  }
  return (await statusResponse.json()) as BackendProcessingStatus;
}

export async function fetchNextProcessingTask(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<ProcessingTaskResponse> {
  const response = await fetch(backendApiUrl(settings, "/processing/next", capabilities), {
    method: "POST",
    headers: authorizationHeader(settings.backendToken)
  });
  if (!response.ok) {
    throw new Error(`Processing task request failed with ${response.status}.`);
  }
  return (await response.json()) as ProcessingTaskResponse;
}

export async function completeProcessingTask(
  settings: ExtensionSettings,
  payload: {
    sessionIds: string[];
    responseText: string;
  },
  capabilities?: BackendCapabilities
): Promise<ProcessingCompleteResponse> {
  const response = await fetch(backendApiUrl(settings, "/processing/complete", capabilities), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authorizationHeader(settings.backendToken)
    },
    body: JSON.stringify({
      session_ids: payload.sessionIds,
      response_text: payload.responseText
    })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Processing completion failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return (await response.json()) as ProcessingCompleteResponse;
}

export async function fetchDashboardSummary(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendDashboardSummary> {
  return fetchBackendJson<BackendDashboardSummary>(settings, "/dashboard/summary", capabilities);
}

export async function fetchSystemStatus(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendSystemStatus> {
  return fetchBackendJson<BackendSystemStatus>(settings, "/system/status", capabilities);
}

export async function fetchGraphNodes(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendGraphNode[]> {
  return fetchBackendJson<BackendGraphNode[]>(settings, "/graph/nodes", capabilities);
}

export async function fetchGraphEdges(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendGraphEdge[]> {
  return fetchBackendJson<BackendGraphEdge[]>(settings, "/graph/edges", capabilities);
}

export async function fetchSessions(
  settings: ExtensionSettings,
  filters?: {
    provider?: ProviderName;
    category?: string;
  },
  capabilities?: BackendCapabilities
): Promise<BackendSessionListItem[]> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  if (filters?.category) {
    search.set("category", filters.category);
  }
  const query = search.toString();
  return fetchBackendJson<BackendSessionListItem[]>(settings, `/sessions${query ? `?${query}` : ""}`, capabilities);
}

export async function fetchSession(
  settings: ExtensionSettings,
  sessionId: string,
  capabilities?: BackendCapabilities
): Promise<BackendSessionRead> {
  return fetchBackendJson<BackendSessionRead>(settings, `/sessions/${encodeURIComponent(sessionId)}`, capabilities);
}

export async function fetchKnowledgeSearch(
  settings: ExtensionSettings,
  query: string,
  limit = 8,
  capabilities?: BackendCapabilities
): Promise<BackendSearchResponse> {
  const search = new URLSearchParams({
    q: query.trim(),
    limit: String(limit)
  });
  return fetchBackendJson<BackendSearchResponse>(settings, `/search?${search.toString()}`, capabilities);
}

export async function updateKnowledgeStoragePath(
  settings: ExtensionSettings,
  markdownRoot: string,
  capabilities?: BackendCapabilities
): Promise<BackendStorageSettings> {
  const response = await fetch(backendApiUrl(settings, "/system/storage", capabilities), {
    method: "POST",
    headers: buildBackendHeaders(settings),
    body: JSON.stringify({
      markdown_root: markdownRoot.trim()
    })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Knowledge path update failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return (await response.json()) as BackendStorageSettings;
}

export async function saveSourceCaptureToBackend(
  settings: ExtensionSettings,
  payload: SourceCapturePayload,
  capabilities?: BackendCapabilities
): Promise<SourceCaptureResponse> {
  const response = await fetch(backendApiUrl(settings, "/capture/source", capabilities), {
    method: "POST",
    headers: buildBackendHeaders(settings),
    body: JSON.stringify({
      capture_kind: payload.captureKind,
      save_mode: payload.saveMode,
      title: payload.title,
      page_title: payload.pageTitle,
      source_url: payload.sourceUrl,
      selection_text: payload.selectionText,
      source_text: payload.sourceText,
      source_markdown: payload.sourceMarkdown,
      raw_payload: payload.rawPayload
    })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Source capture failed with ${response.status}: ${details.slice(0, 300)}`);
  }

  const saved = (await response.json()) as {
    source_id: string;
    title: string;
    capture_kind: "selection" | "page";
    save_mode: "raw" | "ai";
    processed: boolean;
    category?: "journal" | "factual" | "ideas" | "todo" | null;
    markdown_path?: string | null;
    raw_source_path?: string | null;
  };
  return {
    ok: true,
    sourceId: saved.source_id,
    title: saved.title,
    captureKind: saved.capture_kind,
    saveMode: saved.save_mode,
    processed: saved.processed,
    category: saved.category ?? null,
    markdownPath: saved.markdown_path ?? null,
    rawSourcePath: saved.raw_source_path ?? null
  };
}
