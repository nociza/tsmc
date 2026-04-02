import type { ProviderName } from "./types";

export function detectProviderFromUrl(url: string): ProviderName | null {
  try {
    const hostname = new URL(url).hostname;
    if (/chatgpt\.com|chat\.openai\.com/.test(hostname)) {
      return "chatgpt";
    }
    if (/gemini\.google\.com/.test(hostname)) {
      return "gemini";
    }
    if (/grok\.com|x\.com/.test(hostname)) {
      return "grok";
    }
  } catch {
    return null;
  }
  return null;
}

export function supportsProactiveHistorySync(provider: ProviderName): boolean {
  return provider === "chatgpt" || provider === "gemini" || provider === "grok";
}
