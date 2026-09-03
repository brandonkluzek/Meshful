import { byteLength, requireThat } from "../../src/contracts.mjs";

// An explicit local qualification profile, not a promise of unlimited history
// or proof of the eventual Sites dispatcher's memory/CPU/storage allocation.
// The aggregate no longer has to fit one D1 row. This is the canonical engine's
// materialized working-set boundary; recovery reads remain separately paged.
export const MAX_WORKING_STATE_BYTES = 8 * 1_024 * 1_024;
export const MAX_RESULT_BYTES = MAX_WORKING_STATE_BYTES;
// Keep v1's parsed-state value-node envelope. Large native authoring chiefly
// grows strings (5,969 stored nodes at its maximum), not millions of objects.
// Trusted catalog and materialized catalog bases have separate budgets.
export const MAX_STATE_NODES = 150_000;
export const MAX_CATALOG_NODES = 2_000_000;
export const MAX_HYDRATED_NODES = 500_000;
export const MAX_COMMAND_NODES = 150_000;
export const MAX_HTTP_BODY_BYTES = 2 * MAX_WORKING_STATE_BYTES + 8_192;

// Conservative maximum for JSON.stringify of a finite closed schema. Six
// bytes per UTF-16 code unit covers control characters and lone surrogates;
// identifiers with narrower patterns simply have a smaller attainable bound.
// This is envelope arithmetic, not a replacement for canonical validation.
export function jsonSchemaByteBound(schema) {
  if (Object.hasOwn(schema, "const")) return byteLength(JSON.stringify(schema.const));
  if (schema.enum) return Math.max(...schema.enum.map((value) => byteLength(JSON.stringify(value))));
  if (schema.oneOf) return Math.max(...schema.oneOf.map(jsonSchemaByteBound));
  if (schema.type === "string") return Number.isSafeInteger(schema.maxLength) ? 2 + 6 * schema.maxLength : Infinity;
  if (["integer", "number"].includes(schema.type)) return 24;
  if (schema.type === "boolean") return 5;
  if (schema.type === "null") return 4;
  if (schema.type === "array") {
    if (!Number.isSafeInteger(schema.maxItems)) return Infinity;
    return 2 + schema.maxItems * jsonSchemaByteBound(schema.items ?? {}) + Math.max(0, schema.maxItems - 1);
  }
  if (schema.type === "object" && schema.additionalProperties === false) {
    const entries = Object.entries(schema.properties ?? {});
    return 2 + entries.reduce((sum, [key, value]) => sum + byteLength(JSON.stringify(key)) + 1 + jsonSchemaByteBound(value), 0) + Math.max(0, entries.length - 1);
  }
  return Infinity;
}

export function capacityForSchemas(schemas) {
  const nativeAuthoringBytes = Math.max(
    jsonSchemaByteBound(schemas.ingest_deck.input),
    jsonSchemaByteBound(schemas.validate_deck.input),
  );
  requireThat(Number.isSafeInteger(nativeAuthoringBytes) && nativeAuthoringBytes < MAX_WORKING_STATE_BYTES,
    "CAPACITY_CONTRACT_UNSUPPORTED", "Requalify the storage profile before enabling this changed authoring schema", 503);
  return Object.freeze({
    profile: "meshful-local-capacity-v2",
    nativeAuthoringBytes,
    maxCommandBytes: nativeAuthoringBytes,
    maxCommandNodes: MAX_COMMAND_NODES,
    maxStateBytes: MAX_WORKING_STATE_BYTES,
    maxStateNodes: MAX_STATE_NODES,
    maxResultBytes: MAX_RESULT_BYTES,
    maxBodyBytes: MAX_HTTP_BODY_BYTES,
  });
}
