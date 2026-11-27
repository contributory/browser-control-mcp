import { ToolError } from "./errors.js";

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.home\.arpa$/i,
  /^0\.0\.0\.0$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

/**
 * Destination policy for navigation and for provider render requests.
 *
 * An empty allowlist keeps ordinary public HTTP(S) destinations usable while
 * refusing loopback, link-local and private addressing. A configured allowlist
 * (`BROWSER_ALLOWED_ORIGINS`) narrows this to explicit origins; entries may be
 * `https://app.example.com` or `https://*.example.com`.
 *
 * Server-side checks cannot stop SSRF inside a remote browser: the provider or
 * its egress proxy must enforce the same policy. See docs/providers.md.
 */
export class DestinationPolicy {
  private readonly rules: readonly string[];

  constructor(rules: readonly string[]) {
    this.rules = rules.map(rule => rule.trim()).filter(rule => rule.length > 0);
  }

  get configured(): boolean {
    return this.rules.length > 0;
  }

  describe(): string[] {
    return [...this.rules];
  }

  /** Throws a `DESTINATION_BLOCKED` ToolError when the URL is not permitted. */
  check(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ToolError("INVALID_ARGUMENT", "url must be an absolute HTTP(S) URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ToolError("INVALID_ARGUMENT", "Only http and https URLs are supported.");
    }
    if (url.username || url.password) {
      throw new ToolError("DESTINATION_BLOCKED", "URLs with embedded credentials are not allowed.");
    }
    if (this.configured) {
      if (!this.rules.some(rule => matchesRule(url, rule))) {
        throw new ToolError(
          "DESTINATION_BLOCKED",
          "The destination is not on the configured allowlist (BROWSER_ALLOWED_ORIGINS).",
        );
      }
      return url;
    }
    if (isPrivateHost(url.hostname)) {
      throw new ToolError(
        "DESTINATION_BLOCKED",
        "Private, loopback and link-local destinations are not allowed.",
      );
    }
    return url;
  }
}

function matchesRule(url: URL, rule: string): boolean {
  const withScheme = rule.includes("://") ? rule : `https://${rule}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return false;
  }
  if (parsed.protocol !== url.protocol) return false;
  const expectedPort = parsed.port || defaultPort(parsed.protocol);
  const actualPort = url.port || defaultPort(url.protocol);
  if (expectedPort !== actualPort) return false;

  const pattern = parsed.hostname.toLowerCase();
  const host = url.hostname.toLowerCase();
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return pattern === host;
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return PRIVATE_HOST_PATTERNS.some(pattern => pattern.test(host));
}
