import { describe, expect, it } from "vitest";

import { buildIndexingProbeText, evaluateIndexingRules, indexingRulesFingerprint, normalizeRuleWords } from "../src/shared/indexing-rules";
import type { ExtensionSettings, NormalizedSessionSnapshot } from "../src/shared/types";

const baseSettings: ExtensionSettings = {
  backendUrl: "http://127.0.0.1:18888",
  backendToken: "",
  enabledProviders: {
    chatgpt: true,
    gemini: true,
    grok: true
  },
  autoSyncHistory: true,
  indexingMode: "all",
  triggerWords: ["lorem"],
  blacklistWords: [],
  selectionCaptureEnabled: false
};

const snapshot: NormalizedSessionSnapshot = {
  provider: "chatgpt",
  externalSessionId: "session-1",
  title: "Example",
  sourceUrl: "https://chatgpt.com/c/session-1",
  capturedAt: "2026-04-14T10:00:00.000Z",
  messages: [
    {
      id: "u1",
      role: "user",
      content: "Lorem, index this deployment plan. The rest of the conversation can continue normally."
    },
    {
      id: "a1",
      role: "assistant",
      content: "Understood."
    }
  ]
};

describe("indexing rules", () => {
  it("normalizes rule words from comma and newline separated input", () => {
    expect(normalizeRuleWords(" lorem, Alpha\nignore , lorem ")).toEqual(["lorem", "alpha", "ignore"]);
  });

  it("uses the opening user request as the probe text", () => {
    expect(buildIndexingProbeText(snapshot.messages)).toContain("Lorem, index this deployment plan.");
  });

  it("allows indexing when trigger-word mode matches the opening request", () => {
    const decision = evaluateIndexingRules(
      {
        ...baseSettings,
        indexingMode: "trigger_word"
      },
      snapshot
    );

    expect(decision.shouldIndex).toBe(true);
    expect(decision.matchedTriggerWord).toBe("lorem");
  });

  it("skips indexing when no trigger word matches in trigger-word mode", () => {
    const decision = evaluateIndexingRules(
      {
        ...baseSettings,
        indexingMode: "trigger_word",
        triggerWords: ["lorem"]
      },
      {
        ...snapshot,
        messages: [
          {
            id: "u1",
            role: "user",
            content: "Please keep this one out of TSMC for now."
          }
        ]
      }
    );

    expect(decision.shouldIndex).toBe(false);
    expect(decision.reason).toContain("none of the trigger words");
  });

  it("lets blacklist rules override matching trigger words", () => {
    const decision = evaluateIndexingRules(
      {
        ...baseSettings,
        indexingMode: "trigger_word",
        blacklistWords: ["lorem"]
      },
      snapshot
    );

    expect(decision.shouldIndex).toBe(false);
    expect(decision.matchedBlacklistWord).toBe("lorem");
  });

  it("changes the rules fingerprint when indexing settings change", () => {
    const first = indexingRulesFingerprint(baseSettings);
    const second = indexingRulesFingerprint({
      ...baseSettings,
      indexingMode: "trigger_word",
      blacklistWords: ["ignore"]
    });

    expect(first).not.toBe(second);
  });
});
