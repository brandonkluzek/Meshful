// Provider-free source/package verification. This never opens a hosted
// database, reads credentials, changes a Site, or applies a remote migration.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteD1 } from "../test-support/sqlite-d1.mjs";
import { inspectAppliedD1, EXPECTED_SCHEMA_SHA256, REQUIRED_TABLES, REQUIRED_TRIGGERS } from "./inspect-applied-schema.mjs";
import { buildSitesMigrationPackage, parseBreakpointSql } from "./pack-sites-migrations.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const integrationRoot = fileURLToPath(new URL("./", import.meta.url));
const manifestPath = "backend/d1-integration/FILE_MANIFEST.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

async function readRegularContainedFile(root, relative, label) {
  let current = root;
  for (const part of relative.split("/")) {
    assert.ok(part && part !== "." && part !== "..", `Unsafe ${label} path`);
    current = join(current, part);
    let status;
    try { status = await lstat(current); }
    catch (error) {
      if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${relative}`);
      throw error;
    }
    assert.ok(!status.isSymbolicLink(), `${label} must not use symlinks: ${relative}`);
  }
  const status = await lstat(current);
  assert.ok(status.isFile(), `${label} must be a regular file: ${relative}`);
  return readFile(current);
}

export async function walkRegularDeliveryTree(root, relative = "") {
  const found = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), `Unapproved symlink: ${relative}/${entry.name}`);
    if (entry.isDirectory()) found.push(...await walkRegularDeliveryTree(root, `${relative}/${entry.name}`));
    else if (entry.isFile()) found.push(`${relative}/${entry.name}`);
    else assert.fail(`Unapproved non-regular filesystem entry: ${relative}/${entry.name}`);
  }
  return found;
}

async function verifyDeliveryManifest() {
  const manifestBytes = await readFile(join(repositoryRoot, manifestPath));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schema, "meshful-d1-integration-delivery.v1");
  assert.equal(manifest.delivery_root, "backend/d1-integration");
  assert.equal(manifest.files.length, manifest.file_count);

  for (const predecessor of manifest.predecessors) {
    const bytes = await readFile(join(repositoryRoot, predecessor.manifest));
    assert.equal(digest(bytes), predecessor.manifest_sha256,
      `Predecessor manifest changed: ${predecessor.manifest}`);
  }

  const payload = [];
  const declared = new Set();
  for (const file of manifest.files) {
    assert.ok(file.path.startsWith("backend/d1-integration/")
      && file.path.split("/").every((part) => part && part !== "." && part !== ".."));
    assert.equal(file.destination, file.path);
    assert.ok(!declared.has(file.path), `Duplicate manifest path: ${file.path}`);
    declared.add(file.path);
    if (file.path === manifestPath) {
      assert.equal(file.bytes, null);
      assert.equal(file.sha256, null);
      continue;
    }
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    const bytes = await readFile(join(repositoryRoot, file.path));
    assert.equal(bytes.byteLength, file.bytes, `Byte count changed: ${file.path}`);
    assert.equal(digest(bytes), file.sha256, `Digest changed: ${file.path}`);
    payload.push(file);
  }
  assert.equal(payload.length, manifest.payload_file_count);
  assert.ok(declared.has(manifestPath), "Manifest must list itself with null digest/bytes");
  assert.deepEqual((await walkRegularDeliveryTree(repositoryRoot, "backend/d1-integration")).sort(compare),
    [...declared].sort(compare),
    "Manifest must list all and only D1 integration delivery files");
  payload.sort((a, b) => compare(a.path, b.path));
  assert.equal(digest(payload.map((file) => `${file.sha256}  ${file.path}\n`).join("")),
    manifest.payload_sha256, "Delivery payload fingerprint changed");
  return {
    manifest_sha256: digest(manifestBytes),
    payload_sha256: manifest.payload_sha256,
    file_count: manifest.file_count,
  };
}

export async function verifySources() {
  const delivery = await verifyDeliveryManifest();
  const contractBytes = await readFile(join(integrationRoot, "SITES_D1_CONTRACT.json"));
  const contract = JSON.parse(contractBytes);
  const evidenceContractBytes = await readFile(join(integrationRoot, "HOSTED_EVIDENCE_CONTRACT.json"));
  assert.equal(contract.contract_schema, "meshful-sites-d1-integration.v1");
  assert.equal(contract.site.project_id, "appgprj_6a9334b99f20819195ece80ebe97016b");
  assert.equal(contract.site.logical_d1_binding, "DB");
  assert.equal(contract.database_schema.sqlite_schema_sha256, EXPECTED_SCHEMA_SHA256);
  assert.deepEqual(contract.database_schema.table_names, [...REQUIRED_TABLES].sort(compare));
  assert.deepEqual(contract.database_schema.trigger_names, [...REQUIRED_TRIGGERS].sort(compare));
  assert.deepEqual(contract.migrations.map((item) => item.order), [1, 2]);
  assert.deepEqual(contract.migrations.map((item) => item.tag), [
    "0000_meshful_learner_data", "0001_meshful_fragmented_storage",
  ]);
  validateJournal(contract.migration_journal, contract);
  const matrix = await json(join(integrationRoot, "HOSTED_ACCEPTANCE.json"));
  assert.equal(matrix.required_release_pins.d1_contract_sha256.equals, digest(contractBytes),
    "Hosted acceptance contract pin differs from the D1 contract");
  assert.equal(matrix.required_release_pins.hosted_evidence_contract_sha256.equals,
    digest(evidenceContractBytes),
    "Hosted acceptance contract pin differs from the evidence contract");

  const migrationBytes = [];
  for (const item of contract.migrations) {
    const bytes = await readFile(join(repositoryRoot, item.source));
    assert.equal(bytes.byteLength, item.source_bytes, `Migration byte count changed: ${item.source}`);
    assert.equal(digest(bytes), item.source_sha256, `Migration checksum changed: ${item.source}`);
    migrationBytes.push(bytes);
  }
  const authoredSql = migrationBytes.map((bytes) => bytes.toString("utf8")).join("\n");
  const tableNames = [...authoredSql.matchAll(/^CREATE TABLE (\w+)/gm)].map((match) => match[1]).sort(compare);
  const triggerNames = [...authoredSql.matchAll(/^CREATE TRIGGER (\w+)/gm)].map((match) => match[1]).sort(compare);
  assert.deepEqual(tableNames, contract.database_schema.table_names);
  assert.deepEqual(triggerNames, contract.database_schema.trigger_names);
  assert.match(authoredSql, /FOREIGN KEY\s*\(principal_id,\s*response_document_id\)[\s\S]*?REFERENCES\s+meshful_v2_documents\s*\(principal_id,\s*document_id\)[\s\S]*?DEFERRABLE\s+INITIALLY\s+DEFERRED/i);

  const built = await buildSitesMigrationPackage();
  assert.equal(digest(built.journalBytes), contract.migration_journal_sha256);
  for (const item of built.files) {
    const frozenBytes = await readFile(join(integrationRoot, item.site_path));
    assert.equal(digest(frozenBytes), item.packaged_sha256, `Frozen packaged migration changed: ${item.site_path}`);
    assert.equal(digest(frozenBytes), digest(item.bytes), `Packager output differs: ${item.site_path}`);
    assert.equal(parseBreakpointSql(frozenBytes.toString("utf8")).length, item.statement_count);
  }
  assert.equal(digest(await readFile(join(integrationRoot, "drizzle/meta/_journal.json"))),
    contract.migration_journal_sha256, "Frozen migration journal changed");

  const database = new SqliteD1();
  try {
    for (const item of built.files) {
      for (const statement of item.statements) await database.prepare(statement).run();
    }
    const applied = await inspectAppliedD1(database);
    assert.equal(applied.schema_sha256, EXPECTED_SCHEMA_SHA256);
  } finally { database.close(); }
  return {
    schema: "meshful-d1-integration-source-receipt.v1",
    contract_sha256: digest(contractBytes),
    migrations: contract.migrations.map(({ order, tag, source, source_bytes, source_sha256,
      site_path, statement_count, breakpoint_count, packaged_bytes, packaged_sha256 }) => ({
      order, tag, source, source_bytes, source_sha256, site_path, statement_count,
      breakpoint_count, packaged_bytes, packaged_sha256,
    })),
    table_count: tableNames.length,
    trigger_count: triggerNames.length,
    deferred_response_document_fk: true,
    schema_sha256: EXPECTED_SCHEMA_SHA256,
    delivery,
    hosted_changes: 0,
  };
}

function validateJournal(journal, contract) {
  assert.equal(journal?.version, contract.migration_format.journal_version,
    "Unsupported Drizzle journal version");
  assert.equal(journal?.dialect, "sqlite", "Drizzle journal dialect must be sqlite");
  assert.ok(Array.isArray(journal?.entries), "Drizzle journal must contain entries");
  assert.equal(journal.entries.length, contract.migrations.length,
    "Use exactly the reviewed Meshful migration entries for this new Site database");
  let previousWhen = -1;
  return journal.entries.map((entry, index) => {
    assert.equal(entry?.idx, index, "Drizzle journal indexes must be sequential");
    assert.equal(entry?.version, contract.migration_format.entry_version,
      "Unsupported Drizzle journal entry version");
    assert.equal(entry?.breakpoints, true, "Drizzle statement breakpoints must be enabled");
    assert.ok(Number.isSafeInteger(entry?.when) && entry.when > previousWhen,
      "Drizzle journal timestamps must be increasing safe integers");
    previousWhen = entry.when;
    assert.equal(typeof entry?.tag, "string", "Every journal entry needs a tag");
    return entry.tag;
  });
}

export async function verifySitePackage(siteRootInput) {
  const siteRoot = await realpath(resolve(siteRootInput));
  const contract = await json(join(integrationRoot, "SITES_D1_CONTRACT.json"));
  const hosting = JSON.parse(await readRegularContainedFile(siteRoot, ".openai/hosting.json", "Source hosting metadata"));
  assert.deepEqual(hosting, contract.site.hosting_json_exact,
    "Hosting metadata must be exactly the approved project, DB binding and null R2");

  const journalBytes = await readRegularContainedFile(siteRoot, "drizzle/meta/_journal.json", "Source migration journal");
  const journal = JSON.parse(journalBytes);
  const tags = validateJournal(journal, contract);
  const expectedTags = contract.migrations.map((item) => item.tag);
  assert.deepEqual(tags, expectedTags, "Migration journal order differs");
  assert.equal(digest(journalBytes), contract.migration_journal_sha256, "Migration journal bytes differ");
  const packagedStatements = [];
  for (const item of contract.migrations) {
    const siteBytes = await readRegularContainedFile(siteRoot, item.site_path, "Source migration");
    assert.equal(siteBytes.byteLength, item.packaged_bytes, `Packaged migration byte count differs: ${item.site_path}`);
    assert.equal(digest(siteBytes), item.packaged_sha256, `Packaged migration changed: ${item.site_path}`);
    const statements = parseBreakpointSql(siteBytes.toString("utf8"));
    assert.equal(statements.length, item.statement_count, `Packaged statement count differs: ${item.site_path}`);
    assert.equal((siteBytes.toString("utf8").match(/--> statement-breakpoint/g) ?? []).length,
      item.breakpoint_count, `Packaged breakpoint count differs: ${item.site_path}`);
    packagedStatements.push(...statements);
  }

  const database = new SqliteD1();
  try {
    for (const statement of packagedStatements) await database.prepare(statement).run();
    await inspectAppliedD1(database);
  } finally { database.close(); }

  const packagedHosting = await readRegularContainedFile(siteRoot, "dist/.openai/hosting.json", "Built hosting metadata");
  assert.deepEqual(JSON.parse(packagedHosting), hosting, "Built hosting metadata differs from source");
  const serverEntry = await readRegularContainedFile(siteRoot, "dist/server/index.js", "Built server entry");
  assert.ok(serverEntry.byteLength > 0, "Built server entry must not be empty");
  assert.equal(digest(await readRegularContainedFile(siteRoot, "dist/.openai/drizzle/meta/_journal.json", "Built migration journal")), digest(journalBytes),
    "Built migration journal differs from source");
  for (const item of contract.migrations) {
    const sourceBytes = await readRegularContainedFile(siteRoot, item.site_path, "Source migration");
    const packagedPath = `dist/.openai/${item.site_path}`;
    assert.equal(digest(await readRegularContainedFile(siteRoot, packagedPath, "Built migration")),
      digest(sourceBytes), `Built migration differs: ${item.site_path}`);
  }

  return {
    schema: "meshful-d1-site-package-receipt.v1",
    project_id: hosting.project_id,
    logical_d1_binding: hosting.d1,
    migration_tags: tags,
    migration_statements: packagedStatements.length,
    schema_sha256: EXPECTED_SCHEMA_SHA256,
    source_and_dist_match: true,
    built_server_entry_present: true,
    hosted_changes: 0,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let result;
  if (args.length === 0) result = await verifySources();
  else if (args.length === 2 && args[0] === "--site-root") result = {
    source: await verifySources(), site_package: await verifySitePackage(args[1]),
  };
  else throw new Error("usage: node backend/d1-integration/verify.mjs [--site-root /absolute/site/root]");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
