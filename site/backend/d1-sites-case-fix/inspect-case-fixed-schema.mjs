import { REQUIRED_TABLES, REQUIRED_TRIGGERS } from "../d1-integration/inspect-applied-schema.mjs";

export const EXPECTED_CASE_FIXED_SCHEMA_SHA256 = "643dd073a167c4520494bbc9290f461a8607f2c6115efbe0303660c23db2aa2e";

function check(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: "D1_SCHEMA_ATTESTATION_FAILED" });
}

async function rows(statement) {
  const result = await statement.all();
  check(result?.success !== false && Array.isArray(result?.results), "D1 returned an invalid inspection result");
  return result.results.map((row) => ({ ...row }));
}

export function canonicalizeSchemaSql(value) {
  if (value === null) return null;
  const output = [];
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let pendingSpace = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (lineComment) {
      if (char === "\r" || char === "\n") { lineComment = false; pendingSpace = true; }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; pendingSpace = true; index += 1; }
      continue;
    }
    if (quote) {
      output.push(char);
      if (quote === "[" && char === "]") quote = null;
      else if (quote !== "[" && char === quote) {
        if (next === quote) { output.push(next); index += 1; }
        else quote = null;
      }
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; pendingSpace = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; pendingSpace = true; index += 1; continue; }
    if (/\s/.test(char)) { pendingSpace = true; continue; }
    if (pendingSpace && output.length > 0) output.push(" ");
    pendingSpace = false;
    output.push(char);
    if (char === "'" || char === '"' || char === "`" || char === "[") quote = char;
  }
  check(!quote && !blockComment, "Stored schema SQL has an unterminated quote or comment");
  return output.join("").trim().replace(/;$/, "");
}

function canonical(values) {
  return values.map((row) => ({ type: String(row.type), name: String(row.name),
    tbl_name: String(row.tbl_name), sql: canonicalizeSchemaSql(row.sql === null ? null : String(row.sql)) }));
}

async function sha256(value) {
  const output = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(output)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function inspectCaseFixedD1(database) {
  check(database && typeof database.prepare === "function", "The DB binding is unavailable");
  const schemaRows = canonical(await rows(database.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'meshful_*' ORDER BY type,name")));
  const outside = canonical(await rows(database.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'meshful_*' "
      + "AND sql IS NOT NULL AND instr(lower(sql),'meshful_') > 0 ORDER BY type,name")));
  check(outside.length === 0, "Unexpected schema objects reference Meshful tables");
  const tables = schemaRows.filter((row) => row.type === "table").map((row) => row.name).sort();
  const triggers = schemaRows.filter((row) => row.type === "trigger").map((row) => row.name).sort();
  check(JSON.stringify(tables) === JSON.stringify([...REQUIRED_TABLES].sort()), "Required Meshful tables differ");
  check(JSON.stringify(triggers) === JSON.stringify([...REQUIRED_TRIGGERS].sort()), "Required Meshful triggers differ");
  const receipt = schemaRows.find((row) => row.type === "table" && row.name === "meshful_v2_receipts");
  check(typeof receipt?.sql === "string" && /FOREIGN KEY\s*\(principal_id,\s*response_document_id\)[\s\S]*?REFERENCES\s+meshful_v2_documents\s*\(principal_id,\s*document_id\)[\s\S]*?DEFERRABLE\s+INITIALLY\s+DEFERRED/i.test(receipt.sql),
    "The deferred response-document foreign key is missing");
  check((await rows(database.prepare("PRAGMA foreign_key_check"))).length === 0,
    "D1 foreign-key integrity check failed");
  const quick = await rows(database.prepare("PRAGMA quick_check"));
  check(quick.length === 1 && quick[0].quick_check === "ok", "D1 quick integrity check failed");
  const schemaSha256 = await sha256(JSON.stringify(schemaRows));
  check(schemaSha256 === EXPECTED_CASE_FIXED_SCHEMA_SHA256,
    "Meshful provider-compatible schema definitions differ");
  return Object.freeze({ schema: "meshful-applied-d1-case-fixed-schema-receipt.v1", binding: "DB",
    table_count: tables.length, trigger_count: triggers.length,
    deferred_response_document_fk: true, foreign_key_check: "ok", quick_check: "ok",
    schema_sha256: schemaSha256,
    schema_hash_domain: "canonical sqlite_schema rows with comments removed and external whitespace collapsed",
    unexpected_schema_reference_count: 0, learner_rows_returned: 0 });
}
