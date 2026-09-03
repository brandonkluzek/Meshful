import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitTopLevelSql, STATEMENT_BREAKPOINT } from "../d1-integration/pack-sites-migrations.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const here = fileURLToPath(new URL("./", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const targeted = /\bCREATE\s+TRIGGER\s+meshful_v2_head_complete_(?:insert|update)\b/i;

export function parenthesizeTriggerCases(statement) {
  if (!targeted.test(statement)) return Object.freeze({ sql: statement, replacements: 0 });
  let replacements = 0;
  const sql = statement.replace(/SELECT CASE\b([\s\S]*?)\sEND;/g, (_match, body) => {
    replacements += 1;
    return `SELECT (CASE${body} END);`;
  });
  return Object.freeze({ sql, replacements });
}

export function assertPackagePins(migrations, contract, journalBytes) {
  assert.equal(migrations.length, contract.migrations.length, "Packaged migration count changed");
  for (const [index, migration] of migrations.entries()) {
    const expected = contract.migrations[index];
    assert.equal(migration.site_path, expected.site_path, `Packaged path changed: ${expected.site_path}`);
    assert.equal(migration.actual_bytes, expected.packaged_bytes,
      `Packaged byte count differs: ${expected.site_path}`);
    assert.equal(migration.actual_sha256, expected.packaged_sha256,
      `Packaged digest differs: ${expected.site_path}`);
  }
  assert.equal(journalBytes.byteLength, contract.journal.bytes, "Packaged journal byte count differs");
  assert.equal(sha256(journalBytes), contract.journal.sha256, "Packaged journal digest differs");
}

export async function buildCaseFixedPackage() {
  const contract = JSON.parse(await readFile(join(here, "CONTRACT.json"), "utf8"));
  let replacementCount = 0;
  const migrations = [];
  for (const item of contract.migrations) {
    const sourceBytes = await readFile(join(root, item.source));
    assert.equal(sourceBytes.byteLength, item.source_bytes, `Source bytes changed: ${item.source}`);
    assert.equal(sha256(sourceBytes), item.source_sha256, `Source digest changed: ${item.source}`);
    const originalStatements = splitTopLevelSql(sourceBytes.toString("utf8"));
    assert.equal(originalStatements.length, item.statement_count, `Statement count changed: ${item.source}`);
    const statements = originalStatements.map((statement) => {
      const fixed = parenthesizeTriggerCases(statement);
      replacementCount += fixed.replacements;
      return fixed.sql;
    });
    const bytes = Buffer.from(`${statements.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`);
    migrations.push(Object.freeze({ ...item, statements: Object.freeze(statements), bytes,
      actual_bytes: bytes.byteLength, actual_sha256: sha256(bytes) }));
  }
  assert.equal(replacementCount, contract.workaround.case_expression_replacements,
    "Provider workaround replacement count changed");
  const triggerSql = migrations.flatMap((item) => item.statements)
    .filter((sql) => /\bCREATE\s+TRIGGER\b/i.test(sql));
  assert.equal(triggerSql.length, contract.database_schema.trigger_count);
  assert.equal(triggerSql.filter((sql) => /\r/.test(sql)).length, 0, "Trigger SQL must be LF-only");
  assert.equal(triggerSql.filter((sql) => /\bCREATE\s+TRIGGER\b[\s\S]*?\bBEGIN\b/.test(sql)).length,
    triggerSql.length, "Every trigger body must use uppercase BEGIN");
  assert.equal(triggerSql.filter((sql) => /\bSELECT\s+CASE\b/.test(sql)).length, 0,
    "No unparenthesized SELECT CASE may remain in trigger SQL");
  assert.equal((triggerSql.join("\n").match(/\bSELECT\s+\(CASE\b/g) ?? []).length,
    contract.workaround.case_expression_replacements);

  const predecessorJournal = await readFile(new URL("../d1-integration/drizzle/meta/_journal.json", import.meta.url));
  assertPackagePins(migrations, contract, predecessorJournal);
  return Object.freeze({ contract, migrations: Object.freeze(migrations), replacementCount,
    journalBytes: predecessorJournal, journalSha256: sha256(predecessorJournal) });
}
