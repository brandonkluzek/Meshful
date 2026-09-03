import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteD1 } from "../../test-support/sqlite-d1.mjs";
import { splitTopLevelSql } from "../../d1-integration/pack-sites-migrations.mjs";
import { createD1Repository } from "../../v2/src/d1-repository.mjs";
import { encodeDocument } from "../../v2/src/fragment-codec.mjs";
import { sha256 } from "../../src/contracts.mjs";
import { assertPackagePins, buildCaseFixedPackage, parenthesizeTriggerCases } from "../build-case-fixed-package.mjs";
import { canonicalizeSchemaSql, inspectCaseFixedD1 } from "../inspect-case-fixed-schema.mjs";
import { writeCaseFixedPackage } from "../pack-case-fixed.mjs";
import { verifyCaseFixedDelivery } from "../verify.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("provider workaround changes exactly three CASE expressions and no authored source", async () => {
  const built = await buildCaseFixedPackage();
  assert.equal(built.replacementCount, 3);
  const original = await readFile(join(root, "backend/v2/migrations/0002_fragmented_storage.sql"), "utf8");
  const originalStatements = splitTopLevelSql(original);
  const changed = [];
  for (const [index, statement] of originalStatements.entries()) {
    const fixed = parenthesizeTriggerCases(statement);
    if (fixed.sql !== statement) changed.push({ index, before: statement, after: fixed.sql,
      replacements: fixed.replacements });
  }
  assert.deepEqual(changed.map((item) => item.replacements), [1, 2]);
  assert.ok(changed.every((item) => /meshful_v2_head_complete_(?:insert|update)/.test(item.before)));
  assert.ok(changed.every((item) => !/\bSELECT CASE\b/.test(item.after)));
  assert.equal((changed.map((item) => item.after).join("\n").match(/\bSELECT \(CASE\b/g) ?? []).length, 3);
  assert.equal((original.match(/\bSELECT CASE\b/g) ?? []).length, 3,
    "The pinned authored source remains unchanged and still reproduces the remote-parser shape");
});

test("case-fixed package applies as 42 complete statements and attests the exact final schema", async () => {
  const built = await buildCaseFixedPackage();
  assert.deepEqual(built.migrations.map((item) => item.statements.length), [10, 32]);
  const database = new SqliteD1();
  try {
    for (const item of built.migrations) {
      for (const sql of item.statements) await database.prepare(sql).run();
    }
    const receipt = await inspectCaseFixedD1(database);
    assert.equal(receipt.table_count, 13);
    assert.equal(receipt.trigger_count, 23);
    assert.equal(receipt.schema_sha256, built.contract.database_schema.canonical_sqlite_schema_sha256);
    await database.prepare("INSERT INTO meshful_principals (principal_id,created_at) VALUES ('p','now')").run();
    await database.prepare("INSERT INTO meshful_v2_objects "
      + "(principal_id,digest,byte_length,body,created_at) VALUES "
      + "('p','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',2,'{}','now')").run();
    await assert.rejects(database.prepare(
      "UPDATE meshful_v2_objects SET body = body WHERE principal_id = 'p'",
    ).run(), /MESHFUL_IMMUTABLE_OBJECT/);
  } finally { database.close(); }
});

test("schema canonicalization ignores provider comment and whitespace storage rewrites only", () => {
  const source = "CREATE TABLE x (a TEXT, note TEXT DEFAULT '--literal') -- retained by Node SQLite\n;";
  const provider = "  CREATE   TABLE x (a TEXT, note TEXT DEFAULT '--literal') ; ";
  assert.equal(canonicalizeSchemaSql(source), canonicalizeSchemaSql(provider));
  assert.notEqual(canonicalizeSchemaSql("CREATE TABLE x (a TEXT)"),
    canonicalizeSchemaSql("CREATE TABLE x (a INTEGER)"));
  assert.throws(() => canonicalizeSchemaSql("CREATE TABLE x ('unterminated)"),
    /unterminated quote or comment/);
});

test("schema attestation accepts the exact Wrangler sqlite_schema comment rewrite", async () => {
  const built = await buildCaseFixedPackage();
  const database = new SqliteD1();
  try {
    for (const item of built.migrations) {
      for (const sql of item.statements) await database.prepare(sql).run();
    }
    const wranglerShaped = {
      prepare(sql) {
        const statement = database.prepare(sql);
        if (!sql.startsWith("SELECT type,name,tbl_name,sql FROM sqlite_schema")) return statement;
        return {
          async all() {
            const result = await statement.all();
            return { ...result, results: result.results.map((row) => row.name === "meshful_v2_receipts"
              ? { ...row, sql: row.sql.replace(/\s*-- Admission precedes fragments\.[^\n]*\n\s*/, " ") }
              : row) };
          },
        };
      },
    };
    assert.equal((await inspectCaseFixedD1(wranglerShaped)).schema_sha256,
      built.contract.database_schema.canonical_sqlite_schema_sha256);
  } finally { database.close(); }
});

test("builder refuses a generated package that differs from its contract pin", async () => {
  const built = await buildCaseFixedPackage();
  const contract = structuredClone(built.contract);
  contract.migrations[1].packaged_sha256 = "0".repeat(64);
  assert.throws(() => assertPackagePins(built.migrations, contract, built.journalBytes),
    /Packaged digest differs/);
});

test("schema attestation rejects the original unparenthesized trigger definitions", async () => {
  const originalContract = JSON.parse(await readFile(join(root,
    "backend/d1-integration/SITES_D1_CONTRACT.json"), "utf8"));
  const database = new SqliteD1();
  try {
    for (const item of originalContract.migrations) {
      const sql = await readFile(join(root, "backend/d1-integration", item.site_path), "utf8");
      for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
        await database.prepare(statement).run();
      }
    }
    await assert.rejects(inspectCaseFixedD1(database), /provider-compatible schema definitions differ/);
  } finally { database.close(); }
});

test("fixed complex triggers preserve valid commits, invalid transitions and atomic rollback", async () => {
  const built = await buildCaseFixedPackage();
  const database = new SqliteD1();
  try {
    for (const item of built.migrations) {
      for (const sql of item.statements) await database.prepare(sql).run();
    }
    const repository = createD1Repository(database);
    const { principalId } = await repository.provisionPrincipalForVerifiedIdentity({
      provider: "sites-chatgpt", issuer: "urn:meshful:sites:case-fix-test", subject: "learner-a",
    });
    const state = await encodeDocument({ id: "state:1", kind: "state", text: '{"revision":1}' });
    const response = await encodeDocument({ id: "receipt:request-1", kind: "receipt",
      text: '{"receipt":{"replayed":false}}' });
    assert.deepEqual(await repository.commit({
      principalId, expectedRevision: 0, requestId: "request-1", fingerprint: await sha256("request-1"),
      catalogRef: { version: "case-fix-test", digest: `sha256:${"b".repeat(64)}` },
      documents: [state, response], stateDocumentId: state.id, responseDocumentId: response.id,
      events: [], now: "2026-09-01T00:00:00.000Z",
    }), { committed: true, revision: 1 });
    await assert.rejects(database.prepare(
      "UPDATE meshful_v2_heads SET revision = revision + 2 WHERE principal_id = ?",
    ).bind(principalId).run(), /MESHFUL_INVALID_HEAD_TRANSITION/);
    assert.equal((await repository.getState(principalId)).revision, 1);

    const before = database.database.prepare(
      "SELECT count(*) AS n FROM meshful_principals WHERE principal_id = 'rollback-principal'",
    ).get().n;
    await assert.rejects(database.batch([
      database.prepare("INSERT INTO meshful_principals (principal_id,created_at) VALUES ('rollback-principal','now')"),
      database.prepare("INSERT INTO meshful_v2_receipts "
        + "(principal_id,request_id,revision,fingerprint,response_document_id,attempt_token,created_at) "
        + "VALUES ('rollback-principal','r',1,'f','receipt:r','a','now')"),
      database.prepare("INSERT INTO meshful_v2_documents "
        + "(principal_id,document_id,kind,revision,byte_length,digest,part_count,created_at) "
        + `VALUES ('rollback-principal','receipt:r','receipt',1,0,'sha256:${"c".repeat(64)}',0,'now')`),
      database.prepare("INSERT INTO meshful_v2_heads "
        + "(principal_id,revision,state_document_id,catalog_version,catalog_digest,updated_at) "
        + "VALUES ('rollback-principal',1,'state:1','v','d','now')"),
    ]), /MESHFUL_INCOMPLETE_DOCUMENT/);
    assert.equal(before, 0);
    assert.equal(database.database.prepare(
      "SELECT count(*) AS n FROM meshful_principals WHERE principal_id = 'rollback-principal'",
    ).get().n, 0, "The failed complex trigger must roll back its entire D1 batch");
  } finally { database.close(); }
});

test("packager is idempotent and refuses a differing target before any partial write", async (t) => {
  const target = await mkdtemp(join(tmpdir(), "meshful-case-fix-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  await writeCaseFixedPackage(target);
  await writeCaseFixedPackage(target);
  const later = join(target, "drizzle/0001_meshful_fragmented_storage.sql");
  await writeFile(later, "different\n");
  await assert.rejects(writeCaseFixedPackage(target), /Refusing to replace a different artifact/);

  const preflight = await mkdtemp(join(tmpdir(), "meshful-case-fix-preflight-"));
  t.after(() => rm(preflight, { recursive: true, force: true }));
  await writeFile(join(preflight, "keep.txt"), "keep\n");
  await mkdir(join(preflight, "drizzle"));
  await writeFile(join(preflight, "drizzle/0001_meshful_fragmented_storage.sql"), "different\n");
  await assert.rejects(writeCaseFixedPackage(preflight), /Refusing to replace a different artifact/);
  await assert.rejects(access(join(preflight, "drizzle/0000_meshful_learner_data.sql")), { code: "ENOENT" });
});

test("packager rejects extra migration files and symlinks before writing", async (t) => {
  const extra = await mkdtemp(join(tmpdir(), "meshful-case-fix-extra-"));
  t.after(() => rm(extra, { recursive: true, force: true }));
  await mkdir(join(extra, "drizzle"));
  await writeFile(join(extra, "drizzle/9999_unexpected.sql"), "SELECT 1;\n");
  await assert.rejects(writeCaseFixedPackage(extra), /Unexpected file in migration tree/);
  await assert.rejects(access(join(extra, "drizzle/0000_meshful_learner_data.sql")), { code: "ENOENT" });

  const linked = await mkdtemp(join(tmpdir(), "meshful-case-fix-link-"));
  t.after(() => rm(linked, { recursive: true, force: true }));
  await mkdir(join(linked, "drizzle"));
  await symlink(join(linked, "outside"), join(linked, "drizzle/meta"));
  await assert.rejects(writeCaseFixedPackage(linked), /Unexpected symlink in migration tree/);
  await assert.rejects(access(join(linked, "drizzle/0000_meshful_learner_data.sql")), { code: "ENOENT" });
});

test("delivery verifier binds provider failure, package bytes and local schema receipt", async () => {
  const receipt = await verifyCaseFixedDelivery();
  assert.equal(receipt.replacement_count, 3);
  assert.equal(receipt.network_calls, 0);
  assert.equal(receipt.hosted_mutations, 0);
  assert.equal(receipt.trigger_count, 23);
  assert.equal(receipt.historical_failure.sha256,
    "df81189b80e6fb0a80cc02aa19f9cee0f04a1fdd881b61db86a78df7d298d2aa");
  assert.equal(receipt.historical_failure.current_provider_state_verified, false);
  assert.deepEqual(receipt.local_wrangler_control.command_counts, [11, 33]);
  assert.equal(receipt.local_wrangler_control.hosted_acceptance, false);
});
