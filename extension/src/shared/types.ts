export type ProviderName = "chatgpt" | "gemini" | "grok";
export type MessageRole = "user" | "assistant" | "system" | "tool" | "unknown";
export type CaptureMode = "incremental" | "full_snapshot";
export type IndexingMode = "all" | "trigger_word";

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
  indexingRuleDecision?: "indexed" | "skipped";
  indexingRuleFingerprint?: string;
  indexingRuleReason?: string;
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
  indexingMode: IndexingMode;
  triggerWords: string[];
  blacklistWords: string[];
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
    browser_proxy: boolean;
    openai_compatible_api: boolean;
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
  processingMode?: string;
  processingWorkerModel?: string;
  processingPendingCount?: number;
  processingInProgress?: boolean;
  processingProvider?: ProviderName;
  processingProcessedCount?: number;
  processingLastRunAt?: string;
  processingLastError?: string | null;
  lastIndexingDecision?: "indexed" | "skipped";
  lastIndexingReason?: string | null;
}

export interface BackendProcessingStatus {
  enabled: boolean;
  mode: string;
  worker_model?: string;
  pending_count: number;
}

export type SessionCategoryName = "journal" | "factual" | "ideas" | "todo";

export interface DashboardCategoryCount {
  category: SessionCategoryName;
  count: number;
}

export interface BackendDashboardSummary {
  total_sessions: number;
  total_messages: number;
  total_triplets: number;
  total_sync_events: number;
  active_tokens: number;
  latest_sync_at?: string | null;
  categories: DashboardCategoryCount[];
}

export interface BackendSystemStatus {
  product: string;
  version: string;
  server_time: string;
  markdown_root: string;
  vault_root: string;
  todo_list_path: string;
  public_url?: string | null;
  auth_mode: string;
  git_versioning_enabled: boolean;
  git_available: boolean;
  total_sessions: number;
  total_messages: number;
  total_triplets: number;
}

export interface BackendGraphNode {
  id: string;
  label: string;
  kind: string;
  degree: number;
  note_path?: string | null;
}

export interface BackendGraphEdge {
  id: string;
  source: string;
  target: string;
  predicate: string;
  support_count: number;
  session_ids: string[];
}

export interface BackendSearchResult {
  kind: string;
  title: string;
  snippet: string;
  session_id?: string | null;
  entity_id?: string | null;
  category?: SessionCategoryName | null;
  provider?: ProviderName | null;
  markdown_path?: string | null;
}

export interface BackendSearchResponse {
  query: string;
  count: number;
  results: BackendSearchResult[];
}

export interface KnowledgeSearchResponse {
  ok: boolean;
  query: string;
  count: number;
  results: BackendSearchResult[];
  error?: string;
}

export interface ProcessingTaskItem {
  task_key: string;
  session_id: string;
  source_provider?: ProviderName;
  source_session_id?: string;
  title?: string;
}

export interface ProcessingTaskResponse {
  available: boolean;
  tasks: ProcessingTaskItem[];
  task_count: number;
  prompt?: string;
  worker_model?: string;
}

export interface ProcessingCompleteResult {
  session_id: string;
  category: SessionCategoryName;
  markdown_path?: string;
  processed: boolean;
}

export interface ProcessingCompleteResponse {
  processed_count: number;
  results: ProcessingCompleteResult[];
}

export interface RunProviderPromptPayload {
  promptText: string;
  preferFastMode?: boolean;
  requireCompleteJson?: boolean;
}

export interface RunProviderPromptResponse {
  ok: boolean;
  provider?: ProviderName;
  responseText?: string;
  pageUrl?: string;
  title?: string;
  error?: string;
}

export interface PingProviderTabResponse {
  ok: boolean;
  provider?: ProviderName;
  pageUrl?: string;
  mainWorldReady?: boolean;
  error?: string;
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
  | { type: "START_PROCESSING" }
  | { type: "OPEN_QUICK_SEARCH" }
  | { type: "TOGGLE_QUICK_SEARCH" }
  | { type: "SEARCH_KNOWLEDGE"; payload: { query: string; limit?: number } }
  | { type: "PING_PROVIDER_TAB" }
  | { type: "RUN_PROVIDER_PROMPT"; payload: RunProviderPromptPayload }
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; payload: Partial<ExtensionSettings> }
  | { type: "GET_STATUS" };
