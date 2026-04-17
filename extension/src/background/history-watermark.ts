import type { HistorySyncUpdate, ProviderDriftAlert, ProviderHistorySyncState, ProviderName } from "../shared/types";

export function shouldCommitHistoryWatermark(update: HistorySyncUpdate, runError?: string): boolean {
  return (
    update.phase === "completed" &&
    !runError &&
    !update.providerDriftAlert &&
    (update.retryableFailureCount ?? 0) === 0
  );
}

export function activeHistoryWatermarks(
  provider: ProviderName,
  state: ProviderHistorySyncState,
  currentAlert?: ProviderDriftAlert | null
): string[] | undefined {
  if (state.lastDriftAlert?.provider === provider || currentAlert?.provider === provider) {
    return undefined;
  }

  return state.lastTopSessionIds ?? (state.lastTopSessionId ? [state.lastTopSessionId] : undefined);
}
