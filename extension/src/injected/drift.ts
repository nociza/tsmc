import type { ProviderDriftAlert, ProviderName } from "../shared/types";

export class ProviderDriftError extends Error {
  readonly provider: ProviderName;
  readonly evidence?: string;

  constructor(provider: ProviderName, message: string, evidence?: string) {
    super(message);
    this.name = "ProviderDriftError";
    this.provider = provider;
    this.evidence = evidence;
  }
}

export function createProviderDriftError(
  provider: ProviderName,
  message: string,
  evidence?: string
): ProviderDriftError {
  return new ProviderDriftError(provider, message, evidence);
}

export function isProviderDriftError(value: unknown): value is ProviderDriftError {
  return value instanceof ProviderDriftError;
}

export function buildProviderDriftAlert(
  provider: ProviderName,
  pageUrl: string,
  message: string,
  evidence?: string
): ProviderDriftAlert {
  return {
    provider,
    detectedAt: new Date().toISOString(),
    pageUrl,
    message,
    evidence
  };
}
