import { proxyMcp } from "../shared/mcp-proxy.js";

export default function onRequest(context) {
  return proxyMcp(context.request, context.env.MCP_BACKEND_URL);
}
