import { beforeEach, describe, expect, it, vi } from "vitest";

describe("backend validation helpers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({ version: "0.1.0" })
      }
    });
  });

  it("treats localhost as local", async () => {
    const { isLocalBackendUrl } = await import("../src/background/backend");
    expect(isLocalBackendUrl(new URL("http://127.0.0.1:18888"))).toBe(true);
    expect(isLocalBackendUrl(new URL("http://localhost:18888"))).toBe(true);
    expect(isLocalBackendUrl(new URL("https://notes.example.com"))).toBe(false);
  });

  it("rejects insecure remote backends", async () => {
    const { validateBackendConfiguration } = await import("../src/background/backend");
    await expect(
      validateBackendConfiguration({
        backendUrl: "http://notes.example.com",
        backendToken: "",
        autoSyncHistory: true,
        indexingMode: "all",
        triggerWords: ["lorem"],
        blacklistWords: [],
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        }
      })
    ).rejects.toThrow("Remote backends must use https://.");
  });

  it("requires a token for remote app-token backends", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          product: "tsmc-server",
          version: "0.2.0",
          api_prefix: "/api/v1",
          server_time: "2026-04-02T00:00:00Z",
          auth: {
            mode: "app_token",
            token_verify_path: "/api/v1/auth/token/verify",
            local_unauthenticated_access: true,
            remote_requires_token: true
          },
          extension: {
            min_version: "0.1.0",
            auth_mode: "app_token"
          },
          features: {
            ingest: true,
            search: true,
            graph: true,
            obsidian_vault: true,
            knowledge_graph_files: true,
            agent_api: true,
            browser_proxy: false,
            openai_compatible_api: false
          },
          storage: {
            markdown_root: "/srv/tsmc/markdown",
            vault_root: "/srv/tsmc/markdown/TSMC"
          }
        })
      }))
    );

    const { validateBackendConfiguration } = await import("../src/background/backend");
    await expect(
      validateBackendConfiguration({
        backendUrl: "https://notes.example.com",
        backendToken: "",
        autoSyncHistory: true,
        indexingMode: "all",
        triggerWords: ["lorem"],
        blacklistWords: [],
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        }
      })
    ).rejects.toThrow("A backend app token is required for remote sync.");
  });

  it("fetches dashboard summary with backend auth headers", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        total_sessions: 3,
        total_messages: 6,
        total_triplets: 3,
        total_sync_events: 3,
        active_tokens: 0,
        latest_sync_at: "2026-04-14T00:00:00Z",
        categories: [
          { category: "factual", count: 1 },
          { category: "ideas", count: 1 },
          { category: "todo", count: 1 }
        ]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchDashboardSummary } = await import("../src/background/backend");
    const summary = await fetchDashboardSummary({
      backendUrl: "https://notes.example.com/",
      backendToken: "tsmc_pat_test",
      autoSyncHistory: true,
      indexingMode: "all",
      triggerWords: ["lorem"],
      blacklistWords: [],
      enabledProviders: {
        chatgpt: true,
        gemini: true,
        grok: true
      }
    });

    expect(fetchMock).toHaveBeenCalledWith("https://notes.example.com/api/v1/dashboard/summary", {
      headers: {
        Authorization: "Bearer tsmc_pat_test"
      }
    });
    expect(summary.total_sessions).toBe(3);
    expect(summary.categories).toHaveLength(3);
  });

  it("fetches knowledge search results with encoded query params", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        query: "rust ownership",
        count: 1,
        results: [
          {
            kind: "entity",
            title: "Rust",
            snippet: "Rust | uses | ownership"
          }
        ]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchKnowledgeSearch } = await import("../src/background/backend");
    const response = await fetchKnowledgeSearch(
      {
        backendUrl: "https://notes.example.com/",
        backendToken: "tsmc_pat_test",
        autoSyncHistory: true,
        indexingMode: "all",
        triggerWords: ["lorem"],
        blacklistWords: [],
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        }
      },
      "rust ownership",
      5
    );

    expect(fetchMock).toHaveBeenCalledWith("https://notes.example.com/api/v1/search?q=rust+ownership&limit=5", {
      headers: {
        Authorization: "Bearer tsmc_pat_test"
      }
    });
    expect(response.count).toBe(1);
    expect(response.results[0]?.snippet).toBe("Rust | uses | ownership");
  });
});
