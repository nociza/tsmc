import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const currentDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(currentDir, "..");
const extensionDist = resolve(extensionRoot, "dist");
const userDataDir = resolve(extensionRoot, ".playwright-user-data");
const backendUrl = (process.env.TSMC_DEBUG_BACKEND_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const targetUrl = process.env.TSMC_DEBUG_URL || "https://gemini.google.com/app";

function attachPageDebug(page) {
  const label = () => page.url() || "about:blank";

  page.on("console", (message) => {
    const text = message.text();
    if (/TSMC|Failed to construct 'URL'|Invalid URL|ERR_CONNECTION_REFUSED|Failed to fetch/i.test(text)) {
      console.log(`[page console] ${label()} :: ${message.type()} :: ${text}`);
    }
  });

  page.on("pageerror", (error) => {
    console.log(`[page error] ${label()} :: ${error?.stack || error}`);
  });
}

async function waitForServiceWorker(context) {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker");
  }
  return serviceWorker;
}

async function configureExtension(context, extensionId) {
  const optionsPage = await context.newPage();
  attachPageDebug(optionsPage);
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
  await optionsPage.locator("#backend-url").fill(backendUrl);
  await optionsPage.locator("#auto-sync-history").setChecked(true);
  await optionsPage.locator("#provider-chatgpt").setChecked(true);
  await optionsPage.locator("#provider-gemini").setChecked(true);
  await optionsPage.locator("#provider-grok").setChecked(true);
  await optionsPage.locator("#settings-form").evaluate((form) => {
    form.requestSubmit();
  });
  await optionsPage.waitForTimeout(250);
  return optionsPage;
}

async function logExtensionStatus(serviceWorker) {
  try {
    const status = await serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.local.get("tsmc.status");
      return stored["tsmc.status"] ?? null;
    });
    console.log(`[extension status] ${JSON.stringify(status)}`);
  } catch (error) {
    console.log(`[extension status error] ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  await mkdir(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: false,
    args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`]
  });

  context.on("page", (page) => {
    attachPageDebug(page);
  });

  const serviceWorker = await waitForServiceWorker(context);
  const extensionId = serviceWorker.url().split("/")[2] ?? "";

  console.log(`[debug] extension id: ${extensionId}`);
  console.log(`[debug] backend url: ${backendUrl}`);
  console.log(`[debug] target url: ${targetUrl}`);

  await configureExtension(context, extensionId);

  const targetPage = await context.newPage();
  attachPageDebug(targetPage);
  await targetPage.goto(targetUrl, { waitUntil: "domcontentloaded" });

  console.log("[debug] Chromium is open with the unpacked extension loaded.");
  console.log("[debug] If Gemini requires login, complete it in the opened browser window.");
  console.log("[debug] After you reproduce the issue, tell me here and I will inspect the captured logs/status.");

  let lastSerializedStatus = "";
  setInterval(async () => {
    try {
      const status = await serviceWorker.evaluate(async () => {
        const stored = await chrome.storage.local.get("tsmc.status");
        return stored["tsmc.status"] ?? null;
      });
      const serialized = JSON.stringify(status);
      if (serialized !== lastSerializedStatus) {
        lastSerializedStatus = serialized;
        console.log(`[extension status] ${serialized}`);
      }
    } catch (error) {
      console.log(`[extension status error] ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 3000);

  await logExtensionStatus(serviceWorker);
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
