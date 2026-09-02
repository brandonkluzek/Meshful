import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteD1 } from "../test-support/sqlite-d1.mjs";
import { createD1Repository } from "../src/d1-repository.mjs";
import { createLearnerService } from "../src/learner-service.mjs";
import { contextFor, fixtureIdentity, FIXED_NOW, persistenceFixtureEngine } from "../test-support/fixtures.mjs";

function serviceFor(db, engine = persistenceFixtureEngine()) {
  return createLearnerService({ repository: createD1Repository(db), engine, clock: () => FIXED_NOW });
}
const write = (id, expected = 0, value = "exact\r\nα  ") => ({
  request_id: id, expected_revision: expected, operation: "fixture_write", args: { idempotency_key: id, value },
});
const code = (expected) => (error) => error.code === expected;

test("file reload preserves committed state, exact payload, and durable replay", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meshful-backend-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "learner.sqlite");
  let db = new SqliteD1(path).applyMigration();
  let service = serviceFor(db);
  const a = await contextFor(service);
  const input = write("persist-once");
  const committed = await service.command(a, input);
  db.close();
  db = new SqliteD1(path);
  t.after(() => db.close());
  service = serviceFor(db);
  const replayed = await service.command(a, input);
  assert.equal(replayed.result.receipt.replayed, true);
  assert.equal(replayed.result.value, input.args.value);
  assert.deepEqual((await service.getState(a)).state.entries, [input.args.value]);
  assert.equal((await service.listReviews(a)).events.length, 1);
  assert.equal(replayed.durable_revision, committed.durable_revision);
  await assert.rejects(service.command(a, { ...input, args: { ...input.args, value: "changed" } }), code("IDEMPOTENCY_CONFLICT"));
});

test("racing services and separate SQLite connections admit only one stale-revision writer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meshful-race-"));
  const path = join(dir, "learner.sqlite");
  const first = new SqliteD1(path).applyMigration();
  const second = new SqliteD1(path);
  t.after(async () => { first.close(); second.close(); await rm(dir, { recursive: true, force: true }); });
  let arrived = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const base = persistenceFixtureEngine();
  const engine = { ...base, async transition(...args) {
    const result = await base.transition(...args);
    if (++arrived === 2) release();
    await barrier;
    return result;
  } };
  const service1 = serviceFor(first, engine);
  const service2 = serviceFor(second, engine);
  const a = await contextFor(service1);
  const outcomes = await Promise.allSettled([
    service1.command(a, write("writer-a", 0, "A")),
    service2.command(a, write("writer-b", 0, "B")),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === "rejected").reason.code, "STALE_DURABLE_REVISION");
  assert.equal((await service1.getState(a)).state.entries.length, 1);
  assert.equal((await service1.listReviews(a)).events.length, 1);
  assert.equal((await first.prepare("SELECT count(*) AS n FROM meshful_request_receipts").first()).n, 1);
});

test("concurrent identical requests replay one winner without a second event", async (t) => {
  const db = new SqliteD1().applyMigration(); t.after(() => db.close());
  const service = serviceFor(db); const a = await contextFor(service);
  const results = await Promise.all([service.command(a, write("same")), service.command(a, write("same"))]);
  assert.deepEqual(results.map((r) => r.result.receipt.replayed).sort(), [false, true]);
  assert.equal((await service.listReviews(a)).events.length, 1);
});

test("batch failures after receipt, snapshot, or event leave zero mutation and allow exact retry", async (t) => {
  for (const index of [1, 2, 3]) {
    const db = new SqliteD1().applyMigration(); t.after(() => db.close());
    const service = serviceFor(db); const a = await contextFor(service);
    db.beforeStatement = (statement) => { if (statement.index === index) throw new Error("injected failure"); };
    await assert.rejects(service.command(a, write(`failure-${index}`)), code("COMMIT_UNCONFIRMED"));
    db.beforeStatement = undefined;
    assert.equal((await service.getState(a)).state, null);
    assert.equal((await service.listReviews(a)).events.length, 0);
    await assert.rejects(service.getReceipt(a, `failure-${index}`), code("NOT_FOUND"));
    assert.equal((await service.command(a, write(`failure-${index}`))).durable_revision, 1);
  }
});

test("lost batch acknowledgement is recovered from the durable receipt", async (t) => {
  const db = new SqliteD1().applyMigration(); t.after(() => db.close());
  const repo = createD1Repository(db);
  let lose = true;
  const service = createLearnerService({ repository: { ...repo, async commit(input) {
    const result = await repo.commit(input);
    if (lose) { lose = false; throw new Error("lost acknowledgement"); }
    return result;
  } }, engine: persistenceFixtureEngine(), clock: () => FIXED_NOW });
  const a = await contextFor(service);
  const result = await service.command(a, write("ambiguous"));
  assert.equal(result.result.receipt.replayed, true);
  assert.equal((await service.listReviews(a)).events.length, 1);
});

test("exact identity provisioning is idempotent, namespace-sensitive, and leaves no orphan principals", async (t) => {
  const db = new SqliteD1().applyMigration(); t.after(() => db.close());
  const service = serviceFor(db);
  const shared = fixtureIdentity(" exact subject ");
  const [one, two] = await Promise.all([
    service.provisionPrincipalForVerifiedIdentity(shared), service.provisionPrincipalForVerifiedIdentity(shared),
  ]);
  assert.deepEqual(one, two);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM meshful_principals").first()).n, 1);
  assert.equal(await service.findPrincipalByIdentity({ ...shared, subject: "exact subject" }), null);
  assert.notDeepEqual(await service.provisionPrincipalForVerifiedIdentity({ ...shared, issuer: "urn:meshful:sites:other" }), one);
});

test("second learner cannot read receipts/history or use a forged principal and missing scopes", async (t) => {
  const db = new SqliteD1().applyMigration(); t.after(() => db.close());
  const service = serviceFor(db); const a = await contextFor(service); const b = await contextFor(service, "learner-b");
  await service.command(a, write("a-private"));
  assert.equal((await service.getState(b)).state, null);
  assert.equal((await service.listReviews(b)).events.length, 0);
  await assert.rejects(service.getReceipt(b, "a-private"), code("NOT_FOUND"));
  await assert.rejects(service.command({ ...b, principalId: a.principalId }, write("stolen")), code("FORBIDDEN"));
  await assert.rejects(service.command({ ...a, scopes: ["learner:read"] }, write("no-write", 1)), code("FORBIDDEN"));
  await assert.rejects(service.getState(null), code("UNAUTHENTICATED"));
  await assert.rejects(service.command(a, { ...write("body-owner", 1), principalId: b.principalId }), code("INVALID_INPUT"));
  assert.equal((await service.getState(a)).durable_revision, 1);
});

test("claim preserves original bytes, replays once, and will not overwrite existing durable data", async (t) => {
  const db = new SqliteD1().applyMigration(); t.after(() => db.close());
  const engine = persistenceFixtureEngine(); const service = serviceFor(db, engine);
  const a = await contextFor(service); const b = await contextFor(service, "learner-b");
  const raw = '{ "entries": ["local α\\r\\n"] }\n';
  const claim = { request_id: "claim-1", expected_revision: 0, source_id: "origin-lineage-a", catalog_ref: engine.defaultCatalogRef, raw_state_json: raw };
  const result = await service.claimLocalState(a, claim);
  assert.equal(result.result.imported, true);
  assert.equal((await service.getImportArchive(a, claim.source_id)).rawJson, raw);
  assert.equal((await service.claimLocalState(a, claim)).result.receipt.replayed, true);
  await assert.rejects(service.getImportArchive(b, claim.source_id), code("NOT_FOUND"));
  await assert.rejects(service.claimLocalState(b, { ...claim, request_id: "claim-b" }), code("LOCAL_SOURCE_ALREADY_CLAIMED"));
  assert.equal((await service.getState(b)).state, null);
  await assert.rejects(service.claimLocalState(a, { ...claim, expected_revision: 1, request_id: "overwrite" }), code("LOCAL_STATE_CONFLICT"));
  assert.equal((await service.getState(a)).state_json, raw);
});

test("receipts remain replayable after more than the browser's 256-write cache", async (t) => {
  const db = new SqliteD1().applyMigration(); t.after(() => db.close());
  const service = serviceFor(db); const a = await contextFor(service);
  const initial = write("first"); await service.command(a, initial);
  for (let n = 1; n <= 260; n++) await service.command(a, write(`later-${n}`, n, n));
  assert.equal((await service.command(a, initial)).result.receipt.replayed, true);
  assert.equal((await service.getState(a)).durable_revision, 261);
});
