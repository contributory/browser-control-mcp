import { DestinationPolicy } from "./util/destination.js";
import { Redactor } from "./util/redact.js";

export interface SessionLimits {
  /** Close a browser session after this much inactivity. */
  idleTtlMs: number;
  /** Hard cap on a session's total lifetime. */
  maxLifetimeMs: number;
  /** Timeout for connecting Playwright to the provider endpoint. */
  connectTimeoutMs: number;
  /** Default timeout for a single browser action. */
  actionTimeoutMs: number;
  /** Concurrent sessions owned by one authenticated principal. */
  maxSessionsPerPrincipal: number;
  /** Concurrent sessions across all principals. */
  maxSessionsTotal: number;
  /** Maximum tabs (pages) a session may have. */
  maxPages: number;
  /** Byte budget for textual tool output such as snapshots and console reads. */
  maxOutputBytes: number;
  /** Byte budget for screenshot payloads. */
  maxImageBytes: number;
  /** Maximum steps in one `playwright_act` sequence. */
  maxActionSteps: number;
  /** Longest explicit wait a step may request. */
  maxWaitMs: number;
}

export interface DiagnosticLimits {
  /** Entries retained per console/network buffer before the oldest are dropped. */
  maxEntries: number;
  /** Buffer lifetime after the last read, in milliseconds. */
  ttlMs: number;
  /** Maximum CDP event subscriptions per browser session. */
  maxSubscriptions: number;
  /** Maximum parameters/result size for one CDP command. */
  maxCdpBytes: number;
  /** Privileged JavaScript evaluation via `playwright_evaluate`. */
  evaluateEnabled: boolean;
  /** Privileged read-only CDP inspection via `playwright_cdp_*`. */
  cdpEnabled: boolean;
}

export interface HttpLimits {
  /** Largest accepted JSON request body. */
  maxRequestBytes: number;
  /** Per-request socket timeout. */
  requestTimeoutMs: number;
}

export interface AppConfig {
  host: string;
  port: number;
  /** Accepted bearer tokens; the matched token identifies the principal. */
  authTokens: readonly string[];
  allowedOrigins: ReadonlySet<string>;
  /** Playwright provider names callers may open; empty means all configured. */
  allowedServices: readonly string[];
  destinations: DestinationPolicy;
  redactor: Redactor;
  session: SessionLimits;
  diagnostics: DiagnosticLimits;
  http: HttpLimits;
  /** Provider credentials read once at startup. Never logged or returned. */
  providerEnv: NodeJS.ProcessEnv;
}

/** Secrets that must never appear in output; every configured key is included. */
const SECRET_ENV_NAMES = [
  "MCP_AUTH_TOKEN",
  "MCP_OAUTH_SECRET",
  "BROWSER_SESSION_SECRET",
  "HYPERBROWSER_API_KEY",
  "BROWSERCLOUD_TOKEN",
  "PHANTOMJSCLOUD_API_KEY",
] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const authTokens = splitList(env.MCP_AUTH_TOKEN);
  if (authTokens.length === 0) throw new Error("MCP_AUTH_TOKEN is required.");

  const port = readInt(env, "PORT", 3000, 0, 65535);
  const host = env.HOST?.trim() || "127.0.0.1";
  const session: SessionLimits = {
    idleTtlMs: readInt(env, "BROWSER_SESSION_IDLE_TTL_MS", 300_000, 30_000, 3_600_000),
    maxLifetimeMs: readInt(env, "BROWSER_SESSION_MAX_LIFETIME_MS", 900_000, 60_000, 3_600_000),
    connectTimeoutMs: readInt(env, "BROWSER_CONNECT_TIMEOUT_MS", 30_000, 1_000, 120_000),
    actionTimeoutMs: readInt(env, "BROWSER_ACTION_TIMEOUT_MS", 15_000, 500, 120_000),
    maxSessionsPerPrincipal: readInt(env, "BROWSER_MAX_SESSIONS_PER_PRINCIPAL", 2, 1, 32),
    maxSessionsTotal: readInt(env, "BROWSER_MAX_SESSIONS_TOTAL", 8, 1, 128),
    maxPages: readInt(env, "BROWSER_MAX_PAGES", 1, 1, 10),
    maxOutputBytes: readInt(env, "BROWSER_MAX_OUTPUT_BYTES", 64 * 1024, 1024, 1024 * 1024),
    maxImageBytes: readInt(env, "BROWSER_MAX_IMAGE_BYTES", 1_500_000, 1024, 8 * 1024 * 1024),
    maxActionSteps: readInt(env, "BROWSER_MAX_ACTION_STEPS", 12, 1, 50),
    maxWaitMs: readInt(env, "BROWSER_MAX_WAIT_MS", 5_000, 0, 60_000),
  };
  if (session.idleTtlMs > session.maxLifetimeMs) {
    throw new Error("BROWSER_SESSION_IDLE_TTL_MS must not exceed BROWSER_SESSION_MAX_LIFETIME_MS.");
  }

  const diagnostics: DiagnosticLimits = {
    maxEntries: readInt(env, "BROWSER_DIAGNOSTIC_MAX_ENTRIES", 200, 1, 5_000),
    ttlMs: readInt(env, "BROWSER_DIAGNOSTIC_TTL_MS", 300_000, 1_000, 3_600_000),
    maxSubscriptions: readInt(env, "BROWSER_CDP_MAX_SUBSCRIPTIONS", 4, 1, 16),
    maxCdpBytes: readInt(env, "BROWSER_CDP_MAX_BYTES", 32 * 1024, 1024, 1024 * 1024),
    evaluateEnabled: readBool(env, "BROWSER_ENABLE_EVALUATE", false),
    cdpEnabled: readBool(env, "BROWSER_ENABLE_CDP", false),
  };

  const secrets = [
    ...SECRET_ENV_NAMES.flatMap(name => splitList(env[name])),
    ...Object.entries(env)
      .filter(([name]) => name.startsWith("PLAYWRIGHT_CDP_"))
      .map(([, value]) => value ?? ""),
  ];

  return {
    host,
    port,
    authTokens,
    allowedOrigins: new Set(splitList(env.MCP_ALLOWED_ORIGINS)),
    allowedServices: splitList(env.BROWSER_ALLOWED_SERVICES).map(name => name.toLowerCase()),
    destinations: new DestinationPolicy(splitList(env.BROWSER_ALLOWED_ORIGINS)),
    redactor: new Redactor(secrets),
    session,
    diagnostics,
    http: {
      maxRequestBytes: readInt(env, "MCP_MAX_REQUEST_BYTES", 256 * 1024, 1024, 4 * 1024 * 1024),
      requestTimeoutMs: readInt(env, "MCP_REQUEST_TIMEOUT_MS", 60_000, 1_000, 600_000),
    },
    providerEnv: env,
  };
}

export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}
