/**
 * Tool-level errors carry a stable machine-readable code. Messages must never
 * contain credentials, endpoints, page content, or form values.
 */
export type ToolErrorCode =
  | "INVALID_ARGUMENT"
  | "DESTINATION_BLOCKED"
  | "SERVICE_UNAVAILABLE"
  | "QUOTA_EXCEEDED"
  | "NOT_FOUND"
  | "SESSION_EXPIRED"
  | "TIMEOUT"
  | "UNSUPPORTED"
  | "DISABLED"
  | "OUTPUT_TOO_LARGE"
  | "PROVIDER_ERROR"
  | "INTERNAL_ERROR";

export class ToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}
