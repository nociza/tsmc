import { chromium } from "@playwright/test";

const debugUrl = process.env.TSMC_CDP_URL || "http://127.0.0.1:9222";
const targetUrl = process.env.TSMC_DEBUG_URL || "https://gemini.google.com/app";
const logBatchTraffic = process.env.TSMC_LOG_BATCH === "1";
const observeDurationMs = Number.parseInt(process.env.TSMC_OBSERVE_MS || "15000", 10);
const skipReload = process.env.TSMC_SKIP_RELOAD === "1";

function attachPageLogging(page) {
  page.on("console", (message) => {
    const text = message.text();
    if (/TSMC|Failed to construct 'URL'|Invalid URL|ERR_CONNECTION_REFUSED|Failed to fetch/i.test(text)) {
      console.log(`[console] ${page.url() || "about:blank"} :: ${message.type()} :: ${text}`);
    }
  });

  page.on("pageerror", (error) => {
    console.log(`[pageerror] ${page.url() || "about:blank"} :: ${error?.stack || error}`);
  });

  page.on("response", async (response) => {
    if (!logBatchTraffic) {
      return;
    }

    const url = response.url();
    if (!url.includes("/_/BardChatUi/data/batchexecute")) {
      return;
    }

    try {
      const request = response.request();
      const requestBody = request.postData() ?? "";
      const text = await response.text();
      const parsedUrl = new URL(url);
      console.log(
        `[batchexecute] rpcids=${parsedUrl.searchParams.get("rpcids") ?? "unknown"} status=${response.status()} request=${requestBody.slice(
          0,
          240
        )} response=${text.slice(0, 360)}`
      );
    } catch (error) {
      console.log(`[batchexecute] failed to inspect ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

async function getExtensionServiceWorker(context) {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  }
  return serviceWorker;
}

function inferExtensionIdFromPages(context) {
  for (const page of context.pages()) {
    const match = page.url().match(/^chrome-extension:\/\/([^/]+)\//);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

async function main() {
  console.log(`[connect] ${debugUrl}`);
  const browser = await chromium.connectOverCDP(debugUrl);
  const [context] = browser.contexts();
  if (!context) {
    throw new Error("No browser context available over CDP.");
  }
  console.log(`[contexts] ${browser.contexts().length}`);
  console.log(`[pages-before] ${context.pages().map((page) => page.url()).join(" | ")}`);

  for (const page of context.pages()) {
    attachPageLogging(page);
  }
  context.on("page", (page) => {
    attachPageLogging(page);
  });

  let page =
    context.pages().find((candidate) => /gemini\.google\.com/.test(candidate.url())) ??
    context.pages().find((candidate) => candidate.url() === "about:blank") ??
    (await context.newPage());

  attachPageLogging(page);
  console.log(`[page-selected] ${page.url() || "about:blank"}`);

  if (skipReload) {
    console.log(`[skip-reload] ${page.url() || "about:blank"}`);
  } else if (!/gemini\.google\.com/.test(page.url())) {
    console.log(`[goto] ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  } else {
    console.log(`[reload] ${page.url()}`);
    await page.bringToFront();
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  console.log(`[page-after-nav] ${page.url()}`);
  const geminiContext = await page.evaluate(() => {
    const windowRecord = window;
    const wizGlobalData = windowRecord.WIZ_global_data;
    const html = document.documentElement?.innerHTML ?? "";
    const atInput = document.querySelector('input[name="at"]');
    return {
      href: location.href,
      documentLang: document.documentElement?.lang ?? null,
      atInputPresent: Boolean(atInput),
      atInputValueLength: typeof atInput?.value === "string" ? atInput.value.length : 0,
      wizGlobalDataType: typeof wizGlobalData,
      wizGlobalDataKeys:
        wizGlobalData && typeof wizGlobalData === "object" ? Object.keys(wizGlobalData).slice(0, 12) : [],
      htmlHasSNlM0e: html.includes("SNlM0e"),
      htmlHasAtInput: html.includes('name="at"'),
      htmlSNlM0eSnippet: html.includes("SNlM0e")
        ? html.slice(Math.max(0, html.indexOf("SNlM0e") - 40), html.indexOf("SNlM0e") + 180)
        : null,
      htmlSNlM0eRegexMatch: html.match(/"SNlM0e"\s*:\s*"([^"]+)"/)?.[1] ?? null
    };
  });
  console.log(`[gemini-context] ${JSON.stringify(geminiContext)}`);
  const manualListProbe = await page.evaluate(async () => {
    const html = document.documentElement?.innerHTML ?? "";
    const at = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/)?.[1] ?? null;
    const requestUrl = new URL("/_/BardChatUi/data/batchexecute", location.origin);
    requestUrl.searchParams.set("rpcids", "MaZiqc");
    requestUrl.searchParams.set("source-path", "/app");
    requestUrl.searchParams.set("hl", document.documentElement?.lang || "en");
    requestUrl.searchParams.set("rt", "c");
    requestUrl.searchParams.set("_reqid", "9999");
    const innerArgs = [200, null, [0, null, 1]];
    const fReq = JSON.stringify([[["MaZiqc", JSON.stringify(innerArgs), null, "generic"]]]);
    const body = new URLSearchParams({
      "f.req": fReq,
      at: at ?? ""
    }).toString() + "&";

    try {
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
      return {
        requestUrl: requestUrl.toString(),
        atLength: at?.length ?? 0,
        status: response.status,
        ok: response.ok,
        textSnippet: text.slice(0, 500)
      };
    } catch (error) {
      return {
        requestUrl: requestUrl.toString(),
        atLength: at?.length ?? 0,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
  console.log(`[manual-list-probe] ${JSON.stringify(manualListProbe)}`);

  const serviceWorker = await getExtensionServiceWorker(context);
  const extensionId = serviceWorker?.url().split("/")[2] ?? inferExtensionIdFromPages(context);
  if (!extensionId) {
    throw new Error("Extension pages were not found.");
  }

  if (serviceWorker) {
    console.log(`[service-worker] ${serviceWorker.url()}`);
  } else {
    console.log("[service-worker] unavailable, inferred extension id from existing pages");
  }
  console.log(`[extension-id] ${extensionId}`);

  const optionsPage = await context.newPage();
  attachPageLogging(optionsPage);
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
  console.log(`[options-page] ${optionsPage.url()}`);
  const settings = await optionsPage.evaluate(async () => {
    const stored = await chrome.storage.sync.get("tsmc.settings");
    return stored["tsmc.settings"] ?? null;
  });
  const status = await optionsPage.evaluate(async () => {
    const stored = await chrome.storage.local.get("tsmc.status");
    return stored["tsmc.status"] ?? null;
  });
  const syncStateSummary = await optionsPage.evaluate(async () => {
    const stored = await chrome.storage.local.get(["tsmc.sync-state", "tsmc.history-sync"]);
    const syncStates = stored["tsmc.sync-state"] ?? {};
    const historyStates = stored["tsmc.history-sync"] ?? {};
    const geminiKeys = Object.keys(syncStates).filter((key) => key.startsWith("gemini:"));
    return {
      totalSessionKeys: Object.keys(syncStates).length,
      geminiSessionKeys: geminiKeys.length,
      latestGeminiSessionKeys: geminiKeys.slice(-10),
      historyStates
    };
  });

  console.log(`[settings] ${JSON.stringify(settings)}`);
  console.log(`[status] ${JSON.stringify(status)}`);
  console.log(`[sync-state-summary] ${JSON.stringify(syncStateSummary)}`);
  console.log(`[options-history-sync] ${await optionsPage.locator("#history-sync").textContent()}`);
  console.log(`[options-last-error] ${await optionsPage.locator("#last-error").textContent()}`);

  console.log(`[wait] observing runtime for ${observeDurationMs}ms`);
  await page.waitForTimeout(observeDurationMs);

  const popupPage = await context.newPage();
  attachPageLogging(popupPage);
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
  console.log(`[popup-page] ${popupPage.url()}`);

  console.log("[extension-page] reading final status");
  const finalStatus = await popupPage.evaluate(async () => {
    const stored = await chrome.storage.local.get("tsmc.status");
    return stored["tsmc.status"] ?? null;
  });
  console.log(`[final-status] ${JSON.stringify(finalStatus)}`);
  console.log(`[popup-history-sync] ${await popupPage.locator("#history-sync").textContent()}`);
  console.log(`[popup-last-session] ${await popupPage.locator("#last-session").textContent()}`);
  console.log(`[popup-last-error] ${await popupPage.locator("#last-error").textContent()}`);

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
