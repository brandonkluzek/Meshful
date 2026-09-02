// Worker-compatible primitives. No authentication, provider, or scheduler lives here.
export class BackendError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "BackendError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export function requireThat(condition, code, message, status = 400) {
  if (!condition) throw new BackendError(code, message, status);
}

export function object(value, label = "value") {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_INPUT", `${label} must be an object`);
  requireThat([Object.prototype, null].includes(Object.getPrototypeOf(value)),
    "INVALID_INPUT", `${label} must be a plain object`);
  return value;
}

export function exactKeys(value, allowed, required = allowed, label = "input") {
  object(value, label);
  requireThat(Object.keys(value).every((key) => allowed.includes(key)),
    "INVALID_INPUT", `${label} contains an unsupported property`);
  requireThat(required.every((key) => Object.hasOwn(value, key)),
    "INVALID_INPUT", `${label} is missing a required property`);
}

export function text(value, label, max = 128) {
  requireThat(typeof value === "string" && value.trim().length > 0 && value.length <= max,
    "INVALID_INPUT", `${label} must be a nonblank string of at most ${max} characters`);
  return value; // Identity and learner text are never trimmed or normalized.
}

export function revision(value, label = "expected_revision") {
  requireThat(Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER,
    "INVALID_INPUT", `${label} must be a nonnegative safe integer`);
  return value;
}

export function identity(value) {
  exactKeys(value, ["provider", "issuer", "subject"], undefined, "identity");
  text(value.provider, "identity.provider", 64);
  text(value.issuer, "identity.issuer", 512);
  text(value.subject, "identity.subject", 512);
  return value;
}

export function catalogRef(value) {
  exactKeys(value, ["version", "digest"], undefined, "catalog_ref");
  text(value.version, "catalog_ref.version", 128);
  requireThat(typeof value.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.digest),
    "INVALID_INPUT", "catalog_ref.digest must be SHA-256");
  return value;
}

export function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

// Reject non-JSON values and dangerous object keys before passing data into the
// canonical engine. Bounded recursion also covers direct service callers.
export function assertJson(value, { maxDepth = 80, maxNodes = 150_000 } = {}) {
  let count = 0;
  const ancestors = new Set();
  function visit(item, depth) {
    requireThat(++count <= maxNodes && depth <= maxDepth, "INPUT_TOO_LARGE", "JSON is too complex", 413);
    if (item === null || ["string", "boolean"].includes(typeof item)) return;
    if (typeof item === "number") {
      requireThat(Number.isFinite(item), "INVALID_INPUT", "JSON numbers must be finite");
      return;
    }
    requireThat(typeof item === "object" && !ancestors.has(item), "INVALID_INPUT", "Expected acyclic JSON");
    if (!Array.isArray(item)) object(item);
    ancestors.add(item);
    for (const [key, child] of Object.entries(item)) {
      requireThat(key !== "__proto__",
        "INVALID_INPUT", "Unsafe JSON property");
      visit(child, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  return value;
}

export function stableJson(value, options) {
  assertJson(value, typeof options === "object" ? options : undefined);
  function encode(item) {
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    if (item !== null && typeof item === "object") {
      return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode(item[key])}`).join(",")}}`;
    }
    return JSON.stringify(item);
  }
  return encode(value);
}

export async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Supports exactly the JSON Schema vocabulary used by the injected WebMCP
// contracts. Unknown validation keywords fail at setup instead of weakening a
// later contract. This is validation plumbing, not a fork of the card schema.
const SCHEMA_KEYS = new Set([
  "type", "properties", "required", "additionalProperties", "minProperties", "maxProperties",
  "items", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern",
  "minimum", "maximum", "enum", "const", "oneOf", "description", "title", "default", "examples",
]);

export function checkSchema(schema) {
  object(schema, "schema");
  requireThat(schema.type === undefined || ["object", "array", "string", "integer", "number", "boolean", "null"].includes(schema.type),
    "CONTRACT_UNSUPPORTED", "Unsupported schema type; update the adapter before enabling the changed contract", 503);
  requireThat(schema.additionalProperties === undefined || typeof schema.additionalProperties === "boolean",
    "CONTRACT_UNSUPPORTED", "Schema-valued additionalProperties is not supported", 503);
  for (const key of Object.keys(schema)) {
    requireThat(SCHEMA_KEYS.has(key), "CONTRACT_UNSUPPORTED", `Unsupported schema keyword: ${key}`, 503);
  }
  for (const child of Object.values(schema.properties ?? {})) checkSchema(child);
  if (schema.items) checkSchema(schema.items);
  for (const child of schema.oneOf ?? []) checkSchema(child);
}

export function validateSchema(schema, value, path = "args") {
  const invalid = (message) => { throw new BackendError("INVALID_TOOL_INPUT", `${path} ${message}`); };
  if (schema.oneOf) {
    const count = schema.oneOf.filter((candidate) => {
      try { validateSchema(candidate, value, path); return true; } catch { return false; }
    }).length;
    if (count !== 1) invalid("must match exactly one allowed shape");
  }
  if (Object.hasOwn(schema, "const") && stableJson(value) !== stableJson(schema.const)) invalid("has an invalid constant");
  if (schema.enum && !schema.enum.some((item) => stableJson(item) === stableJson(value))) invalid("has an invalid value");
  if (schema.type === "object") {
    object(value, path);
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) invalid(`requires ${key}`);
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) invalid("has too few properties");
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) invalid("has too many properties");
    for (const key of keys) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validateSchema(schema.properties[key], value[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) invalid("contains an unsupported property");
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) invalid("must be an array");
    if (schema.minItems !== undefined && value.length < schema.minItems) invalid("has too few items");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) invalid("has too many items");
    if (schema.uniqueItems && new Set(value.map(stableJson)).size !== value.length) invalid("must contain unique items");
    value.forEach((item, i) => validateSchema(schema.items ?? {}, item, `${path}[${i}]`));
  } else if (schema.type === "string") {
    if (typeof value !== "string") invalid("must be a string");
    if (schema.minLength !== undefined && value.length < schema.minLength) invalid("is too short");
    if (schema.maxLength !== undefined && value.length > schema.maxLength) invalid("is too long");
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) invalid("has an invalid format");
  } else if (["number", "integer"].includes(schema.type)) {
    if (typeof value !== "number" || !Number.isFinite(value)) invalid("must be a finite number");
    if (schema.type === "integer" && !Number.isSafeInteger(value)) invalid("must be a safe integer");
    if (schema.minimum !== undefined && value < schema.minimum) invalid("is below its minimum");
    if (schema.maximum !== undefined && value > schema.maximum) invalid("is above its maximum");
  } else if (schema.type === "boolean" && typeof value !== "boolean") invalid("must be a boolean");
  else if (schema.type === "null" && value !== null) invalid("must be null");
}
