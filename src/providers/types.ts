/** A remote session created by a provider adapter. */
export interface ProviderSession {
  /** Provider-side identifier used for cleanup; never returned to clients. */
  providerSessionId: string;
  /** Connection URL or HTTP endpoint for Playwright. Never returned to clients. */
  endpoint: string;
  /** `cdp` means `chromium.connectOverCDP`; no provider currently offers a Playwright server. */
  connectionKind: "cdp" | "playwright";
  /** Releases provider resources. Must be idempotent and safe to retry. */
  stop(): Promise<void>;
}

export interface OpenOptions {
  /** Total session lifetime the provider should allow. */
  maxLifetimeMs: number;
  /** Timeout for the provider's own create call. */
  timeoutMs: number;
}

/** A provider whose browsers can be driven through Playwright over CDP. */
export interface PlaywrightProvider {
  readonly name: string;
  readonly connectionKind: "cdp" | "playwright";
  open(options: OpenOptions): Promise<ProviderSession>;
}
