export type ProviderName = "chatgpt" | "gemini" | "grok";
export type MessageRole = "user" | "assistant" | "system" | "tool" | "unknown";
export type CaptureMode = "incremental" | "full_snapshot";

export interface CapturedBody {
  text?: string;
  json?: unknown;
}

export interface CapturedNetworkEvent {
  source: "tsmc-network-observer";
  providerHint?: ProviderName;
  captureMode?: CaptureMode;
  historySyncRunId?: string;
  pageUrl: string;
  requestId: string;
  method: string;
  url: string;
  capturedAt: string;
  requestBody?: CapturedBody;
  response: {
    status: number;
    ok: boolean;
    contentType?: string;
    text: string;
    json?: unknown;
  };
}

export interface NormalizedMessage {
  id: string;
  parentId?: string;
  role: MessageRole;
  content: string;
  occurredAt?: string;
  raw?: unknown;
}

export interface NormalizedSessionSnapshot {
  provider: ProviderName;
  externalSessionId: string;
  title?: string;
  sourceUrl: string;
  capturedAt: string;
  messages: NormalizedMessage[];
}

export interface SessionSyncState {
  seenMessageIds: string[];
  lastSyncedAt?: string;
}

export interface ProviderDriftAlert {
  provider: ProviderName;
  detectedAt: string;
  pageUrl: string;
  message: string;
  evidence?: string;
}

export interface ProviderHistorySyncState {
  inProgress?: boolean;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastTopSessionId?: string;
  lastTopSessionIds?: string[];
  lastConversationCount?: number;
  lastPageUrl?: string;
  processedCount?: number;
  totalCount?: number;
  skippedCount?: number;
  lastDriftAlert?: ProviderDriftAlert | null;
}

export interface ExtensionSettings {
  backendUrl: string;
  backendToken?: string;
  enabledProviders: Record<ProviderName, boolean>;
  autoSyncHistory: boolean;
}

export interface BackendCapabilities {
  product: string;
  version: string;
  api_prefix: string;
  server_time: string;
  auth: {
    mode: "bootstrap_local" | "app_token";
    token_verify_path: string;
    local_unauthenticated_access: boolean;
    remote_requires_token: boolean;
  };
  extension: {
    min_version: string;
    auth_mode: "bootstrap_local" | "app_token";
  };
  features: {
    ingest: boolean;
    search: boolean;
    graph: boolean;
    obsidian_vault: boolean;
    knowledge_graph_files: boolean;
    agent_api: boolean;
  };
  storage: {
    markdown_root: string;
    vault_root: string;
    public_url?: string | null;
  };
}

export interface SyncStatus {
  lastSuccessAt?: string;
  lastError?: string | null;
  lastProvider?: ProviderName;
  lastSessionKey?: string;
  lastSyncedMessageCount?: number;
  backendUrl?: string;
  autoSyncHistory?: boolean;
  historySyncInProgress?: boolean;
  historySyncProvider?: ProviderName;
  historySyncLastStartedAt?: string;
  historySyncLastCompletedAt?: string;
  historySyncLastConversationCount?: number;
  historySyncLastPageUrl?: string;
  historySyncLastResult?: "success" | "failed" | "unsupported";
  historySyncLastError?: string | null;
  historySyncProcessedCount?: number;
  historySyncTotalCount?: number;
  historySyncSkippedCount?: number;
  providerDriftAlert?: ProviderDriftAlert | null;
  backendValidatedAt?: string;
  backendProduct?: string;
  backendVersion?: string;
  backendAuthMode?: "bootstrap_local" | "app_token";
  backendValidationError?: string | null;
  backendVaultRoot?: string;
}

export interface PageVisitPayload {
  provider: ProviderName;
  pageUrl: string;
}

export interface HistorySyncTriggerPayload {
  provider: ProviderName;
  syncedSessionIds?: string[];
  previousTopSessionId?: string;
  previousTopSessionIds?: string[];
  refreshSessionIds?: string[];
}

export interface HistorySyncUpdate {
  provider: ProviderName;
  phase: "started" | "completed" | "failed" | "unsupported";
  runId?: string;
  conversationCount?: number;
  processedCount?: number;
  totalCount?: number;
  skippedCount?: number;
  topSessionId?: string;
  topSessionIds?: string[];
  pageUrl: string;
  message?: string;
  providerDriftAlert?: ProviderDriftAlert | null;
}

export interface BackendIngestMessage {
  external_message_id: string;
  parent_external_message_id?: string;
  role: MessageRole;
  content: string;
  occurred_at?: string;
  raw_payload?: unknown;
}

export interface BackendIngestPayload {
  provider: ProviderName;
  external_session_id: string;
  sync_mode: CaptureMode;
  title?: string;
  source_url: string;
  captured_at: string;
  custom_tags: string[];
  raw_capture: CapturedNetworkEvent;
  messages: BackendIngestMessage[];
}

export interface SaveSettingsResponse {
  ok: boolean;
  settings?: ExtensionSettings;
  capabilities?: BackendCapabilities;
  error?: string;
}

export type RuntimeMessage =
  | { type: "NETWORK_CAPTURE"; payload: CapturedNetworkEvent }
  | { type: "PAGE_VISIT"; payload: PageVisitPayload }
  | { type: "TRIGGER_HISTORY_SYNC"; payload: HistorySyncTriggerPayload }
  | { type: "HISTORY_SYNC_STATUS"; payload: HistorySyncUpdate }
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; payload: Partial<ExtensionSettings> }
  | { type: "GET_STATUS" };
