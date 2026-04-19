import type {
  BackendCapabilities,
  BackendCategoryGraph,
  BackendCategoryGraphPath,
  BackendCategoryStats,
  ConnectionRedeemResponse,
  BackendDashboardSummary,
  BackendDiscardedSessionsResponse,
  BackendExplorerGraphEdge,
  BackendExplorerGraphNode,
  BackendGraphEdge,
  BackendGraphNode,
  BackendPileRead,
  BackendPromptTemplateRead,
  BackendProcessingStatus,
  BackendSearchResponse,
  BackendSessionListItem,
  BackendSessionNoteRead,
  BackendSessionRead,
  BackendStorageSettings,
  BackendSystemStatus,
  BackendTodoListRead,
  BackendTodoListUpdate,
  ParsedConnectionBundle,
  BackendUserCategorySummary,
  ExtensionSettings,
  ProcessingCompleteResponse,
  ProcessingTaskResponse,
  ProviderName,
  SessionCategoryName,
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

export async function redeemConnectionBundle(
  bundle: ParsedConnectionBundle,
  payload: {
    installationId: string;
    clientName?: string;
    verificationCode?: string;
  }
): Promise<ConnectionRedeemResponse> {
  const response = await fetch(`${bundle.baseUrl}/api/v1/auth/connections/redeem`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      grant_id: bundle.grantId,
      secret: bundle.secret,
      installation_id: payload.installationId,
      client_name: payload.clientName,
      verification_code: payload.verificationCode?.trim() || undefined
    })
  });
  if (!response.ok) {
    let detail = `Connection enrollment failed with ${response.status}.`;
    try {
      const payload = (await response.json()) as { detail?: string };
      if (payload.detail) {
        detail = payload.detail;
      }
    } catch {
      // ignore non-json failures and keep the status-based message
    }
    throw new Error(detail);
  }
  return (await response.json()) as ConnectionRedeemResponse;
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

export async function fetchTodoList(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendTodoListRead> {
  return fetchBackendJson<BackendTodoListRead>(settings, "/todo", capabilities);
}

export async function updateTodoList(
  settings: ExtensionSettings,
  payload: BackendTodoListUpdate,
  capabilities?: BackendCapabilities
): Promise<BackendTodoListRead> {
  const response = await fetch(backendApiUrl(settings, "/todo", capabilities), {
    method: "PUT",
    headers: buildBackendHeaders(settings),
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Shared to-do update failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return (await response.json()) as BackendTodoListRead;
}

export async function fetchPiles(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendPileRead[]> {
  return fetchBackendJson<BackendPileRead[]>(settings, "/piles", capabilities);
}

export async function fetchPromptTemplates(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendPromptTemplateRead[]> {
  return fetchBackendJson<BackendPromptTemplateRead[]>(settings, "/prompts/templates", capabilities);
}

export interface PileCreatePayload {
  slug: string;
  name: string;
  description?: string;
  folder_label?: string;
  attributes: string[];
  pipeline_config?: Record<string, unknown>;
  sort_order?: number;
}

export interface PileUpdatePayload {
  name?: string;
  description?: string;
  folder_label?: string;
  attributes?: string[];
  pipeline_config?: Record<string, unknown>;
  is_active?: boolean;
  sort_order?: number;
}

export interface PromptTemplateUpdatePayload {
  system_prompt: string;
  user_prompt: string;
}

export async function createPile(
  settings: ExtensionSettings,
  payload: PileCreatePayload,
  capabilities?: BackendCapabilities
): Promise<BackendPileRead> {
  const response = await fetch(backendApiUrl(settings, "/piles", capabilities), {
    method: "POST",
    headers: buildBackendHeaders(settings),
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Pile create failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return (await response.json()) as BackendPileRead;
}

export async function updatePile(
  settings: ExtensionSettings,
  slug: string,
  payload: PileUpdatePayload,
  capabilities?: BackendCapabilities
): Promise<BackendPileRead> {
  const response = await fetch(
    backendApiUrl(settings, `/piles/${encodeURIComponent(slug)}`, capabilities),
    {
      method: "PATCH",
      headers: buildBackendHeaders(settings),
      body: JSON.stringify(payload)
    }
  );
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Pile update failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return (await response.json()) as BackendPileRead;
}

export async function deletePile(
  settings: ExtensionSettings,
  slug: string,
  capabilities?: BackendCapabilities
): Promise<void> {
  const response = await fetch(
    backendApiUrl(settings, `/piles/${encodeURIComponent(slug)}`, capabilities),
    {
      method: "DELETE",
      headers: buildBackendHeaders(settings)
    }
  );
  if (!response.ok && response.status !== 204) {
    const details = await response.text();
    throw new Error(`Pile delete failed with ${response.status}: ${details.slice(0, 300)}`);
  }
}

export async function updatePromptTemplate(
  settings: ExtensionSettings,
  key: string,
  payload: PromptTemplateUpdatePayload,
  capabilities?: BackendCapabilities
): Promise<BackendPromptTemplateRead> {
  const response = await fetch(
    backendApiUrl(settings, `/prompts/templates/${encodeURIComponent(key)}`, capabilities),
    {
      method: "PUT",
      headers: buildBackendHeaders(settings),
      body: JSON.stringify(payload)
    }
  );
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Prompt update failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return (await response.json()) as BackendPromptTemplateRead;
}

export async function resetPromptTemplate(
  settings: ExtensionSettings,
  key: string,
  capabilities?: BackendCapabilities
): Promise<void> {
  const response = await fetch(
    backendApiUrl(settings, `/prompts/templates/${encodeURIComponent(key)}`, capabilities),
    {
      method: "DELETE",
      headers: buildBackendHeaders(settings)
    }
  );
  if (!response.ok && response.status !== 204) {
    const details = await response.text();
    throw new Error(`Prompt reset failed with ${response.status}: ${details.slice(0, 300)}`);
  }
}

export async function fetchDiscardedSessions(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendDiscardedSessionsResponse> {
  return fetchBackendJson<BackendDiscardedSessionsResponse>(
    settings,
    "/piles/discarded/sessions",
    capabilities
  );
}

export async function recoverDiscardedSession(
  settings: ExtensionSettings,
  sessionId: string,
  capabilities?: BackendCapabilities
): Promise<BackendSessionRead> {
  const response = await fetch(
    backendApiUrl(
      settings,
      `/piles/discarded/sessions/${encodeURIComponent(sessionId)}/recover`,
      capabilities
    ),
    {
      method: "POST",
      headers: buildBackendHeaders(settings)
    }
  );
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Recover discarded session failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return (await response.json()) as BackendSessionRead;
}

export async function discardSession(
  settings: ExtensionSettings,
  sessionId: string,
  reason?: string,
  capabilities?: BackendCapabilities
): Promise<BackendSessionRead> {
  const url = backendApiUrl(
    settings,
    `/piles/discarded/sessions/${encodeURIComponent(sessionId)}/discard${
      reason ? `?reason=${encodeURIComponent(reason)}` : ""
    }`,
    capabilities
  );
  const response = await fetch(url, {
    method: "POST",
    headers: buildBackendHeaders(settings)
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Manual discard failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return (await response.json()) as BackendSessionRead;
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
    userCategory?: string;
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
  if (filters?.userCategory) {
    search.set("user_category", filters.userCategory);
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

export async function fetchSessionNote(
  settings: ExtensionSettings,
  sessionId: string,
  capabilities?: BackendCapabilities
): Promise<BackendSessionNoteRead> {
  return fetchBackendJson<BackendSessionNoteRead>(settings, `/notes/${encodeURIComponent(sessionId)}`, capabilities);
}

export async function fetchCategoryStats(
  settings: ExtensionSettings,
  category: SessionCategoryName,
  filters?: {
    provider?: ProviderName;
    sessionIds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendCategoryStats> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  for (const sessionId of filters?.sessionIds ?? []) {
    search.append("session_id", sessionId);
  }
  const query = search.toString();
  return fetchBackendJson<BackendCategoryStats>(
    settings,
    `/categories/${encodeURIComponent(category)}/stats${query ? `?${query}` : ""}`,
    capabilities
  );
}

export async function fetchCustomCategoryStats(
  settings: ExtensionSettings,
  name: string,
  filters?: {
    provider?: ProviderName;
    sessionIds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendCategoryStats> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  for (const sessionId of filters?.sessionIds ?? []) {
    search.append("session_id", sessionId);
  }
  const query = search.toString();
  return fetchBackendJson<BackendCategoryStats>(
    settings,
    `/custom-categories/${encodeURIComponent(name)}/stats${query ? `?${query}` : ""}`,
    capabilities
  );
}

export async function fetchCategoryGraph(
  settings: ExtensionSettings,
  category: SessionCategoryName,
  filters?: {
    provider?: ProviderName;
    sessionIds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendCategoryGraph> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  for (const sessionId of filters?.sessionIds ?? []) {
    search.append("session_id", sessionId);
  }
  const query = search.toString();
  return fetchBackendJson<BackendCategoryGraph>(
    settings,
    `/categories/${encodeURIComponent(category)}/graph${query ? `?${query}` : ""}`,
    capabilities
  );
}

export async function fetchCustomCategoryGraph(
  settings: ExtensionSettings,
  name: string,
  filters?: {
    provider?: ProviderName;
    sessionIds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendCategoryGraph> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  for (const sessionId of filters?.sessionIds ?? []) {
    search.append("session_id", sessionId);
  }
  const query = search.toString();
  return fetchBackendJson<BackendCategoryGraph>(
    settings,
    `/custom-categories/${encodeURIComponent(name)}/graph${query ? `?${query}` : ""}`,
    capabilities
  );
}

export async function fetchCategoryGraphPath(
  settings: ExtensionSettings,
  category: SessionCategoryName,
  source: string,
  target: string,
  filters?: {
    provider?: ProviderName;
    sessionIds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendCategoryGraphPath> {
  const search = new URLSearchParams({ source, target });
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  for (const sessionId of filters?.sessionIds ?? []) {
    search.append("session_id", sessionId);
  }
  return fetchBackendJson<BackendCategoryGraphPath>(
    settings,
    `/categories/${encodeURIComponent(category)}/graph/path?${search.toString()}`,
    capabilities
  );
}

export async function fetchCustomCategoryGraphPath(
  settings: ExtensionSettings,
  name: string,
  source: string,
  target: string,
  filters?: {
    provider?: ProviderName;
    sessionIds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendCategoryGraphPath> {
  const search = new URLSearchParams({ source, target });
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  for (const sessionId of filters?.sessionIds ?? []) {
    search.append("session_id", sessionId);
  }
  return fetchBackendJson<BackendCategoryGraphPath>(
    settings,
    `/custom-categories/${encodeURIComponent(name)}/graph/path?${search.toString()}`,
    capabilities
  );
}

export async function fetchExplorerSearch(
  settings: ExtensionSettings,
  query: string,
  options?: {
    limit?: number;
    category?: SessionCategoryName;
    provider?: ProviderName;
    userCategory?: string;
    kinds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendSearchResponse> {
  const search = new URLSearchParams({
    q: query.trim(),
    limit: String(options?.limit ?? 25)
  });
  if (options?.category) {
    search.set("category", options.category);
  }
  if (options?.provider) {
    search.set("provider", options.provider);
  }
  if (options?.userCategory) {
    search.set("user_category", options.userCategory);
  }
  for (const kind of options?.kinds ?? []) {
    search.append("kind", kind);
  }
  return fetchBackendJson<BackendSearchResponse>(settings, `/search?${search.toString()}`, capabilities);
}

export async function fetchUserCategories(
  settings: ExtensionSettings,
  filters?: {
    provider?: ProviderName;
    category?: SessionCategoryName;
  },
  capabilities?: BackendCapabilities
): Promise<BackendUserCategorySummary[]> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  if (filters?.category) {
    search.set("category", filters.category);
  }
  const query = search.toString();
  return fetchBackendJson<BackendUserCategorySummary[]>(
    settings,
    `/user-categories${query ? `?${query}` : ""}`,
    capabilities
  );
}

export async function updateSessionUserCategories(
  settings: ExtensionSettings,
  sessionId: string,
  userCategories: string[],
  capabilities?: BackendCapabilities
): Promise<BackendSessionListItem> {
  const response = await fetch(backendApiUrl(settings, `/sessions/${encodeURIComponent(sessionId)}/user-categories`, capabilities), {
    method: "PUT",
    headers: buildBackendHeaders(settings),
    body: JSON.stringify({
      user_categories: userCategories
    })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Session categories update failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return (await response.json()) as BackendSessionListItem;
}

export async function fetchKnowledgeSearch(
  settings: ExtensionSettings,
  query: string,
  limit = 8,
  options?: {
    provider?: ProviderName;
    kinds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendSearchResponse> {
  const search = new URLSearchParams({
    q: query.trim(),
    limit: String(limit)
  });
  if (options?.provider) {
    search.set("provider", options.provider);
  }
  for (const kind of options?.kinds ?? []) {
    search.append("kind", kind);
  }
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
