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
    expect(isLocalBackendUrl(new URL("http://127.0.0.1:8000"))).toBe(true);
    expect(isLocalBackendUrl(new URL("http://localhost:8000"))).toBe(true);
    expect(isLocalBackendUrl(new URL("https://notes.example.com"))).toBe(false);
  });

  it("rejects insecure remote backends", async () => {
    const { validateBackendConfiguration } = await import("../src/background/backend");
    await expect(
      validateBackendConfiguration({
        backendUrl: "http://notes.example.com",
        backendToken: "",
        autoSyncHistory: true,
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
            agent_api: true
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
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        }
      })
    ).rejects.toThrow("A backend app token is required for remote sync.");
  });
});
