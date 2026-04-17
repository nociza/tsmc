import type { ProviderName } from "../shared/types";

export interface HistorySyncControlPayload {
  type: "START_HISTORY_SYNC";
  syncedSessionIds?: string[];
  previousTopSessionId?: string;
  previousTopSessionIds?: string[];
  refreshSessionIds?: string[];
}

export function normalizeHistorySessionIds(
  provider: ProviderName,
  sessionIds: string[] | undefined,
  normalizeProviderSessionId?: (sessionId: string) => string | null
): Set<string> {
  const normalized = sessionIds
    ?.map((sessionId) => {
      if (typeof sessionId !== "string") {
        return null;
      }

      const trimmed = sessionId.trim();
      if (!trimmed) {
        return null;
      }

      if (provider !== "gemini" || !normalizeProviderSessionId) {
        return trimmed;
      }

      return normalizeProviderSessionId(trimmed);
    })
    .filter((sessionId): sessionId is string => Boolean(sessionId));

  return new Set(normalized ?? []);
}

export function dedupeIds(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= items.length) {
          return;
        }

        await worker(items[currentIndex], currentIndex);
      }
    })
  );
}

export function countRetryableHistoryFailures(attemptedCount: number, syncedCount: number): number {
  return Math.max(0, attemptedCount - syncedCount);
}
