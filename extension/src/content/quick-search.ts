import type { BackendSearchResult, KnowledgeSearchResponse, RuntimeMessage } from "../shared/types";
import { buildInsertionText, prioritizeKnowledgeResults, resultKindLabel } from "./quick-search-model";

type SearchRequester = <TResponse>(message: RuntimeMessage) => Promise<TResponse>;

type QuickSearchPalette = {
  toggle(): void;
};

type EditableTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const HOST_ID = "savemycontext-quick-search-host";
const DEBOUNCE_MS = 220;

const STYLE_TEXT = `
:host {
  all: initial;
}

*, *::before, *::after {
  box-sizing: border-box;
}

.overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: grid;
  place-items: start center;
  padding: 48px 16px;
  background: rgba(17, 38, 58, 0.22);
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  color: #11263a;
}

.panel {
  inline-size: min(780px, 100%);
  border-radius: 26px;
  border: 1px solid rgba(17, 38, 58, 0.12);
  background:
    radial-gradient(circle at top right, rgba(11, 140, 136, 0.12), transparent 26%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(246, 241, 231, 0.98));
  box-shadow: 0 24px 80px rgba(17, 38, 58, 0.24);
  overflow: hidden;
}

.header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: start;
  padding: 22px 22px 16px;
}

.eyebrow,
.meta-label,
.shortcut {
  margin: 0 0 6px;
  color: rgba(17, 38, 58, 0.62);
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.title {
  margin: 0;
  font-size: 28px;
  line-height: 1;
  font-family: "Iowan Old Style", "Georgia", serif;
}

.summary,
.target-value,
.status {
  margin: 8px 0 0;
  font-size: 14px;
  line-height: 1.55;
  color: rgba(17, 38, 58, 0.78);
}

.status.error {
  color: #bd5d38;
}

.close {
  border: 0;
  border-radius: 999px;
  background: rgba(17, 38, 58, 0.08);
  color: #11263a;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
  padding: 10px 14px;
}

.search {
  padding: 0 22px 16px;
}

.search input {
  inline-size: 100%;
  border: 1px solid rgba(17, 38, 58, 0.12);
  border-radius: 18px;
  padding: 15px 16px;
  font: inherit;
  font-size: 16px;
  background: rgba(255, 255, 255, 0.9);
  color: #11263a;
}

.search input:focus {
  outline: 2px solid rgba(11, 140, 136, 0.3);
  outline-offset: 1px;
}

.meta {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding: 0 22px 18px;
}

.meta-card {
  padding: 14px 16px;
  border-radius: 18px;
  border: 1px solid rgba(17, 38, 58, 0.08);
  background: rgba(255, 255, 255, 0.68);
}

.results {
  display: grid;
  gap: 12px;
  max-block-size: min(56vh, 560px);
  overflow: auto;
  padding: 0 22px 22px;
}

.empty {
  padding: 22px;
  border-radius: 18px;
  border: 1px dashed rgba(17, 38, 58, 0.16);
  color: rgba(17, 38, 58, 0.72);
  background: rgba(255, 255, 255, 0.56);
  line-height: 1.55;
}

.result {
  display: grid;
  gap: 12px;
  padding: 16px;
  border-radius: 20px;
  border: 1px solid rgba(17, 38, 58, 0.1);
  background: rgba(255, 255, 255, 0.82);
}

.result.selected {
  border-color: rgba(11, 140, 136, 0.38);
  background: rgba(11, 140, 136, 0.08);
}

.result-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: start;
}

.result-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.35;
}

.result-snippet {
  margin: 0;
  color: rgba(17, 38, 58, 0.82);
  line-height: 1.6;
  white-space: pre-wrap;
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(17, 38, 58, 0.08);
  color: rgba(17, 38, 58, 0.84);
  font-size: 12px;
  font-weight: 700;
}

.result-actions {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.insert {
  border: 0;
  border-radius: 999px;
  background: #11263a;
  color: white;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
  padding: 10px 14px;
}

.insert:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.source {
  color: rgba(17, 38, 58, 0.62);
  font-size: 12px;
  line-height: 1.45;
}

@media (max-width: 720px) {
  .overlay {
    padding: 24px 10px;
  }

  .meta {
    grid-template-columns: 1fr;
  }

  .result-head,
  .result-actions,
  .header {
    grid-template-columns: 1fr;
    display: grid;
  }
}
`;

function isTextInput(element: Element | null): element is HTMLInputElement {
  return element instanceof HTMLInputElement && ["text", "search", "email", "url", "tel", "password"].includes(element.type);
}

function isEditableElement(element: EventTarget | null): element is EditableTarget {
  return (
    element instanceof HTMLTextAreaElement ||
    isTextInput(element instanceof Element ? element : null) ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

function activeSelectionText(): string {
  const selection = window.getSelection()?.toString().trim() ?? "";
  return selection.slice(0, 120);
}

function describeTarget(target: EditableTarget | null): string {
  if (!target) {
    return "No target field captured yet. Focus an input or editor before opening search.";
  }
  if (target instanceof HTMLTextAreaElement) {
    return target.getAttribute("aria-label") || target.placeholder || "Textarea";
  }
  if (target instanceof HTMLInputElement) {
    return target.getAttribute("aria-label") || target.placeholder || `Input (${target.type})`;
  }
  return target.getAttribute("aria-label") || target.getAttribute("role") || "Rich text editor";
}

function dispatchInputLikeEvent(target: HTMLElement): void {
  target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

function insertIntoTextInput(target: HTMLInputElement | HTMLTextAreaElement, text: string): boolean {
  target.focus();
  const start = typeof target.selectionStart === "number" ? target.selectionStart : target.value.length;
  const end = typeof target.selectionEnd === "number" ? target.selectionEnd : start;
  const prefix = target.value.slice(0, start);
  const suffix = target.value.slice(end);
  target.value = `${prefix}${text}${suffix}`;
  const caret = start + text.length;
  if (typeof target.setSelectionRange === "function") {
    try {
      target.setSelectionRange(caret, caret);
    } catch {
      // Some inputs reject programmatic selection changes after blur; the text is already inserted.
    }
  }
  dispatchInputLikeEvent(target);
  target.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function insertIntoContentEditable(target: HTMLElement, text: string): boolean {
  target.focus();
  const selection = window.getSelection();
  if (!selection) {
    return false;
  }

  let range: Range;
  if (selection.rangeCount > 0 && target.contains(selection.getRangeAt(0).commonAncestorContainer)) {
    range = selection.getRangeAt(0);
  } else {
    range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  dispatchInputLikeEvent(target);
  return true;
}

function insertIntoTarget(target: EditableTarget | null, text: string): boolean {
  if (!target || !target.isConnected) {
    return false;
  }
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    return insertIntoTextInput(target, text);
  }
  return insertIntoContentEditable(target, text);
}

export function createQuickSearchPalette(sendMessage: SearchRequester): QuickSearchPalette {
  let host: HTMLDivElement | null = null;
  let shadow: ShadowRoot | null = null;
  let queryInput: HTMLInputElement | null = null;
  let targetValue: HTMLParagraphElement | null = null;
  let statusLine: HTMLParagraphElement | null = null;
  let resultsRoot: HTMLDivElement | null = null;
  let lastFocusedEditable: EditableTarget | null = null;
  let capturedTarget: EditableTarget | null = null;
  let isOpen = false;
  let isLoading = false;
  let errorMessage = "";
  let query = "";
  let selectedIndex = 0;
  let results: BackendSearchResult[] = [];
  let debounceHandle: number | null = null;
  let requestSequence = 0;

  function isOverlayTarget(target: EventTarget | null): boolean {
    return target instanceof Node && Boolean((shadow && shadow.contains(target)) || (host && host.contains(target)));
  }

  function captureEditableTarget(event: FocusEvent): void {
    if (!isEditableElement(event.target)) {
      return;
    }
    if (isOverlayTarget(event.target)) {
      return;
    }
    lastFocusedEditable = event.target;
  }

  function renderResults(): void {
    if (!resultsRoot) {
      return;
    }
    const root = resultsRoot;

    root.replaceChildren();
    if (!query.trim()) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Type a search query to pull facts, sessions, and graph entities from SaveMyContext.";
      root.append(empty);
      return;
    }
    if (errorMessage) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = errorMessage;
      root.append(empty);
      return;
    }
    if (isLoading) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Searching your SaveMyContext knowledge base…";
      root.append(empty);
      return;
    }
    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No matches yet. Try a narrower term, an entity name, or a keyword from a factual note.";
      root.append(empty);
      return;
    }

    results.forEach((result, index) => {
      const card = document.createElement("article");
      card.className = `result${index === selectedIndex ? " selected" : ""}`;
      card.dataset.index = String(index);

      const head = document.createElement("div");
      head.className = "result-head";

      const textBlock = document.createElement("div");
      const title = document.createElement("p");
      title.className = "result-title";
      title.textContent = result.title;
      textBlock.append(title);

      const badges = document.createElement("div");
      badges.className = "badges";
      for (const label of [resultKindLabel(result), result.provider, result.category].filter(Boolean)) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = String(label);
        badges.append(badge);
      }

      const snippet = document.createElement("p");
      snippet.className = "result-snippet";
      snippet.textContent = result.snippet;

      const actions = document.createElement("div");
      actions.className = "result-actions";

      const source = document.createElement("div");
      source.className = "source";
      source.textContent = result.markdown_path ?? "Stored in the local SaveMyContext knowledge base";

      const insert = document.createElement("button");
      insert.className = "insert";
      insert.type = "button";
      insert.textContent = "Insert";
      insert.disabled = !capturedTarget;
      insert.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void commitResult(index);
      });
      insert.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      insert.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void commitResult(index);
      });

      head.append(textBlock, badges);
      actions.append(source, insert);
      card.append(head, snippet, actions);
      card.addEventListener("mouseenter", () => {
        selectedIndex = index;
        renderResults();
      });
      card.addEventListener("click", () => {
        selectedIndex = index;
        renderResults();
      });
      root.append(card);
    });
  }

  function renderMeta(): void {
    if (targetValue) {
      targetValue.textContent = describeTarget(capturedTarget);
    }
    if (statusLine) {
      statusLine.textContent = errorMessage
        ? errorMessage
        : isLoading
          ? "Searching…"
          : results.length
            ? `Found ${results.length} result${results.length === 1 ? "" : "s"}. Enter inserts the selected result.`
            : "Focus a field, search, then insert the result at the caret.";
      statusLine.className = `status${errorMessage ? " error" : ""}`;
    }
  }

  function render(): void {
    renderMeta();
    renderResults();
  }

  async function performSearch(nextQuery: string): Promise<void> {
    const trimmed = nextQuery.trim();
    requestSequence += 1;
    const requestId = requestSequence;

    if (trimmed.length < 2) {
      isLoading = false;
      errorMessage = "";
      results = [];
      selectedIndex = 0;
      render();
      return;
    }

    isLoading = true;
    errorMessage = "";
    render();

    try {
      const response = await sendMessage<KnowledgeSearchResponse>({
        type: "SEARCH_KNOWLEDGE",
        payload: {
          query: trimmed,
          limit: 8
        }
      });
      if (requestId !== requestSequence) {
        return;
      }

      isLoading = false;
      if (!response.ok) {
        results = [];
        errorMessage = response.error ?? "SaveMyContext search failed.";
        render();
        return;
      }

      results = prioritizeKnowledgeResults(response.results);
      selectedIndex = 0;
      errorMessage = "";
      render();
    } catch (error) {
      if (requestId !== requestSequence) {
        return;
      }
      isLoading = false;
      results = [];
      errorMessage = error instanceof Error ? error.message : String(error);
      render();
    }
  }

  function scheduleSearch(nextQuery: string): void {
    query = nextQuery;
    if (debounceHandle !== null) {
      window.clearTimeout(debounceHandle);
    }
    debounceHandle = window.setTimeout(() => {
      void performSearch(query);
    }, DEBOUNCE_MS);
    render();
  }

  function currentTarget(): EditableTarget | null {
    if (capturedTarget && capturedTarget.isConnected) {
      return capturedTarget;
    }
    if (lastFocusedEditable && lastFocusedEditable.isConnected && !isOverlayTarget(lastFocusedEditable)) {
      return lastFocusedEditable;
    }
    return isEditableElement(document.activeElement) && !isOverlayTarget(document.activeElement)
      ? document.activeElement
      : null;
  }

  async function commitResult(index: number): Promise<void> {
    try {
      const target = currentTarget();
      if (!target) {
        errorMessage = "No input target is available. Focus a text box, then open search again.";
        render();
        return;
      }

      const result = results[index];
      if (!result) {
        return;
      }

      const inserted = insertIntoTarget(target, buildInsertionText(result));
      if (!inserted) {
        errorMessage = "Could not inject into the selected field.";
        render();
        return;
      }

      close();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      render();
    }
  }

  function handleSearchKeydown(event: KeyboardEvent): void {
    if (!isOpen) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (results.length) {
        selectedIndex = (selectedIndex + 1) % results.length;
        renderResults();
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length) {
        selectedIndex = (selectedIndex - 1 + results.length) % results.length;
        renderResults();
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (!results.length) {
        return;
      }
      event.preventDefault();
      void commitResult(selectedIndex);
    }
  }

  function buildDom(): void {
    if (host && shadow) {
      return;
    }

    host = document.createElement("div");
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = STYLE_TEXT;

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        close();
      }
    });

    const panel = document.createElement("section");
    panel.className = "panel";

    const header = document.createElement("div");
    header.className = "header";

    const heading = document.createElement("div");
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "SaveMyContext Quick Search";
    const title = document.createElement("h2");
    title.className = "title";
    title.textContent = "Search and inject";
    const summary = document.createElement("p");
    summary.className = "summary";
    summary.textContent = "Find facts from your local context store and insert them into the field you were editing.";
    heading.append(eyebrow, title, summary);

    const closeButton = document.createElement("button");
    closeButton.className = "close";
    closeButton.type = "button";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", () => {
      dismiss();
    });

    header.append(heading, closeButton);

    const search = document.createElement("div");
    search.className = "search";
    queryInput = document.createElement("input");
    queryInput.id = "savemycontext-quick-search-query";
    queryInput.type = "search";
    queryInput.placeholder = "Search facts, entities, sessions, or to-do items";
    queryInput.autocomplete = "off";
    queryInput.addEventListener("input", () => {
      scheduleSearch(queryInput?.value ?? "");
    });
    queryInput.addEventListener("keydown", handleSearchKeydown);
    search.append(queryInput);

    const meta = document.createElement("div");
    meta.className = "meta";

    const targetCard = document.createElement("div");
    targetCard.className = "meta-card";
    const targetLabel = document.createElement("p");
    targetLabel.className = "meta-label";
    targetLabel.textContent = "Target Field";
    targetValue = document.createElement("p");
    targetValue.className = "target-value";
    targetCard.append(targetLabel, targetValue);

    const shortcutCard = document.createElement("div");
    shortcutCard.className = "meta-card";
    const shortcutLabel = document.createElement("p");
    shortcutLabel.className = "meta-label";
    shortcutLabel.textContent = "Keyboard";
    statusLine = document.createElement("p");
    statusLine.className = "status";
    shortcutCard.append(shortcutLabel, statusLine);

    meta.append(targetCard, shortcutCard);

    resultsRoot = document.createElement("div");
    resultsRoot.className = "results";
    resultsRoot.id = "savemycontext-quick-search-results";

    panel.append(header, search, meta, resultsRoot);
    overlay.append(panel);
    shadow.append(style, overlay);
    document.documentElement.append(host);
  }

  function open(): void {
    buildDom();
    if (!host || !queryInput) {
      return;
    }
    isOpen = true;
    host.hidden = false;
    capturedTarget = currentTarget();
    const selectedText = activeSelectionText();
    if (!query && selectedText.length >= 2) {
      query = selectedText;
    }
    queryInput.value = query;
    render();
    queryInput.focus();
    queryInput.select();
    if (query.trim().length >= 2) {
      void performSearch(query);
    }
  }

  function dismiss(): void {
    close();
  }

  function close(): void {
    isOpen = false;
    if (host) {
      host.hidden = true;
    }
    const target = currentTarget();
    if (target) {
      target.focus();
    }
  }

  document.addEventListener("focusin", captureEditableTarget, true);
  window.addEventListener("keydown", (event) => {
    if (isOpen && event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });

  return {
    toggle() {
      if (isOpen) {
        close();
        return;
      }
      open();
    }
  };
}
