import type { BackendSessionListItem, ProviderName, SessionCategoryName } from "./types";

export const categoryOrder: SessionCategoryName[] = ["factual", "ideas", "journal", "todo"];

export const categoryLabels: Record<SessionCategoryName, string> = {
  factual: "Factual",
  ideas: "Ideas",
  journal: "Journal",
  todo: "To-Do"
};

export const categoryDescriptions: Record<SessionCategoryName, string> = {
  factual: "Verified notes, extracted facts, and the knowledge graph.",
  ideas: "Concepts, proposals, and next-step thinking.",
  journal: "Daily reflections, summaries, and action items.",
  todo: "Task updates and notes that changed the shared list."
};

export const categoryPalette: Record<SessionCategoryName, { accent: string; soft: string; ink: string }> = {
  factual: { accent: "#0f8a84", soft: "#e7f6f4", ink: "#095b58" },
  ideas: { accent: "#c77724", soft: "#fbf0e4", ink: "#855117" },
  journal: { accent: "#2477c7", soft: "#e8f1fb", ink: "#154d82" },
  todo: { accent: "#b04d37", soft: "#f8ebe7", ink: "#793324" }
};

export const providerLabels: Record<ProviderName, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  grok: "Grok"
};

export const providerColors: Record<ProviderName, string> = {
  chatgpt: "#0f8a84",
  gemini: "#c77724",
  grok: "#2477c7"
};

export type CategorySortMode = "recent" | "title";
export type CategoryWorkspaceView = "atlas" | "story" | "ops";

export function titleFromSession(session: Pick<BackendSessionListItem, "title" | "provider" | "external_session_id">): string {
  return session.title?.trim() || `${providerLabels[session.provider]} · ${session.external_session_id}`;
}

export function categoryPageUrl(state: {
  category: SessionCategoryName;
  q?: string;
  provider?: ProviderName | null;
  sort?: CategorySortMode | null;
  view?: CategoryWorkspaceView | null;
  bucket?: string | null;
  note?: string | null;
  userCategory?: string | null;
}): string {
  const url = new URL(chrome.runtime.getURL("category.html"));
  url.searchParams.set("category", state.category);
  if (state.q?.trim()) {
    url.searchParams.set("q", state.q.trim());
  }
  if (state.provider) {
    url.searchParams.set("provider", state.provider);
  }
  if (state.sort && state.sort !== "recent") {
    url.searchParams.set("sort", state.sort);
  }
  if (state.view && state.view !== "atlas") {
    url.searchParams.set("view", state.view);
  }
  if (state.bucket?.trim()) {
    url.searchParams.set("bucket", state.bucket.trim());
  }
  if (state.note) {
    url.searchParams.set("note", state.note);
  }
  if (state.userCategory?.trim()) {
    url.searchParams.set("userCategory", state.userCategory.trim());
  }
  return url.toString();
}

export function notePageUrl(state: {
  id: string;
  category?: SessionCategoryName | null;
  q?: string;
  provider?: ProviderName | null;
  sort?: CategorySortMode | null;
  userCategory?: string | null;
}): string {
  const url = new URL(chrome.runtime.getURL("note.html"));
  url.searchParams.set("id", state.id);
  if (state.category) {
    url.searchParams.set("category", state.category);
  }
  if (state.q?.trim()) {
    url.searchParams.set("q", state.q.trim());
  }
  if (state.provider) {
    url.searchParams.set("provider", state.provider);
  }
  if (state.sort && state.sort !== "recent") {
    url.searchParams.set("sort", state.sort);
  }
  if (state.userCategory?.trim()) {
    url.searchParams.set("userCategory", state.userCategory.trim());
  }
  return url.toString();
}

export function formatCompactDate(value?: string | null, fallback = "No data"): string {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

export function formatLongDate(value?: string | null, fallback = "No data"): string {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function parseCategory(value: string | null): SessionCategoryName {
  return categoryOrder.includes(value as SessionCategoryName) ? (value as SessionCategoryName) : "factual";
}

export function parseProvider(value: string | null): ProviderName | null {
  return value === "chatgpt" || value === "gemini" || value === "grok" ? value : null;
}

export function parseSortMode(value: string | null): CategorySortMode {
  return value === "title" ? "title" : "recent";
}

export function parseCategoryWorkspaceView(value: string | null): CategoryWorkspaceView {
  return value === "story" || value === "ops" ? value : "atlas";
}
