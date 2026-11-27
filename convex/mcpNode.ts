"use node";

import { internalActionGeneric } from "convex/server";
import { v } from "convex/values";
import { handleServerless } from "../src/transport/serverless.js";

/** Internal Node runtime bridge. Convex HTTP Actions themselves cannot import Node APIs. */
export const handle = internalActionGeneric({
  args: {
    method: v.string(),
    headers: v.array(v.array(v.string())),
    body: v.union(v.bytes(), v.null()),
    tokenIndex: v.number(),
  },
  handler: async (_ctx, args) => {
    const headers = new Headers(args.headers as [string, string][]);
    const tokens = (process.env.MCP_AUTH_TOKEN ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const token = tokens[args.tokenIndex];
    if (!token) return { status: 401, headers: [["www-authenticate", "Bearer"]], body: null };
    headers.set("authorization", "Bearer " + token);
    const request = new Request("https://convex.internal/mcp", {
      method: args.method, headers, body: args.body,
    });
    const response = await handleServerless(request, process.env, { oauthHandledUpstream: true });
    return {
      status: response.status,
      headers: [...response.headers.entries()],
      body: response.body === null ? null : await response.text(),
    };
  },
});
