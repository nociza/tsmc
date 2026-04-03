import type { BackendCapabilities, ExtensionSettings } from "../shared/types";

function normalizeBackendUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/$/, "");
}

export function isLocalBackendUrl(candidate: URL): boolean {
  return candidate.hostname === "127.0.0.1" || candidate.hostname === "localhost" || candidate.hostname === "[::1]";
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return 0;
}

function authorizationHeader(token?: string): Record<string, string> {
  if (!token) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

export function buildBackendHeaders(settings: ExtensionSettings): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...authorizationHeader(settings.backendToken)
  };
}

export async function validateBackendConfiguration(settings: ExtensionSettings): Promise<{
  normalizedUrl: string;
  capabilities: BackendCapabilities;
}> {
  const normalizedUrl = normalizeBackendUrl(settings.backendUrl);
  const parsedUrl = new URL(normalizedUrl);
  const isLocal = isLocalBackendUrl(parsedUrl);
  if (!isLocal && parsedUrl.protocol !== "https:") {
    throw new Error("Remote backends must use https://.");
  }

  const capabilityResponse = await fetch(`${normalizedUrl}/api/v1/meta/capabilities`, {
    headers: authorizationHeader(settings.backendToken)
  });
  if (!capabilityResponse.ok) {
    throw new Error(`Compatibility check failed with ${capabilityResponse.status}.`);
  }

  const capabilities = (await capabilityResponse.json()) as BackendCapabilities;
  if (capabilities.product !== "tsmc-server") {
    throw new Error("The configured backend is not a TSMC server.");
  }

  const extensionVersion = chrome.runtime.getManifest().version;
  if (compareVersions(extensionVersion, capabilities.extension.min_version) < 0) {
    throw new Error(
      `This extension is too old for the backend. Minimum required version: ${capabilities.extension.min_version}.`
    );
  }

  if (!isLocal && capabilities.auth.mode !== "app_token") {
    throw new Error("Remote TSMC backends must be provisioned with an app token first.");
  }

  if (!isLocal && !settings.backendToken) {
    throw new Error("A backend app token is required for remote sync.");
  }

  if (settings.backendToken) {
    const verifyResponse = await fetch(`${normalizedUrl}${capabilities.auth.token_verify_path}`, {
      headers: authorizationHeader(settings.backendToken)
    });
    if (!verifyResponse.ok) {
      throw new Error("The backend token is invalid or missing required access.");
    }
    const verification = (await verifyResponse.json()) as { valid?: boolean };
    if (!verification.valid) {
      throw new Error("The backend token is invalid.");
    }
  }

  return {
    normalizedUrl,
    capabilities
  };
}
