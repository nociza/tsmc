export type ProviderName = "chatgpt" | "gemini" | "grok";
export type MessageRole = "user" | "assistant" | "system" | "tool" | "unknown";
export type CaptureMode = "incremental" | "full_snapshot";
export type IndexingMode = "all" | "trigger_word";
export type SourceCaptureKind = "selection" | "page";
export type SourceSaveMode = "raw" | "ai";

export interface CapturedBody {
  text?: string;
  json?: unknown;
}

export interface CapturedNetworkEvent {
  source: "savemycontext-network-observer";
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
  indexingRuleDecision?: "indexed" | "skipped" | "discarded";
  indexingRuleFingerprint?: string;
  indexingRuleReason?: string;
  discardWordMatch?: string;
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
  scheduledProviderRefreshEnabled?: boolean;
  scheduledProviderRefreshIntervalMinutes?: number;
  indexingMode: IndexingMode;
  triggerWords: string[];
  blacklistWords: string[];
  discardWordsEnabled: boolean;
  discardWords: string[];
  selectionCaptureEnabled: boolean;
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
    storage_management?: boolean;
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
  historySyncActiveProviders?: ProviderName[];
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
  backendMarkdownRoot?: string;
  backendVaultRoot?: string;
  processingMode?: string;
  processingWorkerModel?: string;
  processingPendingCount?: number;
  processingInProgress?: boolean;
  processingProvider?: ProviderName;
  processingProcessedCount?: number;
  processingLastRunAt?: string;
  processingLastError?: string | null;
  lastIndexingDecision?: "indexed" | "skipped" | "discarded";
  lastIndexingReason?: string | null;
}

export interface BackendProcessingStatus {
  enabled: boolean;
  mode: string;
  worker_model?: string;
  pending_count: number;
}

export type SessionCategoryName = "journal" | "factual" | "ideas" | "todo" | "discarded";

export type PileSlug = string;

export interface DashboardCategoryCount {
  category: SessionCategoryName;
  count: number;
}

export interface DashboardCustomCategoryCount {
  name: string;
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
  custom_categories: DashboardCustomCategoryCount[];
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

export interface BackendStorageSettings {
  markdown_root: string;
  vault_root: string;
  todo_list_path: string;
  persistence_kind: string;
  persisted_to?: string | null;
  regenerated_session_count: number;
  git_initialized: boolean;
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

export interface BackendSessionListItem {
  id: string;
  provider: ProviderName;
  external_session_id: string;
  title?: string | null;
  category?: SessionCategoryName | null;
  pile_slug?: string | null;
  is_discarded?: boolean;
  discarded_reason?: string | null;
  custom_tags: string[];
  user_categories: string[];
  markdown_path?: string | null;
  share_post?: string | null;
  updated_at: string;
  last_captured_at?: string | null;
  last_processed_at?: string | null;
}

export interface BackendSessionMessage {
  id: string;
  external_message_id: string;
  parent_external_message_id?: string | null;
  role: MessageRole;
  content: string;
  sequence_index: number;
  occurred_at?: string | null;
  raw_payload?: unknown;
  created_at: string;
}

export interface BackendSessionTriplet {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence?: number | null;
  created_at: string;
}

export interface BackendSessionRead extends BackendSessionListItem {
  source_url?: string | null;
  classification_reason?: string | null;
  journal_entry?: string | null;
  todo_summary?: string | null;
  idea_summary?: Record<string, unknown> | null;
  pile_outputs?: Record<string, unknown> | null;
  created_at: string;
  messages: BackendSessionMessage[];
  triplets: BackendSessionTriplet[];
}

export interface BackendLabelCount {
  label: string;
  count: number;
}

export interface BackendProviderCount {
  provider: ProviderName;
  count: number;
}

export interface BackendActivityBucket {
  bucket: string;
  count: number;
}

export interface BackendCategoryStats {
  category: SessionCategoryName;
  scope_kind: "default" | "custom";
  scope_label: string;
  dominant_category: SessionCategoryName;
  total_sessions: number;
  total_messages: number;
  total_triplets: number;
  latest_updated_at?: string | null;
  avg_messages_per_session: number;
  avg_triplets_per_session: number;
  notes_with_share_post: number;
  notes_with_idea_summary: number;
  notes_with_journal_entry: number;
  notes_with_todo_summary: number;
  system_category_counts: DashboardCategoryCount[];
  provider_counts: BackendProviderCount[];
  activity: BackendActivityBucket[];
  top_tags: BackendLabelCount[];
  top_entities: BackendLabelCount[];
  top_predicates: BackendLabelCount[];
}

export interface BackendExplorerGraphNode {
  id: string;
  label: string;
  kind: string;
  size: number;
  session_ids: string[];
  provider?: ProviderName | null;
  category?: SessionCategoryName | null;
  updated_at?: string | null;
  note_path?: string | null;
}

export interface BackendExplorerGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string | null;
  weight: number;
  session_ids: string[];
}

export interface BackendCategoryGraph {
  category: SessionCategoryName;
  scope_kind: "default" | "custom";
  scope_label: string;
  dominant_category: SessionCategoryName;
  node_count: number;
  edge_count: number;
  nodes: BackendExplorerGraphNode[];
  edges: BackendExplorerGraphEdge[];
}

export interface BackendTodoItem {
  text: string;
  done: boolean;
}

export interface BackendTodoGitStatus {
  versioning_enabled: boolean;
  available: boolean;
  repository_ready: boolean;
  branch?: string | null;
  clean?: boolean | null;
  last_commit_short?: string | null;
  last_commit_message?: string | null;
  last_commit_at?: string | null;
}

export interface BackendTodoListRead {
  title: string;
  content: string;
  items: BackendTodoItem[];
  active_count: number;
  completed_count: number;
  total_count: number;
  git: BackendTodoGitStatus;
}

export interface BackendTodoListUpdate {
  items: BackendTodoItem[];
  summary?: string;
}

export interface BackendSessionNoteRead extends BackendSessionRead {
  raw_markdown?: string | null;
  related_entities: string[];
  word_count: number;
}

export interface BackendSearchResult {
  kind: string;
  title: string;
  snippet: string;
  session_id?: string | null;
  source_id?: string | null;
  entity_id?: string | null;
  category?: SessionCategoryName | null;
  provider?: ProviderName | null;
  user_categories: string[];
  markdown_path?: string | null;
}

export interface BackendUserCategorySummary {
  name: string;
  count: number;
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

export interface HistorySyncControlPayload {
  type: "START_HISTORY_SYNC";
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
  retryableFailureCount?: number;
  processedCount?: number;
  totalCount?: number;
  skippedCount?: number;
  topSessionId?: string;
  topSessionIds?: string[];
  pageUrl: string;
  message?: string;
  providerDriftAlert?: ProviderDriftAlert | null;
}

export interface ProxyPromptControlPayload {
  type: "RUN_PROXY_PROMPT";
  requestId: string;
  promptText: string;
  preferFastMode?: boolean;
  requireCompleteJson?: boolean;
}

export type MainWorldControlPayload = HistorySyncControlPayload | ProxyPromptControlPayload;

export interface ProxyPromptResult {
  requestId: string;
  ok: boolean;
  provider?: ProviderName;
  responseText?: string;
  pageUrl?: string;
  title?: string;
  error?: string;
}

export type BridgeToPageMessage = {
  type: "CONTROL";
  payload: MainWorldControlPayload;
};

export type BridgeToExtensionMessage =
  | { type: "BRIDGE_READY" }
  | { type: "NETWORK_CAPTURE"; payload: CapturedNetworkEvent }
  | { type: "HISTORY_SYNC_STATUS"; payload: HistorySyncUpdate }
  | { type: "PROXY_RESULT"; payload: ProxyPromptResult };

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
  route_to_discard?: boolean;
  discard_word_match?: string;
}

export interface BackendPileRead {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  kind: string;
  folder_label: string;
  attributes: string[];
  pipeline_config: Record<string, unknown>;
  is_active: boolean;
  is_visible_on_dashboard: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface BackendDiscardedSessionItem {
  id: string;
  provider: ProviderName;
  external_session_id: string;
  title?: string | null;
  discarded_reason?: string | null;
  last_captured_at?: string | null;
  updated_at: string;
  markdown_path?: string | null;
}

export interface BackendDiscardedSessionsResponse {
  count: number;
  items: BackendDiscardedSessionItem[];
}

export interface SaveSettingsResponse {
  ok: boolean;
  settings?: ExtensionSettings;
  capabilities?: BackendCapabilities;
  error?: string;
}

export interface SaveKnowledgePathResponse {
  ok: boolean;
  storage?: BackendStorageSettings;
  error?: string;
}

export interface SourceCapturePayload {
  captureKind: SourceCaptureKind;
  saveMode: SourceSaveMode;
  title?: string;
  pageTitle?: string;
  sourceUrl: string;
  selectionText?: string;
  sourceText: string;
  sourceMarkdown?: string;
  rawPayload?: unknown;
}

export interface SourceCaptureResponse {
  ok: boolean;
  sourceId?: string;
  title?: string;
  captureKind?: SourceCaptureKind;
  saveMode?: SourceSaveMode;
  processed?: boolean;
  category?: SessionCategoryName | null;
  markdownPath?: string | null;
  rawSourcePath?: string | null;
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
  | { type: "SAVE_KNOWLEDGE_PATH"; payload: { markdownRoot: string } }
  | { type: "SAVE_SOURCE_CAPTURE"; payload: SourceCapturePayload }
  | { type: "SAVE_CURRENT_PAGE_SOURCE"; payload?: { saveMode?: SourceSaveMode } }
  | { type: "GET_STATUS" };
