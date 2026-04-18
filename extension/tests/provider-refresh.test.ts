import { describe, expect, it } from "vitest";

import {
  buildProviderRefreshAlarmPlan,
  providerFromRefreshAlarmName,
  providerRefreshAlarmName
} from "../src/background/provider-refresh";
import { normalizeProviderRefreshIntervalMinutes } from "../src/shared/provider-refresh";
import type { ExtensionSettings } from "../src/shared/types";

const settings: ExtensionSettings = {
  backendUrl: "http://127.0.0.1:18888",
  backendToken: "",
  enabledProviders: {
    chatgpt: true,
    gemini: true,
    grok: true
  },
  autoSyncHistory: true,
  scheduledProviderRefreshEnabled: true,
  scheduledProviderRefreshIntervalMinutes: 60,
  indexingMode: "all",
  triggerWords: ["lorem"],
  blacklistWords: [],
  discardWordsEnabled: true,
  discardWords: [],
  selectionCaptureEnabled: false
};

describe("provider refresh scheduler", () => {
  it("plans staggered alarms for enabled providers", () => {
    expect(buildProviderRefreshAlarmPlan(settings)).toEqual([
      {
        provider: "chatgpt",
        alarmName: "savemycontext.provider-refresh.chatgpt",
        delayInMinutes: 1,
        periodInMinutes: 60
      },
      {
        provider: "gemini",
        alarmName: "savemycontext.provider-refresh.gemini",
        delayInMinutes: 3,
        periodInMinutes: 60
      },
      {
        provider: "grok",
        alarmName: "savemycontext.provider-refresh.grok",
        delayInMinutes: 5,
        periodInMinutes: 60
      }
    ]);
  });

  it("does not plan alarms when auto-sync or scheduled refresh is off", () => {
    expect(buildProviderRefreshAlarmPlan({ ...settings, autoSyncHistory: false })).toEqual([]);
    expect(buildProviderRefreshAlarmPlan({ ...settings, scheduledProviderRefreshEnabled: false })).toEqual([]);
  });

  it("skips disabled providers", () => {
    expect(
      buildProviderRefreshAlarmPlan({
        ...settings,
        enabledProviders: {
          chatgpt: true,
          gemini: false,
          grok: true
        }
      }).map((item) => item.provider)
    ).toEqual(["chatgpt", "grok"]);
  });

  it("maps alarm names back to providers", () => {
    expect(providerRefreshAlarmName("gemini")).toBe("savemycontext.provider-refresh.gemini");
    expect(providerFromRefreshAlarmName("savemycontext.provider-refresh.grok")).toBe("grok");
    expect(providerFromRefreshAlarmName("unrelated")).toBeNull();
  });

  it("clamps refresh intervals", () => {
    expect(normalizeProviderRefreshIntervalMinutes(5)).toBe(15);
    expect(normalizeProviderRefreshIntervalMinutes(2_000)).toBe(1440);
    expect(normalizeProviderRefreshIntervalMinutes("45")).toBe(45);
    expect(normalizeProviderRefreshIntervalMinutes("")).toBe(60);
  });
});
