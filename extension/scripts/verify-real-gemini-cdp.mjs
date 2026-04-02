import { chromium } from "@playwright/test";

const debugUrl = process.env.TSMC_CDP_URL || "http://127.0.0.1:9223";
const preferredSessionId = process.env.TSMC_REIMPORT_SESSION?.trim() || "";
const timeoutMs = Number.parseInt(process.env.TSMC_VERIFY_TIMEOUT_MS || "30000", 10);

function inferExtensionId(context) {
  const serviceWorker = context.serviceWorkers()[0];
  const fromWorker = serviceWorker?.url().split("/")[2] ?? "";
  if (fromWorker) {
    return fromWorker;
  }

  for (const page of context.pages()) {
    const match = page.url().match(/^chrome-extension:\/\/([^/]+)\//);
    if (match?.[1]) {
      return match[1];
    }
  }

  return "";
}

function pickGeminiPage(context) {
  return (
    context.pages().find((page) => /^https:\/\/gemini\.google\.com\//.test(page.url())) ??
    null
  );
}

async function fetchLiveGeminiConversationIds(page) {
  return page.evaluate(async () => {
    const html = document.documentElement?.innerHTML ?? "";
    const at =
      (window.WIZ_global_data && typeof window.WIZ_global_data === "object" && window.WIZ_global_data.SNlM0e) ||
      html.match(/"SNlM0e"\s*:\s*"([^"]+)"/)?.[1] ||
      "";
    const requestUrl = new URL("/_/BardChatUi/data/batchexecute", location.origin);
    requestUrl.searchParams.set("rpcids", "MaZiqc");
    requestUrl.searchParams.set("source-path", "/app");
    requestUrl.searchParams.set("hl", document.documentElement?.lang || "en");
    requestUrl.searchParams.set("rt", "c");
    requestUrl.searchParams.set("_reqid", "9999");

    const fReq = JSON.stringify([[["MaZiqc", JSON.stringify([200, null, [0, null, 1]]), null, "generic"]]]);
    const body =
      new URLSearchParams({
        "f.req": fReq,
        at: typeof at === "string" ? at : ""
      }).toString() + "&";

    const response = await fetch(requestUrl.toString(), {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-same-domain": "1"
      },
      body
    });
    const text = await response.text();

    const payloads = [];
    let currentText = text.startsWith(")]}'\n") ? text.slice(5) : text;
    const lines = currentText.split("\n").filter((line) => line.trim().length > 0);
    for (let index = 0; index < lines.length; ) {
      const lengthLine = lines[index++];
      if (!lengthLine || !Number.isFinite(Number.parseInt(lengthLine, 10))) {
        break;
      }

      const segmentLine = lines[index++] ?? "";
      let segment;
      try {
        segment = JSON.parse(segmentLine);
      } catch {
        continue;
      }

      if (!Array.isArray(segment)) {
        continue;
      }

      for (const entry of segment) {
        if (!Array.isArray(entry) || entry[0] !== "wrb.fr" || entry[1] !== "MaZiqc" || typeof entry[2] !== "string") {
          continue;
        }

        try {
          payloads.push(JSON.parse(entry[2]));
        } catch {
          // Ignore malformed payloads.
        }
      }
    }

    const ids = new Set();
    const scan = (node) => {
      if (!Array.isArray(node)) {
        if (node && typeof node === "object") {
          for (const value of Object.values(node)) {
            scan(value);
          }
        }
        return;
      }

      if (typeof node[0] === "string" && typeof node[1] === "string" && /^c_[A-Za-z0-9_-]{6,}$/.test(node[0])) {
        ids.add(node[0].slice(2));
      }

      for (const child of node) {
        scan(child);
      }
    };

    for (const payload of payloads) {
      scan(payload);
    }

    return [...ids];
  });
}

async function main() {
  console.log(`[connect] ${debugUrl}`);
  const browser = await chromium.connectOverCDP(debugUrl);
  const [context] = browser.contexts();
  if (!context) {
    throw new Error("No browser context available over CDP.");
  }

  const extensionId = inferExtensionId(context);
  if (!extensionId) {
    throw new Error("Could not infer the extension id from the live Edge session.");
  }
  console.log(`[extension-id] ${extensionId}`);

  const observedResponses = [];
  context.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/_/BardChatUi/data/batchexecute")) {
      return;
    }

    try {
      observedResponses.push({
        url,
        requestBody: response.request().postData() ?? "",
        status: response.status(),
        text: (await response.text()).slice(0, 500)
      });
    } catch {
      // Best-effort capture only.
    }
  });

  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, {
    waitUntil: "domcontentloaded"
  });

  const geminiPage = pickGeminiPage(context);
  if (!geminiPage) {
    throw new Error("No live Gemini page was available in the Edge session.");
  }

  console.log(`[gemini-page] ${geminiPage.url()}`);
  await geminiPage.evaluate(() => {
    const windowRecord = window;
    windowRecord.__tsmcHistorySyncEvents = [];
    windowRecord.__tsmcBatchTraffic = [];
    if (windowRecord.__tsmcHistorySyncListenerInstalled) {
      return;
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.source !== "tsmc-history-sync") {
        return;
      }

      windowRecord.__tsmcHistorySyncEvents.push(event.data.payload ?? null);
    });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const [input, init] = args;
      const response = await nativeFetch(...args);

      try {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input instanceof Request
                ? input.url
                : String(input);
        if (url.includes("/_/BardChatUi/data/batchexecute")) {
          const requestBody =
            typeof init?.body === "string"
              ? init.body
              : init?.body instanceof URLSearchParams
                ? init.body.toString()
                : "";
          const text = await response.clone().text();
          windowRecord.__tsmcBatchTraffic.push({
            url,
            requestBody,
            status: response.status,
            text: text.slice(0, 500)
          });
        }
      } catch {
        // Best-effort traffic capture only.
      }

      return response;
    };
    windowRecord.__tsmcHistorySyncListenerInstalled = true;
  });
  const liveConversationIds = await fetchLiveGeminiConversationIds(geminiPage);
  console.log(`[live-conversations] ${liveConversationIds.slice(0, 10).join(",")}`);

  const initialState = await optionsPage.evaluate(
    ({ preferredSessionId: sessionId, liveConversationIds: currentConversationIds }) => {
      return chrome.storage.local.get(["tsmc.sync-state", "tsmc.history-sync", "tsmc.status"]).then((stored) => {
        const syncStates = stored["tsmc.sync-state"] ?? {};
        const status = stored["tsmc.status"] ?? {};
        const historyStates = stored["tsmc.history-sync"] ?? {};
        const geminiSessionIds = Object.keys(syncStates)
          .filter((sessionKey) => sessionKey.startsWith("gemini:"))
          .map((sessionKey) => sessionKey.slice("gemini:".length))
          .filter((sessionIdValue) => sessionIdValue && sessionIdValue !== "gemini-session-6dc78748");
        const eligibleSessionIds = geminiSessionIds.filter((sessionIdValue) =>
          currentConversationIds.includes(sessionIdValue)
        );
        const chosenSessionId =
          (sessionId && eligibleSessionIds.includes(sessionId) ? sessionId : "") || eligibleSessionIds.at(-1) || "";

        return {
          chosenSessionId,
          geminiSessionIds,
          lastStartedAt: status.historySyncLastStartedAt ?? null,
          historyStates
        };
      });
    },
    { preferredSessionId, liveConversationIds }
  );

  if (!initialState.chosenSessionId) {
    throw new Error("No Gemini session IDs were available in extension storage.");
  }

  console.log(`[chosen-session] ${initialState.chosenSessionId}`);

  const syncedSessionIds = initialState.geminiSessionIds.filter(
    (sessionId) => sessionId !== initialState.chosenSessionId
  );

  await optionsPage.evaluate(
    ({ chosenSessionId }) => {
      return chrome.storage.local.get(["tsmc.sync-state", "tsmc.history-sync"]).then(async (stored) => {
        const syncStates = stored["tsmc.sync-state"] ?? {};
        const historyStates = stored["tsmc.history-sync"] ?? {};
        delete syncStates[`gemini:${chosenSessionId}`];
        historyStates.gemini = {
          ...(historyStates.gemini ?? {}),
          inProgress: false,
          lastCompletedAt: "2000-01-01T00:00:00.000Z"
        };
        await chrome.storage.local.set({
          "tsmc.sync-state": syncStates,
          "tsmc.history-sync": historyStates
        });
      });
    },
    { chosenSessionId: initialState.chosenSessionId }
  );

  await geminiPage.bringToFront();
  await geminiPage.evaluate((nextSyncedSessionIds) => {
    window.postMessage(
      {
        source: "tsmc-history-control",
        payload: {
          type: "START_HISTORY_SYNC",
          syncedSessionIds: nextSyncedSessionIds
        }
      },
      window.location.origin
    );
  }, syncedSessionIds);

  const deadline = Date.now() + timeoutMs;
  let finalStatus = null;
  while (Date.now() < deadline) {
    finalStatus = await optionsPage.evaluate(() =>
      chrome.storage.local.get("tsmc.status").then((stored) => stored["tsmc.status"] ?? null)
    );

    const lastStartedAt = finalStatus?.historySyncLastStartedAt ?? null;
    const lastConversationCount = finalStatus?.historySyncLastConversationCount ?? null;
    const completed =
      finalStatus?.historySyncInProgress === false &&
      lastStartedAt &&
      lastStartedAt !== initialState.lastStartedAt &&
      finalStatus?.historySyncLastResult === "success";

    if (completed) {
      console.log(
        `[status] completed count=${lastConversationCount ?? "n/a"} lastSession=${finalStatus?.lastSessionKey ?? "n/a"}`
      );
      break;
    }

    console.log(
      `[status] inProgress=${finalStatus?.historySyncInProgress ?? "n/a"} processed=${finalStatus?.historySyncProcessedCount ?? "n/a"} total=${finalStatus?.historySyncTotalCount ?? "n/a"} skipped=${finalStatus?.historySyncSkippedCount ?? "n/a"}`
    );
    await optionsPage.waitForTimeout(1000);
  }

  if (!finalStatus) {
    throw new Error("Failed to read final extension status.");
  }

  console.log(`[final-status] ${JSON.stringify(finalStatus)}`);
  console.log(`[history-text] ${await optionsPage.locator("#history-sync").textContent()}`);
  console.log(`[last-session] ${await optionsPage.locator("#last-session").textContent()}`);
  const emittedEvents = await geminiPage.evaluate(() => window.__tsmcHistorySyncEvents ?? []);
  const batchTraffic = await geminiPage.evaluate(() => window.__tsmcBatchTraffic ?? []);
  console.log(`[emitted-events] ${JSON.stringify(emittedEvents)}`);
  console.log(`[batch-traffic] ${JSON.stringify(batchTraffic)}`);
  console.log(`[observed-responses] ${JSON.stringify(observedResponses)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
