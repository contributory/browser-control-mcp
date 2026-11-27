import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { ToolError } from "../util/errors.js";

export interface RemoteHandle {
  service: string;
  providerId: string;
  owner: string;
  createdAt: number;
  expiresAt: number;
}

/** A confidential, authenticated capability. Never use a client-known MCP token as the key. */
export class SessionHandleCodec {
  private readonly key: Buffer;
  constructor(secret: string) {
    if (!secret) throw new Error("A server-only session secret is required");
    this.key = createHmac("sha256", secret).update("browser-control-mcp/remote-handle/v1").digest();
  }

  encode(handle: RemoteHandle): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from("browser-control-mcp:v1"));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(handle), "utf8"), cipher.final()]);
    return "r1_" + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }

  decode(id: string, owner: string): RemoteHandle {
    try {
      if (!/^r1_[A-Za-z0-9_-]{39,1021}$/.test(id)) throw new Error();
      const packed = Buffer.from(id.slice(3), "base64url");
      if (packed.toString("base64url") !== id.slice(3)) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, packed.subarray(0, 12));
      decipher.setAAD(Buffer.from("browser-control-mcp:v1"));
      decipher.setAuthTag(packed.subarray(12, 28));
      const value = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8")) as RemoteHandle;
      if (value.owner !== owner || typeof value.service !== "string" ||
          typeof value.providerId !== "string" || !value.providerId ||
          !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) ||
          value.expiresAt <= value.createdAt) throw new Error();
      return value;
    } catch {
      throw new ToolError("NOT_FOUND", "Unknown browser_id for this principal.");
    }
  }
}
