/**
 * Forward an MCP request to the persistent Node backend. The backend owns
 * authentication and browser sessions. The destination is server-configured.
 */
export async function proxyMcp(request, backendUrl, fetchImpl = fetch) {
  let endpoint;
  try {
    endpoint = new URL(backendUrl);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
        endpoint.pathname !== "/mcp" || endpoint.search || endpoint.hash) {
      throw new Error("Invalid endpoint");
    }
  } catch {
    return new Response("MCP_BACKEND_URL must be an HTTP(S) URL ending in /mcp", { status: 503 });
  }

  const headers = new Headers();
  for (const name of ["authorization", "content-type", "accept", "origin", "mcp-protocol-version", "mcp-session-id", "last-event-id", "access-control-request-method", "access-control-request-headers"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  const method = request.method.toUpperCase();
  if (!["GET", "POST", "DELETE", "OPTIONS"].includes(method)) {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST, DELETE, OPTIONS" } });
  }

  try {
    const body = method === "POST" ? await request.arrayBuffer() : undefined;
    const upstream = await fetchImpl(endpoint.toString(), { method, headers, body, redirect: "manual" });
    const responseHeaders = new Headers();
    for (const name of ["content-type", "cache-control", "mcp-session-id", "mcp-protocol-version", "www-authenticate", "access-control-allow-origin", "access-control-allow-headers", "access-control-allow-methods", "access-control-expose-headers", "vary", "allow"]) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return new Response("MCP backend unavailable", { status: 502 });
  }
}
