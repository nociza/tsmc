export const PROVIDER_REFRESH_DEFAULT_INTERVAL_MINUTES = 60;
export const PROVIDER_REFRESH_MIN_INTERVAL_MINUTES = 15;
export const PROVIDER_REFRESH_MAX_INTERVAL_MINUTES = 24 * 60;

export function normalizeProviderRefreshIntervalMinutes(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return PROVIDER_REFRESH_DEFAULT_INTERVAL_MINUTES;
  }

  return Math.min(
    PROVIDER_REFRESH_MAX_INTERVAL_MINUTES,
    Math.max(PROVIDER_REFRESH_MIN_INTERVAL_MINUTES, Math.round(parsed))
  );
}
