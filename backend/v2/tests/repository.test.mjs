import test from "node:test";
import assert from "node:assert/strict";
import { SqliteD1 } from "../../test-support/sqlite-d1.mjs";
import { createD1Repository as createV1Repository } from "../../src/d1-repository.mjs";
import { byteLength, sha256 } from "../../src/contracts.mjs";
import { encodeDocument, DOCUMENT_DECODE_MAX_BYTES, FRAGMENT_MAX_BYTES } from "../src/fragment-codec.mjs";
import { createD1Repository, MAX_BATCH_STATEMENTS, PACKED_JSON_MAX_BYTES } from "../src/d1-repository.mjs";

const migration = new URL("../migrations/0002_fragmented_storage.sql", import.meta.url);
const now = "2026-08-30T17:00:00.000Z";
const catalogRef = { version: "synthetic-repository-test", digest: `sha256:${"a".repeat(64)}` };
const v2Tables = ["objects", "documents", "parts", "receipts", "heads", "review_events", "import_archives"];

async function fixture(t) {
  const db = new SqliteD1();
  db.applyMigration();
  db.applyMigration(migration);
  t.after(() => db.close());
  const repository = createD1Repository(db);
  const legacy = createV1Repository(db);
  const provision = (subject) => repository.provisionPrincipalForVerifiedIdentity({
    provider: "sites-chatgpt", issuer: "urn:meshful:sites:repository-tests", subject,
  });
  const { principalId } = await provision("learner-a");
  return { db, repository, legacy, principalId, provision };
}

async function draft(principalId, {
  expectedRevision = 0, requestId = "request-a", stateJson = '{"deck":{"term":"Set"},"reviews":[]}',
  responseJson, reviewJson, sourceId, rawJson, baseRecord,
} = {}) {
  const revision = expectedRevision + 1;
  responseJson ??= JSON.stringify({ schema_version: 1, durable_revision: revision,
    result: { receipt: { idempotency_key: requestId, replayed: false }, applied: true } });
  const documents = [
    await encodeDocument({ id: `state:${revision}`, kind: "state", text: stateJson }),
    await encodeDocument({ id: `receipt:${requestId}`, kind: "receipt", text: responseJson }),
  ];
  const events = [];
  if (reviewJson !== undefined) {
    const eventId = await sha256(requestId);
    const documentId = `review:${eventId}`;
    documents.push(await encodeDocument({ id: documentId, kind: "review", text: reviewJson }));
    events.push({ eventId, deckId: "definitions", cardId: "set", documentId });
  }
  let importArchive;
  if (rawJson !== undefined) {
    sourceId ??= "local-source-a";
    const documentId = `import:${sourceId}`;
    const document = await encodeDocument({ id: documentId, kind: "import", text: rawJson });
    documents.push(document);
    importArchive = { sourceId, digest: document.digest, documentId };
  }
  return {
    principalId, expectedRevision, requestId, fingerprint: await sha256(JSON.stringify({ requestId, stateJson })),
    catalogRef, documents, stateDocumentId: `state:${revision}`, responseDocumentId: `receipt:${requestId}`,
    events, importArchive, baseRecord, now,
  };
}

function largeJson(label, minimumBytes) {
  const blocks = [];
  for (let index = 0; blocks.length * 60_000 < minimumBytes; index += 1) {
    blocks.push(`${label}:${index}:${"x".repeat(60_000)}:${index}`);
  }
  return JSON.stringify({ label, exactEscape: "\\u0061", unicode: "🧠雪", blocks });
}

function counts(db, principalId) {
  return Object.fromEntries(v2Tables.map((name) => [name,
    db.database.prepare(`SELECT count(*) AS n FROM meshful_v2_${name} WHERE principal_id = ?`).get(principalId).n]));
}

function observeQueries(db) {
  const queries = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const unbound = prepare(sql);
    const bind = unbound.bind.bind(unbound);
    unbound.bind = (...values) => {
      const bound = bind(...values);
      const execute = bound.execute.bind(bound);
      bound.execute = () => {
        queries.push({ sql, bindingCount: values.length });
        return execute();
      };
      return bound;
    };
    return unbound;
  };
  return queries;
}

async function legacyCommit(legacy, principalId, {
  requestId = "v1-request", expectedRevision = 0, sourceId, review = false,
} = {}) {
  const stateJson = JSON.stringify({ legacy: true, exact: "retained", revision: expectedRevision + 1 });
  const responseJson = JSON.stringify({ original: requestId, receipt: { replayed: false } });
  const importArchive = sourceId ? { sourceId, rawJson: '{ "legacy_source" : true }',
    digest: await sha256('{ "legacy_source" : true }') } : undefined;
  const value = { principalId, expectedRevision, requestId, fingerprint: `v1-${requestId}`, stateJson,
    responseJson, catalogRef, now, importArchive,
    events: review ? [{ eventId: `legacy-event-${requestId}`, deckId: "legacy-deck", cardId: "legacy-card",
      payloadJson: '{"learner_answer":"exact legacy answer","rating":"Good"}' }] : [],
  };
  await legacy.commit(value);
  return value;
}

test("all four documents exceed a D1 row while each SQL binding and fragment stays bounded", async (t) => {
  const { db, repository, principalId } = await fixture(t);
  const stateJson = largeJson("state", 2_100_000);
  const responseJson = largeJson("receipt", 2_040_000);
  const reviewJson = largeJson("review", 2_040_000);
  const rawJson = largeJson("import", 2_040_000);
  const input = await draft(principalId, { stateJson, responseJson, reviewJson, rawJson });
  const queries = observeQueries(db);
  const metrics = [];
  db.beforeStatement = ({ index, sql, values }) => {
    const sizes = values.filter((value) => typeof value === "string").map(byteLength);
    assert.ok(byteLength(sql) < 100_000);
    assert.ok(values.length <= 100);
    assert.ok(Math.max(0, ...sizes) <= PACKED_JSON_MAX_BYTES);
    metrics.push({ index, maxBindingBytes: Math.max(0, ...sizes), bindingBytes: sizes.reduce((a, b) => a + b, 0) });
  };
  assert.deepEqual(await repository.commit(input), { committed: true, revision: 1 });
  db.beforeStatement = undefined;
  assert.ok(metrics.length <= MAX_BATCH_STATEMENTS);
  const reloaded = createD1Repository(db); // New facade, same in-memory database; no disk/hosted claim.
  assert.equal((await reloaded.getState(principalId)).stateJson, stateJson);
  assert.equal((await reloaded.getReceipt(principalId, input.requestId)).responseJson, responseJson);
  assert.deepEqual((await reloaded.listReviewEvents(principalId))[0].payload, JSON.parse(reviewJson));
  assert.equal((await reloaded.getImportArchive(principalId, "local-source-a")).rawJson, rawJson);
  const maxRowBytes = db.database.prepare(`SELECT max(byte_length) AS n FROM meshful_v2_objects
    WHERE principal_id = ?`).get(principalId).n;
  assert.ok(maxRowBytes <= FRAGMENT_MAX_BYTES);
  t.diagnostic(JSON.stringify({ localMemoryOnly: true, documentBytes: input.documents.map((doc) => ({ kind: doc.kind, bytes: doc.byteLength })),
    statements: metrics.length, largestBindingBytes: Math.max(...metrics.map((metric) => metric.maxBindingBytes)),
    totalBindingBytes: metrics.reduce((sum, metric) => sum + metric.bindingBytes, 0), maxFragmentBytes: maxRowBytes,
    assemblyReadStatements: queries.length - metrics.length }));
});

test("stale admission creates no bootstrap head, receipt, document, or fragment", async (t) => {
  const { db, repository, principalId } = await fixture(t);
  const before = counts(db, principalId);
  const stale = await draft(principalId, { expectedRevision: 1, reviewJson: '{"rating":"Good"}', rawJson: '{"local":true}' });
  assert.deepEqual(await repository.commit(stale), { committed: false, revision: 0 });
  assert.deepEqual(counts(db, principalId), before);
  assert.equal((await repository.getRecoveryHead(principalId)).storageVersion, 1);
  const valid = await draft(principalId);
  await repository.commit(valid);
  const committedCounts = counts(db, principalId);
  assert.deepEqual(await repository.commit(await draft(principalId, { requestId: "stale-other" })),
    { committed: false, revision: 1 });
  assert.deepEqual(counts(db, principalId), committedCounts);
});

test("a failed first head switch rolls all successor data back and leaves v1 writable", async (t) => {
  const { db, repository, legacy, principalId } = await fixture(t);
  const prior = await legacyCommit(legacy, principalId, { review: true, sourceId: "prior-source" });
  const failure = new Error("injected before final head switch");
  db.beforeStatement = ({ sql }) => { if (sql.includes("INSERT INTO meshful_v2_heads")) throw failure; };
  await assert.rejects(repository.commit(await draft(principalId, { expectedRevision: 1, rawJson: '{"new":true}' })),
    (error) => error === failure);
  db.beforeStatement = undefined;
  assert.ok(Object.values(counts(db, principalId)).every((count) => count === 0));
  assert.equal((await legacy.getState(principalId)).stateJson, prior.stateJson);
  await legacyCommit(legacy, principalId, { requestId: "v1-after-rollback", expectedRevision: 1 });
  assert.equal((await repository.getState(principalId)).revision, 2);
});

test("takeover preserves old receipts/history/archive and rejects late v1 commits and reused v1 keys", async (t) => {
  const { db, repository, legacy, principalId } = await fixture(t);
  const prior = await legacyCommit(legacy, principalId, { review: true, sourceId: "prior-source" });
  const beforeV1 = await legacy.getState(principalId);
  assert.equal((await repository.getState(principalId)).stateJson, prior.stateJson);
  await repository.commit(await draft(principalId, { expectedRevision: 1, requestId: "v2-request", reviewJson: '{"rating":"Good"}' }));
  assert.deepEqual(await legacy.getState(principalId), beforeV1);
  assert.deepEqual(await repository.getReceipt(principalId, "v1-request"), await legacy.getReceipt(principalId, "v1-request"));
  assert.deepEqual(await repository.getImportArchive(principalId, "prior-source"), await legacy.getImportArchive(principalId, "prior-source"));
  assert.deepEqual((await repository.listReviewEvents(principalId)).map((event) => event.revision), [1, 2]);
  await assert.rejects(legacyCommit(legacy, principalId, { requestId: "late-v1", expectedRevision: 1 }), /MESHFUL_STORAGE_V2_REQUIRED/);
  assert.equal(await legacy.getReceipt(principalId, "late-v1"), null);
  await assert.rejects(repository.commit(await draft(principalId, { requestId: "v1-request", expectedRevision: 2 })), /MESHFUL_REQUEST_ALREADY_EXISTS/);
  assert.equal((await repository.getState(principalId)).revision, 2);
  assert.equal(counts(db, principalId).receipts, 1);
});

test("replay and concurrent stale writes cannot append a second review", async (t) => {
  const { db, repository, principalId } = await fixture(t);
  const input = await draft(principalId, { reviewJson: '{"answer":"a collection","rating":"Good"}' });
  const other = await draft(principalId, { requestId: "other", reviewJson: '{"answer":"different","rating":"Hard"}' });
  const results = await Promise.all([repository.commit(input), repository.commit(other)]);
  assert.deepEqual(results, [{ committed: true, revision: 1 }, { committed: false, revision: 1 }]);
  assert.deepEqual(await repository.commit(input), { committed: false, revision: 1 });
  assert.equal((await repository.getReceipt(principalId, input.requestId)).fingerprint, input.fingerprint);
  assert.equal(await repository.getReceipt(principalId, "other"), null);
  assert.equal(counts(db, principalId).review_events, 1);
});

test("reads and shared-content objects stay owner scoped; foreign proof is ignored and forged missing proof rolls back", async (t) => {
  const { db, repository, principalId, provision } = await fixture(t);
  const inputA = await draft(principalId, { stateJson: largeJson("owned", 250_000), rawJson: '{"owned":true}' });
  await repository.commit(inputA);
  const stateA = await repository.getState(principalId);
  const { principalId: learnerB } = await provision("learner-b");
  assert.equal(await repository.getReceipt(learnerB, inputA.requestId), null);
  assert.equal(await repository.getImportArchive(learnerB, "local-source-a"), null);
  assert.equal(await repository.getDocumentParts(learnerB, inputA.stateDocumentId), null);
  assert.deepEqual(await repository.listReviewEvents(learnerB), []);
  const copied = await draft(learnerB, { stateJson: stateA.stateJson,
    baseRecord: { ...stateA, revision: 0, storageProof: { ...stateA.storageProof, revision: 0 } } });
  await repository.commit(copied); // Wrong-owner hint cannot suppress B's objects.
  assert.ok(counts(db, learnerB).objects >= stateA.storageProof.chunkDigests.length);
  const { principalId: learnerC } = await provision("learner-c");
  const forged = await draft(learnerC, { stateJson: stateA.stateJson, baseRecord: { revision: 0,
    storageProof: { principalId: learnerC, revision: 0, chunkDigests: stateA.storageProof.chunkDigests } } });
  await assert.rejects(repository.commit(forged), /FOREIGN KEY constraint failed/);
  assert.ok(Object.values(counts(db, learnerC)).every((count) => count === 0));
  assert.equal((await repository.getState(principalId)).stateJson, stateA.stateJson);
});

test("only a matching owner and revision proof omits known object bindings", async (t) => {
  const { db, repository, principalId } = await fixture(t);
  await repository.commit(await draft(principalId, { stateJson: largeJson("reuse", 260_000) }));
  const baseRecord = await repository.getState(principalId);
  const captured = [];
  db.beforeStatement = ({ sql, values }) => {
    if (sql.includes("INSERT INTO meshful_v2_objects")) captured.push(...JSON.parse(values[1]).map((row) => row[0]));
  };
  await repository.commit(await draft(principalId, { requestId: "reuse-2", expectedRevision: 1, stateJson: baseRecord.stateJson, baseRecord }));
  assert.ok(baseRecord.storageProof.chunkDigests.every((digest) => !captured.includes(digest)));
  captured.length = 0;
  await repository.commit(await draft(principalId, { requestId: "reuse-3", expectedRevision: 2, stateJson: baseRecord.stateJson, baseRecord }));
  assert.ok(baseRecord.storageProof.chunkDigests.every((digest) => captured.includes(digest)));
  db.beforeStatement = undefined;
  assert.equal((await repository.getState(principalId)).stateJson, baseRecord.stateJson);
});

test("source claims remain globally exclusive across both storage formats", async (t) => {
  const { db, repository, legacy, principalId, provision } = await fixture(t);
  await legacyCommit(legacy, principalId, { sourceId: "v1-source" });
  const { principalId: learnerB } = await provision("learner-b");
  await assert.rejects(repository.commit(await draft(learnerB, { sourceId: "v1-source", rawJson: '{"second":true}' })),
    (error) => error.code === "LOCAL_SOURCE_ALREADY_CLAIMED" && error.status === 409 && !error.message.includes(principalId));
  assert.ok(Object.values(counts(db, learnerB)).every((count) => count === 0));
  await repository.commit(await draft(learnerB, { sourceId: "v2-source", rawJson: '{"first":true}' }));
  const { principalId: learnerC } = await provision("learner-c");
  await assert.rejects(legacyCommit(legacy, learnerC, { sourceId: "v2-source" }), /MESHFUL_LOCAL_SOURCE_ALREADY_CLAIMED/);
  assert.equal((await legacy.getState(learnerC)).revision, 0);
  assert.equal(await legacy.getReceipt(learnerC, "v1-request"), null);
  await assert.rejects(repository.commit(await draft(learnerC, { sourceId: "v2-source", rawJson: '{"second":true}' })),
    (error) => error.code === "LOCAL_SOURCE_ALREADY_CLAIMED");
  assert.ok(Object.values(counts(db, learnerC)).every((count) => count === 0));
});

test("embedded NUL request identities are distinct and 128 NUL characters remain valid", async (t) => {
  const { db, repository, principalId } = await fixture(t);
  const keys = ["x\0a", "x\0b", "\0".repeat(128)];
  for (const [expectedRevision, requestId] of keys.entries()) {
    const input = await draft(principalId, { expectedRevision, requestId, reviewJson: '{"rating":"Good"}' });
    input.events[0].deckId = "\0deck";
    input.events[0].cardId = "\0card";
    await repository.commit(input);
  }
  for (const requestId of keys) {
    const receipt = await repository.getReceipt(principalId, requestId);
    assert.equal(JSON.parse(receipt.responseJson).result.receipt.idempotency_key, requestId);
  }
  assert.equal(counts(db, principalId).receipts, 3);
  assert.ok((await repository.listReviewEvents(principalId)).every((event) => event.deckId === "\0deck" && event.cardId === "\0card"));
});

test("immutable document pages remain pinned while a newer head commits", async (t) => {
  const { repository, principalId, provision } = await fixture(t);
  const oldText = largeJson("old", 1_200_000);
  await repository.commit(await draft(principalId, { stateJson: oldText }));
  const first = await repository.getDocumentParts(principalId, "state:1", { limit: 3 });
  assert.equal(first.done, false);
  assert.equal(first.parts.length, 3);
  await repository.commit(await draft(principalId, { expectedRevision: 1, requestId: "new-head", stateJson: '{"new":true}' }));
  const parts = [...first.parts];
  let cursor = first.nextAfterPart;
  while (parts.length < first.document.partCount) {
    const page = await repository.getDocumentParts(principalId, "state:1", { afterPart: cursor, limit: 3 });
    parts.push(...page.parts);
    cursor = page.nextAfterPart;
  }
  assert.equal(parts.map((part) => part.text).join(""), oldText);
  assert.equal((await repository.getRecoveryHead(principalId)).stateDocumentId, "state:2");
  const { principalId: other } = await provision("other");
  assert.equal(await repository.getDocumentParts(other, "state:1"), null);
});

test("all durable successor documents, receipts, reviews, imports and objects reject mutation", async (t) => {
  const { db, repository, principalId } = await fixture(t);
  await repository.commit(await draft(principalId, { reviewJson: '{"rating":"Good"}', rawJson: '{"original":true}' }));
  for (const table of v2Tables.filter((name) => name !== "heads")) {
    assert.throws(() => db.database.prepare(`UPDATE meshful_v2_${table} SET principal_id = principal_id WHERE principal_id = ?`).run(principalId), /MESHFUL_IMMUTABLE/);
    assert.throws(() => db.database.prepare(`DELETE FROM meshful_v2_${table} WHERE principal_id = ?`).run(principalId), /MESHFUL_IMMUTABLE/);
  }
  assert.throws(() => db.database.prepare("DELETE FROM meshful_v2_heads WHERE principal_id = ?").run(principalId), /MESHFUL_IMMUTABLE_HEAD/);
});

test("stored corruption fails recovery and hydration without silently falling back to v1", async (t) => {
  const { db, repository, principalId } = await fixture(t);
  await repository.commit(await draft(principalId, { stateJson: largeJson("integrity", 250_000) }));
  const part = db.database.prepare(`SELECT object_digest FROM meshful_v2_parts
    WHERE principal_id = ? AND document_id = 'state:1' AND ordinal = 0`).get(principalId);
  // Deliberate local corruption after disabling the test database's protection.
  db.exec("DROP TRIGGER meshful_v2_objects_no_update");
  db.database.prepare(`UPDATE meshful_v2_objects SET body = '!' || substr(body, 2)
    WHERE principal_id = ? AND digest = ?`).run(principalId, part.object_digest);
  await assert.rejects(repository.getState(principalId), (error) => error.code === "STORAGE_CORRUPT");
  await assert.rejects(repository.getDocumentParts(principalId, "state:1"), (error) => error.code === "STORAGE_CORRUPT");
  assert.equal((await repository.getRecoveryHead(principalId)).storageVersion, 2);
});

test("missing ordinal is detected even when the remaining pieces are valid", async (t) => {
  const { db, repository, principalId } = await fixture(t);
  await repository.commit(await draft(principalId, { stateJson: largeJson("ordinal", 250_000) }));
  db.exec("DROP TRIGGER meshful_v2_parts_no_delete");
  db.database.prepare(`DELETE FROM meshful_v2_parts WHERE principal_id = ?
    AND document_id = 'state:1' AND ordinal = 1`).run(principalId);
  await assert.rejects(repository.getState(principalId), (error) => error.code === "STORAGE_CORRUPT");
  await assert.rejects(repository.getDocumentParts(principalId, "state:1"), (error) => error.code === "STORAGE_CORRUPT");
});

test("receipt-first admission cannot commit with a missing manifest part", async (t) => {
  const { db, repository, principalId } = await fixture(t);
  const originalBatch = db.batch.bind(db);
  db.batch = (statements) => originalBatch(statements.filter((statement) => !statement.sql.includes("INSERT INTO meshful_v2_parts")));
  await assert.rejects(repository.commit(await draft(principalId)), /MESHFUL_INCOMPLETE_DOCUMENT/);
  assert.ok(Object.values(counts(db, principalId)).every((count) => count === 0));
});

test("identity provisioning remains idempotent after takeover without rewriting the v1 shadow", async (t) => {
  const { repository, principalId, provision } = await fixture(t);
  await repository.commit(await draft(principalId));
  const repeated = await Promise.all([provision("learner-a"), provision("learner-a")]);
  assert.deepEqual(repeated, [{ principalId }, { principalId }]);
  assert.equal((await repository.getState(principalId)).revision, 1);
});

test("oversized and incoherent metadata are rejected before fetching any fragments", async (t) => {
  const { db, repository, principalId } = await fixture(t);
  await repository.commit(await draft(principalId));
  db.exec("DROP TRIGGER meshful_v2_documents_no_update");
  db.database.prepare(`UPDATE meshful_v2_documents SET byte_length = ?
    WHERE principal_id = ? AND document_id = 'state:1'`).run(DOCUMENT_DECODE_MAX_BYTES + 1, principalId);
  const queries = observeQueries(db);
  await assert.rejects(repository.getState(principalId), (error) => error.code === "RECOVERY_REQUIRED");
  assert.ok(queries.every(({ sql }) => !sql.includes("FROM meshful_v2_parts")));
  db.database.prepare(`UPDATE meshful_v2_documents SET byte_length = 10, part_count = 999999
    WHERE principal_id = ? AND document_id = 'state:1'`).run(principalId);
  queries.length = 0;
  await assert.rejects(repository.getState(principalId), (error) => error.code === "STORAGE_CORRUPT");
  assert.ok(queries.every(({ sql }) => !sql.includes("FROM meshful_v2_parts")));
});

test("an 8MiB state with 1024 small parts uses bounded private assembly query count", async (t) => {
  const { db, repository, principalId } = await fixture(t);
  const stateJson = JSON.stringify({ payload: "x".repeat(8 * 1024 * 1024 - 16) });
  const parts = [];
  const digests = new Map();
  for (let offset = 0; offset < stateJson.length; offset += 8192) {
    const text = stateJson.slice(offset, offset + 8192);
    if (!digests.has(text)) digests.set(text, await sha256(text));
    parts.push({ digest: digests.get(text), byteLength: text.length, text });
  }
  const initial = await draft(principalId);
  initial.documents[0] = { id: "state:1", kind: "state", byteLength: stateJson.length,
    digest: await sha256(stateJson), parts };
  await repository.commit(initial);
  const queries = observeQueries(db);
  const identity = { provider: "sites-chatgpt", issuer: "urn:meshful:sites:repository-tests", subject: "learner-a" };
  await repository.findPrincipalByIdentity(identity); // Accounts binding lookup.
  await repository.findPrincipalByIdentity(identity); // Service binding revalidation.
  await repository.getReceipt(principalId, "next");
  await repository.getRecoveryHead(principalId);
  const baseRecord = await repository.getState(principalId);
  assert.equal(baseRecord.stateJson, stateJson);
  assert.equal(baseRecord.storageProof.readStatements, 9);
  const next = await draft(principalId, { expectedRevision: 1, requestId: "next", baseRecord });
  next.documents[0] = { ...initial.documents[0], id: "state:2" };
  await repository.commit(next);
  assert.ok(queries.length <= 40);
  t.diagnostic(JSON.stringify({ localMemoryOnly: true, stateBytes: stateJson.length, parts: parts.length,
    ownerLookupsReceiptPreflightStateAndCommitSQL: queries.length, privateStateReadSQL: baseRecord.storageProof.readStatements }));
});

test("oversized atomic SQL transport is rejected before the first database statement", async (t) => {
  const { db, repository, principalId } = await fixture(t);
  // A codec-level UTF-8 stress document, deliberately not a canonical learner
  // fixture: controls maximize JSON binding expansion without a huge disk file.
  const text = Array.from({ length: 130 }, (_, index) =>
    `${String(index).padStart(6, "0")}${"\0".repeat(FRAGMENT_MAX_BYTES - 6)}`).join("");
  const input = await draft(principalId);
  input.documents[0] = await encodeDocument({ id: "state:1", kind: "state", text });
  const queries = observeQueries(db);
  await assert.rejects(repository.commit(input), (error) => error.code === "COMMIT_TOO_LARGE" && error.status === 413);
  assert.equal(queries.length, 0);
  assert.ok(Object.values(counts(db, principalId)).every((count) => count === 0));
});
