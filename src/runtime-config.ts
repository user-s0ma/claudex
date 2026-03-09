import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  parseApiKeyFromAuthJson,
  parseChatgptRefreshConfigFromAuthJson,
  parseChatgptTokenFromAuthJson,
} from "./auth-json.ts";
import { readConfig } from "./config.ts";

interface ModelMapping {
  opus: string;
  sonnet: string;
  haiku: string;
  small: string;
  subagent: string;
}

export interface RuntimeConfig {
  upstreamBaseUrl: string;
  upstreamBearerToken: string;
  upstreamExtraHeaders: Record<string, string>;
  forcedModel: string;
  availableModels: string[];
  modelEffortMap: Map<
    string,
    { defaultEffort: string; supportedEfforts: string[] }
  >;
  modelMapping: ModelMapping;
  authMode: "provider-api-key" | "chatgpt-token" | "chatgpt-api-key";
  chatgptRefreshConfig?: {
    authPath: string;
    refreshToken: string;
    clientId: string;
  };
}

interface CachedModelInfo {
  slug: string;
  defaultEffort: string;
  supportedEfforts: string[];
}

export function trimOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

const codexHome = join(homedir(), ".codex");

function resolveAuthPath(): string {
  return join(codexHome, "auth.json");
}

function resolveModelsCachePath(): string {
  return join(codexHome, "models_cache.json");
}

function readLatestModelFromCache(): string | null {
  try {
    const cachePath = resolveModelsCachePath();
    if (!existsSync(cachePath)) return null;
    const data = JSON.parse(readFileSync(cachePath, "utf8")) as any;
    if (!Array.isArray(data?.models) || data.models.length === 0) return null;

    const listed = data.models.filter(
      (m: any) =>
        m?.slug && m.visibility === "list" && m.supported_in_api !== false,
    );
    const latest = listed.find((m: any) => !m.upgrade);
    if (latest?.slug) return String(latest.slug);

    const sorted = listed
      .map((m: any) => String(m.slug))
      .sort((a: string, b: string) =>
        b.localeCompare(a, undefined, { numeric: true }),
      );
    return sorted[0] || null;
  } catch {
    return null;
  }
}

function resolveChatgptModel(
  forcedModel: string,
  forcedModelSource: string,
  defaultForcedModel: string,
): string {
  if (forcedModelSource !== "default" || forcedModel !== defaultForcedModel) {
    return forcedModel;
  }
  const cached = readLatestModelFromCache();
  if (cached) return cached;
  return defaultForcedModel;
}

function readModelsCacheRaw(): CachedModelInfo[] {
  try {
    const cachePath = resolveModelsCachePath();
    if (!existsSync(cachePath)) return [];
    const data = JSON.parse(readFileSync(cachePath, "utf8")) as any;
    if (!Array.isArray(data?.models)) return [];
    return data.models
      .filter(
        (m: any) =>
          m?.slug && m.visibility === "list" && m.supported_in_api !== false,
      )
      .sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m: any) => ({
        slug: String(m.slug),
        defaultEffort: String(m.default_reasoning_level || "medium"),
        supportedEfforts: Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels
              .map((l: any) => String(l.effort || ""))
              .filter(Boolean)
          : [],
      }));
  } catch {
    return [];
  }
}

export function readAvailableModelsFromCache(): string[] {
  return readModelsCacheRaw().map((m) => m.slug);
}

function readModelEffortMap(): Map<
  string,
  { defaultEffort: string; supportedEfforts: string[] }
> {
  const map = new Map<
    string,
    { defaultEffort: string; supportedEfforts: string[] }
  >();
  for (const model of readModelsCacheRaw()) {
    map.set(model.slug, {
      defaultEffort: model.defaultEffort,
      supportedEfforts: model.supportedEfforts,
    });
  }
  return map;
}

function buildModelMapping(
  defaultModel: string,
  forcedModelSource: string,
  available: string[],
): ModelMapping {
  const all = {
    opus: defaultModel,
    sonnet: defaultModel,
    haiku: defaultModel,
    small: defaultModel,
    subagent: defaultModel,
  };
  if (forcedModelSource !== "default" || available.length <= 1) return all;
  const others = available.filter((model) => model !== defaultModel);
  if (others.length === 0) return all;
  return {
    opus: others[0] || defaultModel,
    sonnet: defaultModel,
    haiku: others[others.length - 1] || defaultModel,
    small: others[others.length - 1] || defaultModel,
    subagent: others[Math.min(1, others.length - 1)] || defaultModel,
  };
}

function resolveChatgptModelBundle(
  forcedModel: string,
  forcedModelSource: string,
  defaultForcedModel: string,
): {
  resolvedModel: string;
  availableModels: string[];
  modelMapping: ModelMapping;
} {
  const resolvedModel = resolveChatgptModel(
    forcedModel,
    forcedModelSource,
    defaultForcedModel,
  );
  const available = readAvailableModelsFromCache();
  const availableModels = available.length > 0 ? available : [resolvedModel];
  return {
    resolvedModel,
    availableModels,
    modelMapping: buildModelMapping(
      resolvedModel,
      forcedModelSource,
      availableModels,
    ),
  };
}

export function loadRuntimeConfig(): RuntimeConfig {
  const config = readConfig();
  const authPath = resolveAuthPath();
  const baseUrlOverride =
    process.env.CLAUDEX_BASE_URL?.trim() || trimOrNull(config.base_url);
  const chatgptBaseUrl = "https://chatgpt.com/backend-api/codex";
  const envApiKey =
    process.env.CLAUDEX_API_KEY || trimOrNull(config.api_key) || undefined;

  const effortMap = readModelEffortMap();
  const forceModelFromEnv =
    process.env.CLAUDEX_MODEL?.trim() ||
    trimOrNull(config.model);
  const forcedModelSource = forceModelFromEnv ? "env" : "default";
  const defaultForcedModel = "gpt-5.4";
  const forcedModel = (forceModelFromEnv || defaultForcedModel).trim();

  const authFileExists = existsSync(authPath);
  const authContents = authFileExists ? readFileSync(authPath, "utf8") : "";
  if (!authFileExists && !envApiKey?.trim()) {
    throw new Error(`missing auth file: ${authPath}`);
  }

  if (baseUrlOverride) {
    return {
      upstreamBaseUrl: baseUrlOverride,
      upstreamBearerToken: parseApiKeyFromAuthJson(authContents, envApiKey),
      upstreamExtraHeaders: {},
      forcedModel,
      availableModels: [forcedModel],
      modelEffortMap: effortMap,
      modelMapping: buildModelMapping(forcedModel, "env", []),
      authMode: "provider-api-key",
    };
  }

  const chatgptModels = resolveChatgptModelBundle(
    forcedModel,
    forcedModelSource,
    defaultForcedModel,
  );

  try {
    const tokenAuth = parseChatgptTokenFromAuthJson(authContents);
    const refreshConfig = authContents.trim()
      ? parseChatgptRefreshConfigFromAuthJson(authContents)
      : {};
    const extraHeaders: Record<string, string> = {};
    if (tokenAuth.accountId) {
      extraHeaders["chatgpt-account-id"] = tokenAuth.accountId;
    }

    const canAutoRefresh =
      typeof refreshConfig.refreshToken === "string" &&
      refreshConfig.refreshToken.length > 0 &&
      typeof refreshConfig.clientId === "string" &&
      refreshConfig.clientId.length > 0;

    return {
      upstreamBaseUrl: chatgptBaseUrl,
      upstreamBearerToken: tokenAuth.bearerToken,
      upstreamExtraHeaders: extraHeaders,
      forcedModel: chatgptModels.resolvedModel,
      availableModels: chatgptModels.availableModels,
      modelEffortMap: effortMap,
      modelMapping: chatgptModels.modelMapping,
      authMode: "chatgpt-token",
      chatgptRefreshConfig: canAutoRefresh
        ? {
            authPath,
            refreshToken: refreshConfig.refreshToken!,
            clientId: refreshConfig.clientId!,
          }
        : undefined,
    };
  } catch {
    return {
      upstreamBaseUrl: chatgptBaseUrl,
      upstreamBearerToken: parseApiKeyFromAuthJson(authContents, envApiKey),
      upstreamExtraHeaders: {},
      forcedModel: chatgptModels.resolvedModel,
      availableModels: chatgptModels.availableModels,
      modelEffortMap: effortMap,
      modelMapping: chatgptModels.modelMapping,
      authMode: "chatgpt-api-key",
    };
  }
}
