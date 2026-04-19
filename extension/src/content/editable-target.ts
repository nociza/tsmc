export type EditableTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

function isTextInput(element: Element | null): element is HTMLInputElement {
  return element instanceof HTMLInputElement && ["text", "search", "email", "url", "tel", "password"].includes(element.type);
}

export function isEditableElement(element: EventTarget | null): element is EditableTarget {
  return (
    element instanceof HTMLTextAreaElement ||
    isTextInput(element instanceof Element ? element : null) ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

export function describeEditableTarget(target: EditableTarget | null): string {
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

export function insertIntoTarget(target: EditableTarget | null, text: string): boolean {
  if (!target || !target.isConnected) {
    return false;
  }
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    return insertIntoTextInput(target, text);
  }
  return insertIntoContentEditable(target, text);
}

export function readEditableText(target: EditableTarget | null): string {
  if (!target) {
    return "";
  }
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    return target.value.trim();
  }
  return (target.innerText || target.textContent || "").trim();
}
