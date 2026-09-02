// Opt-in composition with the real Backend client; transport/server are synthetic.
// Reads source only. No provider, HTTP socket, database, build, or disk writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAccountStorageController } from '../browser-storage.mjs';
import { createBrowserHarness, createDeferred } from '../tests/browser-storage-fixtures.mjs';

const backendRoot = process.argv[2];
if (!backendRoot) {
  console.log('Not run: pass the authorized Backend source directory explicitly.');
  process.exit(0);
}
const sourceHashes = {};
for (const name of ['durable-client.mjs', 'canonical-engine.mjs', 'contracts.mjs', 'local-state-validation.mjs']) {
  const bytes = await readFile(resolve(backendRoot, 'src', name));
  sourceHashes[name] = createHash('sha256').update(bytes).digest('hex');
}
const { createDurableClient } = await import(pathToFileURL(resolve(backendRoot, 'src/durable-client.mjs')).href);
const h = createBrowserHarness();
const state = createAccountStorageController({
  siteId: 'backend-composition-fixture', storage: h.tabs[0].storage,
  locks: h.tabs[0].locks, eventTarget: h.tabs[0].window,
  channelFactory: null, onInvalidate() {},
});
const delayed = createDeferred();
const received = createDeferred();
const receipts = new Map();
const revisions = new Map();
let signedIn = 'A';
let delayFirst = true;
let loseBReply = true;
let commits = 0;
const bodies = [];
const ok = (data) => Response.json({ ok: true, data });
const error = (code) => Response.json({ ok: false, error: { code, message: code } }, { status: 409 });
async function fetchImpl(path, init) {
  const account = signedIn;
  if (path.endsWith('/state')) return ok({ account_binding: account,
    durable_revision: revisions.get(account) ?? 0, state: null, state_json: null });
  if (init.headers['X-Meshful-Account'] !== account) return error('ACCOUNT_CHANGED');
  const receiptPath = '/receipts/';
  if (path.includes(receiptPath)) {
    const requestId = decodeURIComponent(path.slice(path.indexOf(receiptPath) + receiptPath.length));
    const known = receipts.get(JSON.stringify([account, requestId]));
    assert.ok(known, 'synthetic receipt recovery must be owner-scoped');
    const replay = structuredClone(known.data); replay.result.receipt.replayed = true;
    return ok(replay);
  }
  assert.ok(path.endsWith('/commands'));
  const request = JSON.parse(init.body);
  bodies.push({ account, body: init.body });
  const key = JSON.stringify([account, request.request_id]);
  const known = receipts.get(key);
  if (known) {
    if (known.body !== init.body) return error('IDEMPOTENCY_CONFLICT');
    const replay = structuredClone(known.data); replay.result.receipt.replayed = true;
    return ok(replay);
  }
  assert.equal(request.expected_revision, revisions.get(account) ?? 0);
  const revision = request.expected_revision + 1;
  const data = { durable_revision: revision, result: { receipt: {
    idempotency_key: request.request_id, replayed: false,
  } } };
  receipts.set(key, { body: init.body, data }); revisions.set(account, revision); commits += 1;
  if (account === 'A' && delayFirst) {
    delayFirst = false; received.resolve(); await delayed.promise;
  }
  if (account === 'B' && loseBReply) { loseBReply = false; throw new Error('synthetic lost acknowledgement'); }
  return ok(data);
}
async function client(account) {
  signedIn = account;
  const ticket = state.bindPrincipal(account, state.beginEpoch());
  const lease = await state.acquire({ accountBinding: account, ticket });
  const value = createDurableClient({ fetchImpl, outbox: lease.outbox });
  await value.load();
  return { lease, value };
}
const argsA = { deck_id: 'synthetic-deck', limit: 1, idempotency_key: 'request-A' };
const argsB = { deck_id: 'synthetic-deck', limit: 1, idempotency_key: 'request-B' };
try {
  const a = await client('A');
  const ticketA = a.lease.executionGuard.capture();
  const pendingA = a.value.startStudySession(argsA);
  await received.promise;
  state.beginEpoch({ broadcast: true }); await a.lease.released;
  const b = await client('B');
  await assert.rejects(b.value.startStudySession(argsB), (failure) => failure.code === 'REQUEST_UNCONFIRMED');
  const rawB = h.bytes.get(b.lease.keys.outbox);
  delayed.resolve();
  const committedA = await pendingA;
  assert.equal(committedA.receipt.replayed, false); // An old A commit may finish.
  assert.equal(a.lease.executionGuard.isCurrent(ticketA), false); // Never deliver it as B.
  assert.equal(h.bytes.get(b.lease.keys.outbox), rawB);
  assert.equal(b.lease.outbox.read().command.request_id, 'request-B');
  await b.lease.release();
  const reopened = await client('A');
  assert.equal((await reopened.value.startStudySession(argsA)).receipt.replayed, true);
  assert.equal(reopened.lease.outbox.read(), null);
  // Same tool after acknowledged completion uses the real client's receipt path.
  assert.equal((await reopened.value.startStudySession(argsA)).receipt.replayed, true);
  assert.equal(commits, 2);
  const aBodies = bodies.filter((row) => row.account === 'A').map((row) => row.body);
  assert.equal(aBodies.at(-1), aBodies[0]);
  assert.ok(reopened.lease.recovery.read().settled.previous !== null);
  await assert.rejects(reopened.value.startStudySession({ ...argsA, limit: 2 }),
    (failure) => failure.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(commits, 2);
  console.log(JSON.stringify({ ok: true, scenarios: 6, simulated_commits: commits,
    backend_source_hashes: sourceHashes,
    boundary: 'Real unchanged Backend durable client + real Accounts helper; synthetic transport/server, no SQL or hosted proof.',
  }, null, 2));
} finally { state.dispose(); }
