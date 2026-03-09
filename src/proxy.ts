import http from "node:http";
import { Readable } from "node:stream";
import {
  applyDefaultEffort,
  approxTokenCount,
  sanitizeToolFields,
} from "./anthropic-responses.ts";
import type { JsonObject } from "./types.ts";
import {
  adaptAnthropicMessagesRequestForChatgpt,
  proxyChatgptCodexResponsesAsAnthropic,
  refreshChatgptBearerToken,
} from "./chatgpt-proxy.ts";
import {
  type AuthState,
  buildUpstreamUrl,
  isChatgptCodexOrigin,
  mergeRequestHeaders,
  rewriteRequestPath,
} from "./upstream.ts";

export interface ProxyOptions {
  forcedModel: string;
  availableModels: string[];
  modelEffortMap: Map<
    string,
    { defaultEffort: string; supportedEfforts: string[] }
  >;
  defaultReasoningEffort: string;
  preserveClientEffort: boolean;
  workspaceSummary?: string;
}

function writeJson(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function copyHeadersFromUpstream(headers: Headers): Record<string, string> {
  const skip = new Set([
    "transfer-encoding",
    "content-encoding",
    "content-length",
  ]);
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) out[key] = value;
  });
  return out;
}

function parseJsonObjectBuffer(bodyBuffer: Buffer): JsonObject | null {
  try {
    return bodyBuffer.length > 0 ? JSON.parse(bodyBuffer.toString("utf8")) : {};
  } catch {
    return null;
  }
}

function applyRequestedModel(
  parsed: JsonObject,
  options: Pick<ProxyOptions, "availableModels" | "forcedModel">,
): void {
  const requestedModel = String(parsed.model || "");
  parsed.model = options.availableModels.includes(requestedModel)
    ? requestedModel
    : options.forcedModel;
}

async function proxyRaw(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyBuffer: Buffer,
  requestPath: string,
  upstreamOrigin: URL,
  authState: AuthState,
  overrideBody: JsonObject | null = null,
  allowRefreshRetry = true,
): Promise<void> {
  const headers = mergeRequestHeaders(req, authState);

  let outboundBody = bodyBuffer;
  if (overrideBody !== null) {
    outboundBody = Buffer.from(JSON.stringify(overrideBody));
    headers["content-type"] = "application/json";
  }
  if (outboundBody.length > 0) {
    headers["content-length"] = String(outboundBody.length);
  }

  const upstreamUrl = buildUpstreamUrl(
    upstreamOrigin,
    rewriteRequestPath(upstreamOrigin, requestPath),
  );

  const upstreamResponse = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : outboundBody,
  });

  if (
    upstreamResponse.status === 401 &&
    allowRefreshRetry &&
    authState.chatgptRefreshConfig
  ) {
    try {
      await refreshChatgptBearerToken(authState);
      return proxyRaw(
        req,
        res,
        bodyBuffer,
        requestPath,
        upstreamOrigin,
        authState,
        overrideBody,
        false,
      );
    } catch {
      /* refresh failed, continue with original response */
    }
  }

  const copiedHeaders = copyHeadersFromUpstream(upstreamResponse.headers);
  res.writeHead(upstreamResponse.status, copiedHeaders);
  if (!upstreamResponse.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstreamResponse.body as any).pipe(res);
}

export async function startProxy(
  listenHost: string,
  listenPort: number,
  upstreamOrigin: URL,
  authState: AuthState,
  options: ProxyOptions,
): Promise<http.Server> {
  const isChatgpt = isChatgptCodexOrigin(upstreamOrigin);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${listenHost}:${listenPort}`);
      const path = url.pathname;
      const method = req.method || "GET";

      if (method === "GET" && path === "/health") {
        writeJson(res, 200, {
          ok: true,
          forced_model: options.forcedModel,
          upstream: upstreamOrigin.origin + upstreamOrigin.pathname,
        });
        return;
      }

      if (method === "GET" && path === "/v1/models") {
        const now = Math.floor(Date.now() / 1000);
        const models =
          options.availableModels.length > 0
            ? options.availableModels
            : [options.forcedModel];
        writeJson(res, 200, {
          object: "list",
          data: models.map((id) => ({
            id,
            object: "model",
            created: now,
            owned_by: "claudex",
          })),
        });
        return;
      }

      if (method === "GET" && path.startsWith("/v1/models/")) {
        writeJson(res, 200, {
          id: decodeURIComponent(path.slice("/v1/models/".length)),
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "claudex",
        });
        return;
      }

      if (method === "POST" && path === "/v1/messages/count_tokens") {
        const bodyBuffer = await readBody(req);
        const parsed = parseJsonObjectBuffer(bodyBuffer) || {};
        writeJson(res, 200, { input_tokens: approxTokenCount(parsed) });
        return;
      }

      if (method === "POST" && path === "/v1/messages") {
        const bodyBuffer = await readBody(req);
        const parsed = parseJsonObjectBuffer(bodyBuffer);
        if (!parsed) {
          writeJson(res, 400, {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Invalid JSON body",
            },
          });
          return;
        }

        applyRequestedModel(parsed, options);
        applyDefaultEffort(parsed, {
          forcedModel: parsed.model,
          defaultReasoningEffort: options.defaultReasoningEffort,
          preserveClientEffort: options.preserveClientEffort,
          modelEffortInfo: options.modelEffortMap.get(parsed.model),
        });
        sanitizeToolFields(parsed);

        if (isChatgpt) {
          await proxyChatgptCodexResponsesAsAnthropic(
            req,
            res,
            url.pathname + url.search,
            upstreamOrigin,
            authState,
            adaptAnthropicMessagesRequestForChatgpt(parsed, options),
          );
          return;
        }

        await proxyRaw(
          req,
          res,
          bodyBuffer,
          url.pathname + url.search,
          upstreamOrigin,
          authState,
          parsed,
        );
        return;
      }

      const bodyBuffer = await readBody(req);
      await proxyRaw(
        req,
        res,
        bodyBuffer,
        url.pathname + url.search,
        upstreamOrigin,
        authState,
      );
    } catch (error) {
      writeJson(res, 500, {
        type: "error",
        error: {
          type: "api_error",
          message: `claudex-proxy internal error: ${error instanceof Error ? error.message : error}`,
        },
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => resolve());
  });

  return server;
}
