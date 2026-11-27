/**
 * Removes credentials from anything that can reach a client, a log line, or an
 * error message. Providers may place tokens in connection URLs, so whole query
 * strings are stripped before the generic key/value rules run.
 */
const SECRET_KEYS = [
  "token",
  "key",
  "api_key",
  "apikey",
  "api-key",
  "access_token",
  "secret",
  "password",
  "signature",
  "sig",
  "auth",
  "authorization",
];

const QUERY_PATTERN = /([?&])([^=&\s]+)=([^&\s]*)/g;

export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: readonly string[]) {
    this.secrets = secrets
      .map(secret => secret.trim())
      .filter(secret => secret.length >= 8)
      // Longest first so a token that contains another token is fully removed.
      .sort((left, right) => right.length - left.length);
  }

  /** Redacts secret values, bearer headers, and connection-string queries. */
  text(value: string): string {
    let output = value;
    for (const secret of this.secrets) {
      output = output.split(secret).join("[redacted]");
    }
    output = output.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
    output = output.replace(
      /(?:wss?|https?):\/\/[^\s"'<>]*/gi,
      url => stripUrlSecrets(url),
    );
    output = output.replace(QUERY_PATTERN, (match, separator: string, name: string) => {
      return SECRET_KEYS.includes(name.toLowerCase()) ? `${separator}${name}=[redacted]` : match;
    });
    return output;
  }

  /**
   * Turns an arbitrary thrown value into a short, redacted single-line message.
   * Stack traces and provider payloads are deliberately dropped.
   */
  error(error: unknown): string {
    const raw =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "unexpected failure";
    const collapsed = raw.replace(/\s+/g, " ").trim() || "unexpected failure";
    return this.text(collapsed).slice(0, 400);
  }
}

/** Drops userinfo and query values from a URL, keeping the shape readable. */
export function stripUrlSecrets(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/\s?#]*)([^?\s#]*)(\?[^\s#]*)?/i.exec(url);
  if (!match) return "[redacted-url]";
  const [, scheme, authority, path, query] = match;
  const host = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  return `${scheme}://${host}${path ?? ""}${query ? "?[redacted]" : ""}`;
}
