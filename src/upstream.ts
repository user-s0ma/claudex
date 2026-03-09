import type http from "node:http";

export interface AuthState {
  bearerToken: string;
  extraHeaders: Record<string, string>;
  chatgptRefreshConfig?: {
    authPath: string;
    refreshToken: string;
    clientId: string;
  };
  refreshInFlight?: Promise<string>;
}

function normalizeBasePath(pathname: string): string {
  if (pathname === "/" || !pathname.trim()) return "";
  return `/${pathname.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

export function isChatgptCodexOrigin(origin: URL): boolean {
  return (
    origin.hostname === "chatgpt.com" &&
    normalizeBasePath(origin.pathname).startsWith("/backend-api/codex")
  );
}

export function buildUpstreamUrl(
  upstreamOrigin: URL,
  requestPath: string,
): URL {
  const incoming = new URL(requestPath, "http://localhost");
  const basePath = normalizeBasePath(upstreamOrigin.pathname);
  let resolvedPath = incoming.pathname;
  if (
    basePath &&
    resolvedPath !== basePath &&
    !resolvedPath.startsWith(`${basePath}/`)
  ) {
    resolvedPath = `${basePath}${resolvedPath.startsWith("/") ? "" : "/"}${resolvedPath}`;
  }
  const upstream = new URL(upstreamOrigin.toString());
  upstream.pathname = resolvedPath;
  upstream.search = incoming.search;
  return upstream;
}

export function rewriteRequestPath(
  upstreamOrigin: URL,
  requestPath: string,
): string {
  const incoming = new URL(requestPath, "http://localhost");
  if (
    isChatgptCodexOrigin(upstreamOrigin) &&
    incoming.pathname === "/v1/messages"
  ) {
    incoming.pathname = "/responses";
  }
  return `${incoming.pathname}${incoming.search}`;
}

export function mergeRequestHeaders(
  req: http.IncomingMessage,
  authState: AuthState,
): Record<string, string> {
  const skip = new Set([
    "host",
    "content-length",
    "authorization",
    "accept-encoding",
  ]);
  const headers: Record<string, string> = {
    authorization: `Bearer ${authState.bearerToken}`,
    "accept-encoding": "identity",
  };
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (skip.has(lower)) continue;
    headers[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  for (const [key, value] of Object.entries(authState.extraHeaders)) {
    headers[key.toLowerCase()] = value;
  }
  return headers;
}
