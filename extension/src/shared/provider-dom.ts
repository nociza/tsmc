import type { ProviderName } from "./types";

export interface ProviderDomAdapter {
  startUrl: string;
  inputSelectors: string[];
  sendButtonSelectors: string[];
  stopButtonSelectors: string[];
  responseSelectors: string[];
  thinkingTogglePatterns: RegExp[];
  stopButtonPatterns: RegExp[];
}

export const providerDomAdapters: Record<ProviderName, ProviderDomAdapter> = {
  chatgpt: {
    startUrl: "https://chatgpt.com/",
    inputSelectors: [
      "#prompt-textarea",
      "textarea[data-id]",
      "form textarea",
      "textarea",
      "div[contenteditable='true'][role='textbox']"
    ],
    sendButtonSelectors: [
      "button[data-testid='send-button']",
      "button[aria-label*='Send']",
      "form button[type='submit']"
    ],
    stopButtonSelectors: [
      "button[data-testid='stop-button']",
      "button[aria-label*='Stop']",
      "button[title*='Stop']"
    ],
    responseSelectors: ["article div[data-message-author-role='assistant']", "main article"],
    thinkingTogglePatterns: [/think/i, /reason/i, /research/i],
    stopButtonPatterns: [/stop/i, /interrupt/i, /cancel/i]
  },
  gemini: {
    startUrl: "https://gemini.google.com/app",
    inputSelectors: [
      "rich-textarea textarea",
      "div[contenteditable='true'][role='textbox']",
      "div.ql-editor[contenteditable='true']",
      "textarea"
    ],
    sendButtonSelectors: [
      "button[aria-label*='Send']",
      "button[aria-label*='Run']",
      "button[mattooltip*='Send']",
      "form button[type='submit']"
    ],
    stopButtonSelectors: [
      "button[aria-label*='Stop']",
      "button[mattooltip*='Stop']",
      "button[title*='Stop']",
      "button[aria-label*='Cancel']"
    ],
    responseSelectors: ["message-content", "article model-response", "main article"],
    thinkingTogglePatterns: [/thinking/i, /reason/i, /research/i],
    stopButtonPatterns: [/stop/i, /cancel/i]
  },
  grok: {
    startUrl: "https://grok.com/",
    inputSelectors: ["textarea", "div[contenteditable='true'][role='textbox']", "div[contenteditable='true']"],
    sendButtonSelectors: ["button[aria-label*='Send']", "button[data-testid*='send']", "form button[type='submit']"],
    stopButtonSelectors: [
      "button[aria-label*='Stop']",
      "button[title*='Stop']",
      "button[data-testid*='stop']"
    ],
    responseSelectors: ["article", "main article", "[data-testid*='message']"],
    thinkingTogglePatterns: [/think/i, /reason/i, /deep\\s*search/i, /research/i],
    stopButtonPatterns: [/stop/i, /interrupt/i, /cancel/i]
  }
};
