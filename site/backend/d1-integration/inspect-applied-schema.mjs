// Worker-safe, read-only schema attestation. It returns no learner data rows,
// but its integrity pragmas can scan stored records/pages and incur D1 reads.
// It owns no route; Website calls it with env.DB during owner acceptance.

export const REQUIRED_TABLES = Object.freeze([
  "meshful_identity_bindings", "meshful_import_archives", "meshful_learner_state",
  "meshful_principals", "meshful_request_receipts", "meshful_review_events",
  "meshful_v2_documents", "meshful_v2_heads", "meshful_v2_import_archives",
  "meshful_v2_objects", "meshful_v2_parts", "meshful_v2_receipts",
  "meshful_v2_review_events",
]);

export const REQUIRED_TRIGGERS = Object.freeze([
  "meshful_v1_import_preserve_v2", "meshful_v1_receipt_preserve_v2",
  "meshful_v1_review_preserve_v2", "meshful_v1_state_after_takeover_delete",
  "meshful_v1_state_after_takeover_update", "meshful_v2_documents_no_delete",
  "meshful_v2_documents_no_update", "meshful_v2_head_complete_insert",
  "meshful_v2_head_complete_update", "meshful_v2_head_no_delete",
  "meshful_v2_import_preserve_v1", "meshful_v2_imports_no_delete",
  "meshful_v2_imports_no_update", "meshful_v2_objects_no_delete",
  "meshful_v2_objects_no_update", "meshful_v2_parts_no_delete",
  "meshful_v2_parts_no_update", "meshful_v2_receipt_preserve_v1",
  "meshful_v2_receipts_no_delete", "meshful_v2_receipts_no_update",
  "meshful_v2_review_preserve_v1", "meshful_v2_reviews_no_delete",
  "meshful_v2_reviews_no_update",
]);

// SHA-256 of the ordered sqlite_schema rows created by the two exact packaged
// migrations. This binds trigger bodies and table/index definitions, not names.
export const EXPECTED_SCHEMA_SHA256 = "7a3c780a36d7a8a3865942d5f7a457ad52852dae7505641c6af9185610b54c9f";

function check(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: "D1_SCHEMA_ATTESTATION_FAILED" });
}

async function rows(statement) {
  const result = await statement.all();
  check(result?.success !== false && Array.isArray(result?.results), "D1 returned an invalid inspection result");
  return result.results.map((row) => ({ ...row }));
}

function canonicalSchemaRows(values) {
  return values.map((row) => ({
    type: String(row.type),
    name: String(row.name),
    tbl_name: String(row.tbl_name),
    sql: row.sql === null ? null : String(row.sql),
  }));
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function inspectAppliedD1(database) {
  check(database && typeof database.prepare === "function", "The DB binding is unavailable");
  const schemaRows = canonicalSchemaRows(await rows(database.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'meshful_*' ORDER BY type,name",
  )));
  const outsideSchemaReferences = canonicalSchemaRows(await rows(database.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema "
      + "WHERE name NOT GLOB 'meshful_*' AND sql IS NOT NULL "
      + "AND instr(lower(sql),'meshful_') > 0 ORDER BY type,name",
  )));
  check(outsideSchemaReferences.length === 0,
    "Unexpected schema objects reference Meshful tables");
  const tables = schemaRows.filter((row) => row.type === "table").map((row) => row.name).sort();
  const triggers = schemaRows.filter((row) => row.type === "trigger").map((row) => row.name).sort();
  check(JSON.stringify(tables) === JSON.stringify([...REQUIRED_TABLES].sort()), "Required Meshful tables differ");
  check(JSON.stringify(triggers) === JSON.stringify([...REQUIRED_TRIGGERS].sort()), "Required Meshful triggers differ");

  const receipt = schemaRows.find((row) => row.type === "table" && row.name === "meshful_v2_receipts");
  check(typeof receipt?.sql === "string" && /FOREIGN KEY\s*\(principal_id,\s*response_document_id\)[\s\S]*?REFERENCES\s+meshful_v2_documents\s*\(principal_id,\s*document_id\)[\s\S]*?DEFERRABLE\s+INITIALLY\s+DEFERRED/i.test(receipt.sql),
    "The deferred response-document foreign key is missing");

  const foreignKeyFailures = await rows(database.prepare("PRAGMA foreign_key_check"));
  check(foreignKeyFailures.length === 0, "D1 foreign-key integrity check failed");
  const quick = await rows(database.prepare("PRAGMA quick_check"));
  check(quick.length === 1 && quick[0].quick_check === "ok", "D1 quick integrity check failed");
  const schemaSha256 = await sha256(JSON.stringify(schemaRows));
  check(schemaSha256 === EXPECTED_SCHEMA_SHA256, "Meshful schema or safety-trigger definitions differ");

  return Object.freeze({
    schema: "meshful-applied-d1-schema-receipt.v1",
    binding: "DB",
    table_count: tables.length,
    trigger_count: triggers.length,
    deferred_response_document_fk: true,
    foreign_key_check: "ok",
    quick_check: "ok",
    schema_sha256: schemaSha256,
    unexpected_schema_reference_count: 0,
    learner_rows_returned: 0,
  });
}
