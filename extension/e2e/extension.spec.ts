import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { chromium, expect, test } from "@playwright/test";

const currentDir = fileURLToPath(new URL(".", import.meta.url));
const extensionRoot = resolve(currentDir, "..");
const projectRoot = resolve(extensionRoot, "..");
const backendRoot = resolve(projectRoot, "backend");
const extensionDist = resolve(extensionRoot, "dist");
const backendPython = resolve(backendRoot, ".venv/bin/python");
const HEALTHCHECK_TIMEOUT_MS = 15_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function buildBatchExecuteResponseBody(rpcId: string, payload: unknown): string {
  const innerPayload = JSON.stringify(payload);
  return `)]}'\n${innerPayload.length}\n${JSON.stringify([["wrb.fr", rpcId, innerPayload, null, null, null, "generic"]])}\n`;
}

function parseGeminiRequestArgs(postData: string | null | undefined): unknown[] | null {
  if (!postData) {
    return null;
  }

  try {
    const params = new URLSearchParams(postData.endsWith("&") ? postData.slice(0, -1) : postData);
    const encoded = params.get("f.req");
    if (!encoded) {
      return null;
    }

    const outer = JSON.parse(encoded) as unknown[];
    const argsText = Array.isArray(outer?.[0]) && Array.isArray(outer[0]?.[0]) ? outer[0][0]?.[1] : null;
    return typeof argsText === "string" ? (JSON.parse(argsText) as unknown[]) : null;
  } catch {
    return null;
  }
}

function buildGeminiConversationEntry(
  conversationId: string,
  title: string,
  options?: {
    pinned?: boolean;
    hidden?: boolean;
  }
): unknown[] {
  const entry: unknown[] = [];
  entry[0] = `c_${conversationId}`;
  entry[1] = title;
  entry[2] = options?.pinned ?? false;
  entry[3] = options?.hidden ?? false;
  return entry;
}

function buildGeminiListPayload(entries: unknown[], nextPageToken?: string): unknown[] {
  const payload: unknown[] = [];
  payload[1] = nextPageToken ?? null;
  payload[2] = entries;
  return payload;
}

function buildGeminiTurnBlock(userText: string, assistantText: string, timestampSeconds: number, assistantId: string): unknown[] {
  return [
    [[userText], 2],
    [[[assistantId, [assistantText]]]],
    [timestampSeconds, 1]
  ];
}

function buildGeminiTurnPayload(blocks: unknown[], nextPageToken?: string): unknown[] {
  const payload: unknown[] = [];
  payload[0] = blocks;
  payload[1] = nextPageToken ?? null;
  return payload;
}

function configuredBackendBaseUrl(): string | null {
  const value = globalThis.process.env.TSMC_E2E_BACKEND_URL?.trim();
  return value ? value.replace(/\/$/, "") : null;
}

async function waitForBackendUrlHealthy(backendBaseUrl: string): Promise<void> {
  const deadline = Date.now() + HEALTHCHECK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${backendBaseUrl}/api/v1/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // The server is still starting.
    }

    await wait(250);
  }

  throw new Error(`Backend did not become healthy at ${backendBaseUrl}.`);
}

function extractBackendBaseUrl(logs: string[]): string | null {
  const match = logs.join("").match(/Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/);
  return match?.[1] ?? null;
}

async function waitForBackendHealthy(logs: string[]): Promise<string> {
  const deadline = Date.now() + HEALTHCHECK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const backendBaseUrl = extractBackendBaseUrl(logs);
    if (backendBaseUrl) {
      try {
        const response = await fetch(`${backendBaseUrl}/api/v1/health`);
        if (response.ok) {
          return backendBaseUrl;
        }
      } catch {
        // The server picked a port but is still starting.
      }
    }

    await wait(250);
  }

  throw new Error(`Backend did not become healthy.\n${logs.join("")}`);
}

async function stopBackend(process: ReturnType<typeof spawn> | undefined): Promise<void> {
  if (!process || process.killed) {
    return;
  }

  process.kill("SIGTERM");

  await Promise.race([
    new Promise<void>((resolvePromise) => {
      process.once("exit", () => resolvePromise());
    }),
    wait(5_000).then(() => {
      process.kill("SIGKILL");
    })
  ]);
}

test("auto-syncs ChatGPT history on provider visit", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "tsmc-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "tsmc-backend-e2e-"));
  const sessionId = `e2e-chatgpt-${Date.now()}`;
  const backendLogs: string[] = [];
  let backendProcess: ReturnType<typeof spawn> | undefined;
  let backendBaseUrl = configuredBackendBaseUrl();

  try {
    if (backendBaseUrl) {
      await waitForBackendUrlHealthy(backendBaseUrl);
    } else {
      const backendChild = spawn(
        backendPython,
        ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "0"],
        {
          cwd: backendRoot,
          env: {
            ...globalThis.process.env,
            PYTHONUNBUFFERED: "1",
            TSMC_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "tsmc.db")}`,
            TSMC_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            TSMC_LLM_BACKEND: "heuristic"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      backendProcess = backendChild;

      backendChild.stdout?.on("data", (chunk: Buffer) => {
        backendLogs.push(chunk.toString());
      });
      backendChild.stderr?.on("data", (chunk: Buffer) => {
        backendLogs.push(chunk.toString());
      });

      backendBaseUrl = await waitForBackendHealthy(backendLogs);
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: testInfo.project.use.headless ?? true,
      args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`]
    });

    try {
      let [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent("serviceworker");
      }
      const extensionId = serviceWorker.url().split("/")[2] ?? "";
      expect(extensionId).not.toHaveLength(0);

      const optionsPage = await context.newPage();
      await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
      await optionsPage.locator("#backend-url").fill(backendBaseUrl);
      await optionsPage.locator("#auto-sync-history").setChecked(true);
      await optionsPage.locator("#settings-form").evaluate((form) => {
        (form as HTMLFormElement).requestSubmit();
      });
      await expect(optionsPage.locator("#save-status")).toHaveText("Settings saved.");

      const conversationUrl = "https://chatgpt.com/";
      const sessionApiUrl = "https://chatgpt.com/api/auth/session";
      const listApiUrl = "https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=updated";
      const detailApiUrl = `https://chatgpt.com/backend-api/conversation/${sessionId}`;

      await context.route(sessionApiUrl, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            accessToken: "e2e-token"
          })
        });
      });

      await context.route(listApiUrl, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [
              {
                id: sessionId,
                title: "E2E ChatGPT Sync"
              }
            ],
            total: 1
          })
        });
      });

      await context.route(detailApiUrl, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            conversation_id: sessionId,
            title: "E2E ChatGPT Sync",
            mapping: {
              root: {
                id: "root"
              },
              userNode: {
                id: "userNode",
                parent: "root",
                message: {
                  id: "msg-user",
                  author: { role: "user" },
                  create_time: 1711842000,
                  content: { parts: ["Explain how FastAPI uses uvloop in an async backend."] }
                }
              },
              assistantNode: {
                id: "assistantNode",
                parent: "msg-user",
                message: {
                  id: "msg-assistant",
                  author: { role: "assistant" },
                  create_time: 1711842060,
                  content: { parts: ["FastAPI uses uvloop to run the event loop with high-performance async I/O."] }
                }
              }
            }
          })
        });
      });

      const page = await context.newPage();
      await page.goto(conversationUrl, { waitUntil: "domcontentloaded" });

      await expect
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("tsmc.status");
              return (
                (stored["tsmc.status"] as { historySyncLastResult?: string } | undefined)?.historySyncLastResult ??
                null
              );
            }),
          {
            message: "Waiting for the extension to finish ChatGPT history sync."
          }
        )
        .toBe("success");

      await expect
        .poll(
          async () => {
            const response = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=chatgpt`);
            if (!response.ok()) {
              return null;
            }
            const sessions = (await response.json()) as Array<{ external_session_id: string }>;
            return sessions.find((session) => session.external_session_id === sessionId)?.external_session_id ?? null;
          },
          {
            message: "Waiting for the backend to persist the auto-synced ChatGPT session."
          }
        )
        .toBe(sessionId);

      const sessionsResponse = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=chatgpt`);
      expect(sessionsResponse.ok()).toBeTruthy();
      const sessions = (await sessionsResponse.json()) as Array<{
        id: string;
        external_session_id: string;
        title: string | null;
      }>;
      const matchedSession = sessions.find((session) => session.external_session_id === sessionId);
      expect(matchedSession?.title).toBe("E2E ChatGPT Sync");

      const sessionResponse = await request.get(`${backendBaseUrl}/api/v1/sessions/${matchedSession?.id}`);
      expect(sessionResponse.ok()).toBeTruthy();
      const persisted = (await sessionResponse.json()) as {
        external_session_id: string;
        messages: Array<{ content: string }>;
        triplets: Array<{ subject: string }>;
      };

      expect(persisted.external_session_id).toBe(sessionId);
      expect(persisted.messages).toHaveLength(2);
      expect(persisted.messages.map((message) => message.content)).toEqual([
        "Explain how FastAPI uses uvloop in an async backend.",
        "FastAPI uses uvloop to run the event loop with high-performance async I/O."
      ]);
      expect(persisted.triplets.length).toBeGreaterThan(0);

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
      await expect(popup.locator("#history-sync")).toContainText("success");
      await expect(popup.locator("#last-session")).toHaveText(`chatgpt:${sessionId}`);
    } finally {
      await context.close();
    }
  } finally {
    await stopBackend(backendProcess);
    await rm(userDataDir, { recursive: true, force: true });
    await rm(backendDataDir, { recursive: true, force: true });
  }
});

test("auto-syncs Gemini history on provider visit", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "tsmc-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "tsmc-backend-e2e-"));
  const sessionId = "gemini-e2e-123456789";
  const secondSessionId = "gemini-e2e-987654321";
  const thirdSessionId = "gemini-e2e-333333333";
  const skippedSessionId = "gemini-e2e-skipped-123456789";
  const backendLogs: string[] = [];
  const observedListRequests: Array<{ sourcePath: string; pinned: boolean; pageToken: string | null }> = [];
  const observedReadRequests: Array<{ conversationId: string; pageToken: string | null }> = [];
  let backendProcess: ReturnType<typeof spawn> | undefined;
  let backendBaseUrl = configuredBackendBaseUrl();

  try {
    if (backendBaseUrl) {
      await waitForBackendUrlHealthy(backendBaseUrl);
    } else {
      const backendChild = spawn(
        backendPython,
        ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "0"],
        {
          cwd: backendRoot,
          env: {
            ...globalThis.process.env,
            PYTHONUNBUFFERED: "1",
            TSMC_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "tsmc.db")}`,
            TSMC_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            TSMC_LLM_BACKEND: "heuristic"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      backendProcess = backendChild;

      backendChild.stdout?.on("data", (chunk: Buffer) => {
        backendLogs.push(chunk.toString());
      });
      backendChild.stderr?.on("data", (chunk: Buffer) => {
        backendLogs.push(chunk.toString());
      });

      backendBaseUrl = await waitForBackendHealthy(backendLogs);
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: testInfo.project.use.headless ?? true,
      args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`]
    });

    try {
      let [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent("serviceworker");
      }
      const extensionId = serviceWorker.url().split("/")[2] ?? "";
      expect(extensionId).not.toHaveLength(0);

      const optionsPage = await context.newPage();
      await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
      await optionsPage.locator("#backend-url").fill(backendBaseUrl);
      await optionsPage.locator("#auto-sync-history").setChecked(true);
      await optionsPage.locator("#settings-form").evaluate((form) => {
        (form as HTMLFormElement).requestSubmit();
      });
      await expect(optionsPage.locator("#save-status")).toHaveText("Settings saved.");

      await serviceWorker.evaluate((skippedId) => {
        return chrome.storage.local.set({
          "tsmc.sync-state": {
            [`gemini:${skippedId}`]: {
              seenMessageIds: ["existing-message"],
              lastSyncedAt: "2026-04-01T11:50:00.000Z"
            }
          }
        });
      }, skippedSessionId);

      await context.route(/^https:\/\/gemini\.google\.com\/app(?:\/.*)?$/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Gemini</title>
  </head>
  <body>
    <input name="at" value="e2e-gemini-token" />
    <script>window.WIZ_global_data = { SNlM0e: "e2e-gemini-token" };</script>
  </body>
</html>`
        });
      });

      await context.route("https://gemini.google.com/_/BardChatUi/data/batchexecute*", async (route) => {
        const url = new URL(route.request().url());
        const rpcId = url.searchParams.get("rpcids");
        const requestArgs = parseGeminiRequestArgs(route.request().postData());

        if (rpcId === "MaZiqc") {
          const pinned = Array.isArray(requestArgs?.[2]) && requestArgs[2]?.[0] === 1;
          const pageToken = typeof requestArgs?.[1] === "string" ? requestArgs[1] : null;
          observedListRequests.push({
            sourcePath: url.searchParams.get("source-path") ?? "",
            pinned,
            pageToken
          });

          if (pinned) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: buildBatchExecuteResponseBody("MaZiqc", buildGeminiListPayload([]))
            });
            return;
          }

          if (!pageToken) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: buildBatchExecuteResponseBody(
                "MaZiqc",
                buildGeminiListPayload(
                  [
                    buildGeminiConversationEntry(sessionId, "Gemini E2E Sync"),
                    buildGeminiConversationEntry(secondSessionId, "Gemini E2E Sync 2")
                  ],
                  "page-2"
                )
              )
            });
            return;
          }

          if (pageToken === "page-2") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: buildBatchExecuteResponseBody(
                "MaZiqc",
                buildGeminiListPayload([
                  buildGeminiConversationEntry(skippedSessionId, "Gemini Previously Synced"),
                  buildGeminiConversationEntry(thirdSessionId, "Gemini E2E Sync 3")
                ])
              )
            });
            return;
          }

          await route.fulfill({
            status: 404,
            contentType: "text/plain",
            body: `Unexpected Gemini list pageToken=${pageToken ?? "missing"}`
          });
          return;
        }

        if (rpcId === "hNvQHb") {
          const conversationId = typeof requestArgs?.[0] === "string" ? requestArgs[0].replace(/^c_/, "") : "";
          const pageToken = typeof requestArgs?.[2] === "string" ? requestArgs[2] : null;
          observedReadRequests.push({ conversationId, pageToken });
          await wait(400);

          if (conversationId === sessionId && !pageToken) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: buildBatchExecuteResponseBody(
                "hNvQHb",
                buildGeminiTurnPayload(
                  [buildGeminiTurnBlock("Explain proactive backfill on Gemini.", "Proactive backfill imports your saved Gemini conversations automatically.", 1711842000, "rc_1")],
                  "turn-page-2"
                )
              )
            });
            return;
          }

          if (conversationId === sessionId && pageToken === "turn-page-2") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: buildBatchExecuteResponseBody(
                "hNvQHb",
                buildGeminiTurnPayload([
                  buildGeminiTurnBlock("How does turn pagination work?", "It follows Gemini next-page tokens until the full conversation is imported.", 1711842030, "rc_2")
                ])
              )
            });
            return;
          }

          if (conversationId === secondSessionId && !pageToken) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: buildBatchExecuteResponseBody(
                "hNvQHb",
                buildGeminiTurnPayload([
                  buildGeminiTurnBlock("How is incremental sync different?", "Incremental sync only sends newly observed messages after the initial import.", 1711842060, "rc_3")
                ])
              )
            });
            return;
          }

          if (conversationId === thirdSessionId && !pageToken) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: buildBatchExecuteResponseBody(
                "hNvQHb",
                buildGeminiTurnPayload([
                  buildGeminiTurnBlock("Does Gemini list pagination work?", "Yes. The importer follows the history next-page token and reaches later conversations too.", 1711842120, "rc_4")
                ])
              )
            });
            return;
          }

          await route.fulfill({
            status: 404,
            contentType: "text/plain",
            body: `Unexpected conversationId=${conversationId || "missing"}`
          });
          return;
        }

        await route.fulfill({
          status: 404,
          contentType: "text/plain",
          body: `Unexpected rpcids=${rpcId ?? "missing"}`
        });
      });

      const page = await context.newPage();
      await page.goto(`https://gemini.google.com/app/${sessionId}`, { waitUntil: "domcontentloaded" });

      await expect
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("tsmc.status");
              return JSON.stringify((stored["tsmc.status"] ??
                {}) as {
                historySyncLastResult?: string;
                historySyncLastError?: string | null;
                historySyncProcessedCount?: number;
                historySyncTotalCount?: number;
                historySyncSkippedCount?: number;
                historySyncLastConversationCount?: number;
              });
            }),
          {
            message: "Waiting for the extension to finish Gemini history sync."
          }
        )
        .toContain('"historySyncLastResult":"success"');

      const completedStatus = (await serviceWorker.evaluate(async () => {
        const stored = await chrome.storage.local.get("tsmc.status");
        return (stored["tsmc.status"] ??
          {}) as {
          historySyncProcessedCount?: number;
          historySyncTotalCount?: number;
          historySyncSkippedCount?: number;
          historySyncLastConversationCount?: number;
        };
      })) as {
        historySyncProcessedCount?: number;
        historySyncTotalCount?: number;
        historySyncSkippedCount?: number;
        historySyncLastConversationCount?: number;
      };

      expect(completedStatus.historySyncProcessedCount).toBe(4);
      expect(completedStatus.historySyncTotalCount).toBe(4);
      expect(completedStatus.historySyncSkippedCount).toBe(1);
      expect(completedStatus.historySyncLastConversationCount).toBe(3);

      await expect
        .poll(
          async () => {
            const response = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=gemini`);
            if (!response.ok()) {
              return null;
            }
            const sessions = (await response.json()) as Array<{ external_session_id: string }>;
            return sessions.find((session) => session.external_session_id === sessionId)?.external_session_id ?? null;
          },
          {
            message: "Waiting for the backend to persist the auto-synced Gemini session."
          }
        )
        .toBe(sessionId);

      const sessionsResponse = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=gemini`);
      expect(sessionsResponse.ok()).toBeTruthy();
      const sessions = (await sessionsResponse.json()) as Array<{
        id: string;
        external_session_id: string;
        title: string | null;
      }>;
      const matchedSession = sessions.find((session) => session.external_session_id === sessionId);
      expect(matchedSession?.title).toBe("Gemini E2E Sync");

      const sessionResponse = await request.get(`${backendBaseUrl}/api/v1/sessions/${matchedSession?.id}`);
      expect(sessionResponse.ok()).toBeTruthy();
      const persisted = (await sessionResponse.json()) as {
        external_session_id: string;
        messages: Array<{ content: string }>;
      };

      expect(persisted.external_session_id).toBe(sessionId);
      expect(persisted.messages.map((message) => message.content)).toEqual([
        "Explain proactive backfill on Gemini.",
        "Proactive backfill imports your saved Gemini conversations automatically.",
        "How does turn pagination work?",
        "It follows Gemini next-page tokens until the full conversation is imported."
      ]);

      const secondSession = sessions.find((session) => session.external_session_id === secondSessionId);
      expect(secondSession?.title).toBe("Gemini E2E Sync 2");
      const thirdSession = sessions.find((session) => session.external_session_id === thirdSessionId);
      expect(thirdSession?.title).toBe("Gemini E2E Sync 3");

      const refreshBaseline = (await serviceWorker.evaluate(async () => {
        const stored = await chrome.storage.local.get("tsmc.status");
        return (stored["tsmc.status"] ??
          {}) as {
          historySyncLastStartedAt?: string;
          historySyncLastCompletedAt?: string;
        };
      })) as {
        historySyncLastStartedAt?: string;
        historySyncLastCompletedAt?: string;
      };
      const readCountAfterInitialSync = observedReadRequests.length;

      await page.reload({ waitUntil: "domcontentloaded" });

      await expect
        .poll(
          async () =>
            serviceWorker.evaluate(async (baseline) => {
              const stored = await chrome.storage.local.get("tsmc.status");
              const status = (stored["tsmc.status"] ??
                {}) as {
                historySyncInProgress?: boolean;
                historySyncLastStartedAt?: string;
                historySyncLastCompletedAt?: string;
                historySyncLastResult?: string;
                historySyncProcessedCount?: number;
                historySyncTotalCount?: number;
                historySyncLastConversationCount?: number;
              };
              return {
                historySyncInProgress: status.historySyncInProgress ?? null,
                reran:
                  Boolean(status.historySyncLastStartedAt) &&
                  status.historySyncLastStartedAt !== baseline.historySyncLastStartedAt &&
                  status.historySyncLastCompletedAt !== baseline.historySyncLastCompletedAt,
                historySyncLastResult: status.historySyncLastResult ?? null,
                historySyncProcessedCount: status.historySyncProcessedCount ?? null,
                historySyncTotalCount: status.historySyncTotalCount ?? null,
                historySyncLastConversationCount: status.historySyncLastConversationCount ?? null
              };
            }, refreshBaseline),
          {
            message: "Waiting for the extension to finish a no-op Gemini refresh sync."
          }
        )
        .toEqual({
          historySyncInProgress: false,
          reran: true,
          historySyncLastResult: "success",
          historySyncProcessedCount: 0,
          historySyncTotalCount: 0,
          historySyncLastConversationCount: 0
        });

      expect(observedReadRequests.slice(readCountAfterInitialSync)).toEqual([]);

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
      await expect(popup.locator("#history-sync")).toContainText("success");
      await expect(popup.locator("#last-session")).toHaveText(
        new RegExp(`^gemini:(${sessionId}|${secondSessionId}|${thirdSessionId})$`)
      );
      await expect(popup.locator("#history-sync")).toContainText("0 conversations");

      expect(observedListRequests.length).toBeGreaterThan(0);
      expect(new Set(observedListRequests.map((request) => request.sourcePath))).toEqual(new Set(["/app"]));
      expect(observedListRequests.some((request) => request.pageToken === "page-2")).toBe(true);
      expect(observedReadRequests.slice(readCountAfterInitialSync)).toEqual([]);
      expect(observedReadRequests).toEqual(
        expect.arrayContaining([
          { conversationId: sessionId, pageToken: null },
          { conversationId: sessionId, pageToken: "turn-page-2" },
          { conversationId: secondSessionId, pageToken: null },
          { conversationId: thirdSessionId, pageToken: null }
        ])
      );
    } finally {
      await context.close();
    }
  } finally {
    await stopBackend(backendProcess);
    await rm(userDataDir, { recursive: true, force: true });
    await rm(backendDataDir, { recursive: true, force: true });
  }
});

test("surfaces provider drift alerts when Gemini history shapes change", async ({}, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "tsmc-extension-e2e-"));

  try {
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: testInfo.project.use.headless ?? true,
      args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`]
    });

    try {
      let [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent("serviceworker");
      }
      const extensionId = serviceWorker.url().split("/")[2] ?? "";
      expect(extensionId).not.toHaveLength(0);

      await context.route(/^https:\/\/gemini\.google\.com\/app(?:\/.*)?$/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Gemini</title>
  </head>
  <body>
    <input name="at" value="e2e-gemini-token" />
    <script>window.WIZ_global_data = { SNlM0e: "e2e-gemini-token" };</script>
  </body>
</html>`
        });
      });

      await context.route("https://gemini.google.com/_/BardChatUi/data/batchexecute*", async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("rpcids") !== "MaZiqc") {
          await route.fulfill({
            status: 404,
            contentType: "text/plain",
            body: "Unexpected RPC"
          });
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: `)]}'\n2\n[]\n`
        });
      });

      const page = await context.newPage();
      await page.goto("https://gemini.google.com/app/drift-test", { waitUntil: "domcontentloaded" });

      await expect
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("tsmc.status");
              return (stored["tsmc.status"] ??
                {}) as {
                historySyncLastResult?: string;
                providerDriftAlert?: { provider?: string; message?: string } | null;
              };
            }),
          {
            message: "Waiting for the extension to report Gemini provider drift."
          }
        )
        .toMatchObject({
          historySyncLastResult: "failed",
          providerDriftAlert: {
            provider: "gemini"
          }
        });

      const badge = await serviceWorker.evaluate(async () => {
        return {
          text: await chrome.action.getBadgeText({}),
          title: await chrome.action.getTitle({})
        };
      });
      expect(badge.text).toBe("!");
      expect(badge.title).toContain("Provider drift suspected for gemini");

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
      await expect(popup.locator("#provider-drift-card")).toBeVisible();
      await expect(popup.locator("#provider-drift")).toContainText("gemini:");
    } finally {
      await context.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("auto-syncs Grok history on provider visit", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "tsmc-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "tsmc-backend-e2e-"));
  const sessionId = "grok-e2e-123456789";
  const secondSessionId = "grok-e2e-987654321";
  const thirdSessionId = "grok-e2e-333333333";
  const skippedSessionId = "grok-e2e-skipped-123456789";
  const backendLogs: string[] = [];
  const observedListPageTokens: Array<string | null> = [];
  const observedResponseConversationIds: string[] = [];
  let backendProcess: ReturnType<typeof spawn> | undefined;
  let backendBaseUrl = configuredBackendBaseUrl();

  try {
    if (backendBaseUrl) {
      await waitForBackendUrlHealthy(backendBaseUrl);
    } else {
      const backendChild = spawn(
        backendPython,
        ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "0"],
        {
          cwd: backendRoot,
          env: {
            ...globalThis.process.env,
            PYTHONUNBUFFERED: "1",
            TSMC_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "tsmc.db")}`,
            TSMC_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            TSMC_LLM_BACKEND: "heuristic"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      backendProcess = backendChild;

      backendChild.stdout?.on("data", (chunk: Buffer) => {
        backendLogs.push(chunk.toString());
      });
      backendChild.stderr?.on("data", (chunk: Buffer) => {
        backendLogs.push(chunk.toString());
      });

      backendBaseUrl = await waitForBackendHealthy(backendLogs);
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: testInfo.project.use.headless ?? true,
      args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`]
    });

    try {
      let [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent("serviceworker");
      }
      const extensionId = serviceWorker.url().split("/")[2] ?? "";
      expect(extensionId).not.toHaveLength(0);

      const optionsPage = await context.newPage();
      await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
      await optionsPage.locator("#backend-url").fill(backendBaseUrl);
      await optionsPage.locator("#auto-sync-history").setChecked(true);
      await optionsPage.locator("#settings-form").evaluate((form) => {
        (form as HTMLFormElement).requestSubmit();
      });
      await expect(optionsPage.locator("#save-status")).toHaveText("Settings saved.");

      await serviceWorker.evaluate((skippedId) => {
        return chrome.storage.local.set({
          "tsmc.sync-state": {
            [`grok:${skippedId}`]: {
              seenMessageIds: ["existing-message"],
              lastSyncedAt: "2026-04-01T11:50:00.000Z"
            }
          }
        });
      }, skippedSessionId);

      await context.route(/^https:\/\/grok\.com(?:\/c\/.*)?$/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Grok</title>
  </head>
  <body>
    <div id="root">Grok</div>
  </body>
</html>`
        });
      });

      await context.route(/^https:\/\/grok\.com\/rest\/app-chat\/conversations(?:\?.*)?$/, async (route) => {
        const url = new URL(route.request().url());
        const pageToken = url.searchParams.get("pageToken");
        observedListPageTokens.push(pageToken);

        if (!pageToken) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              conversations: [
                {
                  conversationId: sessionId,
                  title: "Grok E2E Sync",
                  modifyTime: "2026-04-01T12:00:00.000Z"
                },
                {
                  conversationId: secondSessionId,
                  title: "Grok E2E Sync 2",
                  modifyTime: "2026-04-01T11:58:00.000Z"
                }
              ],
              nextPageToken: "page-2"
            })
          });
          return;
        }

        if (pageToken === "page-2") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              conversations: [
                {
                  conversationId: skippedSessionId,
                  title: "Grok Previously Synced",
                  modifyTime: "2026-04-01T11:55:00.000Z"
                },
                {
                  conversationId: thirdSessionId,
                  title: "Grok E2E Sync 3",
                  modifyTime: "2026-04-01T11:54:00.000Z"
                }
              ]
            })
          });
          return;
        }

        await route.fulfill({
          status: 404,
          contentType: "text/plain",
          body: `Unexpected Grok pageToken=${pageToken ?? "missing"}`
        });
      });

      await context.route("https://grok.com/rest/app-chat/conversations/*/responses?includeThreads=true", async (route) => {
        const match = route.request().url().match(/conversations\/([^/]+)\/responses/);
        const conversationId = match?.[1] ?? "";
        observedResponseConversationIds.push(conversationId);

        if (conversationId === sessionId) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              responses: [
                {
                  responseId: "grok-user-1",
                  sender: "USER",
                  query: "Explain Grok proactive sync.",
                  createTime: "2026-04-01T11:59:00.000Z"
                },
                {
                  responseId: "grok-assistant-1",
                  sender: "ASSISTANT",
                  message: "It backfills Grok conversations from the website history API.",
                  parentResponseId: "grok-user-1",
                  createTime: "2026-04-01T11:59:05.000Z"
                }
              ]
            })
          });
          return;
        }

        if (conversationId === secondSessionId) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              responses: [
                {
                  responseId: "grok-user-2",
                  sender: "USER",
                  query: "How does incremental Grok sync work?",
                  createTime: "2026-04-01T11:58:00.000Z"
                },
                {
                  responseId: "grok-assistant-2",
                  sender: "ASSISTANT",
                  message: "It only sends new network captures after the initial history import.",
                  parentResponseId: "grok-user-2",
                  createTime: "2026-04-01T11:58:05.000Z"
                }
              ]
            })
          });
          return;
        }

        if (conversationId === thirdSessionId) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              responses: [
                {
                  responseId: "grok-user-3",
                  sender: "USER",
                  query: "Does Grok pagination work?",
                  createTime: "2026-04-01T11:54:00.000Z"
                },
                {
                  responseId: "grok-assistant-3",
                  sender: "ASSISTANT",
                  message: "Yes. The importer follows Grok next-page tokens to reach later conversations.",
                  parentResponseId: "grok-user-3",
                  createTime: "2026-04-01T11:54:05.000Z"
                }
              ]
            })
          });
          return;
        }

        await route.fulfill({
          status: 404,
          contentType: "text/plain",
          body: `Unexpected Grok conversationId=${conversationId || "missing"}`
        });
      });

      const page = await context.newPage();
      await page.goto(`https://grok.com/c/${sessionId}`, { waitUntil: "domcontentloaded" });

      await expect
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("tsmc.status");
              return JSON.stringify((stored["tsmc.status"] ??
                {}) as {
                historySyncLastResult?: string;
                historySyncLastError?: string | null;
                historySyncProcessedCount?: number;
                historySyncTotalCount?: number;
                historySyncSkippedCount?: number;
                historySyncLastConversationCount?: number;
              });
            }),
          {
            message: "Waiting for the extension to finish Grok history sync."
          }
        )
        .toContain('"historySyncLastResult":"success"');

      const completedStatus = (await serviceWorker.evaluate(async () => {
        const stored = await chrome.storage.local.get("tsmc.status");
        return (stored["tsmc.status"] ??
          {}) as {
          historySyncProcessedCount?: number;
          historySyncTotalCount?: number;
          historySyncSkippedCount?: number;
          historySyncLastConversationCount?: number;
        };
      })) as {
        historySyncProcessedCount?: number;
        historySyncTotalCount?: number;
        historySyncSkippedCount?: number;
        historySyncLastConversationCount?: number;
      };

      expect(completedStatus.historySyncProcessedCount).toBe(4);
      expect(completedStatus.historySyncTotalCount).toBe(4);
      expect(completedStatus.historySyncSkippedCount).toBe(1);
      expect(completedStatus.historySyncLastConversationCount).toBe(3);

      await expect
        .poll(
          async () => {
            const response = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=grok`);
            if (!response.ok()) {
              return null;
            }
            const sessions = (await response.json()) as Array<{ external_session_id: string }>;
            return sessions.find((session) => session.external_session_id === sessionId)?.external_session_id ?? null;
          },
          {
            message: "Waiting for the backend to persist the auto-synced Grok session."
          }
        )
        .toBe(sessionId);

      const sessionsResponse = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=grok`);
      expect(sessionsResponse.ok()).toBeTruthy();
      const sessions = (await sessionsResponse.json()) as Array<{
        id: string;
        external_session_id: string;
        title: string | null;
      }>;
      const matchedSession = sessions.find((session) => session.external_session_id === sessionId);
      expect(matchedSession?.title).toBe("Grok E2E Sync");

      const sessionResponse = await request.get(`${backendBaseUrl}/api/v1/sessions/${matchedSession?.id}`);
      expect(sessionResponse.ok()).toBeTruthy();
      const persisted = (await sessionResponse.json()) as {
        external_session_id: string;
        messages: Array<{ content: string }>;
      };

      expect(persisted.external_session_id).toBe(sessionId);
      expect(persisted.messages.map((message) => message.content)).toEqual([
        "Explain Grok proactive sync.",
        "It backfills Grok conversations from the website history API."
      ]);

      const secondSession = sessions.find((session) => session.external_session_id === secondSessionId);
      expect(secondSession?.title).toBe("Grok E2E Sync 2");
      const thirdSession = sessions.find((session) => session.external_session_id === thirdSessionId);
      expect(thirdSession?.title).toBe("Grok E2E Sync 3");

      const refreshBaseline = (await serviceWorker.evaluate(async () => {
        const stored = await chrome.storage.local.get("tsmc.status");
        return (stored["tsmc.status"] ??
          {}) as {
          historySyncLastStartedAt?: string;
          historySyncLastCompletedAt?: string;
        };
      })) as {
        historySyncLastStartedAt?: string;
        historySyncLastCompletedAt?: string;
      };
      const responseCountAfterInitialSync = observedResponseConversationIds.length;

      await page.reload({ waitUntil: "domcontentloaded" });

      await expect
        .poll(
          async () =>
            serviceWorker.evaluate(async (baseline) => {
              const stored = await chrome.storage.local.get("tsmc.status");
              const status = (stored["tsmc.status"] ??
                {}) as {
                historySyncInProgress?: boolean;
                historySyncLastStartedAt?: string;
                historySyncLastCompletedAt?: string;
                historySyncLastResult?: string;
                historySyncProcessedCount?: number;
                historySyncTotalCount?: number;
                historySyncLastConversationCount?: number;
              };
              return {
                historySyncInProgress: status.historySyncInProgress ?? null,
                reran:
                  Boolean(status.historySyncLastStartedAt) &&
                  status.historySyncLastStartedAt !== baseline.historySyncLastStartedAt &&
                  status.historySyncLastCompletedAt !== baseline.historySyncLastCompletedAt,
                historySyncLastResult: status.historySyncLastResult ?? null,
                historySyncProcessedCount: status.historySyncProcessedCount ?? null,
                historySyncTotalCount: status.historySyncTotalCount ?? null,
                historySyncLastConversationCount: status.historySyncLastConversationCount ?? null
              };
            }, refreshBaseline),
          {
            message: "Waiting for the extension to finish a no-op Grok refresh sync."
          }
        )
        .toEqual({
          historySyncInProgress: false,
          reran: true,
          historySyncLastResult: "success",
          historySyncProcessedCount: 0,
          historySyncTotalCount: 0,
          historySyncLastConversationCount: 0
        });

      expect(observedResponseConversationIds.slice(responseCountAfterInitialSync)).toEqual([]);
      expect(observedListPageTokens).toEqual(expect.arrayContaining([null, "page-2"]));

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
      await expect(popup.locator("#history-sync")).toContainText("success");
      await expect(popup.locator("#last-session")).toHaveText(
        new RegExp(`^grok:(${sessionId}|${secondSessionId}|${thirdSessionId})$`)
      );
      await expect(popup.locator("#history-sync")).toContainText("0 conversations");
    } finally {
      await context.close();
    }
  } finally {
    await stopBackend(backendProcess);
    await rm(userDataDir, { recursive: true, force: true });
    await rm(backendDataDir, { recursive: true, force: true });
  }
});

test("falls back to Grok response-node and load-responses when direct responses are empty", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "tsmc-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "tsmc-backend-e2e-"));
  const sessionId = "grok-e2e-fallback-123456789";
  const backendLogs: string[] = [];
  const observedRoutes: string[] = [];
  let backendProcess: ReturnType<typeof spawn> | undefined;
  let backendBaseUrl = configuredBackendBaseUrl();

  try {
    if (backendBaseUrl) {
      await waitForBackendUrlHealthy(backendBaseUrl);
    } else {
      const backendChild = spawn(
        backendPython,
        ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "0"],
        {
          cwd: backendRoot,
          env: {
            ...globalThis.process.env,
            PYTHONUNBUFFERED: "1",
            TSMC_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "tsmc.db")}`,
            TSMC_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            TSMC_LLM_BACKEND: "heuristic"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      backendProcess = backendChild;

      backendChild.stdout?.on("data", (chunk: Buffer) => {
        backendLogs.push(chunk.toString());
      });
      backendChild.stderr?.on("data", (chunk: Buffer) => {
        backendLogs.push(chunk.toString());
      });

      backendBaseUrl = await waitForBackendHealthy(backendLogs);
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: testInfo.project.use.headless ?? true,
      args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`]
    });

    try {
      let [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent("serviceworker");
      }
      const extensionId = serviceWorker.url().split("/")[2] ?? "";
      expect(extensionId).not.toHaveLength(0);

      const optionsPage = await context.newPage();
      await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
      await optionsPage.locator("#backend-url").fill(backendBaseUrl);
      await optionsPage.locator("#auto-sync-history").setChecked(true);
      await optionsPage.locator("#settings-form").evaluate((form) => {
        (form as HTMLFormElement).requestSubmit();
      });
      await expect(optionsPage.locator("#save-status")).toHaveText("Settings saved.");

      await context.route(/^https:\/\/grok\.com(?:\/c\/.*)?$/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Grok</title>
  </head>
  <body>
    <div id="root">Grok</div>
  </body>
</html>`
        });
      });

      await context.route(/^https:\/\/grok\.com\/rest\/app-chat\/conversations(?:\?.*)?$/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            conversations: [
              {
                conversationId: sessionId,
                title: "Grok Fallback Sync",
                modifyTime: "2026-04-01T12:00:00.000Z"
              }
            ]
          })
        });
      });

      await context.route(`https://grok.com/rest/app-chat/conversations/${sessionId}/responses?includeThreads=true`, async (route) => {
        observedRoutes.push("responses");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            responses: []
          })
        });
      });

      await context.route(`https://grok.com/rest/app-chat/conversations/${sessionId}/response-node?includeThreads=true`, async (route) => {
        observedRoutes.push("response-node");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            responseNodes: [
              {
                responseId: "grok-user-fallback"
              },
              {
                responseId: "grok-assistant-fallback"
              }
            ]
          })
        });
      });

      await context.route(`https://grok.com/rest/app-chat/conversations/${sessionId}/load-responses`, async (route) => {
        observedRoutes.push("load-responses");
        expect(route.request().method()).toBe("POST");
        expect(route.request().postDataJSON()).toEqual({
          responseIds: ["grok-user-fallback", "grok-assistant-fallback"]
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            responses: [
              {
                responseId: "grok-user-fallback",
                sender: "USER",
                query: "Explain the fallback path.",
                createTime: "2026-04-01T11:59:00.000Z"
              },
              {
                responseId: "grok-assistant-fallback",
                sender: "ASSISTANT",
                message: "The importer can recover through response-node and load-responses.",
                parentResponseId: "grok-user-fallback",
                createTime: "2026-04-01T11:59:05.000Z"
              }
            ]
          })
        });
      });

      const page = await context.newPage();
      await page.goto(`https://grok.com/c/${sessionId}`, { waitUntil: "domcontentloaded" });

      await expect
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("tsmc.status");
              return (
                (stored["tsmc.status"] as { historySyncLastResult?: string } | undefined)?.historySyncLastResult ??
                null
              );
            }),
          {
            message: "Waiting for the extension to finish Grok fallback history sync."
          }
        )
        .toBe("success");

      await expect
        .poll(
          async () => {
            const response = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=grok`);
            if (!response.ok()) {
              return null;
            }
            const sessions = (await response.json()) as Array<{ external_session_id: string }>;
            return sessions.find((session) => session.external_session_id === sessionId)?.external_session_id ?? null;
          },
          {
            message: "Waiting for the backend to persist the Grok fallback session."
          }
        )
        .toBe(sessionId);

      const sessionsResponse = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=grok`);
      expect(sessionsResponse.ok()).toBeTruthy();
      const sessions = (await sessionsResponse.json()) as Array<{
        id: string;
        external_session_id: string;
        title: string | null;
      }>;
      const matchedSession = sessions.find((session) => session.external_session_id === sessionId);
      expect(matchedSession?.title).toBe("Grok Fallback Sync");

      const sessionResponse = await request.get(`${backendBaseUrl}/api/v1/sessions/${matchedSession?.id}`);
      expect(sessionResponse.ok()).toBeTruthy();
      const persisted = (await sessionResponse.json()) as {
        external_session_id: string;
        messages: Array<{ content: string }>;
      };
      expect(persisted.external_session_id).toBe(sessionId);
      expect(persisted.messages.map((message) => message.content)).toEqual([
        "Explain the fallback path.",
        "The importer can recover through response-node and load-responses."
      ]);
      expect(observedRoutes).toEqual(["responses", "response-node", "load-responses"]);
    } finally {
      await context.close();
    }
  } finally {
    await stopBackend(backendProcess);
    await rm(userDataDir, { recursive: true, force: true });
    await rm(backendDataDir, { recursive: true, force: true });
  }
});

test("surfaces provider drift alerts when Grok history shapes change", async ({}, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "tsmc-extension-e2e-"));

  try {
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: testInfo.project.use.headless ?? true,
      args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`]
    });

    try {
      let [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent("serviceworker");
      }
      const extensionId = serviceWorker.url().split("/")[2] ?? "";
      expect(extensionId).not.toHaveLength(0);

      await context.route(/^https:\/\/grok\.com(?:\/c\/.*)?$/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Grok</title>
  </head>
  <body>
    <div id="root">Grok</div>
  </body>
</html>`
        });
      });

      await context.route(/^https:\/\/grok\.com\/rest\/app-chat\/conversations(?:\?.*)?$/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            unexpected: true
          })
        });
      });

      const page = await context.newPage();
      await page.goto("https://grok.com/c/drift-test", { waitUntil: "domcontentloaded" });

      await expect
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("tsmc.status");
              return (stored["tsmc.status"] ??
                {}) as {
                historySyncLastResult?: string;
                providerDriftAlert?: { provider?: string; message?: string } | null;
              };
            }),
          {
            message: "Waiting for the extension to report Grok provider drift."
          }
        )
        .toMatchObject({
          historySyncLastResult: "failed",
          providerDriftAlert: {
            provider: "grok"
          }
        });

      const badge = await serviceWorker.evaluate(async () => {
        return {
          text: await chrome.action.getBadgeText({}),
          title: await chrome.action.getTitle({})
        };
      });
      expect(badge.text).toBe("!");
      expect(badge.title).toContain("Provider drift suspected for grok");

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
      await expect(popup.locator("#provider-drift-card")).toBeVisible();
      await expect(popup.locator("#provider-drift")).toContainText("grok:");
    } finally {
      await context.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
