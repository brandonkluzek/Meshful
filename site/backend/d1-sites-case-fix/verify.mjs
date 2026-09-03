import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteD1 } from "../test-support/sqlite-d1.mjs";
import { parseBreakpointSql } from "../d1-integration/pack-sites-migrations.mjs";
import { buildCaseFixedPackage } from "./build-case-fixed-package.mjs";
import { inspectCaseFixedD1 } from "./inspect-case-fixed-schema.mjs";

const here = fileURLToPath(new URL("./", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function walk(relative = "") {
  const files = [];
  for (const entry of await readdir(join(here, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    const status = await lstat(join(here, path));
    assert.ok(!status.isSymbolicLink(), `Delivery contains a symlink: ${path}`);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
    else assert.fail(`Delivery contains a non-regular entry: ${path}`);
  }
  return files;
}

async function verifyManifest() {
  const bytes = await readFile(join(here, "FILE_MANIFEST.json"));
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.schema, "meshful-sites-d1-case-fix-delivery.v1");
  assert.equal(manifest.delivery_root, "backend/d1-sites-case-fix");
  assert.equal(manifest.files.length, manifest.file_count);
  const actual = (await walk()).map((path) => `backend/d1-sites-case-fix/${path}`).sort(compare);
  assert.deepEqual(actual, manifest.files.map((file) => file.path).sort(compare));
  const payload = [];
  for (const file of manifest.files) {
    assert.equal(file.destination, file.path);
    if (file.path.endsWith("/FILE_MANIFEST.json")) {
      assert.equal(file.bytes, null); assert.equal(file.sha256, null); continue;
    }
    const relative = file.path.slice("backend/d1-sites-case-fix/".length);
    const value = await readFile(join(here, relative));
    assert.equal(value.byteLength, file.bytes, `Delivery bytes differ: ${file.path}`);
    assert.equal(sha256(value), file.sha256, `Delivery digest differs: ${file.path}`);
    payload.push(file);
  }
  payload.sort((a, b) => compare(a.path, b.path));
  assert.equal(sha256(payload.map((file) => `${file.sha256}  ${file.path}\n`).join("")), manifest.payload_sha256);
  const predecessor = await readFile(new URL("../d1-integration/FILE_MANIFEST.json", import.meta.url));
  assert.equal(sha256(predecessor), manifest.predecessor.manifest_sha256);
  return { manifest_sha256: sha256(bytes), payload_sha256: manifest.payload_sha256,
    file_count: manifest.file_count };
}

async function verifyHistoricalFailureReceipt(contract) {
  const bytes = await readFile(join(here, contract.predecessor.failure_receipt_path));
  assert.equal(sha256(bytes), contract.predecessor.failure_receipt_sha256,
    "Website failure receipt digest differs");
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.schema, "meshful-sites-d1-provisioning-receipt.v1");
  assert.equal(receipt.recorded_at, contract.predecessor.failure_receipt_recorded_at);
  assert.equal(receipt.status, "provider_failed_before_publication");
  assert.equal(receipt.site.project_id, contract.site_project_id);
  assert.equal(receipt.site.access, "owner-only");
  assert.equal(receipt.site.public_access_changed, false);
  assert.equal(receipt.site.live_version_changed, false);
  assert.equal(`v${receipt.source.saved_version_number}`, contract.predecessor.failed_saved_version);
  assert.equal(receipt.deployment.deployment_id, contract.predecessor.failed_deployment_id);
  assert.equal(receipt.deployment.status, "failed");
  assert.equal(receipt.deployment.failure_message, contract.predecessor.provider_error);
  assert.equal(receipt.deployment.published_url, null);
  assert.deepEqual(receipt.post_failure_database_overview.bindings, []);
  assert.deepEqual(receipt.post_failure_database_overview.tables, []);
  assert.equal(receipt.post_failure_database_overview.partial_schema_visible, false);
  assert.equal(receipt.backend_delivery.manifest_sha256, contract.predecessor.manifest_sha256);
  assert.equal(receipt.backend_delivery.payload_sha256, contract.predecessor.payload_sha256);
  assert.equal(receipt.backend_delivery.migration_0000_sha256, contract.migrations[0].packaged_sha256);
  assert.equal(receipt.backend_delivery.journal_sha256, contract.journal.sha256);
  return Object.freeze({ sha256: sha256(bytes), recorded_at: receipt.recorded_at,
    observed_bindings: 0, observed_tables: 0, authority: "Website historical receipt",
    current_provider_state_verified: false });
}

async function verifyLocalWranglerReceipt(contract, built) {
  const bytes = await readFile(join(here, contract.local_wrangler_control.receipt_path));
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.schema, "meshful-sites-d1-case-fix-local-wrangler-receipt.v1");
  assert.equal(receipt.mode, "local");
  assert.equal(receipt.wrangler_version, contract.local_wrangler_control.wrangler_version);
  assert.equal(receipt.remote_flag_used, false);
  assert.equal(receipt.remote_database_mutations, 0);
  assert.equal(receipt.provider_resources_created, 0);
  assert.equal(receipt.canonical_sqlite_schema_sha256,
    contract.database_schema.canonical_sqlite_schema_sha256);
  assert.deepEqual(receipt.migrations.map((item) => item.sha256),
    built.migrations.map((item) => item.actual_sha256));
  assert.deepEqual(receipt.migrations.map((item) => item.wrangler_commands_executed),
    contract.local_wrangler_control.migration_command_counts);
  assert.ok(receipt.migrations.every((item) => item.status === "passed"));
  assert.equal(receipt.journal_sha256, built.journalSha256);
  assert.equal(receipt.table_count, contract.database_schema.table_count);
  assert.equal(receipt.trigger_count, contract.database_schema.trigger_count);
  return Object.freeze({ sha256: sha256(bytes), wrangler_version: receipt.wrangler_version,
    mode: receipt.mode, command_counts: receipt.migrations.map((item) => item.wrangler_commands_executed),
    remote_database_mutations: 0, hosted_acceptance: false });
}

export async function verifyCaseFixedDelivery() {
  const delivery = await verifyManifest();
  const built = await buildCaseFixedPackage();
  const historicalFailure = await verifyHistoricalFailureReceipt(built.contract);
  const localWrangler = await verifyLocalWranglerReceipt(built.contract, built);
  for (const item of built.migrations) {
    assert.equal(item.actual_bytes, item.packaged_bytes, `Packaged byte count differs: ${item.site_path}`);
    assert.equal(item.actual_sha256, item.packaged_sha256, `Packaged digest differs: ${item.site_path}`);
    const committed = await readFile(join(here, item.site_path));
    assert.equal(committed.byteLength, item.packaged_bytes);
    assert.equal(sha256(committed), item.packaged_sha256);
    assert.deepEqual(parseBreakpointSql(committed.toString("utf8")), [...item.statements]);
  }
  const journal = await readFile(join(here, built.contract.journal.path));
  assert.equal(journal.byteLength, built.contract.journal.bytes);
  assert.equal(sha256(journal), built.contract.journal.sha256);

  const database = new SqliteD1();
  try {
    for (const item of built.migrations) {
      for (const sql of item.statements) await database.prepare(sql).run();
    }
    const schema = await inspectCaseFixedD1(database);
    assert.equal(schema.schema_sha256, built.contract.database_schema.canonical_sqlite_schema_sha256);
    return Object.freeze({ schema: "meshful-sites-d1-case-fix-local-receipt.v1",
      predecessor_manifest_sha256: built.contract.predecessor.manifest_sha256,
      provider_failure_receipt_sha256: built.contract.predecessor.failure_receipt_sha256,
      replacement_count: built.replacementCount,
      migrations: built.migrations.map((item) => ({ path: item.site_path,
        statements: item.statements.length, bytes: item.actual_bytes, sha256: item.actual_sha256 })),
      journal_sha256: built.journalSha256, table_count: schema.table_count,
      trigger_count: schema.trigger_count, schema_sha256: schema.schema_sha256,
      historical_failure: historicalFailure, local_wrangler_control: localWrangler,
      delivery,
      network_calls: 0, hosted_mutations: 0,
      boundary: "Provider-free SQLite proof only; the next owner-only Sites deployment must prove the remote workaround." });
  } finally { database.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${JSON.stringify(await verifyCaseFixedDelivery(), null, 2)}\n`);
}
