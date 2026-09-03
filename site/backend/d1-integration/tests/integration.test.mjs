import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1 } from "../../test-support/sqlite-d1.mjs";
import { inspectAppliedD1 } from "../inspect-applied-schema.mjs";
import { parseBreakpointSql, splitTopLevelSql, writeSitesMigrationPackage } from "../pack-sites-migrations.mjs";
import { loadHostedAdapterBundle, runHostedAcceptance, runIsolatedAdapterChild,
  verifyHostedAcceptanceDelivery, verifyHostedAcceptanceDeliveryAt } from "../run-hosted-acceptance.mjs";
import { verifySitePackage, verifySources, walkRegularDeliveryTree } from "../verify.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const integration = fileURLToPath(new URL("../", import.meta.url));
const contract = JSON.parse(await readFile(join(integration, "SITES_D1_CONTRACT.json"), "utf8"));
const matrix = JSON.parse(await readFile(join(integration, "HOSTED_ACCEPTANCE.json"), "utf8"));

function createFifo(path) {
  const result = spawnSync("mkfifo", [path], { encoding: "utf8" });
  assert.equal(result.status, 0, `mkfifo failed: ${result.stderr || result.error?.message || "unknown"}`);
}

test("source contract and applied schema attest exact tables, triggers and deferred FK", async () => {
  const source = await verifySources();
  assert.equal(source.table_count, 13);
  assert.equal(source.trigger_count, 23);
  const database = new SqliteD1();
  try {
    for (const item of contract.migrations) {
      const packaged = await readFile(join(integration, item.site_path), "utf8");
      for (const statement of parseBreakpointSql(packaged)) await database.prepare(statement).run();
    }
    const receipt = await inspectAppliedD1(database);
    assert.equal(receipt.binding, "DB");
    assert.equal(receipt.schema_sha256, source.schema_sha256);
    assert.equal(receipt.learner_rows_returned, 0);
  } finally { database.close(); }
});

test("every Drizzle breakpoint chunk is exactly one complete SQLite statement", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  try {
    const counts = [];
    for (const item of contract.migrations) {
      const source = await readFile(join(root, item.source), "utf8");
      const packaged = await readFile(join(integration, item.site_path), "utf8");
      const statements = parseBreakpointSql(packaged);
      counts.push(statements.length);
      assert.equal([...source.matchAll(/;/g)].length, item.order === 1 ? 10 : 56,
        "Raw semicolon count changed; review the trigger-aware splitter");
      for (const sql of statements) {
        const prepared = database.prepare(sql);
        assert.equal(prepared.sourceSQL.trim(), sql.trim(), "SQLite did not consume the complete breakpoint chunk");
        prepared.run();
      }
    }
    assert.deepEqual(counts, [10, 32]);
    const names = database.prepare(
      "SELECT type,name FROM sqlite_schema WHERE name GLOB 'meshful_*' ORDER BY type,name",
    ).all();
    assert.equal(names.filter((row) => row.type === "table").length, 13);
    assert.deepEqual(names.filter((row) => row.type === "trigger").map((row) => row.name).sort(),
      [...contract.database_schema.trigger_names].sort());
  } finally { database.close(); }
});

test("migration splitter handles comments, quotes, nested CASE and CR-only lines", () => {
  const fixture = "-- lead\rCREATE TABLE sample(value TEXT CHECK(value <> '--not-comment'));\r"
    + "CREATE TRIGGER sample_guard BEFORE UPDATE ON sample BEGIN\r"
    + "SELECT CASE WHEN NEW.value = 'END; -- literal' THEN RAISE(ABORT, 'bad;') END;\rEND;\r"
    + "/* comment-only tail; */";
  const statements = splitTopLevelSql(fixture);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /CREATE TABLE sample/);
  assert.match(statements[1], /CREATE TRIGGER sample_guard/);
});

test("migration packager is idempotent and refuses to replace a differing artifact", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshful-d1-pack-idempotent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeSitesMigrationPackage(directory);
  await writeSitesMigrationPackage(directory);
  await writeFile(join(directory, contract.migrations[0].site_path), "different\n");
  await assert.rejects(writeSitesMigrationPackage(directory), /Refusing to replace a different migration artifact/);

  const laterConflict = await mkdtemp(join(tmpdir(), "meshful-d1-pack-later-conflict-"));
  t.after(() => rm(laterConflict, { recursive: true, force: true }));
  const laterPath = join(laterConflict, contract.migrations[1].site_path);
  await mkdir(join(laterConflict, "drizzle"), { recursive: true });
  await writeFile(laterPath, "preserve-this-byte-for-byte\n");
  const before = await readFile(laterPath);
  await assert.rejects(writeSitesMigrationPackage(laterConflict), /Refusing to replace a different migration artifact/);
  assert.deepEqual(await readFile(laterPath), before);
  await assert.rejects(access(join(laterConflict, contract.migrations[0].site_path)), { code: "ENOENT" });
  await assert.rejects(access(join(laterConflict, "drizzle/meta/_journal.json")), { code: "ENOENT" });
});

test("migration packager rejects a symlinked target tree without writing outside it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshful-d1-pack-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "meshful-d1-pack-outside-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(directory, "drizzle"), "dir");
  await assert.rejects(writeSitesMigrationPackage(directory), /must not use symlinks/);
  assert.deepEqual(await readdir(outside), []);
});

test("Site-package verifier requires exact DB binding, journal order and migration bytes in source and dist", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshful-d1-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, ".openai"), { recursive: true });
  await mkdir(join(directory, "drizzle/meta"), { recursive: true });
  await mkdir(join(directory, "dist/.openai"), { recursive: true });
  const hosting = { project_id: contract.site.project_id, d1: "DB", r2: null };
  await writeFile(join(directory, ".openai/hosting.json"), `${JSON.stringify(hosting, null, 2)}\n`);
  await writeSitesMigrationPackage(directory);
  await cp(join(directory, ".openai/hosting.json"), join(directory, "dist/.openai/hosting.json"));
  await cp(join(directory, "drizzle"), join(directory, "dist/.openai/drizzle"), { recursive: true });
  await assert.rejects(verifySitePackage(directory), /Built server entry/);
  await mkdir(join(directory, "dist/server"), { recursive: true });
  await writeFile(join(directory, "dist/server/index.js"), "export default {};\n");
  assert.equal((await verifySitePackage(directory)).source_and_dist_match, true);

  await rm(join(directory, "dist/.openai/hosting.json"));
  await symlink("../../.openai/hosting.json", join(directory, "dist/.openai/hosting.json"));
  await assert.rejects(verifySitePackage(directory), /must not use symlinks/);
  await rm(join(directory, "dist/.openai/hosting.json"));
  await cp(join(directory, ".openai/hosting.json"), join(directory, "dist/.openai/hosting.json"));

  await rm(join(directory, "dist/.openai/drizzle"), { recursive: true });
  await symlink("../../drizzle", join(directory, "dist/.openai/drizzle"), "dir");
  await assert.rejects(verifySitePackage(directory), /must not use symlinks/);
  await rm(join(directory, "dist/.openai/drizzle"));
  await cp(join(directory, "drizzle"), join(directory, "dist/.openai/drizzle"), { recursive: true });

  const sourceMigrationPath = join(directory, contract.migrations[0].site_path);
  const sourceMigrationBytes = await readFile(sourceMigrationPath);
  await rm(sourceMigrationPath);
  await symlink(`../dist/.openai/${contract.migrations[0].site_path}`, sourceMigrationPath);
  await assert.rejects(verifySitePackage(directory), /must not use symlinks/);
  await rm(sourceMigrationPath);
  await writeFile(sourceMigrationPath, sourceMigrationBytes);
  const wrong = { ...hosting, d1: null };
  await writeFile(join(directory, ".openai/hosting.json"), `${JSON.stringify(wrong)}\n`);
  await assert.rejects(verifySitePackage(directory), /Hosting metadata must be exactly/);

  await writeFile(join(directory, ".openai/hosting.json"), `${JSON.stringify({ ...hosting, r2: "R2" })}\n`);
  await assert.rejects(verifySitePackage(directory), /Hosting metadata must be exactly/);

  await writeFile(join(directory, ".openai/hosting.json"), `${JSON.stringify(hosting, null, 2)}\n`);
  const malformed = { ...contract.migration_journal, dialect: "postgresql" };
  await writeFile(join(directory, "drizzle/meta/_journal.json"), `${JSON.stringify(malformed, null, 2)}\n`);
  await assert.rejects(verifySitePackage(directory), /dialect must be sqlite/);
});

test("schema attestation rejects a same-name no-op replacement for a required trigger", async () => {
  const database = new SqliteD1();
  try {
    for (const item of contract.migrations) {
      const packaged = await readFile(join(integration, item.site_path), "utf8");
      for (const statement of parseBreakpointSql(packaged)) await database.prepare(statement).run();
    }
    database.exec("DROP TRIGGER meshful_v2_documents_no_delete");
    database.exec("CREATE TRIGGER meshful_v2_documents_no_delete BEFORE DELETE ON meshful_v2_documents BEGIN SELECT 1; END;");
    await assert.rejects(inspectAppliedD1(database), /schema or safety-trigger definitions differ/);
  } finally { database.close(); }
});

test("schema attestation rejects differently named triggers that touch Meshful tables", async () => {
  const database = new SqliteD1();
  try {
    for (const item of contract.migrations) {
      const packaged = await readFile(join(integration, item.site_path), "utf8");
      for (const statement of parseBreakpointSql(packaged)) await database.prepare(statement).run();
    }
    database.exec("CREATE TRIGGER unexpected_mutator AFTER INSERT ON meshful_v2_heads "
      + "BEGIN DELETE FROM meshful_v2_heads WHERE principal_id = NEW.principal_id; END;");
    await assert.rejects(inspectAppliedD1(database), /Unexpected schema objects reference Meshful tables/);
  } finally { database.close(); }
});

test("schema attestation canonicalizes driver property order", async () => {
  const database = new SqliteD1();
  try {
    for (const item of contract.migrations) {
      const packaged = await readFile(join(integration, item.site_path), "utf8");
      for (const statement of parseBreakpointSql(packaged)) await database.prepare(statement).run();
    }
    const reordered = { prepare(sql) {
      const statement = database.prepare(sql);
      return { async all() {
        const result = await statement.all();
        if (!sql.includes("sqlite_schema")) return result;
        return { ...result, results: result.results.map((row) => ({
          name: row.name, sql: row.sql, type: row.type, tbl_name: row.tbl_name,
        })) };
      } };
    } };
    assert.equal((await inspectAppliedD1(reordered)).schema_sha256, contract.database_schema.sqlite_schema_sha256);
  } finally { database.close(); }
});

function satisfyingEvidence(scenario, challenge) {
  const result = {};
  for (const item of scenario.assertions) result[item.path] = Object.hasOwn(item, "equals") ? item.equals
    : Array.isArray(item.one_of) ? item.one_of[0]
      : Object.hasOwn(item, "integer_min") ? item.integer_min : "a".repeat(64);
  Object.assign(result, { scenario_id: scenario.id, runner_challenge: challenge,
    challenge_observed_by_host: true, network_trace_sha256: "e".repeat(64),
    d1_observation_sha256: "f".repeat(64) });
  return result;
}

test("hosted runner enforces every release pin and every acceptance assertion without printing raw evidence", async () => {
  const releasePins = Object.fromEntries(Object.entries(matrix.required_release_pins).map(([name, rule]) => [
    name, Object.hasOwn(rule, "equals") ? rule.equals
      : rule.matches.includes("{64}") ? "a".repeat(64)
        : rule.matches.includes("{40}") ? "a".repeat(40) : "test-version-1",
  ]));
  const runNonce = "c".repeat(64);
  const runStartedAtMs = Date.now();
  const adapter = {
    async metadata() {
      return { environment: matrix.environment, base_url: "https://meshful.ai",
        actors: matrix.required_actors, executed_at: new Date(runStartedAtMs).toISOString(),
        release_pins: releasePins, run_nonce: runNonce };
    },
    async runScenario(...args) {
      assert.equal(args.length, 1, "Runner must not disclose assertion values to the adapter");
      assert.deepEqual(Object.keys(args[0]).sort(), ["challenge", "id"]);
      return satisfyingEvidence(matrix.scenarios.find((scenario) => scenario.id === args[0].id), args[0].challenge);
    },
  };
  const options = { adapterProvenance: {
    site_source_commit: releasePins.site_source_commit,
    site_source_manifest_sha256: releasePins.site_source_manifest_sha256,
    site_source_payload_sha256: releasePins.site_source_payload_sha256,
    site_saved_version_id: releasePins.site_saved_version_id,
    site_deployment_id: releasePins.site_deployment_id,
    manifest_sha256: "b".repeat(64), payload_sha256: "d".repeat(64),
  }, deliveryProvenance: {
    d1_integration_manifest_sha256: "1".repeat(64),
    d1_integration_payload_sha256: "2".repeat(64),
    acceptance_matrix_sha256: "3".repeat(64),
    hosted_evidence_contract_sha256: "4".repeat(64),
    hosted_runner_sha256: "5".repeat(64),
  }, runNonce, runStartedAtMs, clock: () => runStartedAtMs + 1_000 };
  const receipt = await runHostedAcceptance(adapter, "https://meshful.ai", options);
  assert.equal(receipt.harness_scenarios_passed, matrix.scenarios.length);
  assert.equal(receipt.harness_scenarios_failed, 0);
  assert.equal(receipt.raw_learner_data_in_receipt, false);
  assert.equal(receipt.independent_network_proof, false);
  assert.equal(receipt.paired_artifacts_verified, false);
  assert.equal(receipt.provider_limits_verified, false);
  assert.equal(receipt.hosted_acceptance_complete, false);
  assert.ok(receipt.scenarios.every((scenario) => scenario.harness_assertions_passed === true));
  assert.equal(receipt.release_pins.hosted_adapter_manifest_sha256, options.adapterProvenance.manifest_sha256);
  assert.equal(receipt.release_pins.hosted_adapter_payload_sha256, options.adapterProvenance.payload_sha256);
  assert.deepEqual(receipt.delivery_provenance, options.deliveryProvenance);
  assert.ok(receipt.scenarios.every((scenario) => /^[a-f0-9]{64}$/.test(scenario.evidence_sha256)));

  const failing = { ...adapter, async runScenario(input) {
    const evidence = await adapter.runScenario(input);
    if (input.id === "learner_a_b_isolation") evidence.distinct_verified_principals = false;
    return evidence;
  } };
  await assert.rejects(runHostedAcceptance(failing, "https://meshful.ai", options),
    /HOSTED_ACCEPTANCE_FAILED:learner_a_b_isolation:distinct_verified_principals/);

  const leaking = { ...adapter, async runScenario(input) {
    return { ...await adapter.runScenario(input), raw_state_json: "secret" };
  } };
  await assert.rejects(runHostedAcceptance(leaking, "https://meshful.ai", options),
    /has missing or extra fields/);

  const wrongPin = { ...adapter, async metadata() {
    const metadata = await adapter.metadata();
    return { ...metadata, release_pins: { ...metadata.release_pins, backend_v2_manifest_sha256: "0".repeat(64) } };
  } };
  await assert.rejects(runHostedAcceptance(wrongPin, "https://meshful.ai", options),
    /Release pin differs: backend_v2_manifest_sha256/);

  await assert.rejects(runHostedAcceptance(adapter, "https://does-not-exist.invalid", options),
    /HOSTED_ORIGIN_REJECTED/);

  const stale = { ...adapter, async metadata() {
    return { ...await adapter.metadata(), executed_at: new Date(runStartedAtMs - 60_000).toISOString() };
  } };
  await assert.rejects(runHostedAcceptance(stale, "https://meshful.ai", options),
    /evidence is stale or future-dated/);
});

test("hosted adapter provenance pins one reviewed all-and-only entry package", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshful-hosted-adapter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = "export function createHostedAcceptanceAdapter() { return 1; }\n";
  await writeFile(join(directory, "adapter.mjs"), entry);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const payloadFiles = [
    { path: "adapter.mjs", bytes: Buffer.byteLength(entry), sha256: hash(entry) },
  ];
  const payload = hash(payloadFiles.map((file) => `${file.sha256}  ${file.path}\n`).join(""));
  const manifest = {
    schema: "meshful-website-hosted-adapter.v1",
    site_source_commit: "a".repeat(40),
    site_source_manifest_sha256: "b".repeat(64),
    site_source_payload_sha256: "c".repeat(64),
    site_saved_version_id: "saved-version-1",
    site_deployment_id: "deployment-1",
    entry: "adapter.mjs",
    file_count: 2,
    payload_sha256: payload,
    files: [
      ...payloadFiles,
      { path: "HOSTED_ADAPTER_MANIFEST.json", bytes: null, sha256: null },
    ],
  };
  const manifestPath = join(directory, "HOSTED_ADAPTER_MANIFEST.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const bundle = await loadHostedAdapterBundle(manifestPath);
  assert.equal(bundle.provenance.payload_sha256, payload);
  assert.equal(typeof bundle.module.createHostedAcceptanceAdapter, "function");
  assert.equal(bundle.module.createHostedAcceptanceAdapter(), 1);

  const entry2 = "export function createHostedAcceptanceAdapter() { return 2; }\n";
  await writeFile(join(directory, "adapter.mjs"), entry2);
  manifest.files[0] = { path: "adapter.mjs", bytes: Buffer.byteLength(entry2), sha256: hash(entry2) };
  manifest.payload_sha256 = hash(`${manifest.files[0].sha256}  adapter.mjs\n`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const replaced = await loadHostedAdapterBundle(manifestPath);
  assert.equal(replaced.module.createHostedAcceptanceAdapter(), 2,
    "A same-path replacement must execute the newly verified content");

  await writeFile(join(directory, "unlisted-secret.txt"), "should fail\n");
  await assert.rejects(loadHostedAdapterBundle(manifestPath), /all and only bundle files/);
  await rm(join(directory, "unlisted-secret.txt"));
  const socketPath = join(directory, "undeclared.fifo");
  createFifo(socketPath);
  await assert.rejects(loadHostedAdapterBundle(manifestPath), /non-regular filesystem entry/);
});

test("hosted adapter manifest rejects portable path traversal before reading files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshful-hosted-adapter-path-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = {
    schema: "meshful-website-hosted-adapter.v1",
    site_source_commit: "a".repeat(40),
    site_source_manifest_sha256: "b".repeat(64),
    site_source_payload_sha256: "c".repeat(64),
    site_saved_version_id: "saved-version-1",
    site_deployment_id: "deployment-1",
    entry: "..\\outside.mjs",
    file_count: 2,
    payload_sha256: "d".repeat(64),
    files: [
      { path: "..\\outside.mjs", bytes: 0, sha256: "e".repeat(64) },
      { path: "HOSTED_ADAPTER_MANIFEST.json", bytes: null, sha256: null },
    ],
  };
  const manifestPath = join(directory, "HOSTED_ADAPTER_MANIFEST.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(loadHostedAdapterBundle(manifestPath), /relative \.mjs path/);
});

async function writeHostedAdapterBundle(directory, entry) {
  const entryHash = createHash("sha256").update(entry).digest("hex");
  await writeFile(join(directory, "adapter.mjs"), entry);
  const manifest = {
    schema: "meshful-website-hosted-adapter.v1",
    site_source_commit: "a".repeat(40),
    site_source_manifest_sha256: "b".repeat(64),
    site_source_payload_sha256: "c".repeat(64),
    site_saved_version_id: "saved-version-1",
    site_deployment_id: "deployment-1",
    entry: "adapter.mjs",
    file_count: 2,
    payload_sha256: createHash("sha256").update(`${entryHash}  adapter.mjs\n`).digest("hex"),
    files: [
      { path: "adapter.mjs", bytes: Buffer.byteLength(entry), sha256: entryHash },
      { path: "HOSTED_ADAPTER_MANIFEST.json", bytes: null, sha256: null },
    ],
  };
  const manifestPath = join(directory, "HOSTED_ADAPTER_MANIFEST.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

test("isolated adapter uses canonical bundle cwd and observes output through pipe close", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshful-hosted-canonical-"));
  const aliasRoot = await mkdtemp(join(tmpdir(), "meshful-hosted-alias-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(aliasRoot, { recursive: true, force: true }));
  const entry = `import { spawn } from "node:child_process";\n`
    + `export function createHostedAcceptanceAdapter(){return {\n`
    + `async metadata(){spawn(process.execPath,["-e","setTimeout(()=>process.stdout.write('late-output'),50)"],`
    + `{stdio:["ignore","inherit","ignore"]});return {cwd:process.cwd()};},\n`
    + `async runScenario(){return {};}};}\n`;
  const manifestPath = await writeHostedAdapterBundle(directory, entry);
  const alias = join(aliasRoot, "bundle");
  await symlink(directory, alias, "dir");
  await assert.rejects(runIsolatedAdapterChild(
    join(alias, "HOSTED_ADAPTER_MANIFEST.json"), "https://meshful.ai", "c".repeat(64), [],
    { timeoutMs: 2_000, killGraceMs: 50 },
  ), /HOSTED_ADAPTER_EMITTED_PROCESS_OUTPUT/);

  const quietEntry = `export function createHostedAcceptanceAdapter(){return {\n`
    + `async metadata(){return {cwd:process.cwd()};},async runScenario(){return {};}};}\n`;
  await writeHostedAdapterBundle(directory, quietEntry);
  const result = await runIsolatedAdapterChild(
    join(alias, "HOSTED_ADAPTER_MANIFEST.json"), "https://meshful.ai", "c".repeat(64), [],
    { timeoutMs: 2_000, killGraceMs: 50 },
  );
  assert.equal(result.metadata.cwd, await realpath(directory));
});

test("isolated adapter timeout settles and force-kills a SIGTERM-resistant child", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshful-hosted-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = `export function createHostedAcceptanceAdapter(){process.on("SIGTERM",()=>{});return {\n`
    + `async metadata(){return new Promise(()=>setInterval(()=>{},1000));},async runScenario(){return {};}};}\n`;
  const manifestPath = await writeHostedAdapterBundle(directory, entry);
  const started = Date.now();
  await assert.rejects(runIsolatedAdapterChild(
    manifestPath, "https://meshful.ai", "c".repeat(64), [],
    { timeoutMs: 250, killGraceMs: 50 },
  ), /HOSTED_ACCEPTANCE_ISOLATE_TIMEOUT/);
  assert.ok(Date.now() - started < 1_500, "Timeout rejection must not wait for child teardown");
});

function spawnRunner(args, { env = {}, nodeArgs = [] } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [...nodeArgs, join(integration, "run-hosted-acceptance.mjs"), ...args], {
      env: { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp",
        LANG: process.env.LANG ?? "C", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (bytes) => stdout.push(bytes));
    child.stderr.on("data", (bytes) => stderr.push(bytes));
    child.on("error", rejectPromise);
    child.on("exit", (code) => resolvePromise({ code,
      stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

test("CLI isolates adapter output, redacts failures and validates origin before import", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshful-hosted-adapter-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = "RAW-LEARNER-DATA-MUST-NOT-ESCAPE";
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const writeAdapter = async (entry) => {
    await writeFile(join(directory, "adapter.mjs"), entry);
    const entryHash = hash(entry);
    const manifest = {
      schema: "meshful-website-hosted-adapter.v1", site_source_commit: "a".repeat(40),
      site_source_manifest_sha256: "b".repeat(64), site_source_payload_sha256: "c".repeat(64),
      site_saved_version_id: "saved-version-1", site_deployment_id: "deployment-1",
      entry: "adapter.mjs", file_count: 2,
      payload_sha256: hash(`${entryHash}  adapter.mjs\n`),
      files: [
        { path: "adapter.mjs", bytes: Buffer.byteLength(entry), sha256: entryHash },
        { path: "HOSTED_ADAPTER_MANIFEST.json", bytes: null, sha256: null },
      ],
    };
    const manifestPath = join(directory, "HOSTED_ADAPTER_MANIFEST.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifestPath;
  };

  const importLeak = `process.stdout.write(${JSON.stringify(secret)});\n`
    + "export function createHostedAcceptanceAdapter(){ throw new Error('adapter failure'); }\n";
  const manifestPath = await writeAdapter(importLeak);
  const invalidOrigin = await spawnRunner(["--adapter-manifest", manifestPath, "--base-url", "https://invalid.example"]);
  assert.equal(invalidOrigin.code, 1);
  assert.ok(!`${invalidOrigin.stdout}${invalidOrigin.stderr}`.includes(secret));

  const importResult = await spawnRunner(["--adapter-manifest", manifestPath, "--base-url", "https://meshful.ai"]);
  assert.equal(importResult.code, 1);
  assert.equal(importResult.stdout, "");
  assert.equal(importResult.stderr, "HOSTED_ACCEPTANCE_REJECTED\n");
  assert.ok(!`${importResult.stdout}${importResult.stderr}`.includes(secret));

  const scenarioLeak = "export function createHostedAcceptanceAdapter(){return {"
    + "async metadata(){return {};},async runScenario(){process.stderr.write("
    + JSON.stringify(secret) + ");return {};}};}\n";
  await writeAdapter(scenarioLeak);
  const scenarioResult = await spawnRunner(["--adapter-manifest", manifestPath, "--base-url", "https://meshful.ai"]);
  assert.equal(scenarioResult.code, 1);
  assert.equal(scenarioResult.stdout, "");
  assert.equal(scenarioResult.stderr, "HOSTED_ACCEPTANCE_REJECTED\n");
  assert.ok(!`${scenarioResult.stdout}${scenarioResult.stderr}`.includes(secret));

  const importHook = join(directory, "preload.mjs");
  await writeFile(importHook, "globalThis.__meshful_preload_ran = true;\n");
  const preloaded = await spawnRunner(["--adapter-manifest", manifestPath, "--base-url", "https://meshful.ai"], {
    env: { NODE_OPTIONS: `--import=${pathToFileURL(importHook).href}` },
  });
  assert.equal(preloaded.code, 1);
  assert.equal(preloaded.stdout, "");
  assert.equal(preloaded.stderr, "HOSTED_ACCEPTANCE_REJECTED\n");

  const flagged = await spawnRunner(["--adapter-manifest", manifestPath, "--base-url", "https://meshful.ai"], {
    nodeArgs: ["--no-warnings"],
  });
  assert.equal(flagged.code, 1);
  assert.equal(flagged.stdout, "");
  assert.equal(flagged.stderr, "HOSTED_ACCEPTANCE_REJECTED\n");
});

test("hosted delivery provenance identifies this exact manifest, matrix and runner", async () => {
  const provenance = await verifyHostedAcceptanceDelivery();
  const manifestBytes = await readFile(join(integration, "FILE_MANIFEST.json"));
  assert.equal(provenance.d1_integration_manifest_sha256,
    createHash("sha256").update(manifestBytes).digest("hex"));
  assert.match(provenance.acceptance_matrix_sha256, /^[a-f0-9]{64}$/);
  assert.match(provenance.hosted_evidence_contract_sha256, /^[a-f0-9]{64}$/);
  assert.match(provenance.hosted_runner_sha256, /^[a-f0-9]{64}$/);
});

test("hosted delivery verification rejects traversal and symlinks before payload reads", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "meshful-hosted-delivery-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const integrationRoot = join(repositoryRoot, "backend/d1-integration");
  await mkdir(integrationRoot, { recursive: true });
  const manifestPath = join(integrationRoot, "FILE_MANIFEST.json");
  const self = { path: "backend/d1-integration/FILE_MANIFEST.json",
    destination: "backend/d1-integration/FILE_MANIFEST.json", role: "manifest-self-excluded",
    bytes: null, sha256: null };
  const base = { schema: "meshful-d1-integration-delivery.v1",
    delivery_root: "backend/d1-integration", file_count: 2, payload_sha256: "0".repeat(64),
    predecessors: [] };
  const traversal = { path: "backend/d1-integration/../../outside-secret",
    destination: "backend/d1-integration/../../outside-secret", role: "test",
    bytes: 1, sha256: "0".repeat(64) };
  await writeFile(manifestPath, JSON.stringify({ ...base, files: [self, traversal] }));
  await assert.rejects(verifyHostedAcceptanceDeliveryAt({ integrationRoot, repositoryRoot }),
    /Unsafe D1 delivery path/);

  const outside = join(repositoryRoot, "outside-secret");
  await writeFile(outside, "secret");
  await symlink(outside, join(integrationRoot, "payload.mjs"));
  const linked = { path: "backend/d1-integration/payload.mjs",
    destination: "backend/d1-integration/payload.mjs", role: "test",
    bytes: 6, sha256: createHash("sha256").update("secret").digest("hex") };
  await writeFile(manifestPath, JSON.stringify({ ...base, files: [self, linked] }));
  await assert.rejects(verifyHostedAcceptanceDeliveryAt({ integrationRoot, repositoryRoot }),
    /Adapter bundle contains a symlink/);

  await rm(join(integrationRoot, "payload.mjs"));
  const socketPath = join(integrationRoot, "undeclared.fifo");
  createFifo(socketPath);
  await writeFile(manifestPath, JSON.stringify({ ...base, file_count: 1, files: [self] }));
  await assert.rejects(verifyHostedAcceptanceDeliveryAt({ integrationRoot, repositoryRoot }),
    /non-regular filesystem entry/);
  await assert.rejects(walkRegularDeliveryTree(repositoryRoot, "backend/d1-integration"),
    /non-regular filesystem entry/);
});
