import { supportsProactiveHistorySync } from "../shared/provider";
import {
  normalizeProviderRefreshIntervalMinutes,
  PROVIDER_REFRESH_DEFAULT_INTERVAL_MINUTES
} from "../shared/provider-refresh";
import type { ExtensionSettings, ProviderName } from "../shared/types";

export const PROVIDER_REFRESH_ALARM_PREFIX = "savemycontext.provider-refresh.";
const PROVIDER_REFRESH_STAGGER_MINUTES = 2;
const PROVIDER_REFRESH_INITIAL_DELAY_MINUTES = 1;
const PROVIDER_ORDER: ProviderName[] = ["chatgpt", "gemini", "grok"];

export interface ProviderRefreshAlarmPlan {
  provider: ProviderName;
  alarmName: string;
  delayInMinutes: number;
  periodInMinutes: number;
}

export function providerRefreshAlarmName(provider: ProviderName): string {
  return `${PROVIDER_REFRESH_ALARM_PREFIX}${provider}`;
}

export function providerFromRefreshAlarmName(name: string): ProviderName | null {
  if (!name.startsWith(PROVIDER_REFRESH_ALARM_PREFIX)) {
    return null;
  }

  const candidate = name.slice(PROVIDER_REFRESH_ALARM_PREFIX.length);
  return PROVIDER_ORDER.includes(candidate as ProviderName) ? (candidate as ProviderName) : null;
}

export function buildProviderRefreshAlarmPlan(settings: ExtensionSettings): ProviderRefreshAlarmPlan[] {
  if (!settings.autoSyncHistory || !settings.scheduledProviderRefreshEnabled) {
    return [];
  }

  const periodInMinutes = normalizeProviderRefreshIntervalMinutes(
    settings.scheduledProviderRefreshIntervalMinutes ?? PROVIDER_REFRESH_DEFAULT_INTERVAL_MINUTES
  );

  return PROVIDER_ORDER.filter((provider) => settings.enabledProviders[provider] && supportsProactiveHistorySync(provider)).map(
    (provider, index) => ({
      provider,
      alarmName: providerRefreshAlarmName(provider),
      delayInMinutes: Math.min(
        Math.max(PROVIDER_REFRESH_INITIAL_DELAY_MINUTES, periodInMinutes - 1),
        PROVIDER_REFRESH_INITIAL_DELAY_MINUTES + index * PROVIDER_REFRESH_STAGGER_MINUTES
      ),
      periodInMinutes
    })
  );
}
