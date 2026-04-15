import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { chromium, expect, test, type APIRequestContext } from "@playwright/test";

const currentDir = fileURLToPath(new URL(".", import.meta.url));
const extensionRoot = resolve(currentDir, "..");
const projectRoot = resolve(extensionRoot, "..");
const backendRoot = resolve(projectRoot, "backend");
const extensionDist = resolve(extensionRoot, "dist");
const backendPython = resolve(backendRoot, ".venv/bin/python");
const HEALTHCHECK_TIMEOUT_MS = 15_000;
const EVENTUAL_TIMEOUT_MS = 30_000;
const eventually = expect.configure({ timeout: EVENTUAL_TIMEOUT_MS });

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
  const value = globalThis.process.env.SAVEMYCONTEXT_E2E_BACKEND_URL?.trim();
  return value ? value.replace(/\/$/, "") : null;
}

function parseProcessingPromptTasks(prompt: string): Array<{
  task_key?: string;
  source_session_id?: string;
  transcript?: string;
}> {
  const match = prompt.match(/Tasks:\n([\s\S]+)$/);
  if (!match?.[1]) {
    return [];
  }

  try {
    const parsed = JSON.parse(match[1]) as Array<{
      task_key?: string;
      source_session_id?: string;
      transcript?: string;
    }>;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseExpectedProcessingTaskKeys(prompt: string): string[] {
  const taskKeys = parseProcessingPromptTasks(prompt)
    .map((task) => ("task_key" in task ? (task as { task_key?: string }).task_key : undefined))
    .filter((value): value is string => Boolean(value));
  if (taskKeys.length) {
    return taskKeys;
  }

  const match = prompt.match(/Expected task_keys:\s*([^\n]+)/);
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
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

async function ingestDiff(
  request: APIRequestContext,
  backendBaseUrl: string,
  payload: Record<string, unknown>
): Promise<void> {
  const response = await request.post(`${backendBaseUrl}/api/v1/ingest/diff`, {
    data: payload
  });
  expect(response.status()).toBe(202);
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
  const userDataDir = await mkdtemp(join(tmpdir(), "savemycontext-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "savemycontext-backend-e2e-"));
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
            SAVEMYCONTEXT_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "savemycontext.db")}`,
            SAVEMYCONTEXT_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            SAVEMYCONTEXT_LLM_BACKEND: "heuristic"
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

      await eventually
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("savemycontext.status");
              return (
                (stored["savemycontext.status"] as { historySyncLastResult?: string } | undefined)?.historySyncLastResult ??
                null
              );
            }),
          {
            message: "Waiting for the extension to finish ChatGPT history sync."
          }
        )
        .toBe("success");

      await eventually
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

test("skips indexing when trigger-word mode is enabled and the opening request does not match", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "savemycontext-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "savemycontext-backend-e2e-"));
  const sessionId = `e2e-chatgpt-trigger-skip-${Date.now()}`;
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
            SAVEMYCONTEXT_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "savemycontext.db")}`,
            SAVEMYCONTEXT_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            SAVEMYCONTEXT_LLM_BACKEND: "heuristic"
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
      await optionsPage.locator("#indexing-mode-trigger").setChecked(true);
      await optionsPage.locator("#trigger-words").fill("lorem");
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
                title: "E2E Trigger Skip"
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
            title: "E2E Trigger Skip",
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
                  content: { parts: ["Please keep this planning thread out of SaveMyContext for now."] }
                }
              },
              assistantNode: {
                id: "assistantNode",
                parent: "msg-user",
                message: {
                  id: "msg-assistant",
                  author: { role: "assistant" },
                  create_time: 1711842060,
                  content: { parts: ["Understood, I will keep it separate."] }
                }
              }
            },
            current_node: "assistantNode"
          })
        });
      });

      const page = await context.newPage();
      await page.goto(conversationUrl, { waitUntil: "domcontentloaded" });

      await eventually
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("savemycontext.status");
              return (stored["savemycontext.status"] ??
                {}) as {
                lastIndexingDecision?: string;
                lastIndexingReason?: string | null;
              };
            }),
          {
            message: "Waiting for the extension to record a skipped indexing decision."
          }
        )
        .toMatchObject({
          lastIndexingDecision: "skipped"
        });

      const sessionsResponse = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=chatgpt`);
      expect(sessionsResponse.ok()).toBeTruthy();
      const sessions = (await sessionsResponse.json()) as Array<{ external_session_id: string }>;
      expect(sessions).toHaveLength(0);

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
      await expect(popup.locator("#last-error")).toHaveText("None");
    } finally {
      await context.close();
    }
  } finally {
    await stopBackend(backendProcess);
    await rm(userDataDir, { recursive: true, force: true });
    await rm(backendDataDir, { recursive: true, force: true });
  }
});

test("runs queued AI processing from the popup through the signed-in provider tab", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "savemycontext-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "savemycontext-backend-e2e-"));
  const pendingSessionId = "processing-source-session";
  const secondPendingSessionId = "processing-source-session-2";
  const backendLogs: string[] = [];
  const observedPrompts: string[] = [];
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
            SAVEMYCONTEXT_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "savemycontext.db")}`,
            SAVEMYCONTEXT_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            SAVEMYCONTEXT_LLM_BACKEND: "browser_proxy",
            SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION: "true",
            SAVEMYCONTEXT_BROWSER_LLM_MODEL: "browser-chatgpt"
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

      const ingestResponse = await request.post(`${backendBaseUrl}/api/v1/ingest/diff`, {
        data: {
          provider: "gemini",
          external_session_id: pendingSessionId,
          sync_mode: "full_snapshot",
          title: "Pending Processing Session",
          source_url: `https://gemini.google.com/app/${pendingSessionId}`,
          captured_at: "2026-04-02T12:00:00.000Z",
          messages: [
            {
              external_message_id: "msg-1",
              role: "user",
              content: "I need to plan tomorrow and review today's work."
            }
          ],
          raw_capture: { source: "e2e-processing" }
        }
      });
      expect(ingestResponse.ok()).toBeTruthy();
      const secondIngestResponse = await request.post(`${backendBaseUrl}/api/v1/ingest/diff`, {
        data: {
          provider: "gemini",
          external_session_id: secondPendingSessionId,
          sync_mode: "full_snapshot",
          title: "Pending Processing Session 2",
          source_url: `https://gemini.google.com/app/${secondPendingSessionId}`,
          captured_at: "2026-04-02T12:05:00.000Z",
          messages: [
            {
              external_message_id: "msg-2",
              role: "user",
              content: "Explain how FastAPI uses uvloop."
            }
          ],
          raw_capture: { source: "e2e-processing" }
        }
      });
      expect(secondIngestResponse.ok()).toBeTruthy();

      await context.route(/^https:\/\/chatgpt\.com(?:\/.*)?$/, async (route) => {
        if (route.request().resourceType() !== "document") {
          await route.fulfill({
            status: 204,
            body: ""
          });
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>ChatGPT</title>
  </head>
  <body>
    <main>
      <textarea id="prompt-textarea"></textarea>
      <button data-testid="send-button" type="button">Send</button>
      <section id="responses"></section>
    </main>
    <script>
      const textarea = document.querySelector("#prompt-textarea");
      const sendButton = document.querySelector("[data-testid='send-button']");
      const responses = document.querySelector("#responses");
      sendButton.addEventListener("click", async () => {
        const prompt = textarea.value;
        const response = await fetch("/backend-api/conversation/processing-worker", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt })
        });
        const data = await response.json();
        const article = document.createElement("article");
        const assistant = document.createElement("div");
        assistant.setAttribute("data-message-author-role", "assistant");
        assistant.textContent = data.messages[data.messages.length - 1].content;
        article.appendChild(assistant);
        responses.appendChild(article);
      });
    </script>
  </body>
</html>`
        });
      });

      await context.route("https://chatgpt.com/backend-api/conversation/processing-worker", async (route) => {
        const payload = route.request().postDataJSON() as { prompt?: string } | null;
        observedPrompts.push(payload?.prompt ?? "");
        const taskRefs = parseProcessingPromptTasks(payload?.prompt ?? "");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            conversation_id: "worker-chat-session",
            title: "SaveMyContext Processing Worker",
            messages: [
              {
                id: "worker-user-1",
                role: "user",
                content: payload?.prompt ?? ""
              },
              {
                id: "worker-assistant-1",
                parent: "worker-user-1",
                role: "assistant",
                content: JSON.stringify({
                  results: taskRefs.map((task) => {
                    if (task.source_session_id === secondPendingSessionId) {
                      return {
                        task_key: task.task_key,
                        category: "factual",
                        classification_reason: "This is a technical explanation request.",
                        journal: null,
                        factual_triplets: [
                          {
                            subject: "FastAPI",
                            predicate: "uses",
                            object: "uvloop",
                            confidence: 0.93
                          }
                        ],
                        idea: null
                      };
                    }

                    return {
                      task_key: task.task_key,
                      category: "journal",
                      classification_reason: "This is personal planning and reflection.",
                      journal: {
                        entry: "Planned the next day and reviewed progress from today.",
                        action_items: ["Review the release checklist", "Write tomorrow's priorities"]
                      },
                      factual_triplets: [],
                      idea: null
                    };
                  })
                })
              }
            ]
          })
        });
      });

      const workerPage = await context.newPage();
      await workerPage.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });

      await expect(popup.locator("#processing-pending")).toHaveText("2");
      await expect(popup.locator("#run-processing")).toBeEnabled();

      await popup.locator("#run-processing").click();

      await eventually
        .poll(
          async () => {
            const response = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=gemini`);
            if (!response.ok()) {
              return null;
            }
            const sessions = (await response.json()) as Array<{
              id: string;
              external_session_id: string;
              category: string | null;
            }>;
            const firstCategory = sessions.find((session) => session.external_session_id === pendingSessionId)?.category ?? null;
            const secondCategory =
              sessions.find((session) => session.external_session_id === secondPendingSessionId)?.category ?? null;
            return `${firstCategory ?? "null"}:${secondCategory ?? "null"}`;
          },
          {
            message: "Waiting for the extension worker to finish queued AI processing."
          }
        )
        .toBe("journal:factual");

      const sessionsResponse = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=gemini`);
      expect(sessionsResponse.ok()).toBeTruthy();
      const sessions = (await sessionsResponse.json()) as Array<{
        id: string;
        external_session_id: string;
        category: string | null;
      }>;
      const matchedSession = sessions.find((session) => session.external_session_id === pendingSessionId);
      const matchedSecondSession = sessions.find((session) => session.external_session_id === secondPendingSessionId);
      expect(matchedSession?.category).toBe("journal");
      expect(matchedSecondSession?.category).toBe("factual");

      const sessionResponse = await request.get(`${backendBaseUrl}/api/v1/sessions/${matchedSession?.id}`);
      expect(sessionResponse.ok()).toBeTruthy();
      const persisted = (await sessionResponse.json()) as {
        category: string | null;
        journal_entry: string | null;
        classification_reason: string | null;
      };

      expect(persisted.category).toBe("journal");
      expect(persisted.classification_reason).toContain("personal planning");
      expect(persisted.journal_entry).toContain("Planned the next day");

      const secondSessionResponse = await request.get(`${backendBaseUrl}/api/v1/sessions/${matchedSecondSession?.id}`);
      expect(secondSessionResponse.ok()).toBeTruthy();
      const secondPersisted = (await secondSessionResponse.json()) as {
        category: string | null;
        triplets: Array<{ subject: string; predicate: string; object: string }>;
        classification_reason: string | null;
      };

      expect(secondPersisted.category).toBe("factual");
      expect(secondPersisted.classification_reason).toContain("technical explanation");
      expect(secondPersisted.triplets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subject: "FastAPI",
            predicate: "uses",
            object: "uvloop"
          })
        ])
      );

      const workerSessionsResponse = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=chatgpt`);
      expect(workerSessionsResponse.ok()).toBeTruthy();
      const workerSessions = (await workerSessionsResponse.json()) as Array<{ external_session_id: string }>;
      expect(workerSessions).toHaveLength(0);

      await eventually
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("savemycontext.status");
              return (stored["savemycontext.status"] ??
                {}) as {
                processingInProgress?: boolean;
                processingPendingCount?: number;
                processingProcessedCount?: number;
                processingLastError?: string | null;
              };
            }),
          {
            message: "Waiting for the popup state to reflect the completed AI processing run."
          }
        )
        .toMatchObject({
          processingInProgress: false,
          processingPendingCount: 0,
          processingProcessedCount: 2,
          processingLastError: null
        });

      expect(observedPrompts).toHaveLength(1);
      expect(observedPrompts[0]).toContain("Use fast mode.");
      expect(observedPrompts[0]).toContain(`"source_session_id":"${pendingSessionId}"`);
      expect(observedPrompts[0]).toContain(`"source_session_id":"${secondPendingSessionId}"`);
      expect(observedPrompts[0]).toContain("I need to plan tomorrow and review today's work.");
      expect(observedPrompts[0]).toContain("Explain how FastAPI uses uvloop.");

      await expect(popup.locator("#processing-pending")).toHaveText("0");
      await expect(popup.locator("#processing-status")).toContainText("browser-chatgpt");
      await expect(popup.locator("#last-error")).toHaveText("None");

      await serviceWorker.evaluate(async () => {
        const stored = await chrome.storage.local.get("savemycontext.status");
        await chrome.storage.local.set({
          "savemycontext.status": {
            ...(stored["savemycontext.status"] ?? {}),
            processingLastError: "stale processing error"
          }
        });
      });

      await popup.reload({ waitUntil: "domcontentloaded" });
      await expect(popup.locator("#processing-status")).not.toContainText("Failed:");
      await expect(popup.locator("#last-error")).toHaveText("None");
    } finally {
      await context.close();
    }
  } finally {
    await stopBackend(backendProcess);
    await rm(userDataDir, { recursive: true, force: true });
    await rm(backendDataDir, { recursive: true, force: true });
  }
});

test("salvages a partial batched AI processing reply and continues with the remaining queued task", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "savemycontext-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "savemycontext-backend-e2e-"));
  const firstPendingSessionId = "processing-partial-session-1";
  const secondPendingSessionId = "processing-partial-session-2";
  const backendLogs: string[] = [];
  const observedPrompts: string[] = [];
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
            SAVEMYCONTEXT_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "savemycontext.db")}`,
            SAVEMYCONTEXT_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            SAVEMYCONTEXT_LLM_BACKEND: "browser_proxy",
            SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION: "true",
            SAVEMYCONTEXT_BROWSER_LLM_MODEL: "browser-chatgpt"
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

      const firstIngestResponse = await request.post(`${backendBaseUrl}/api/v1/ingest/diff`, {
        data: {
          provider: "gemini",
          external_session_id: firstPendingSessionId,
          sync_mode: "full_snapshot",
          title: "Partial Processing Session 1",
          source_url: `https://gemini.google.com/app/${firstPendingSessionId}`,
          captured_at: "2026-04-02T13:00:00.000Z",
          messages: [
            {
              external_message_id: "partial-msg-1",
              role: "user",
              content: "Summarize this into a personal journal note."
            }
          ],
          raw_capture: { source: "e2e-processing-partial" }
        }
      });
      expect(firstIngestResponse.ok()).toBeTruthy();

      const secondIngestResponse = await request.post(`${backendBaseUrl}/api/v1/ingest/diff`, {
        data: {
          provider: "gemini",
          external_session_id: secondPendingSessionId,
          sync_mode: "full_snapshot",
          title: "Partial Processing Session 2",
          source_url: `https://gemini.google.com/app/${secondPendingSessionId}`,
          captured_at: "2026-04-02T13:05:00.000Z",
          messages: [
            {
              external_message_id: "partial-msg-2",
              role: "user",
              content: "Explain how FastAPI uses uvloop."
            }
          ],
          raw_capture: { source: "e2e-processing-partial" }
        }
      });
      expect(secondIngestResponse.ok()).toBeTruthy();

      await context.route(/^https:\/\/chatgpt\.com(?:\/.*)?$/, async (route) => {
        if (route.request().resourceType() !== "document") {
          await route.fulfill({
            status: 204,
            body: ""
          });
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>ChatGPT</title>
  </head>
  <body>
    <main>
      <textarea id="prompt-textarea"></textarea>
      <button data-testid="send-button" type="button">Send</button>
      <section id="responses"></section>
    </main>
    <script>
      const textarea = document.querySelector("#prompt-textarea");
      const sendButton = document.querySelector("[data-testid='send-button']");
      const responses = document.querySelector("#responses");
      sendButton.addEventListener("click", async () => {
        const prompt = textarea.value;
        const response = await fetch("/backend-api/conversation/processing-worker", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt })
        });
        const data = await response.json();
        const article = document.createElement("article");
        const assistant = document.createElement("div");
        assistant.setAttribute("data-message-author-role", "assistant");
        assistant.textContent = data.messages[data.messages.length - 1].content;
        article.appendChild(assistant);
        responses.appendChild(article);
      });
    </script>
  </body>
</html>`
        });
      });

      await context.route("https://chatgpt.com/backend-api/conversation/processing-worker", async (route) => {
        const payload = route.request().postDataJSON() as { prompt?: string } | null;
        observedPrompts.push(payload?.prompt ?? "");
        const taskRefs = parseProcessingPromptTasks(payload?.prompt ?? "");
        const journalTask = taskRefs.find((task) => task.source_session_id === firstPendingSessionId) ?? taskRefs[0];
        const assistantContent =
          observedPrompts.length === 1
            ? JSON.stringify({
                results: [
                  {
                    task_key: journalTask?.task_key ?? "task_1",
                    category: "journal",
                    classification_reason: "Personal planning and reflection.",
                    journal: {
                      entry: "Captured the personal planning request as a journal note.",
                      action_items: ["Review tomorrow's priorities"]
                    },
                    factual_triplets: [],
                    idea: null
                  }
                ]
              })
            : JSON.stringify({
                results: taskRefs.map((task) => ({
                  task_key: task.task_key,
                  category: "factual",
                  classification_reason: "Technical explanation request.",
                  journal: null,
                  factual_triplets: [
                    {
                      subject: "FastAPI",
                      predicate: "uses",
                      object: "uvloop",
                      confidence: 0.92
                    }
                  ],
                  idea: null
                }))
              });

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            conversation_id: "worker-chat-session",
            title: "SaveMyContext Processing Worker",
            messages: [
              {
                id: `worker-user-${observedPrompts.length}`,
                role: "user",
                content: payload?.prompt ?? ""
              },
              {
                id: `worker-assistant-${observedPrompts.length}`,
                parent: `worker-user-${observedPrompts.length}`,
                role: "assistant",
                content: assistantContent
              }
            ]
          })
        });
      });

      const workerPage = await context.newPage();
      await workerPage.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });

      await expect(popup.locator("#processing-pending")).toHaveText("2");
      await popup.locator("#run-processing").click();

      await eventually
        .poll(
          async () => {
            const response = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=gemini`);
            if (!response.ok()) {
              return null;
            }
            const sessions = (await response.json()) as Array<{
              external_session_id: string;
              category: string | null;
            }>;
            const firstCategory = sessions.find((session) => session.external_session_id === firstPendingSessionId)?.category ?? null;
            const secondCategory =
              sessions.find((session) => session.external_session_id === secondPendingSessionId)?.category ?? null;
            return `${firstCategory ?? "null"}:${secondCategory ?? "null"}`;
          },
          {
            message: "Waiting for the extension to salvage the first processing result and continue with the second queued task."
          }
        )
        .toBe("journal:factual");

      expect(observedPrompts).toHaveLength(2);
      expect(observedPrompts[0]).toContain(`"source_session_id":"${firstPendingSessionId}"`);
      expect(observedPrompts[0]).toContain(`"source_session_id":"${secondPendingSessionId}"`);
      expect(observedPrompts[1]).toContain(`"source_session_id":"${secondPendingSessionId}"`);
      expect(observedPrompts[1]).not.toContain(`"source_session_id":"${firstPendingSessionId}"`);
      expect(observedPrompts[1]).toContain('"task_key":"task_1"');

      await eventually
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("savemycontext.status");
              return (stored["savemycontext.status"] ??
                {}) as {
                processingInProgress?: boolean;
                processingPendingCount?: number;
                processingProcessedCount?: number;
                processingLastError?: string | null;
              };
            }),
          {
            message: "Waiting for the popup state to reflect the salvaged processing run."
          }
        )
        .toMatchObject({
          processingInProgress: false,
          processingPendingCount: 0,
          processingProcessedCount: 2,
          processingLastError: null
        });

      await expect(popup.locator("#last-error")).toHaveText("None");
    } finally {
      await context.close();
    }
  } finally {
    await stopBackend(backendProcess);
    await rm(userDataDir, { recursive: true, force: true });
    await rm(backendDataDir, { recursive: true, force: true });
  }
});

test("repairs malformed processing JSON by retrying in the provider tab", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "savemycontext-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "savemycontext-backend-e2e-"));
  const pendingSessionId = "processing-repair-session";
  const backendLogs: string[] = [];
  const observedPrompts: string[] = [];
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
            SAVEMYCONTEXT_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "savemycontext.db")}`,
            SAVEMYCONTEXT_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            SAVEMYCONTEXT_LLM_BACKEND: "browser_proxy",
            SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION: "true",
            SAVEMYCONTEXT_BROWSER_LLM_MODEL: "browser-chatgpt"
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

      const ingestResponse = await request.post(`${backendBaseUrl}/api/v1/ingest/diff`, {
        data: {
          provider: "gemini",
          external_session_id: pendingSessionId,
          sync_mode: "full_snapshot",
          title: "Pending Processing Repair Session",
          source_url: `https://gemini.google.com/app/${pendingSessionId}`,
          captured_at: "2026-04-02T12:00:00.000Z",
          messages: [
            {
              external_message_id: "repair-msg-1",
              role: "user",
              content: "Turn this into a personal planning journal note."
            }
          ],
          raw_capture: { source: "e2e-processing-repair" }
        }
      });
      expect(ingestResponse.ok()).toBeTruthy();

      await context.route(/^https:\/\/chatgpt\.com(?:\/.*)?$/, async (route) => {
        if (route.request().resourceType() !== "document") {
          await route.fulfill({
            status: 204,
            body: ""
          });
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>ChatGPT</title>
  </head>
  <body>
    <main>
      <textarea id="prompt-textarea"></textarea>
      <button data-testid="send-button" type="button">Send</button>
      <section id="responses"></section>
    </main>
    <script>
      const textarea = document.querySelector("#prompt-textarea");
      const sendButton = document.querySelector("[data-testid='send-button']");
      const responses = document.querySelector("#responses");
      sendButton.addEventListener("click", async () => {
        const prompt = textarea.value;
        const response = await fetch("/backend-api/conversation/processing-worker", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt })
        });
        const data = await response.json();
        const article = document.createElement("article");
        const assistant = document.createElement("div");
        assistant.setAttribute("data-message-author-role", "assistant");
        assistant.textContent = data.messages[data.messages.length - 1].content;
        article.appendChild(assistant);
        responses.appendChild(article);
      });
    </script>
  </body>
</html>`
        });
      });

      await context.route("https://chatgpt.com/backend-api/conversation/processing-worker", async (route) => {
        const payload = route.request().postDataJSON() as { prompt?: string } | null;
        observedPrompts.push(payload?.prompt ?? "");
        const taskKeys = parseExpectedProcessingTaskKeys(payload?.prompt ?? "");
        const assistantContent =
          observedPrompts.length === 1
            ? `{"results":[{"task_key":"${taskKeys[0] ?? "task_1"}","category":"journal","classification_reason":"Personal planning and reflection.","journal":{"entry":"Drafted tomorrow priorities`
            : JSON.stringify({
                results: taskKeys.map((taskKey) => ({
                  task_key: taskKey,
                  category: "journal",
                  classification_reason: "Personal planning and reflection.",
                  journal: {
                    entry: "Drafted tomorrow priorities and reviewed the release checklist.",
                    action_items: ["Review the release checklist"]
                  },
                  factual_triplets: [],
                  idea: null
                }))
              });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            conversation_id: "worker-chat-session",
            title: "SaveMyContext Processing Worker",
            messages: [
              {
                id: `worker-user-${observedPrompts.length}`,
                role: "user",
                content: payload?.prompt ?? ""
              },
              {
                id: `worker-assistant-${observedPrompts.length}`,
                parent: `worker-user-${observedPrompts.length}`,
                role: "assistant",
                content: assistantContent
              }
            ]
          })
        });
      });

      const workerPage = await context.newPage();
      await workerPage.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });

      await expect(popup.locator("#processing-pending")).toHaveText("1");
      await popup.locator("#run-processing").click();

      await eventually
        .poll(
          async () => {
            const response = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=gemini`);
            if (!response.ok()) {
              return null;
            }
            const sessions = (await response.json()) as Array<{
              id: string;
              external_session_id: string;
              category: string | null;
            }>;
            return sessions.find((session) => session.external_session_id === pendingSessionId)?.category ?? null;
          },
          {
            message: "Waiting for the extension worker to repair and complete queued AI processing."
          }
        )
        .toBe("journal");

      const sessionResponse = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=gemini`);
      expect(sessionResponse.ok()).toBeTruthy();
      const sessions = (await sessionResponse.json()) as Array<{
        id: string;
        external_session_id: string;
        category: string | null;
      }>;
      const matchedSession = sessions.find((session) => session.external_session_id === pendingSessionId);
      expect(matchedSession?.category).toBe("journal");

      expect(observedPrompts).toHaveLength(2);
      expect(observedPrompts[0]).toContain("Use fast mode.");
      expect(observedPrompts[0]).toContain('"results"');
      expect(observedPrompts[0]).toContain('"task_key":"task_1"');
      expect(observedPrompts[1]).toContain("Repair it and return exactly one valid JSON object.");
      expect(observedPrompts[1]).toContain("Could not parse the processing response as valid JSON");
      expect(observedPrompts[1]).toContain("Expected task_keys:");
      expect(observedPrompts[1]).toContain("complete JSON object");

      const workerSessionsResponse = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=chatgpt`);
      expect(workerSessionsResponse.ok()).toBeTruthy();
      const workerSessions = (await workerSessionsResponse.json()) as Array<{ external_session_id: string }>;
      expect(workerSessions).toHaveLength(0);

      await expect(popup.locator("#last-error")).toHaveText("None");
    } finally {
      await context.close();
    }
  } finally {
    await stopBackend(backendProcess);
    await rm(userDataDir, { recursive: true, force: true });
    await rm(backendDataDir, { recursive: true, force: true });
  }
});

test("waits for provider generation to finish before attempting JSON repair", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "savemycontext-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "savemycontext-backend-e2e-"));
  const pendingSessionId = "processing-wait-session";
  const backendLogs: string[] = [];
  const observedPrompts: string[] = [];
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
            SAVEMYCONTEXT_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "savemycontext.db")}`,
            SAVEMYCONTEXT_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            SAVEMYCONTEXT_LLM_BACKEND: "browser_proxy",
            SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION: "true",
            SAVEMYCONTEXT_BROWSER_LLM_MODEL: "browser-chatgpt"
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

      const ingestResponse = await request.post(`${backendBaseUrl}/api/v1/ingest/diff`, {
        data: {
          provider: "gemini",
          external_session_id: pendingSessionId,
          sync_mode: "full_snapshot",
          title: "Pending Processing Wait Session",
          source_url: `https://gemini.google.com/app/${pendingSessionId}`,
          captured_at: "2026-04-03T12:00:00.000Z",
          messages: [
            {
              external_message_id: "wait-msg-1",
              role: "user",
              content: "Turn this into a personal planning journal note."
            }
          ],
          raw_capture: { source: "e2e-processing-wait" }
        }
      });
      expect(ingestResponse.ok()).toBeTruthy();

      await context.route(/^https:\/\/chatgpt\.com(?:\/.*)?$/, async (route) => {
        if (route.request().resourceType() !== "document") {
          await route.fulfill({
            status: 204,
            body: ""
          });
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>ChatGPT</title>
  </head>
  <body>
    <main>
      <textarea id="prompt-textarea"></textarea>
      <button data-testid="send-button" type="button">Send</button>
      <button data-testid="stop-button" type="button" aria-label="Stop generating" hidden>Stop</button>
      <section id="responses"></section>
    </main>
    <script>
      const textarea = document.querySelector("#prompt-textarea");
      const sendButton = document.querySelector("[data-testid='send-button']");
      const stopButton = document.querySelector("[data-testid='stop-button']");
      const responses = document.querySelector("#responses");
      sendButton.addEventListener("click", async () => {
        const prompt = textarea.value;
        const response = await fetch("/backend-api/conversation/processing-worker", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt })
        });
        const data = await response.json();
        const article = document.createElement("article");
        const assistant = document.createElement("div");
        assistant.setAttribute("data-message-author-role", "assistant");
        assistant.textContent = data.messages[data.messages.length - 1].content;
        article.appendChild(assistant);
        responses.appendChild(article);
        sendButton.hidden = true;
        stopButton.hidden = false;
        window.setTimeout(() => {
          assistant.textContent = data.final_content;
          stopButton.hidden = true;
          sendButton.hidden = false;
        }, 11000);
      });
    </script>
  </body>
</html>`
        });
      });

      await context.route("https://chatgpt.com/backend-api/conversation/processing-worker", async (route) => {
        const payload = route.request().postDataJSON() as { prompt?: string } | null;
        observedPrompts.push(payload?.prompt ?? "");
        const taskKeys = parseExpectedProcessingTaskKeys(payload?.prompt ?? "");
        const partialContent = `{"results":[{"task_key":"${taskKeys[0] ?? "task_1"}","category":"journal","classification_reason":"Personal planning."`;
        const finalContent = JSON.stringify({
          results: [
            {
              task_key: taskKeys[0] ?? "task_1",
              category: "journal",
              classification_reason: "Personal planning and reflection.",
              journal: {
                entry: "Drafted tomorrow priorities and reviewed the release checklist.",
                action_items: ["Review the release checklist"]
              },
              factual_triplets: [],
              idea: null
            }
          ]
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            conversation_id: "worker-chat-session",
            title: "SaveMyContext Processing Worker",
            final_content: finalContent,
            messages: [
              {
                id: `worker-user-${observedPrompts.length}`,
                role: "user",
                content: payload?.prompt ?? ""
              },
              {
                id: `worker-assistant-${observedPrompts.length}`,
                parent: `worker-user-${observedPrompts.length}`,
                role: "assistant",
                content: partialContent
              }
            ]
          })
        });
      });

      const workerPage = await context.newPage();
      await workerPage.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });

      await expect(popup.locator("#processing-pending")).toHaveText("1");
      await popup.locator("#run-processing").click();

      await eventually
        .poll(
          async () => {
            const response = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=gemini`);
            if (!response.ok()) {
              return null;
            }
            const sessions = (await response.json()) as Array<{
              id: string;
              external_session_id: string;
              category: string | null;
            }>;
            return sessions.find((session) => session.external_session_id === pendingSessionId)?.category ?? null;
          },
          {
            timeout: 25_000,
            message: "Waiting for the extension worker to wait for the provider to finish before completing processing."
          }
        )
        .toBe("journal");

      expect(observedPrompts).toHaveLength(1);
      expect(observedPrompts[0]).toContain('"task_key":"task_1"');
      await expect(popup.locator("#last-error")).toHaveText("None");
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
  const userDataDir = await mkdtemp(join(tmpdir(), "savemycontext-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "savemycontext-backend-e2e-"));
  const sessionId = "gemini-e2e-123456789";
  const secondSessionId = "gemini-e2e-987654321";
  const thirdSessionId = "gemini-e2e-333333333";
  const skippedSessionId = "gemini-e2e-skipped-123456789";
  const accountOneSessionId = "gemini-e2e-u1-555555555";
  const skippedAccountOneSessionId = "gemini-e2e-u1-skipped-555555555";
  const backendLogs: string[] = [];
  const observedListRequests: Array<{ sourcePath: string; pinned: boolean; pageToken: string | null }> = [];
  const observedReadRequests: Array<{ sourcePath: string; conversationId: string; pageToken: string | null }> = [];
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
            SAVEMYCONTEXT_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "savemycontext.db")}`,
            SAVEMYCONTEXT_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            SAVEMYCONTEXT_LLM_BACKEND: "heuristic"
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
          "savemycontext.sync-state": {
            [`gemini:u0__${skippedId}`]: {
              seenMessageIds: ["existing-message"],
              lastSyncedAt: "2026-04-01T11:50:00.000Z"
            },
            [`gemini:u1__gemini-e2e-u1-skipped-555555555`]: {
              seenMessageIds: ["existing-message-u1"],
              lastSyncedAt: "2026-04-01T11:51:00.000Z"
            }
          }
        });
      }, skippedSessionId);

      await context.route(/^https:\/\/gemini\.google\.com(?:\/u\/\d+)?\/app(?:\/.*)?$/, async (route) => {
        const pageUrl = new URL(route.request().url());
        const isAccountOne = pageUrl.pathname.startsWith("/u/1/");
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
    <input name="at" value="${isAccountOne ? "e2e-gemini-token-u1" : "e2e-gemini-token-u0"}" />
    <a href="/app/${sessionId}">Primary account</a>
    <a href="/u/1/app/${accountOneSessionId}">Secondary account</a>
    <script>window.WIZ_global_data = { SNlM0e: "${isAccountOne ? "e2e-gemini-token-u1" : "e2e-gemini-token-u0"}" };</script>
  </body>
</html>`
        });
      });

      await context.route(/^https:\/\/gemini\.google\.com(?:\/u\/\d+)?\/_\/BardChatUi\/data\/batchexecute.*$/, async (route) => {
        const url = new URL(route.request().url());
        const rpcId = url.searchParams.get("rpcids");
        const requestArgs = parseGeminiRequestArgs(route.request().postData());
        const sourcePath = url.searchParams.get("source-path") ?? "";
        const accountBasePrefix = sourcePath.startsWith("/u/1/") ? "/u/1" : "";

        if (rpcId === "MaZiqc") {
          const pinned = Array.isArray(requestArgs?.[2]) && requestArgs[2]?.[0] === 1;
          const pageToken = typeof requestArgs?.[1] === "string" ? requestArgs[1] : null;
          observedListRequests.push({
            sourcePath,
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

          if (!pageToken && accountBasePrefix === "") {
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

          if (pageToken === "page-2" && accountBasePrefix === "") {
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

          if (!pageToken && accountBasePrefix === "/u/1") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: buildBatchExecuteResponseBody(
                "MaZiqc",
                buildGeminiListPayload([
                  buildGeminiConversationEntry(accountOneSessionId, "Gemini E2E Account 1"),
                  buildGeminiConversationEntry(skippedAccountOneSessionId, "Gemini Account 1 Previously Synced")
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
          observedReadRequests.push({ sourcePath, conversationId, pageToken });
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

          if (conversationId === accountOneSessionId && !pageToken && accountBasePrefix === "/u/1") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: buildBatchExecuteResponseBody(
                "hNvQHb",
                buildGeminiTurnPayload([
                  buildGeminiTurnBlock(
                    "Do you sync multiple Gemini accounts?",
                    "Yes. The importer enumerates each logged-in /u/N Gemini surface and syncs them separately.",
                    1711842180,
                    "rc_5"
                  )
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

      await eventually
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("savemycontext.status");
              return JSON.stringify((stored["savemycontext.status"] ??
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
        const stored = await chrome.storage.local.get("savemycontext.status");
        return (stored["savemycontext.status"] ??
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

      expect(completedStatus.historySyncProcessedCount).toBe(6);
      expect(completedStatus.historySyncTotalCount).toBe(6);
      expect(completedStatus.historySyncSkippedCount).toBe(2);
      expect(completedStatus.historySyncLastConversationCount).toBe(4);

      await eventually
        .poll(
          async () => {
            const response = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=gemini`);
            if (!response.ok()) {
              return null;
            }
            const sessions = (await response.json()) as Array<{ external_session_id: string }>;
            return sessions.find((session) => session.external_session_id === `u0__${sessionId}`)?.external_session_id ?? null;
          },
          {
            message: "Waiting for the backend to persist the auto-synced Gemini session."
          }
        )
        .toBe(`u0__${sessionId}`);

      const sessionsResponse = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=gemini`);
      expect(sessionsResponse.ok()).toBeTruthy();
      const sessions = (await sessionsResponse.json()) as Array<{
        id: string;
        external_session_id: string;
        title: string | null;
      }>;
      const matchedSession = sessions.find((session) => session.external_session_id === `u0__${sessionId}`);
      expect(matchedSession?.title).toBe("Gemini E2E Sync");

      const sessionResponse = await request.get(`${backendBaseUrl}/api/v1/sessions/${matchedSession?.id}`);
      expect(sessionResponse.ok()).toBeTruthy();
      const persisted = (await sessionResponse.json()) as {
        external_session_id: string;
        messages: Array<{ content: string }>;
      };

      expect(persisted.external_session_id).toBe(`u0__${sessionId}`);
      expect(persisted.messages.map((message) => message.content)).toEqual([
        "Explain proactive backfill on Gemini.",
        "Proactive backfill imports your saved Gemini conversations automatically.",
        "How does turn pagination work?",
        "It follows Gemini next-page tokens until the full conversation is imported."
      ]);

      const secondSession = sessions.find((session) => session.external_session_id === `u0__${secondSessionId}`);
      expect(secondSession?.title).toBe("Gemini E2E Sync 2");
      const thirdSession = sessions.find((session) => session.external_session_id === `u0__${thirdSessionId}`);
      expect(thirdSession?.title).toBe("Gemini E2E Sync 3");
      const accountOneSession = sessions.find((session) => session.external_session_id === `u1__${accountOneSessionId}`);
      expect(accountOneSession?.title).toBe("Gemini E2E Account 1");

      const refreshBaseline = (await serviceWorker.evaluate(async () => {
        const stored = await chrome.storage.local.get("savemycontext.status");
        return (stored["savemycontext.status"] ??
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

      await eventually
        .poll(
          async () =>
            serviceWorker.evaluate(async (baseline) => {
              const stored = await chrome.storage.local.get("savemycontext.status");
              const status = (stored["savemycontext.status"] ??
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
        new RegExp(`^gemini:(u0__(${sessionId}|${secondSessionId}|${thirdSessionId})|u1__${accountOneSessionId})$`)
      );
      await expect(popup.locator("#history-sync")).toContainText("0 conversations");

      expect(observedListRequests.length).toBeGreaterThan(0);
      expect(new Set(observedListRequests.map((request) => request.sourcePath))).toEqual(new Set(["/app", "/u/1/app"]));
      expect(observedListRequests.some((request) => request.pageToken === "page-2")).toBe(true);
      expect(observedReadRequests.slice(readCountAfterInitialSync)).toEqual([]);
      expect(observedReadRequests).toEqual(
        expect.arrayContaining([
          { sourcePath: "/app/gemini-e2e-123456789", conversationId: sessionId, pageToken: null },
          { sourcePath: "/app/gemini-e2e-123456789", conversationId: sessionId, pageToken: "turn-page-2" },
          { sourcePath: "/app/gemini-e2e-987654321", conversationId: secondSessionId, pageToken: null },
          { sourcePath: "/app/gemini-e2e-333333333", conversationId: thirdSessionId, pageToken: null },
          { sourcePath: "/u/1/app/gemini-e2e-u1-555555555", conversationId: accountOneSessionId, pageToken: null }
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
  const userDataDir = await mkdtemp(join(tmpdir(), "savemycontext-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "savemycontext-backend-e2e-"));
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
            SAVEMYCONTEXT_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "savemycontext.db")}`,
            SAVEMYCONTEXT_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            SAVEMYCONTEXT_LLM_BACKEND: "heuristic"
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

      await eventually
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("savemycontext.status");
              return (stored["savemycontext.status"] ??
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
    await stopBackend(backendProcess);
    await rm(userDataDir, { recursive: true, force: true });
    await rm(backendDataDir, { recursive: true, force: true });
  }
});

test("auto-syncs Grok history on provider visit", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "savemycontext-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "savemycontext-backend-e2e-"));
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
            SAVEMYCONTEXT_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "savemycontext.db")}`,
            SAVEMYCONTEXT_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            SAVEMYCONTEXT_LLM_BACKEND: "heuristic"
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
          "savemycontext.sync-state": {
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

      await eventually
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("savemycontext.status");
              return JSON.stringify((stored["savemycontext.status"] ??
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
        const stored = await chrome.storage.local.get("savemycontext.status");
        return (stored["savemycontext.status"] ??
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

      await eventually
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
        const stored = await chrome.storage.local.get("savemycontext.status");
        return (stored["savemycontext.status"] ??
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

      await eventually
        .poll(
          async () =>
            serviceWorker.evaluate(async (baseline) => {
              const stored = await chrome.storage.local.get("savemycontext.status");
              const status = (stored["savemycontext.status"] ??
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
  const userDataDir = await mkdtemp(join(tmpdir(), "savemycontext-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "savemycontext-backend-e2e-"));
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
            SAVEMYCONTEXT_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "savemycontext.db")}`,
            SAVEMYCONTEXT_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            SAVEMYCONTEXT_LLM_BACKEND: "heuristic"
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

      await eventually
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("savemycontext.status");
              return (
                (stored["savemycontext.status"] as { historySyncLastResult?: string } | undefined)?.historySyncLastResult ??
                null
              );
            }),
          {
            message: "Waiting for the extension to finish Grok fallback history sync."
          }
        )
        .toBe("success");

      await eventually
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
  const userDataDir = await mkdtemp(join(tmpdir(), "savemycontext-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "savemycontext-backend-e2e-"));
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
            SAVEMYCONTEXT_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "savemycontext.db")}`,
            SAVEMYCONTEXT_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            SAVEMYCONTEXT_LLM_BACKEND: "heuristic"
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
            unexpected: true
          })
        });
      });

      const page = await context.newPage();
      await page.goto("https://grok.com/c/drift-test", { waitUntil: "domcontentloaded" });

      await eventually
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("savemycontext.status");
              return (stored["savemycontext.status"] ??
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
    await stopBackend(backendProcess);
    await rm(userDataDir, { recursive: true, force: true });
    await rm(backendDataDir, { recursive: true, force: true });
  }
});

test("renders the dashboard with backend corpus, graph, and storage statistics", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "savemycontext-extension-dashboard-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "savemycontext-backend-dashboard-"));
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
            SAVEMYCONTEXT_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "savemycontext.db")}`,
            SAVEMYCONTEXT_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            SAVEMYCONTEXT_LLM_BACKEND: "heuristic"
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

    const capturedAt = new Date("2026-04-14T17:20:00.000Z").toISOString();

    await ingestDiff(request, backendBaseUrl, {
      provider: "gemini",
      external_session_id: "dashboard-factual",
      sync_mode: "full_snapshot",
      title: "Rust knowledge",
      source_url: "https://gemini.google.com/app/dashboard-factual",
      captured_at: capturedAt,
      custom_tags: [],
      raw_capture: {
        source: "dashboard-e2e",
        provider: "gemini"
      },
      messages: [
        {
          external_message_id: "fact-user",
          role: "user",
          content: "Explain Rust fundamentals."
        },
        {
          external_message_id: "fact-assistant",
          parent_external_message_id: "fact-user",
          role: "assistant",
          content:
            "Rust is a systems programming language. Rust uses ownership. Rust supports fearless concurrency."
        }
      ]
    });
    await ingestDiff(request, backendBaseUrl, {
      provider: "chatgpt",
      external_session_id: "dashboard-ideas",
      sync_mode: "full_snapshot",
      title: "Idea sprint",
      source_url: "https://chatgpt.com/c/dashboard-ideas",
      captured_at: capturedAt,
      custom_tags: [],
      raw_capture: {
        source: "dashboard-e2e",
        provider: "chatgpt"
      },
      messages: [
        {
          external_message_id: "idea-user",
          role: "user",
          content: "Brainstorm a small product idea for turning AI chat histories into a research notebook."
        },
        {
          external_message_id: "idea-assistant",
          parent_external_message_id: "idea-user",
          role: "assistant",
          content:
            "One advantage is that it gives every conversation a reusable artifact. One risk is information overload without clear filters. Next step: build a narrow prototype for factual research sessions."
        }
      ]
    });
    await ingestDiff(request, backendBaseUrl, {
      provider: "grok",
      external_session_id: "dashboard-todo",
      sync_mode: "full_snapshot",
      title: "Todo update",
      source_url: "https://grok.com/c/dashboard-todo",
      captured_at: capturedAt,
      custom_tags: [],
      raw_capture: {
        source: "dashboard-e2e",
        provider: "grok"
      },
      messages: [
        {
          external_message_id: "todo-user",
          role: "user",
          content: "Please add Buy milk to my to-do list."
        },
        {
          external_message_id: "todo-assistant",
          parent_external_message_id: "todo-user",
          role: "assistant",
          content: "Added Buy milk to your shared to-do list."
        }
      ]
    });

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

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
      const dashboardPagePromise = context.waitForEvent("page");
      await popup.locator("#open-dashboard").click();
      const dashboardPage = await dashboardPagePromise;
      await dashboardPage.waitForLoadState("domcontentloaded");

      await expect(dashboardPage.locator("#backend-alert")).toBeHidden();
      await expect(dashboardPage.locator("#metric-sessions")).toHaveText("3");
      await expect(dashboardPage.locator("#metric-messages")).toHaveText("6");
      await expect(dashboardPage.locator("#metric-sync-events")).toHaveText("3");
      await expect(dashboardPage.locator("#metric-triplets")).toHaveText("3");
      await expect(dashboardPage.locator("#metric-entities")).toHaveText("6");
      await expect(dashboardPage.locator("#metric-edges")).toHaveText("3");
      await expect(dashboardPage.locator("#category-total-label")).toContainText("3 indexed sessions");
      await expect(dashboardPage.locator("#category-list")).toContainText("Factual");
      await expect(dashboardPage.locator("#category-list")).toContainText("Ideas");
      await expect(dashboardPage.locator("#category-list")).toContainText("To-Do");
      await expect(dashboardPage.locator("#graph-summary")).toContainText("6 entities, 3 edges");
      await expect(dashboardPage.locator("#top-entities")).toContainText("Rust");
      await expect(dashboardPage.locator("#system-auth-mode")).toHaveText("bootstrap_local");
      await expect(dashboardPage.locator("#system-todo-path")).toContainText("To-Do List.md");
      await expect(dashboardPage.locator("#health-last-error")).toHaveText("None");
    } finally {
      await context.close();
    }
  } finally {
    await stopBackend(backendProcess);
    await rm(userDataDir, { recursive: true, force: true });
    await rm(backendDataDir, { recursive: true, force: true });
  }
});

test("searches the knowledge base and injects a fact into the focused page field", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "savemycontext-extension-search-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "savemycontext-backend-search-"));
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
            SAVEMYCONTEXT_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "savemycontext.db")}`,
            SAVEMYCONTEXT_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            SAVEMYCONTEXT_LLM_BACKEND: "heuristic"
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

    await ingestDiff(request, backendBaseUrl, {
      provider: "gemini",
      external_session_id: "search-factual",
      sync_mode: "full_snapshot",
      title: "Rust ownership facts",
      source_url: "https://gemini.google.com/app/search-factual",
      captured_at: new Date("2026-04-14T18:10:00.000Z").toISOString(),
      custom_tags: [],
      raw_capture: {
        source: "search-e2e",
        provider: "gemini"
      },
      messages: [
        {
          external_message_id: "search-user",
          role: "user",
          content: "Explain Rust ownership."
        },
        {
          external_message_id: "search-assistant",
          parent_external_message_id: "search-user",
          role: "assistant",
          content: "Rust uses ownership to manage memory safely without a garbage collector."
        }
      ]
    });

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

      await context.route("https://example.com/compose", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Compose</title>
  </head>
  <body>
    <main>
      <label for="composer">Composer</label>
      <textarea id="composer" rows="12" cols="80" placeholder="Write here"></textarea>
    </main>
  </body>
</html>`
        });
      });

      const page = await context.newPage();
      await page.goto("https://example.com/compose", { waitUntil: "domcontentloaded" });
      await page.locator("#composer").click();

      const openSearchResponse = await serviceWorker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) {
          return { ok: false, error: "Missing active tab." };
        }
        return (await chrome.tabs.sendMessage(tab.id, {
          type: "TOGGLE_QUICK_SEARCH"
        })) as { ok: boolean; error?: string };
      });
      expect(openSearchResponse.ok).toBe(true);

      await page.locator("#savemycontext-quick-search-query").fill("ownership");
      await expect(page.locator("#savemycontext-quick-search-results")).toContainText("Rust | uses | ownership");

      const factCard = page.locator("article.result").filter({ hasText: "Rust | uses | ownership" }).first();
      await factCard.getByRole("button", { name: "Insert" }).click();

      await expect(page.locator("#composer")).toHaveValue(/Rust \| uses \| ownership/);
    } finally {
      await context.close();
    }
  } finally {
    await stopBackend(backendProcess);
    await rm(userDataDir, { recursive: true, force: true });
    await rm(backendDataDir, { recursive: true, force: true });
  }
});

test("shows the selection capture pop-up and saves the selected text into the backend", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "savemycontext-extension-selection-capture-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "savemycontext-backend-selection-capture-"));
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
            SAVEMYCONTEXT_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "savemycontext.db")}`,
            SAVEMYCONTEXT_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            SAVEMYCONTEXT_LLM_BACKEND: "heuristic"
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
      await optionsPage.locator("#selection-capture-enabled").setChecked(true);
      await optionsPage.locator("#settings-form").evaluate((form) => {
        (form as HTMLFormElement).requestSubmit();
      });
      await expect(optionsPage.locator("#save-status")).toHaveText("Settings saved.");

      await context.route("https://example.com/article", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Rust reference</title>
  </head>
  <body>
    <main>
      <article>
        <h1>Rust reference</h1>
        <p id="source">
          Rust uses ownership to manage memory safely without a garbage collector.
        </p>
      </article>
    </main>
  </body>
</html>`
        });
      });

      const page = await context.newPage();
      await page.goto("https://example.com/article", { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        const element = document.getElementById("source");
        if (!element) {
          throw new Error("Missing source paragraph.");
        }
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });

      const addButton = page.getByRole("button", { name: "Add to Knowledge Base" });
      await expect(addButton).toBeVisible();
      await addButton.click();
      await expect(page.locator("text=Saved")).toContainText("Saved");

      await eventually
        .poll(
          async () => {
            const response = await request.get(`${backendBaseUrl}/api/v1/search`, {
              params: {
                q: "ownership"
              }
            });
            if (response.status() !== 200) {
              return [];
            }
            const payload = (await response.json()) as {
              results?: Array<{ kind?: string; title?: string }>;
            };
            return payload.results ?? [];
          },
          {
            message: "Waiting for the saved source capture to appear in backend search."
          }
        )
        .toContainEqual(
          expect.objectContaining({
            kind: "source_capture"
          })
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
