import type { RuntimeMessage, SourceCapturePayload, SourceCaptureResponse } from "../shared/types";

type RuntimeRequester = <TResponse>(message: RuntimeMessage) => Promise<TResponse>;

type SelectionSnapshot = {
  text: string;
  rect: DOMRect;
};

type PageSnapshot = {
  title: string;
  sourceUrl: string;
  sourceText: string;
  sourceMarkdown: string;
  rawPayload: Record<string, unknown>;
};

type SelectionCaptureController = {
  handleRuntimeMessage(message: RuntimeMessage): Promise<SourceCaptureResponse | null>;
};

const SETTINGS_CACHE_KEY = "tsmc.settings.cache";
const SETTINGS_SYNC_KEY = "tsmc.settings";
const STYLE = `
:host {
  all: initial;
}

.bubble {
  position: fixed;
  z-index: 2147483646;
  min-width: 248px;
  max-width: min(320px, calc(100vw - 24px));
  padding: 14px;
  border-radius: 18px;
  border: 1px solid rgba(17, 38, 58, 0.12);
  background:
    radial-gradient(circle at top right, rgba(11, 140, 136, 0.16), transparent 38%),
    rgba(255, 253, 247, 0.96);
  color: #11263a;
  box-shadow: 0 22px 64px rgba(17, 38, 58, 0.16);
  backdrop-filter: blur(14px);
  font-family: "Avenir Next", "Segoe UI", sans-serif;
}

.eyebrow {
  margin: 0 0 6px;
  color: rgba(17, 38, 58, 0.56);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.selection {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: rgba(17, 38, 58, 0.82);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.actions {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

button {
  border: 0;
  border-radius: 999px;
  padding: 10px 14px;
  background: #11263a;
  color: white;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

button.secondary {
  background: rgba(17, 38, 58, 0.12);
  color: #11263a;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.status {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: rgba(17, 38, 58, 0.72);
}

.status.error {
  color: #bd5d38;
}
`;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function blockText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isInsideHost(target: EventTarget | null, host: HTMLDivElement | null, shadow: ShadowRoot | null): boolean {
  return target instanceof Node && Boolean((host && host.contains(target)) || (shadow && shadow.contains(target)));
}

function extractSelectionSnapshot(): SelectionSnapshot | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const text = selection.toString().trim();
  if (!text) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) {
    return null;
  }
  return {
    text,
    rect
  };
}

function preferredContentRoot(): HTMLElement {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>("article, main, [role='main']"));
  const viable = candidates
    .map((element) => ({
      element,
      size: normalizeWhitespace(element.innerText || "").length
    }))
    .filter((entry) => entry.size > 120)
    .sort((left, right) => right.size - left.size);
  return viable[0]?.element ?? document.body;
}

function inlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (!(node instanceof HTMLElement)) {
    return "";
  }
  if (["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS"].includes(node.tagName)) {
    return "";
  }

  const children = Array.from(node.childNodes).map((child) => inlineMarkdown(child)).join("");
  if (node.tagName === "A") {
    const text = normalizeWhitespace(children || node.innerText || "");
    const href = node.getAttribute("href")?.trim();
    if (text && href) {
      return `[${text}](${href})`;
    }
    return text;
  }
  if (node.tagName === "STRONG" || node.tagName === "B") {
    const text = normalizeWhitespace(children);
    return text ? `**${text}**` : "";
  }
  if (node.tagName === "EM" || node.tagName === "I") {
    const text = normalizeWhitespace(children);
    return text ? `*${text}*` : "";
  }
  if (node.tagName === "CODE") {
    const text = normalizeWhitespace(children);
    return text ? `\`${text}\`` : "";
  }
  if (node.tagName === "BR") {
    return "\n";
  }
  return children;
}

function elementToMarkdown(element: HTMLElement): string {
  if (["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS"].includes(element.tagName)) {
    return "";
  }
  if (element.closest("nav, aside, footer")) {
    return "";
  }

  const inline = normalizeWhitespace(inlineMarkdown(element));
  if (!inline && element.tagName !== "PRE") {
    return "";
  }

  if (/^H[1-6]$/.test(element.tagName)) {
    const level = Number.parseInt(element.tagName.slice(1), 10) || 1;
    return `${"#".repeat(level)} ${inline}`;
  }
  if (element.tagName === "LI") {
    return `- ${inline}`;
  }
  if (element.tagName === "BLOCKQUOTE") {
    return inline
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }
  if (element.tagName === "PRE") {
    return `\`\`\`\n${(element.innerText || "").trim()}\n\`\`\``;
  }
  if (element.tagName === "P") {
    return inline;
  }
  return inline;
}

function collectPageMarkdown(root: HTMLElement): string {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6, p, li, blockquote, pre"));
  const rendered = blocks
    .map((element) => elementToMarkdown(element))
    .filter(Boolean);
  if (rendered.length) {
    return rendered.join("\n\n").trim();
  }
  return blockText(root.innerText || "");
}

function collectPageSnapshot(): PageSnapshot {
  const root = preferredContentRoot();
  const sourceText = blockText(root.innerText || document.body.innerText || "");
  const sourceMarkdown = collectPageMarkdown(root);
  return {
    title: document.title.trim() || "Saved page",
    sourceUrl: window.location.href,
    sourceText,
    sourceMarkdown,
    rawPayload: {
      rootTag: root.tagName.toLowerCase(),
      textLength: sourceText.length,
      markdownLength: sourceMarkdown.length
    }
  };
}

export function createSelectionCaptureController(sendMessage: RuntimeRequester): SelectionCaptureController {
  let enabled = false;
  let host: HTMLDivElement | null = null;
  let shadow: ShadowRoot | null = null;
  let bubble: HTMLDivElement | null = null;
  let selectionPreview: HTMLParagraphElement | null = null;
  let statusLine: HTMLParagraphElement | null = null;
  let rawButton: HTMLButtonElement | null = null;
  let aiButton: HTMLButtonElement | null = null;
  let currentSelection: SelectionSnapshot | null = null;
  let visible = false;
  let saveInFlight = false;
  let selectionTimer: number | null = null;

  async function refreshSettings(): Promise<void> {
    try {
      const settings = await sendMessage<{ selectionCaptureEnabled?: boolean }>({ type: "GET_SETTINGS" });
      enabled = Boolean(settings.selectionCaptureEnabled);
      if (!enabled) {
        hide();
      }
    } catch {
      enabled = false;
      hide();
    }
  }

  function ensureDom(): void {
    if (host && shadow && bubble) {
      return;
    }
    host = document.createElement("div");
    host.id = "tsmc-selection-capture-root";
    host.hidden = true;
    shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = STYLE;

    bubble = document.createElement("div");
    bubble.className = "bubble";

    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "TSMC Selection";

    selectionPreview = document.createElement("p");
    selectionPreview.className = "selection";

    const actions = document.createElement("div");
    actions.className = "actions";

    rawButton = document.createElement("button");
    rawButton.type = "button";
    rawButton.className = "secondary";
    rawButton.textContent = "Add to Knowledge Base";

    aiButton = document.createElement("button");
    aiButton.type = "button";
    aiButton.textContent = "Save with AI";

    statusLine = document.createElement("p");
    statusLine.className = "status";
    statusLine.textContent = "Save the raw selection or enrich it with AI before storing it.";

    for (const [button, mode] of [
      [rawButton, "raw"],
      [aiButton, "ai"]
    ] as const) {
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void saveSelection(mode);
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }

    actions.append(rawButton, aiButton);
    bubble.append(eyebrow, selectionPreview, actions, statusLine);
    shadow.append(style, bubble);
    document.documentElement.append(host);
  }

  function setSavingState(isSaving: boolean): void {
    saveInFlight = isSaving;
    if (rawButton) {
      rawButton.disabled = isSaving;
    }
    if (aiButton) {
      aiButton.disabled = isSaving;
    }
  }

  function showStatus(text: string, isError = false): void {
    if (!statusLine) {
      return;
    }
    statusLine.textContent = text;
    statusLine.className = `status${isError ? " error" : ""}`;
  }

  function positionBubble(rect: DOMRect): void {
    if (!bubble) {
      return;
    }
    const width = 280;
    const top = Math.max(12, rect.top - 12);
    const left = Math.min(
      window.innerWidth - width - 12,
      Math.max(12, rect.left + rect.width / 2 - width / 2)
    );
    bubble.style.top = `${Math.max(12, top)}px`;
    bubble.style.left = `${Math.max(12, left)}px`;
  }

  function show(selection: SelectionSnapshot): void {
    ensureDom();
    if (!host || !selectionPreview) {
      return;
    }
    currentSelection = selection;
    visible = true;
    host.hidden = false;
    selectionPreview.textContent = selection.text;
    showStatus("Save the raw selection or enrich it with AI before storing it.");
    positionBubble(selection.rect);
  }

  function hide(): void {
    visible = false;
    currentSelection = null;
    if (host) {
      host.hidden = true;
    }
  }

  async function saveSelection(mode: "raw" | "ai"): Promise<void> {
    if (!currentSelection || saveInFlight) {
      return;
    }
    setSavingState(true);
    showStatus(mode === "ai" ? "Saving selection with AI…" : "Saving selection…");
    const payload: SourceCapturePayload = {
      captureKind: "selection",
      saveMode: mode,
      title: document.title.trim() || undefined,
      pageTitle: document.title.trim() || undefined,
      sourceUrl: window.location.href,
      selectionText: currentSelection.text,
      sourceText: currentSelection.text,
      sourceMarkdown: currentSelection.text,
      rawPayload: {
        pageTitle: document.title.trim() || null,
        selectionLength: currentSelection.text.length
      }
    };
    try {
      const response = await sendMessage<SourceCaptureResponse>({
        type: "SAVE_SOURCE_CAPTURE",
        payload
      });
      if (!response.ok) {
        showStatus(response.error ?? "Could not save the selection.", true);
        return;
      }
      showStatus(`Saved ${response.title ?? "selection"} to TSMC.`);
      window.setTimeout(() => {
        hide();
      }, 1000);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      setSavingState(false);
    }
  }

  async function saveCurrentPage(mode: "raw" | "ai"): Promise<SourceCaptureResponse> {
    const snapshot = collectPageSnapshot();
    if (!snapshot.sourceText) {
      return {
        ok: false,
        error: "Could not extract readable text from the current page."
      };
    }
    return await sendMessage<SourceCaptureResponse>({
      type: "SAVE_SOURCE_CAPTURE",
      payload: {
        captureKind: "page",
        saveMode: mode,
        title: snapshot.title,
        pageTitle: snapshot.title,
        sourceUrl: snapshot.sourceUrl,
        sourceText: snapshot.sourceText,
        sourceMarkdown: snapshot.sourceMarkdown,
        rawPayload: snapshot.rawPayload
      }
    });
  }

  function maybeShowSelectionBubble(): void {
    if (!enabled || saveInFlight) {
      hide();
      return;
    }
    const snapshot = extractSelectionSnapshot();
    if (!snapshot) {
      hide();
      return;
    }
    show(snapshot);
  }

  document.addEventListener("selectionchange", () => {
    if (selectionTimer !== null) {
      window.clearTimeout(selectionTimer);
    }
    selectionTimer = window.setTimeout(() => {
      selectionTimer = null;
      maybeShowSelectionBubble();
    }, 80);
  });
  document.addEventListener("mouseup", () => {
    maybeShowSelectionBubble();
  });
  document.addEventListener(
    "mousedown",
    (event) => {
      if (!visible || isInsideHost(event.target, host, shadow)) {
        return;
      }
      hide();
    },
    true
  );
  window.addEventListener("scroll", () => {
    if (!visible || !currentSelection) {
      return;
    }
    maybeShowSelectionBubble();
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" && areaName !== "sync") {
      return;
    }
    if (changes[SETTINGS_CACHE_KEY] || changes[SETTINGS_SYNC_KEY]) {
      void refreshSettings();
    }
  });

  void refreshSettings();

  return {
    async handleRuntimeMessage(message: RuntimeMessage): Promise<SourceCaptureResponse | null> {
      if (message.type !== "SAVE_CURRENT_PAGE_SOURCE") {
        return null;
      }
      return await saveCurrentPage(message.payload?.saveMode ?? "ai");
    }
  };
}
