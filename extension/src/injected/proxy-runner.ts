import type { CapturedNetworkEvent, ProviderName } from "../shared/types";

import { ChatGPTScraper } from "../providers/chatgpt";
import { GeminiScraper } from "../providers/gemini";
import { GrokScraper } from "../providers/grok";
import { normalizeWhitespace } from "../providers/helpers";
import { providerDomAdapters } from "../shared/provider-dom";
import { extractFirstBalancedJsonObject } from "./proxy-json";

interface ProxyRunState {
  provider: ProviderName;
  events: CapturedNetworkEvent[];
  lastEventAt: number | null;
}

export interface ProxyPromptResult {
  provider: ProviderName;
  responseText: string;
  pageUrl: string;
  title?: string;
}

interface RunProxyPromptOptions {
  preferFastMode?: boolean;
  requireCompleteJson?: boolean;
}

const QUIET_PERIOD_MS = 1500;
const FALLBACK_QUIET_PERIOD_MS = 5000;
const PARTIAL_JSON_FALLBACK_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 120_000;

const scrapers = {
  chatgpt: new ChatGPTScraper(),
  gemini: new GeminiScraper(),
  grok: new GrokScraper()
};

let activeRun: ProxyRunState | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isVisible(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}

function findFirstVisible(selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (isVisible(element)) {
        return element;
      }
    }
  }
  return null;
}

function isDisabled(element: HTMLElement): boolean {
  return element.matches(":disabled,[aria-disabled='true']");
}

function isToggleActive(element: HTMLElement): boolean {
  return (
    element.getAttribute("aria-pressed") === "true" ||
    element.getAttribute("aria-checked") === "true" ||
    element.getAttribute("data-state") === "on" ||
    element.getAttribute("data-selected") === "true"
  );
}

function toggleLabel(element: HTMLElement): string {
  return [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent ?? ""]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .trim();
}

function findVisibleMatchingButton(selectors: string[], patterns: RegExp[]): HTMLElement | null {
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement) || !isVisible(element) || isDisabled(element)) {
        continue;
      }
      return element;
    }
  }

  const candidates = Array.from(document.querySelectorAll("button,[role='button']"));
  for (const element of candidates) {
    if (!(element instanceof HTMLElement) || !isVisible(element) || isDisabled(element)) {
      continue;
    }
    const label = toggleLabel(element);
    if (label && patterns.some((pattern) => pattern.test(label))) {
      return element;
    }
  }

  return null;
}

function isProviderGenerationActive(provider: ProviderName): boolean {
  const adapter = providerDomAdapters[provider];
  if (findVisibleMatchingButton(adapter.stopButtonSelectors, adapter.stopButtonPatterns)) {
    return true;
  }

  const input = findFirstVisible(adapter.inputSelectors);
  if (
    input &&
    (isDisabled(input) ||
      input.matches("[readonly],[aria-busy='true']") ||
      input.getAttribute("contenteditable") === "false")
  ) {
    return true;
  }

  return false;
}

async function disableThinkingMode(provider: ProviderName): Promise<void> {
  const patterns = providerDomAdapters[provider].thinkingTogglePatterns;
  if (!patterns.length) {
    return;
  }

  const candidates = Array.from(document.querySelectorAll("button,[role='button'],[aria-pressed],[aria-checked]"));
  for (const element of candidates) {
    if (!(element instanceof HTMLElement) || !isVisible(element) || isDisabled(element) || !isToggleActive(element)) {
      continue;
    }

    const label = toggleLabel(element);
    if (!label || !patterns.some((pattern) => pattern.test(label))) {
      continue;
    }

    element.click();
    await sleep(150);
    return;
  }
}

async function waitForInput(provider: ProviderName, timeoutMs: number): Promise<HTMLElement> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const input = findFirstVisible(providerDomAdapters[provider].inputSelectors);
    if (input) {
      return input;
    }
    await sleep(250);
  }
  throw new Error(`Could not find the ${provider} prompt input in the current page.`);
}

function setElementValue(element: HTMLElement, value: string): void {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    setter?.call(element, "");
    element.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: "", inputType: "deleteContentBackward" }));
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  if (element.isContentEditable) {
    element.focus();
    element.textContent = "";
    element.appendChild(document.createTextNode(value));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function clickSendButton(provider: ProviderName): boolean {
  for (const selector of providerDomAdapters[provider].sendButtonSelectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!isVisible(element)) {
        continue;
      }
      const htmlElement = element as HTMLElement;
      if (isDisabled(htmlElement)) {
        continue;
      }
      htmlElement.click();
      return true;
    }
  }
  return false;
}

async function sendPrompt(provider: ProviderName, promptText: string, timeoutMs: number): Promise<void> {
  const input = await waitForInput(provider, timeoutMs);
  input.focus();
  input.click();
  setElementValue(input, promptText);
  await sleep(150);
  if (clickSendButton(provider)) {
    return;
  }
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true
    })
  );
  input.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true
    })
  );
}

function extractResponseFromDom(provider: ProviderName): string | null {
  const values: string[] = [];
  for (const selector of providerDomAdapters[provider].responseSelectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!isVisible(element)) {
        continue;
      }
      const text = normalizeWhitespace((element.textContent ?? "").trim());
      if (text) {
        values.push(text);
      }
    }
  }
  return values.at(-1) ?? null;
}

function latestAssistantText(provider: ProviderName, events: CapturedNetworkEvent[]): string | null {
  const scraper = scrapers[provider];
  let latestText: string | null = null;
  for (const event of events) {
    const snapshot = scraper.parse(event);
    if (!snapshot) {
      continue;
    }
    for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
      const message = snapshot.messages[index];
      if (message.role === "assistant" && message.content.trim()) {
        latestText = message.content.trim();
        break;
      }
    }
  }
  return latestText;
}

async function waitForReply(
  provider: ProviderName,
  timeoutMs: number,
  options: RunProxyPromptOptions = {}
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastDomStructuredCandidate: string | null = null;
  let lastDomStructuredAt = 0;
  let latestObservedText: string | null = null;
  let latestObservedChangedAt = performance.now();
  let generationSeen = false;
  let lastGenerationActiveAt = performance.now();

  while (Date.now() < deadline) {
    const run = activeRun;
    const latestText = run ? latestAssistantText(provider, run.events) : null;
    const quietForMs = run && run.lastEventAt !== null ? performance.now() - run.lastEventAt : 0;
    const generationActive = isProviderGenerationActive(provider);
    if (generationActive) {
      generationSeen = true;
      lastGenerationActiveAt = performance.now();
    }
    const providerIdleForMs = generationSeen ? performance.now() - lastGenerationActiveAt : Number.POSITIVE_INFINITY;
    const structuredCandidate = latestText ? extractFirstBalancedJsonObject(latestText) : null;
    const domText = extractResponseFromDom(provider);
    const domStructuredCandidate = domText ? extractFirstBalancedJsonObject(domText) : null;
    const bestObservedText =
      [domText, latestText].filter((value): value is string => Boolean(value)).sort((left, right) => right.length - left.length)[0] ??
      null;

    if (bestObservedText && bestObservedText !== latestObservedText) {
      latestObservedText = bestObservedText;
      latestObservedChangedAt = performance.now();
    }

    if (domStructuredCandidate && domStructuredCandidate !== lastDomStructuredCandidate) {
      lastDomStructuredCandidate = domStructuredCandidate;
      lastDomStructuredAt = performance.now();
    }

    if (structuredCandidate && quietForMs >= QUIET_PERIOD_MS && providerIdleForMs >= QUIET_PERIOD_MS) {
      return structuredCandidate;
    }
    if (
      domStructuredCandidate &&
      performance.now() - lastDomStructuredAt >= QUIET_PERIOD_MS &&
      providerIdleForMs >= QUIET_PERIOD_MS
    ) {
      return domStructuredCandidate;
    }
    if (
      options.requireCompleteJson &&
      latestObservedText &&
      performance.now() - latestObservedChangedAt >= PARTIAL_JSON_FALLBACK_MS &&
      (quietForMs >= QUIET_PERIOD_MS || !run || run.lastEventAt === null) &&
      providerIdleForMs >= QUIET_PERIOD_MS
    ) {
      return latestObservedText;
    }
    if (
      !options.requireCompleteJson &&
      latestText &&
      quietForMs >= FALLBACK_QUIET_PERIOD_MS &&
      providerIdleForMs >= QUIET_PERIOD_MS
    ) {
      return latestText;
    }
    await sleep(250);
  }

  const domFallback = extractResponseFromDom(provider);
  const partialFallback =
    [domFallback, latestObservedText].filter((value): value is string => Boolean(value)).sort((left, right) => right.length - left.length)[0] ??
    null;
  if (domFallback && !options.requireCompleteJson) {
    return extractFirstBalancedJsonObject(domFallback) ?? domFallback;
  }
  if (options.requireCompleteJson) {
    if (partialFallback && !isProviderGenerationActive(provider)) {
      return partialFallback;
    }
    throw new Error(`Timed out waiting for ${provider} to finish a complete JSON response.`);
  }
  throw new Error(`Timed out waiting for a ${provider} response in the current browser session.`);
}

export function observeProxyCapture(event: CapturedNetworkEvent): void {
  if (!activeRun || activeRun.provider !== (event.providerHint ?? activeRun.provider)) {
    return;
  }

  const scraper = scrapers[activeRun.provider];
  try {
    if (!scraper.matches(event)) {
      return;
    }
  } catch {
    return;
  }

  activeRun.events.push(event);
  activeRun.lastEventAt = performance.now();
}

export async function runProxyPrompt(
  provider: ProviderName,
  promptText: string,
  options: RunProxyPromptOptions = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ProxyPromptResult> {
  activeRun = {
    provider,
    events: [],
    lastEventAt: null
  };
  try {
    if (options.preferFastMode) {
      await disableThinkingMode(provider);
    }
    await sendPrompt(provider, promptText, timeoutMs);
    const responseText = await waitForReply(provider, timeoutMs, options);
    return {
      provider,
      responseText,
      pageUrl: location.href,
      title: document.title || undefined
    };
  } finally {
    activeRun = null;
  }
}
