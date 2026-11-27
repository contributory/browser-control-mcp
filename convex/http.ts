import { httpRouter, httpActionGeneric } from "convex/server";
import { proxyMcp } from "../shared/mcp-proxy.js";

const http = httpRouter();
const proxy = httpActionGeneric(async (_ctx, request) =>
  proxyMcp(request, process.env.MCP_BACKEND_URL),
);

for (const method of ["GET", "POST", "DELETE", "OPTIONS"] as const) {
  http.route({ path: "/mcp", method, handler: proxy });
}

export default http;
