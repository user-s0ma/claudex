import type { JsonObject } from "./types.ts";

function textPartTypeForRole(role: string): "input_text" | "output_text" {
  return role === "assistant" ? "output_text" : "input_text";
}

export function approxTokenCount(body: JsonObject): number {
  const lines: string[] = [];
  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      if (typeof message?.content === "string") {
        lines.push(message.content);
        continue;
      }
      if (Array.isArray(message?.content)) {
        for (const part of message.content) {
          if (typeof part?.text === "string") {
            lines.push(part.text);
          }
          if (typeof part?.content === "string") {
            lines.push(part.content);
          }
        }
      }
    }
  }

  const text = lines.join("\n");
  return Math.max(1, Math.ceil(text.length / 4));
}

function hasExplicitEffort(body: JsonObject): boolean {
  return Boolean(
    (typeof body?.effort === "string" && body.effort.length > 0) ||
    (typeof body?.output_config?.effort === "string" &&
      body.output_config.effort.length > 0) ||
    (typeof body?.reasoning?.effort === "string" &&
      body.reasoning.effort.length > 0),
  );
}

export function applyDefaultEffort(
  body: JsonObject,
  options: {
    forcedModel: string;
    defaultReasoningEffort: string;
    preserveClientEffort: boolean;
    modelEffortInfo?: { defaultEffort: string; supportedEfforts: string[] };
  },
): void {
  if (options.preserveClientEffort || hasExplicitEffort(body)) {
    return;
  }

  const info = options.modelEffortInfo;
  if (!info || info.supportedEfforts.length === 0) return;

  let effort = options.defaultReasoningEffort;
  if (effort === "xhigh" && !info.supportedEfforts.includes("xhigh")) {
    const preferred = ["xhigh", "high", "medium", "low"];
    effort =
      preferred.find((e) => info.supportedEfforts.includes(e)) ||
      info.defaultEffort;
  }

  if (typeof body.output_config !== "object" || body.output_config === null) {
    body.output_config = {};
  }
  body.output_config.effort = effort;

  if (typeof body.reasoning !== "object" || body.reasoning === null) {
    body.reasoning = {};
  }
  body.reasoning.effort = effort;
}

export function sanitizeToolFields(body: JsonObject): number {
  let removed = 0;
  if (!Array.isArray(body?.tools)) {
    return removed;
  }

  for (const tool of body.tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }
    if ("defer_loading" in tool) {
      delete tool.defer_loading;
      removed += 1;
    }
  }

  return removed;
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (!item || typeof item !== "object") {
        continue;
      }
      const text = (item as Record<string, unknown>).text;
      if (typeof text === "string") {
        parts.push(text);
      }
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  try {
    return JSON.stringify(content ?? "");
  } catch {
    return String(content ?? "");
  }
}

export function extractInstructionsFromSystem(
  systemField: unknown,
): string | undefined {
  if (typeof systemField === "string" && systemField.trim().length > 0) {
    return systemField.trim();
  }
  if (!Array.isArray(systemField)) {
    return undefined;
  }

  const parts: string[] = [];
  for (const item of systemField) {
    if (typeof item === "string" && item.trim().length > 0) {
      parts.push(item.trim());
      continue;
    }
    if (item && typeof item === "object") {
      const text = (item as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim().length > 0) {
        parts.push(text.trim());
      }
    }
  }

  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n\n");
}

export function toResponsesInput(
  messages: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) {
    return [];
  }

  const mapped: Array<Record<string, unknown>> = [];
  let fallbackCallId = 0;

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const roleRaw = (message as Record<string, unknown>).role;
    const role = typeof roleRaw === "string" ? roleRaw : "user";
    const contentRaw = (message as Record<string, unknown>).content;

    const textParts: Array<Record<string, unknown>> = [];
    const flushTextParts = (): void => {
      if (textParts.length === 0) {
        return;
      }
      mapped.push({
        role,
        content: [...textParts],
      });
      textParts.length = 0;
    };

    const pushText = (text: string): void => {
      if (text.length === 0) {
        return;
      }
      textParts.push({
        type: textPartTypeForRole(role),
        text,
      });
    };

    if (typeof contentRaw === "string") {
      pushText(contentRaw);
      flushTextParts();
      continue;
    }

    if (!Array.isArray(contentRaw)) {
      continue;
    }

    for (const part of contentRaw) {
      if (typeof part === "string") {
        pushText(part);
        continue;
      }
      if (!part || typeof part !== "object") {
        continue;
      }

      const partObject = part as Record<string, unknown>;
      const partType =
        typeof partObject.type === "string" ? partObject.type : "";

      if (partType === "tool_use") {
        const name =
          typeof partObject.name === "string" ? partObject.name : undefined;
        if (!name) {
          continue;
        }
        flushTextParts();
        const callIdRaw = partObject.id;
        const callId =
          typeof callIdRaw === "string" && callIdRaw.length > 0
            ? callIdRaw
            : `call_${++fallbackCallId}`;
        const input = partObject.input ?? {};
        mapped.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: typeof input === "string" ? input : JSON.stringify(input),
        });
        continue;
      }

      if (partType === "tool_result") {
        const callIdRaw = partObject.tool_use_id ?? partObject.id;
        const callId = typeof callIdRaw === "string" ? callIdRaw : undefined;
        if (!callId) {
          continue;
        }
        flushTextParts();
        mapped.push({
          type: "function_call_output",
          call_id: callId,
          output: normalizeToolResultContent(partObject.content),
        });
        continue;
      }

      const text = partObject.text;
      if (typeof text === "string") {
        pushText(text);
        continue;
      }
      const nestedContent = partObject.content;
      if (typeof nestedContent === "string") {
        pushText(nestedContent);
      }
    }

    flushTextParts();
  }

  return mapped;
}

function stripNullValues(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      result[key] = stripNullValues(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function parseFunctionCallArguments(
  argumentsRaw: unknown,
): Record<string, unknown> {
  if (
    argumentsRaw &&
    typeof argumentsRaw === "object" &&
    !Array.isArray(argumentsRaw)
  ) {
    return stripNullValues(argumentsRaw as Record<string, unknown>);
  }
  if (typeof argumentsRaw !== "string") {
    return {};
  }
  const trimmed = argumentsRaw.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return stripNullValues(parsed as Record<string, unknown>);
    }
    return {};
  } catch {
    return {};
  }
}

export function mapResponsesOutputToAnthropicContent(output: unknown): {
  content: Array<Record<string, unknown>>;
  stopReason: "tool_use" | "end_turn";
} {
  if (!Array.isArray(output)) {
    return { content: [], stopReason: "end_turn" };
  }

  const content: Array<Record<string, unknown>> = [];
  let hasToolUse = false;
  let fallbackToolUseId = 0;

  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const itemType = typeof obj.type === "string" ? obj.type : "";

    if (itemType === "message" && Array.isArray(obj.content)) {
      for (const part of obj.content) {
        if (!part || typeof part !== "object") {
          continue;
        }
        const partObj = part as Record<string, unknown>;
        const partType = typeof partObj.type === "string" ? partObj.type : "";
        const text = partObj.text;
        if (
          (partType === "output_text" || partType === "text") &&
          typeof text === "string"
        ) {
          content.push({
            type: "text",
            text,
          });
        }
      }
      continue;
    }

    if (itemType === "function_call") {
      const name = typeof obj.name === "string" ? obj.name : "";
      if (!name) {
        continue;
      }
      const idRaw = obj.call_id ?? obj.id;
      const id =
        typeof idRaw === "string" && idRaw.length > 0
          ? idRaw
          : `toolu_${++fallbackToolUseId}`;
      content.push({
        type: "tool_use",
        id,
        name,
        input: parseFunctionCallArguments(obj.arguments ?? obj.input),
      });
      hasToolUse = true;
      continue;
    }
  }

  return {
    content,
    stopReason: hasToolUse ? "tool_use" : "end_turn",
  };
}
