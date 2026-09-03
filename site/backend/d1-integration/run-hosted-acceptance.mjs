// Website supplies a real signed-in browser adapter. This runner owns the
// acceptance order and assertions but never receives credentials or raw learner
// state. It prints only evidence digests and release pins.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const matrixUrl = new URL("HOSTED_ACCEPTANCE.json", import.meta.url);
const matrixBytes = await readFile(matrixUrl);
const matrix = JSON.parse(matrixBytes);
const evidenceContractUrl = new URL("HOSTED_EVIDENCE_CONTRACT.json", import.meta.url);
const evidenceContractBytes = await readFile(evidenceContractUrl);
const evidenceContract = JSON.parse(evidenceContractBytes);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function valueAt(object, path) {
  return path.split(".").reduce((value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined, object);
}
function verifyAssertion(scenario, evidence, assertion) {
  const actual = valueAt(evidence, assertion.path);
  let ok;
  if (Object.hasOwn(assertion, "equals")) ok = Object.is(actual, assertion.equals);
  else if (Array.isArray(assertion.one_of)) ok = assertion.one_of.some((candidate) => Object.is(actual, candidate));
  else if (Object.hasOwn(assertion, "integer_min") || Object.hasOwn(assertion, "integer_max")) {
    ok = Number.isSafeInteger(actual)
      && (!Object.hasOwn(assertion, "integer_min") || actual >= assertion.integer_min)
      && (!Object.hasOwn(assertion, "integer_max") || actual <= assertion.integer_max);
  } else if (Object.hasOwn(assertion, "matches")) {
    ok = typeof actual === "string" && new RegExp(assertion.matches).test(actual);
  } else ok = false;
  assert.ok(ok, `HOSTED_ACCEPTANCE_FAILED:${scenario.id}:${assertion.path}`);
}

function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has missing or extra fields`);
}

function safeScalar(value, label) {
  const type = typeof value;
  assert.ok(type === "boolean" || type === "number" || type === "string", `${label} must be a JSON scalar`);
  if (type === "number") assert.ok(Number.isSafeInteger(value), `${label} must be a safe integer`);
  if (type === "string") {
    assert.ok(new TextEncoder().encode(value).byteLength <= 256, `${label} is too long`);
    assert.match(value, /^[A-Za-z0-9:._/-]+$/, `${label} contains unsafe characters`);
  }
}

function admittedOrigin(baseUrl) {
  let origin;
  try { origin = new URL(baseUrl); } catch { throw new Error("HOSTED_ORIGIN_REJECTED"); }
  if (origin.protocol !== "https:" || origin.origin !== String(baseUrl).replace(/\/$/, "")
    || !matrix.allowed_origins.includes(origin.origin)) throw new Error("HOSTED_ORIGIN_REJECTED");
  return origin.origin;
}

function inertSnapshot(value, label) {
  try { return structuredClone(value); }
  catch { throw new Error(`${label}_SNAPSHOT_REJECTED`); }
}

function validatePin(name, value, rule) {
  assert.equal(typeof value, "string", `Missing release pin: ${name}`);
  safeScalar(value, `Release pin ${name}`);
  if (Object.hasOwn(rule, "equals")) assert.equal(value, rule.equals, `Release pin differs: ${name}`);
  else {
    assert.equal(typeof rule.matches, "string", `Invalid pin rule: ${name}`);
    assert.match(value, new RegExp(rule.matches), `Release pin format differs: ${name}`);
  }
}

async function walk(root, relative = "") {
  const found = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), `Adapter bundle contains a symlink: ${relative}${entry.name}`);
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walk(root, path));
    else if (entry.isFile()) found.push(path);
    else assert.fail(`Bundle contains a non-regular filesystem entry: ${path}`);
  }
  return found;
}

function safeBundlePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 512
    || path.startsWith("/") || path.includes("\\") || path.includes(":")
    || /[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every((part) => part !== "." && part !== ".."
    && /^[A-Za-z0-9._-]+$/.test(part));
}

export async function verifyHostedAdapterBundle(manifestPathInput) {
  const manifestPath = await realpath(resolve(manifestPathInput));
  assert.equal(basename(manifestPath), "HOSTED_ADAPTER_MANIFEST.json",
    "Use a dedicated HOSTED_ADAPTER_MANIFEST.json bundle");
  const root = dirname(manifestPath);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  exactKeys(manifest, [
    "schema", "site_source_commit", "site_source_manifest_sha256",
    "site_source_payload_sha256", "site_saved_version_id", "site_deployment_id",
    "entry", "file_count", "payload_sha256", "files",
  ], "Hosted adapter manifest");
  assert.equal(manifest.schema, "meshful-website-hosted-adapter.v1");
  for (const name of ["site_source_commit", "site_source_manifest_sha256", "site_source_payload_sha256",
    "site_saved_version_id", "site_deployment_id"]) {
    validatePin(name, manifest[name], matrix.required_release_pins[name]);
  }
  assert.ok(safeBundlePath(manifest.entry) && manifest.entry.endsWith(".mjs"), "Adapter entry must be a relative .mjs path");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === 2,
    "Adapter bundle must contain exactly one reviewed entry and its manifest");
  assert.equal(manifest.files.length, manifest.file_count);

  const declared = new Set();
  const payload = [];
  for (const file of manifest.files) {
    exactKeys(file, ["path", "bytes", "sha256"], `Adapter bundle file ${file?.path ?? "<unknown>"}`);
    assert.ok(safeBundlePath(file.path), `Unsafe adapter bundle path: ${file.path}`);
    assert.ok(!declared.has(file.path), `Duplicate adapter bundle path: ${file.path}`);
    declared.add(file.path);
    if (file.path === "HOSTED_ADAPTER_MANIFEST.json") {
      assert.equal(file.bytes, null);
      assert.equal(file.sha256, null);
      continue;
    }
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0, `Invalid adapter bundle byte count: ${file.path}`);
    payload.push(file);
  }
  assert.ok(declared.has("HOSTED_ADAPTER_MANIFEST.json"), "Adapter manifest must list itself with null digest/bytes");
  assert.ok(declared.has(manifest.entry), "Adapter entry is not in the bundle manifest");
  assert.deepEqual((await walk(root)).sort(compare), [...declared].sort(compare),
    "Adapter manifest must list all and only bundle files");
  let entryBytes;
  for (const file of payload) {
    const bytes = await readFile(join(root, file.path));
    assert.equal(bytes.byteLength, file.bytes, `Adapter bundle byte count differs: ${file.path}`);
    assert.equal(digest(bytes), file.sha256, `Adapter bundle digest differs: ${file.path}`);
    if (file.path === manifest.entry) entryBytes = bytes;
  }
  payload.sort((a, b) => compare(a.path, b.path));
  assert.match(manifest.payload_sha256, /^[a-f0-9]{64}$/);
  assert.equal(digest(payload.map((file) => `${file.sha256}  ${file.path}\n`).join("")), manifest.payload_sha256,
    "Adapter bundle payload fingerprint differs");
  const entryFile = payload.find((file) => file.path === manifest.entry);
  assert.ok(entryFile && entryBytes, "Adapter entry bytes are unavailable");
  return Object.freeze({ manifest_path: manifestPath, bundle_root: root,
    entry_path: join(root, manifest.entry), entry_sha256: entryFile.sha256,
    provenance: Object.freeze({
    site_source_commit: manifest.site_source_commit,
    site_source_manifest_sha256: manifest.site_source_manifest_sha256,
    site_source_payload_sha256: manifest.site_source_payload_sha256,
    site_saved_version_id: manifest.site_saved_version_id,
    site_deployment_id: manifest.site_deployment_id,
    manifest_sha256: digest(manifestBytes),
    payload_sha256: manifest.payload_sha256,
  }) });
}

export async function loadHostedAdapterBundle(manifestPathInput) {
  const verified = await verifyHostedAdapterBundle(manifestPathInput);
  const module = await import(`${pathToFileURL(verified.entry_path).href}?sha256=${verified.entry_sha256}`);
  const afterImport = await readFile(verified.entry_path);
  assert.equal(digest(afterImport), verified.entry_sha256, "Adapter entry changed while it was loading");
  assert.equal(typeof module.createHostedAcceptanceAdapter, "function",
    "Adapter entry must export createHostedAcceptanceAdapter");
  return Object.freeze({ module, provenance: verified.provenance });
}

function safeRepositoryPath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 1_024
    && !path.startsWith("/") && !path.includes("\\") && !path.includes(":")
    && !/[\u0000-\u001f\u007f]/.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."
      && /^[A-Za-z0-9._-]+$/.test(part));
}

export async function verifyHostedAcceptanceDeliveryAt({ integrationRoot, repositoryRoot }) {
  const deliveryManifestPath = join(integrationRoot, "FILE_MANIFEST.json");
  const deliveryManifestBytes = await readFile(deliveryManifestPath);
  const delivery = JSON.parse(deliveryManifestBytes);
  assert.equal(delivery.schema, "meshful-d1-integration-delivery.v1");
  assert.equal(delivery.delivery_root, "backend/d1-integration");
  assert.equal(delivery.files.length, delivery.file_count);
  const declared = new Set();
  const payload = [];
  for (const file of delivery.files) {
    exactKeys(file, ["path", "destination", "role", "bytes", "sha256"],
      `D1 delivery file ${file?.path ?? "<unknown>"}`);
    assert.ok(safeRepositoryPath(file.path) && file.path.startsWith("backend/d1-integration/"),
      `Unsafe D1 delivery path: ${file.path}`);
    assert.equal(file.destination, file.path, `D1 delivery destination differs: ${file.path}`);
    assert.ok(!declared.has(file.path));
    declared.add(file.path);
    if (file.path === "backend/d1-integration/FILE_MANIFEST.json") {
      assert.equal(file.bytes, null); assert.equal(file.sha256, null); continue;
    }
    payload.push(file);
  }
  const actualFiles = (await walk(integrationRoot)).map((path) => `backend/d1-integration/${path}`).sort(compare);
  assert.deepEqual(actualFiles, [...declared].sort(compare));
  for (const file of payload) {
    const bytes = await readFile(join(repositoryRoot, file.path));
    assert.equal(bytes.byteLength, file.bytes);
    assert.equal(digest(bytes), file.sha256);
  }
  payload.sort((a, b) => compare(a.path, b.path));
  assert.equal(digest(payload.map((file) => `${file.sha256}  ${file.path}\n`).join("")), delivery.payload_sha256);
  for (const predecessor of delivery.predecessors) {
    assert.ok(safeRepositoryPath(predecessor.manifest) && predecessor.manifest.startsWith("backend/"),
      `Unsafe predecessor manifest path: ${predecessor.manifest}`);
    const bytes = await readFile(join(repositoryRoot, predecessor.manifest));
    assert.equal(digest(bytes), predecessor.manifest_sha256);
  }
  const runnerBytes = await readFile(fileURLToPath(import.meta.url));
  return Object.freeze({
    d1_integration_manifest_sha256: digest(deliveryManifestBytes),
    d1_integration_payload_sha256: delivery.payload_sha256,
    acceptance_matrix_sha256: digest(matrixBytes),
    hosted_evidence_contract_sha256: digest(evidenceContractBytes),
    hosted_runner_sha256: digest(runnerBytes),
  });
}

export async function verifyHostedAcceptanceDelivery() {
  const integrationRoot = dirname(fileURLToPath(import.meta.url));
  return verifyHostedAcceptanceDeliveryAt({
    integrationRoot,
    repositoryRoot: resolve(integrationRoot, "../.."),
  });
}

export async function runHostedAcceptance(adapter, baseUrl, {
  adapterProvenance, deliveryProvenance, runNonce, runStartedAtMs,
  clock = Date.now, challengeFactory = () => randomBytes(32).toString("hex"),
} = {}) {
  assert.equal(matrix.schema, "meshful-hosted-d1-acceptance-matrix.v1");
  const normalizedOrigin = admittedOrigin(baseUrl);
  exactKeys(adapterProvenance, [
    "site_source_commit", "site_source_manifest_sha256", "site_source_payload_sha256",
    "site_saved_version_id", "site_deployment_id", "manifest_sha256", "payload_sha256",
  ], "Adapter provenance");
  assert.match(adapterProvenance.site_source_commit, /^[a-f0-9]{40}$/);
  assert.match(adapterProvenance.site_source_manifest_sha256, /^[a-f0-9]{64}$/);
  assert.match(adapterProvenance.site_source_payload_sha256, /^[a-f0-9]{64}$/);
  safeScalar(adapterProvenance.site_saved_version_id, "Adapter provenance Site saved version");
  safeScalar(adapterProvenance.site_deployment_id, "Adapter provenance Site deployment");
  assert.match(adapterProvenance.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.match(adapterProvenance.payload_sha256, /^[a-f0-9]{64}$/);
  exactKeys(deliveryProvenance, [
    "d1_integration_manifest_sha256", "d1_integration_payload_sha256",
    "acceptance_matrix_sha256", "hosted_evidence_contract_sha256", "hosted_runner_sha256",
  ], "D1 integration delivery provenance");
  for (const [name, value] of Object.entries(deliveryProvenance)) {
    assert.match(value, /^[a-f0-9]{64}$/, `Invalid D1 integration provenance: ${name}`);
  }
  assert.match(runNonce, /^[a-f0-9]{64}$/, "Fresh runner nonce is required");
  assert.ok(Number.isSafeInteger(runStartedAtMs), "Runner start time is required");
  const metadataMethod = adapter?.metadata;
  const runScenarioMethod = adapter?.runScenario;
  assert.equal(typeof metadataMethod, "function", "Adapter metadata() is required");
  assert.equal(typeof runScenarioMethod, "function", "Adapter runScenario() is required");

  const metadata = inertSnapshot(await metadataMethod.call(adapter), "HOSTED_METADATA");
  const metadataObservedAtMs = clock();
  exactKeys(metadata, ["environment", "base_url", "actors", "executed_at", "release_pins", "run_nonce"], "Adapter metadata");
  assert.equal(metadata?.environment, matrix.environment);
  assert.equal(metadata?.base_url, normalizedOrigin);
  assert.ok(Array.isArray(metadata.actors));
  assert.deepEqual([...metadata.actors].sort(), [...matrix.required_actors].sort());
  assert.match(metadata.executed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/);
  const executedAtMs = Date.parse(metadata.executed_at);
  assert.ok(Number.isFinite(executedAtMs), "Adapter executed_at is invalid");
  assert.ok(executedAtMs >= runStartedAtMs - 1_000 && executedAtMs <= metadataObservedAtMs + 5_000,
    "Adapter evidence is stale or future-dated");
  assert.equal(metadata.run_nonce, runNonce, "Adapter did not echo the fresh runner nonce");
  exactKeys(metadata.release_pins, Object.keys(matrix.required_release_pins), "Release pins");
  const pins = {};
  for (const [name, rule] of Object.entries(matrix.required_release_pins)) {
    validatePin(name, metadata.release_pins[name], rule);
    pins[name] = metadata.release_pins[name];
  }
  for (const name of ["site_source_commit", "site_source_manifest_sha256", "site_source_payload_sha256",
    "site_saved_version_id", "site_deployment_id"]) {
    assert.equal(metadata.release_pins[name], adapterProvenance[name],
      `Adapter manifest and release metadata pin different ${name}`);
  }
  pins.hosted_adapter_manifest_sha256 = adapterProvenance.manifest_sha256;
  pins.hosted_adapter_payload_sha256 = adapterProvenance.payload_sha256;

  const results = [];
  for (const scenario of matrix.scenarios) {
    const challenge = challengeFactory(scenario.id);
    assert.match(challenge, /^[a-f0-9]{64}$/, "Scenario challenge must be 32 random bytes in lowercase hex");
    const evidence = inertSnapshot(await runScenarioMethod.call(adapter,
      Object.freeze({ id: scenario.id, challenge })), "HOSTED_SCENARIO");
    assert.ok(evidence && typeof evidence === "object" && !Array.isArray(evidence), `Missing evidence: ${scenario.id}`);
    const allowed = scenario.assertions.map((assertion) => assertion.path);
    assert.ok(allowed.every((path) => !path.includes(".")), "Acceptance evidence paths must be flat");
    exactKeys(evidence, [...allowed, "scenario_id", "runner_challenge", "challenge_observed_by_host",
      "network_trace_sha256", "d1_observation_sha256"], `Evidence ${scenario.id}`);
    assert.equal(evidence.scenario_id, scenario.id, `Scenario identity differs: ${scenario.id}`);
    assert.equal(evidence.runner_challenge, challenge, `Scenario challenge differs: ${scenario.id}`);
    assert.equal(evidence.challenge_observed_by_host, true, `Scenario challenge was not observed by the host: ${scenario.id}`);
    assert.match(evidence.network_trace_sha256, /^[a-f0-9]{64}$/, `Network trace digest missing: ${scenario.id}`);
    assert.match(evidence.d1_observation_sha256, /^[a-f0-9]{64}$/, `D1 observation digest missing: ${scenario.id}`);
    for (const [name, value] of Object.entries(evidence)) safeScalar(value, `Evidence ${scenario.id}.${name}`);
    const encoded = stable({ scenario_id: scenario.id, challenge, release_pins: pins, evidence });
    assert.ok(new TextEncoder().encode(encoded).byteLength <= 16_384, `Evidence summary is too large: ${scenario.id}`);
    for (const item of scenario.assertions) verifyAssertion(scenario, evidence, item);
    if (scenario.id === "qualified_capacity_history_and_recovery") {
      for (const [observed, limit] of [
        ["max_observed_invocation_cpu_ms", "effective_cpu_limit_ms"],
        ["observed_total_query_count", "effective_query_limit"],
        ["observed_request_body_bytes", "effective_request_body_limit_bytes"],
        ["observed_d1_storage_bytes", "effective_d1_storage_limit_bytes"],
      ]) assert.ok(evidence[observed] <= evidence[limit], `HOSTED_ACCEPTANCE_FAILED:${scenario.id}:${observed}_within_${limit}`);
    }
    const result = { id: scenario.id, harness_assertions_passed: true, evidence_sha256: digest(encoded),
      challenge_sha256: digest(challenge), network_trace_sha256: evidence.network_trace_sha256,
      d1_observation_sha256: evidence.d1_observation_sha256,
      assertion_count: scenario.assertions.length };
    if (scenario.id === "qualified_capacity_history_and_recovery") {
      result.resource_metrics_source = evidence.resource_metrics_source;
      result.resource_metrics_sha256 = evidence.resource_metrics_sha256;
    }
    results.push(result);
  }
  const runCompletedAtMs = clock();
  return Object.freeze({
    schema: "meshful-hosted-d1-acceptance-receipt.v1",
    environment: matrix.environment,
    receipt_authority: matrix.receipt_authority,
    independent_network_proof: false,
    paired_artifacts_verified: false,
    provider_limits_verified: false,
    hosted_acceptance_complete: false,
    run_started_at: new Date(runStartedAtMs).toISOString(),
    run_completed_at: new Date(runCompletedAtMs).toISOString(),
    run_nonce_sha256: digest(runNonce),
    base_url: normalizedOrigin,
    executed_at: metadata.executed_at,
    release_pins: pins,
    delivery_provenance: deliveryProvenance,
    runner_runtime: process.version,
    scenarios: results,
    harness_scenarios_passed: results.length,
    harness_scenarios_failed: 0,
    raw_learner_data_in_receipt: false,
  });
}

export async function runIsolatedAdapterChild(manifestPath, baseUrl, runNonce, scenarioChallenges, {
  timeoutMs = 15 * 60 * 1_000,
  killGraceMs = 1_000,
} = {}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "Invalid adapter timeout");
  assert.ok(Number.isSafeInteger(killGraceMs) && killGraceMs >= 0, "Invalid adapter kill grace");
  const canonicalManifestPath = await realpath(resolve(manifestPath));
  return new Promise((resolvePromise, rejectPromise) => {
    const child = fork(fileURLToPath(import.meta.url), [
      "--internal-adapter-run", canonicalManifestPath, baseUrl, runNonce, JSON.stringify(scenarioChallenges),
    ], {
      cwd: dirname(canonicalManifestPath),
      env: Object.freeze({ PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp",
        LANG: process.env.LANG ?? "C" }),
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let unexpectedOutputBytes = 0;
    const messages = [];
    let settled = false;
    let forceKillTimer;
    const clearDeadline = () => clearTimeout(timeout);
    const rejectSanitized = (code) => rejectPromise(Object.assign(new Error(code), { code }));
    const terminateAndReject = (code) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      rejectSanitized(code);
      try { child.kill("SIGTERM"); } catch {}
      forceKillTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        child.stdout.destroy();
        child.stderr.destroy();
        try { child.disconnect(); } catch {}
      }, killGraceMs);
    };
    const timeout = setTimeout(() => terminateAndReject("HOSTED_ACCEPTANCE_ISOLATE_TIMEOUT"), timeoutMs);
    const observeOutput = (bytes) => {
      unexpectedOutputBytes += bytes.byteLength;
      if (unexpectedOutputBytes > 65_536) terminateAndReject("HOSTED_ADAPTER_EMITTED_PROCESS_OUTPUT");
    };
    child.stdout.on("data", observeOutput);
    child.stderr.on("data", observeOutput);
    child.on("message", (message) => {
      messages.push(message);
      if (messages.length > 1) terminateAndReject("HOSTED_ACCEPTANCE_ISOLATE_FAILED");
    });
    child.on("error", () => terminateAndReject("HOSTED_ACCEPTANCE_ISOLATE_FAILED"));
    child.on("close", (code) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (settled) return;
      settled = true;
      clearDeadline();
      if (unexpectedOutputBytes > 0) return rejectSanitized("HOSTED_ADAPTER_EMITTED_PROCESS_OUTPUT");
      if (code !== 0 || messages.length !== 1) return rejectSanitized("HOSTED_ACCEPTANCE_ISOLATE_FAILED");
      resolvePromise(messages[0]);
    });
  });
}

async function runHostedAcceptanceIsolated(manifestPath, baseUrl, runNonce, runStartedAtMs) {
  const normalizedOrigin = admittedOrigin(baseUrl);
  const deliveryProvenance = await verifyHostedAcceptanceDelivery();
  const adapterPackageBefore = await verifyHostedAdapterBundle(manifestPath);
  const scenarioChallenges = matrix.scenarios.map((scenario) => Object.freeze({
    id: scenario.id, challenge: randomBytes(32).toString("hex"),
  }));
  const raw = inertSnapshot(await runIsolatedAdapterChild(
    adapterPackageBefore.manifest_path, normalizedOrigin, runNonce, scenarioChallenges,
  ), "HOSTED_CHILD_RESULT");
  assert.ok(new TextEncoder().encode(JSON.stringify(raw)).byteLength <= 1_048_576,
    "Hosted adapter result is too large");
  exactKeys(raw, ["type", "provenance", "metadata", "scenarios"], "Hosted child result");
  assert.equal(raw.type, "meshful-hosted-adapter-observations");
  assert.deepEqual(raw.provenance, adapterPackageBefore.provenance,
    "Hosted child used different adapter provenance");
  assert.ok(Array.isArray(raw.scenarios) && raw.scenarios.length === scenarioChallenges.length,
    "Hosted child returned the wrong scenario count");
  const byId = new Map();
  for (const observation of raw.scenarios) {
    exactKeys(observation, ["id", "challenge", "evidence"], "Hosted child scenario");
    assert.ok(!byId.has(observation.id), "Hosted child returned a duplicate scenario");
    byId.set(observation.id, observation);
  }
  assert.deepEqual([...byId.keys()].sort(), scenarioChallenges.map((item) => item.id).sort(),
    "Hosted child returned different scenario IDs");
  const adapterPackageAfter = await verifyHostedAdapterBundle(adapterPackageBefore.manifest_path);
  assert.deepEqual(adapterPackageAfter.provenance, adapterPackageBefore.provenance,
    "Hosted adapter package changed during the run");

  const proxy = {
    metadata: async () => raw.metadata,
    runScenario: async ({ id, challenge }) => {
      const observation = byId.get(id);
      assert.equal(observation?.challenge, challenge, `Hosted child challenge differs: ${id}`);
      return observation.evidence;
    },
  };
  const challengeById = new Map(scenarioChallenges.map((item) => [item.id, item.challenge]));
  return runHostedAcceptance(proxy, normalizedOrigin, {
    adapterProvenance: adapterPackageBefore.provenance,
    deliveryProvenance,
    runNonce,
    runStartedAtMs,
    challengeFactory: (id) => challengeById.get(id),
  });
}

function assertCleanAuthorityRuntime() {
  assert.equal(process.execArgv.length, 0, "HOSTED_ACCEPTANCE_UNCLEAN_NODE_RUNTIME");
  assert.ok(!(typeof process.env.NODE_OPTIONS === "string" && process.env.NODE_OPTIONS.trim()),
    "HOSTED_ACCEPTANCE_UNCLEAN_NODE_RUNTIME");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--internal-adapter-run") {
    const send = process.send?.bind(process);
    const exitProcess = process.exit.bind(process);
    const [, manifestPath, baseUrl, runNonce, challengesJson] = args;
    try {
      const normalizedOrigin = admittedOrigin(baseUrl);
      const challenges = JSON.parse(challengesJson);
      assert.ok(Array.isArray(challenges));
      const bundle = await loadHostedAdapterBundle(manifestPath);
      assert.equal(evidenceContract.schema, "meshful-hosted-evidence-contract.v1");
      const actorContexts = inertSnapshot(evidenceContract.actor_lifecycle.contexts,
        "HOSTED_ACTOR_CONTEXTS");
      const adapter = await bundle.module.createHostedAcceptanceAdapter({
        baseUrl: normalizedOrigin, runNonce, actorContexts,
      });
      const metadata = await adapter.metadata();
      const scenarios = [];
      for (const item of challenges) {
        scenarios.push({ id: item.id, challenge: item.challenge,
          evidence: await adapter.runScenario(Object.freeze({ id: item.id, challenge: item.challenge })) });
      }
      send?.({ type: "meshful-hosted-adapter-observations", provenance: bundle.provenance,
        metadata, scenarios }, () => exitProcess(0));
    } catch {
      send?.({ type: "meshful-hosted-adapter-failed" }, () => exitProcess(1));
    }
  } else {
    try {
      assertCleanAuthorityRuntime();
      assert.deepEqual(args.slice(0, 1), ["--adapter-manifest"]);
      assert.equal(args[2], "--base-url");
      assert.equal(args.length, 4, "HOSTED_ACCEPTANCE_USAGE_REJECTED");
      const runNonce = randomBytes(32).toString("hex");
      const runStartedAtMs = Date.now();
      const receipt = await runHostedAcceptanceIsolated(args[1], args[3], runNonce, runStartedAtMs);
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    } catch {
      process.stderr.write("HOSTED_ACCEPTANCE_REJECTED\n");
      process.exitCode = 1;
    }
  }
}
