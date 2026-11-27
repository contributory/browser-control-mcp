import { ToolError } from "../util/errors.js";
import { truncateBytes } from "../util/limits.js";
import type { Redactor } from "../util/redact.js";

const DEFAULT_ENDPOINT = "https://phantomjscloud.com/api/browser/v2";

/** Render types documented for `IPageRequest.renderType`. */
export type PhantomJsCloudFormat = "png" | "jpeg" | "pdf" | "html" | "plainText";

export interface RenderOptions {
  url: string;
  format: PhantomJsCloudFormat;
  viewportWidth?: number;
  viewportHeight?: number;
  zoomFactor?: number;
  selector?: string;
  /** Total time allowed for the provider call. */
  timeoutMs: number;
  /** Byte budget for the returned payload. */
  maxBytes: number;
}

export interface RenderResult {
  format: PhantomJsCloudFormat;
  finalUrl?: string;
  statusCode?: number;
  contentType: string;
  /** Present for text formats. */
  text?: string;
  /** Present for image and PDF formats. */
  data?: Buffer;
  truncated: boolean;
  creditCost?: number;
  elapsedMs?: number;
}

interface UserResponse {
  statusCode?: number;
  content?: {
    data?: string;
    encoding?: string;
    name?: string;
    url?: string;
    statusCode?: number;
    size?: number;
    extraHeaders?: Record<string, string>;
  };
  meta?: { billing?: { creditCost?: number; elapsedMs?: number } };
}

/**
 * PhantomJSCloud Standard JSON API (verified against
 * https://phantomjscloud.com/docs/http-api/):
 *
 *   POST https://phantomjscloud.com/api/browser/v2/{KEY}/
 *   Content-Type: application/json
 *   body: IPageRequest JSON
 *
 * `outputAsJson: true` returns an IUserResponse whose `content.data` is base64
 * for images/PDF and utf8 for text.
 */
export class PhantomJsCloudClient {
  private readonly endpoint: string;

  constructor(
    private readonly apiKey: string,
    private readonly redactor: Redactor,
    endpoint: string = DEFAULT_ENDPOINT,
  ) {
    this.endpoint = endpoint.replace(/\/+$/, "");
  }

  async render(options: RenderOptions): Promise<RenderResult> {
    const renderSettings: Record<string, unknown> = {};
    if (options.viewportWidth && options.viewportHeight) {
      renderSettings.viewport = { width: options.viewportWidth, height: options.viewportHeight };
    }
    if (options.zoomFactor !== undefined) renderSettings.zoomFactor = options.zoomFactor;
    if (options.selector) renderSettings.selector = options.selector;

    const body: Record<string, unknown> = {
      url: options.url,
      renderType: options.format,
      outputAsJson: true,
      suppressJson: ["pageResponses", "originalRequest", "meta.trace", "meta.backend"],
      ...(Object.keys(renderSettings).length > 0 ? { renderSettings } : {}),
    };

    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/${encodeURIComponent(this.apiKey)}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ToolError("TIMEOUT", "The render request exceeded its timeout.");
      }
      throw new ToolError("PROVIDER_ERROR", `The render request failed: ${this.redactor.error(error)}`);
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new ToolError("PROVIDER_ERROR", describeStatus(response.status, this.redactor, raw));
    }

    let payload: UserResponse;
    try {
      payload = JSON.parse(raw) as UserResponse;
    } catch {
      throw new ToolError("PROVIDER_ERROR", "The render service returned an unreadable response.");
    }

    const content = payload.content;
    if (!content || typeof content.data !== "string") {
      throw new ToolError("PROVIDER_ERROR", "The render service returned no content.");
    }

    const isBinary = options.format === "png" || options.format === "jpeg" || options.format === "pdf";
    const result: RenderResult = {
      format: options.format,
      contentType: isBinary ? mimeTypeFor(options.format) : "text/plain",
      truncated: false,
      ...(content.url ? { finalUrl: content.url } : {}),
      ...(typeof content.statusCode === "number" ? { statusCode: content.statusCode } : {}),
      ...(typeof payload.meta?.billing?.creditCost === "number"
        ? { creditCost: payload.meta.billing.creditCost }
        : {}),
      ...(typeof payload.meta?.billing?.elapsedMs === "number"
        ? { elapsedMs: payload.meta.billing.elapsedMs }
        : {}),
    };

    if (isBinary) {
      const decoded = Buffer.from(content.data, "base64");
      if (decoded.byteLength > options.maxBytes) {
        throw new ToolError(
          "OUTPUT_TOO_LARGE",
          `Rendered ${options.format} is ${decoded.byteLength} bytes, above the ${options.maxBytes} byte limit.`,
        );
      }
      result.data = decoded;
      result.contentType = options.format === "pdf" ? "application/pdf" : mimeTypeFor(options.format);
    } else {
      const bytes = Buffer.byteLength(content.data, "utf8");
      if (bytes > options.maxBytes) {
        const limited = truncateBytes(content.data, options.maxBytes);
        result.text = limited.text;
        result.truncated = true;
      } else {
        result.text = content.data;
      }
    }
    return result;
  }
}

function describeStatus(status: number, redactor: Redactor, raw: string): string {
  if (status === 401 || status === 403) {
    return "The render service rejected the API key.";
  }
  if (status === 402 || status === 429) {
    return "The render service reported a quota or rate limit.";
  }
  const detail = redactor.text(raw).replace(/\s+/g, " ").trim().slice(0, 200);
  return detail ? `The render service returned HTTP ${status}: ${detail}` : `The render service returned HTTP ${status}.`;
}

function mimeTypeFor(format: PhantomJsCloudFormat): string {
  if (format === "png") return "image/png";
  if (format === "jpeg") return "image/jpeg";
  if (format === "pdf") return "application/pdf";
  return "text/plain";
}
