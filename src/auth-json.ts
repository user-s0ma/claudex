function parseAuthJson(contents: string): any {
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error("failed to parse ~/.codex/auth.json as JSON");
  }
}

function firstNonEmptyString(candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function pickFromParsedAuthJson(
  parsed: any,
  candidates: Array<(parsed: any) => unknown>,
): string | undefined {
  return firstNonEmptyString(candidates.map((getValue) => getValue(parsed)));
}

function pickChatgptAccountId(parsed: any): string | undefined {
  return firstNonEmptyString([
    parsed?.tokens?.account_id,
    parsed?.account_id,
    parsed?.chatgpt_account_id,
    parsed?.chatgptAccountId,
  ]);
}

export interface ParsedChatgptTokenFromAuth {
  bearerToken: string;
  accountId?: string;
  source:
    | "tokens.id_token"
    | "tokens.access_token"
    | "id_token"
    | "access_token";
}

function pickChatgptBearerToken(parsed: any): {
  bearerToken?: string;
  source?: ParsedChatgptTokenFromAuth["source"];
} {
  const orderedCandidates: Array<{
    source: ParsedChatgptTokenFromAuth["source"];
    getValue: (parsed: any) => unknown;
  }> = [
    {
      source: "tokens.access_token",
      getValue: (input) => input?.tokens?.access_token,
    },
    {
      source: "tokens.id_token",
      getValue: (input) => input?.tokens?.id_token,
    },
    {
      source: "access_token",
      getValue: (input) => input?.access_token,
    },
    {
      source: "id_token",
      getValue: (input) => input?.id_token,
    },
  ];

  for (const candidate of orderedCandidates) {
    const bearerToken = firstNonEmptyString([candidate.getValue(parsed)]);
    if (bearerToken) {
      return { bearerToken, source: candidate.source };
    }
  }

  return {};
}

export function parseApiKeyFromAuthJson(
  contents: string,
  envApiKey?: string,
): string {
  if (envApiKey?.trim()) {
    return envApiKey.trim();
  }

  const parsed = parseAuthJson(contents);

  const apiKey = pickFromParsedAuthJson(parsed, [
    (input) => input?.OPENAI_API_KEY,
    (input) => input?.openai_api_key,
    (input) => input?.api_key,
    (input) => input?.openai?.api_key,
    (input) => input?.providers?.openai?.api_key,
  ]);
  if (apiKey) {
    return apiKey;
  }

  throw new Error("failed to read OPENAI API key from ~/.codex/auth.json");
}

export function parseChatgptTokenFromAuthJson(
  contents: string,
): ParsedChatgptTokenFromAuth {
  const parsed = contents.trim().length > 0 ? parseAuthJson(contents) : {};
  const accountId = pickChatgptAccountId(parsed);

  const token = pickChatgptBearerToken(parsed);
  if (token.bearerToken && token.source) {
    return {
      bearerToken: token.bearerToken,
      accountId,
      source: token.source,
    };
  }

  throw new Error(
    "failed to read ChatGPT token from ~/.codex/auth.json (expected tokens.id_token or tokens.access_token)",
  );
}

function decodeJwtPayload(token?: string): any | null {
  if (typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export interface ParsedChatgptRefreshConfigFromAuth {
  refreshToken?: string;
  clientId?: string;
}

function parseJwtAudience(payload: any): string | undefined {
  const aud = payload?.aud;
  if (typeof aud === "string" && aud.trim().length > 0) {
    return aud.trim();
  }
  if (Array.isArray(aud)) {
    return firstNonEmptyString(aud);
  }
  return undefined;
}

export function parseChatgptRefreshConfigFromAuthJson(
  contents: string,
): ParsedChatgptRefreshConfigFromAuth {
  const parsed = parseAuthJson(contents);

  const refreshToken = pickFromParsedAuthJson(parsed, [
    (input) => input?.tokens?.refresh_token,
    (input) => input?.refresh_token,
  ]);
  const clientId =
    pickFromParsedAuthJson(parsed, [
      (input) => input?.tokens?.client_id,
      (input) => input?.client_id,
      (input) => input?.oauth?.client_id,
    ]) ||
    parseJwtAudience(
      decodeJwtPayload(
        pickFromParsedAuthJson(parsed, [
          (input) => input?.tokens?.id_token,
          (input) => input?.id_token,
        ]),
      ),
    );

  return { refreshToken, clientId };
}
