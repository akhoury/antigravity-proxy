const UNSUPPORTED_SCHEMA_FIELDS = new Set([
  "additionalProperties",
  "$schema",
  "$id",
  "$comment",
  "$ref",
  "$defs",
  "definitions",
  "const",
  "contentMediaType",
  "contentEncoding",
  "if",
  "then",
  "else",
  "not",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
  "minContains",
  "maxContains",
]);

const AGGRESSIVE_ALLOWED_SCHEMA_FIELDS = new Set([
  "type", "description", "properties", "required", "enum", "items", "nullable",
]);

export function shouldRetryWithAggressiveSchema(
  status: number, reason: string, errorBody: string, hasTools: boolean, aggressive: boolean
): boolean {
  if (status !== 400 || aggressive) return false;
  const lower = errorBody.toLowerCase();
  const explicitSchemaError = lower.includes("tool schema") ||
    lower.includes("invalid json payload") || lower.includes("function_declarations");
  return explicitSchemaError || (reason === "invalid_argument" && hasTools);
}

function resolveLocalRef(rootSchema: any, ref: string): any | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let current = rootSchema;
  for (const rawPart of ref.slice(2).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function fallbackForSchema(schema: any): any {
  const rawTypes = Array.isArray(schema?.type) ? schema.type : [schema?.type];
  const type = rawTypes.find((value: any) => typeof value === "string" && value !== "null");
  if (type === "array") return { type: "ARRAY", items: { type: "STRING" } };
  if (type === "object" || schema?.properties) return { type: "OBJECT" };
  if (typeof type === "string") return { type: type.toUpperCase() };
  if (Array.isArray(schema?.enum)) return { type: "STRING", enum: schema.enum };
  return { type: "OBJECT" };
}

function cleanSchema(
  schema: any,
  aggressive: boolean,
  rootSchema: any,
  resolvingRefs: ReadonlySet<string>
): any {
  if (schema === true) return { type: "STRING" };
  if (schema === false) return { type: "NULL" };
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => cleanSchema(item, aggressive, rootSchema, resolvingRefs));
  }

  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    const target = resolveLocalRef(rootSchema, ref);
    if (!target) return fallbackForSchema(schema);
    if (resolvingRefs.has(ref)) return fallbackForSchema(target);

    const merged = { ...target, ...schema };
    delete merged.$ref;
    const nextRefs = new Set(resolvingRefs);
    nextRefs.add(ref);
    return cleanSchema(merged, aggressive, rootSchema, nextRefs);
  }

  if (schema.anyOf || schema.oneOf) {
    const options = schema.anyOf || schema.oneOf;
    const bestOption = options.find((opt: any) => opt?.type === "object") ||
      options.find((opt: any) => opt?.type !== "null") || options[0];
    const cleaned = cleanSchema(bestOption, aggressive, rootSchema, resolvingRefs);
    if (options.some((opt: any) => opt?.type === "null") && cleaned && typeof cleaned === "object") {
      cleaned.nullable = true;
    }
    return cleaned;
  }

  const result: any = {};
  const propertyNames = new Set<string>();
  if (schema.properties && typeof schema.properties === "object") {
    for (const propName of Object.keys(schema.properties)) propertyNames.add(propName);
  }

  for (const [key, value] of Object.entries(schema)) {
    if (aggressive && !AGGRESSIVE_ALLOWED_SCHEMA_FIELDS.has(key)) continue;
    if (UNSUPPORTED_SCHEMA_FIELDS.has(key)) continue;

    if (key === "type") {
      const types = Array.isArray(value) ? value : [value];
      const actualType = types.find((item) => typeof item === "string" && item !== "null");
      if (types.includes("null")) result.nullable = true;
      if (typeof actualType === "string") result.type = actualType.toUpperCase();
    } else if (key === "properties" && typeof value === "object" && value !== null) {
      const props: Record<string, any> = {};
      const entries = Object.entries(value);
      if (entries.length > 0) {
        for (const [propName, propSchema] of entries) {
          props[propName] = cleanSchema(propSchema, aggressive, rootSchema, resolvingRefs);
        }
      } else {
        props._placeholder = {
          type: "BOOLEAN",
          description: "Technical placeholder to ensure non-empty schema"
        };
      }
      result.properties = props;
    } else if (key === "items" && typeof value === "object" && value !== null) {
      result.items = cleanSchema(value, aggressive, rootSchema, resolvingRefs);
    } else if (key === "required" && Array.isArray(value)) {
      if (propertyNames.size > 0) {
        const validRequired = value.filter((prop) => typeof prop === "string" && propertyNames.has(prop));
        if (validRequired.length > 0) result.required = validRequired;
      }
    } else if (key === "description" && !aggressive) {
      result.description = value;
    } else if (key === "nullable" && typeof value === "boolean") {
      result.nullable = value;
    } else if (key === "enum" || key === "format" || key === "default" || key === "examples") {
      result[key] = value;
    }
  }

  if (result.type === "ARRAY" && (!result.items || Object.keys(result.items).length === 0)) {
    result.items = { type: "STRING" };
  }
  if (!result.type && result.properties) result.type = "OBJECT";
  if (!result.type && result.enum) result.type = "STRING";
  if (Object.keys(result).length === 0) return fallbackForSchema(schema);
  return result;
}

export function cleanJSONSchemaForAntigravity(schema: any, aggressive: boolean = false): any {
  return cleanSchema(schema, aggressive, schema, new Set());
}
