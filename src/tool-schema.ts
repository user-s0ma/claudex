const STRICT_ALLOWED_KEYS = new Set([
  "type",
  "description",
  "title",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "anyOf",
  "oneOf",
]);

function defaultStrictSchema(isOptional: boolean): Record<string, unknown> {
  return isOptional
    ? { anyOf: [{ type: "string" }, { type: "null" }] }
    : { type: "string" };
}

function pickStrictAllowedKeys(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (STRICT_ALLOWED_KEYS.has(key)) result[key] = value;
  }
  return result;
}

function cleanStrictObjectSchema(result: Record<string, unknown>): void {
  const hasProps = result.properties && typeof result.properties === "object";
  const isObject = result.type === "object" || hasProps;
  if (!isObject) return;

  if (!result.type) result.type = "object";

  const originalRequired = new Set<string>(
    Array.isArray(result.required) ? (result.required as string[]) : [],
  );
  const properties = hasProps ? (result.properties as Record<string, unknown>) : {};
  const cleanedProperties: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties)) {
    cleanedProperties[key] = toStrictSchema(value, !originalRequired.has(key));
  }

  result.properties = cleanedProperties;
  result.required = Object.keys(cleanedProperties);
  result.additionalProperties = false;
}

function cleanStrictArraySchema(result: Record<string, unknown>): void {
  if (result.type === "array" && result.items && typeof result.items === "object") {
    result.items = toStrictSchema(result.items);
  }
}

function cleanStrictUnionSchemas(result: Record<string, unknown>): void {
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as unknown[]).map((schema) => toStrictSchema(schema));
    }
  }
}

function addNullBranchIfMissing(branches: unknown[]): void {
  if (!branches.some((value: any) => value?.type === "null")) {
    branches.push({ type: "null" });
  }
}

function wrapOptionalStrictSchema(
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (Array.isArray(result.anyOf)) {
    addNullBranchIfMissing(result.anyOf as unknown[]);
    return result;
  }
  if (Array.isArray(result.oneOf)) {
    addNullBranchIfMissing(result.oneOf as unknown[]);
    return result;
  }
  if (typeof result.type === "string") {
    const { description: desc, ...body } = result;
    const wrapped: Record<string, unknown> = {
      anyOf: [body, { type: "null" }],
    };
    if (desc !== undefined) wrapped.description = desc;
    return wrapped;
  }
  return result;
}

export function toStrictSchema(
  node: unknown,
  isOptional = false,
): Record<string, unknown> {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return defaultStrictSchema(isOptional);
  }

  const result = pickStrictAllowedKeys(node as Record<string, unknown>);
  cleanStrictObjectSchema(result);
  cleanStrictArraySchema(result);
  cleanStrictUnionSchemas(result);

  return isOptional ? wrapOptionalStrictSchema(result) : result;
}

export function mapAnthropicToolsToResponsesTools(
  tools: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) {
    return [];
  }

  const mapped: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }
    const obj = tool as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) {
      continue;
    }
    const description =
      typeof obj.description === "string" ? obj.description.trim() : "";
    const inputSchema = obj.input_schema;
    const parameters =
      inputSchema && typeof inputSchema === "object"
        ? toStrictSchema(inputSchema)
        : {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          };

    const mappedTool: Record<string, unknown> = {
      type: "function",
      name,
      parameters,
      strict: true,
    };
    if (description) {
      mappedTool.description = description;
    }
    mapped.push(mappedTool);
  }

  return mapped;
}

export function mapAnthropicToolChoiceToResponsesToolChoice(
  toolChoice: unknown,
): unknown {
  if (typeof toolChoice === "string") {
    if (
      toolChoice === "auto" ||
      toolChoice === "none" ||
      toolChoice === "required"
    ) {
      return toolChoice;
    }
    if (toolChoice === "any") {
      return "required";
    }
    return undefined;
  }

  if (!toolChoice || typeof toolChoice !== "object") {
    return undefined;
  }

  const obj = toolChoice as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";
  const name = typeof obj.name === "string" ? obj.name : undefined;

  if (type === "auto" || type === "none" || type === "required") {
    return type;
  }
  if (type === "any") {
    return "required";
  }
  if ((type === "tool" || type === "function") && name) {
    return {
      type: "function",
      name,
    };
  }

  return undefined;
}
