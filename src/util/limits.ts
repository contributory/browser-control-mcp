import { ToolError } from "./errors.js";

/** Coerces a value to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateBytes(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: value.length > 0 };
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  // Back off to a UTF-8 character boundary; continuation bytes are 0b10xxxxxx.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return { text: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

/** Truncates an arbitrary JSON-serializable value to a byte budget. */
export function serializeLimited(value: unknown, maxBytes: number): unknown {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new ToolError("INVALID_ARGUMENT", "The result is not serializable to JSON.");
  }
  if (json === undefined) return null;
  if (Buffer.byteLength(json, "utf8") <= maxBytes) return value;
  const { text, truncated } = truncateBytes(json, maxBytes - 64);
  return { truncated, json: text };
}

/** Rejects values that a caller supplied for a bounded numeric option. */
export function requireIntInRange(
  name: string,
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ToolError("INVALID_ARGUMENT", `${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
