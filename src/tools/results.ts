import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isToolError } from "../util/errors.js";
import type { Redactor } from "../util/redact.js";

/** Successful JSON result, mirrored into `structuredContent` for typed clients. */
export function ok(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** Image result with a JSON metadata block before the image payload. */
export function image(
  payload: Record<string, unknown>,
  data: Buffer,
  mimeType: string,
): CallToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload) },
      { type: "image", data: data.toString("base64"), mimeType },
    ],
    structuredContent: payload,
  };
}

/**
 * Machine-readable failure. Messages are redacted and never include request
 * bodies, form values, page content, endpoints, or credentials.
 */
export function failure(redactor: Redactor, error: unknown): CallToolResult {
  const code = isToolError(error) ? error.code : "INTERNAL_ERROR";
  const message = isToolError(error)
    ? error.message
    : `Unexpected failure: ${redactor.error(error)}`;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
    structuredContent: { error: { code, message } },
  };
}

/** Wraps a tool body so every thrown error becomes a redacted tool result. */
export function guarded<TArgs>(
  redactor: Redactor,
  body: (args: TArgs) => Promise<CallToolResult>,
): (args: TArgs) => Promise<CallToolResult> {
  return async (args: TArgs) => {
    try {
      return await body(args);
    } catch (error) {
      return failure(redactor, error);
    }
  };
}
