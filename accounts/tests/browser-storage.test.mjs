import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountStorageController, DEFAULT_STORAGE_LIMITS } from '../browser-storage.mjs';
import { createBrowserHarness, createDeferred } from './browser-storage-fixtures.mjs';

const SITE = 'appgprj_accounts_local_fixture';
const isBoundaryError = (error) => typeof error?.code === 'string' && error.name === 'AccountStorageError';
const code = (value) => (error) => isBoundaryError(error) && error.code === value;
function controller(t, h, index = 0, options = {}) {
  const tab = h.tabs[index];
  const invalidations = [];
  const state = createAccountStorageController({
    siteId: SITE, storage: tab.storage, locks: tab.locks, eventTarget: tab.window,
    channelFactory: null, onInvalidate: (event) => invalidations.push(event.reason), ...options,
  });
  t.after(() => state.dispose());
  return { state, tab, invalidations };
}
async function open(state, accountBinding = 'A', epochOptions) {
  const startup = state.beginEpoch(epochOptions);
  const ticket = state.bindPrincipal(accountBinding, startup);
  return state.acquire({ accountBinding, ticket });
}
function draft(accountBinding = 'A', requestId = 'grade-one', expectedRevision = 7) {
  return { accountBinding, command: {
    request_id: requestId, expected_revision: expectedRevision, operation: 'submit_grade',
    args: { idempotency_key: requestId, answer_text: '  exact e\u0301\r\n🙂 answer  ' },
  } };
}
function snapshot(accountBinding = 'A', revision = 7) {
  return { account_binding: accountBinding, durable_revision: revision,
    state: { note: 'private ' + accountBinding }, state_json: '{ "note":"exact local backup" }' };
}
function claim(accountBinding = 'A') {
  return { accountBinding, request: {
    request_id: 'claim-one', expected_revision: 0, source_id: 'source-one',
    catalog_ref: { version: 'fixture', digest: 'fixture' }, raw_state_json: ' {\r\n "exact":"e\u0301🙂"\r\n } ',
  } };
}

test('bootstrap is guarded, bound once, and never imports the legacy browser key', async (t) => {
  const legacy = 'adaptive-study-lab:web-state:v1';
  const h = createBrowserHarness({ initialBytes: { [legacy]: 'untouched private legacy bytes' } });
  const { state } = controller(t, h);
  assert.throws(() => state.executionGuard.capture(), code('ACCOUNT_CHANGED'));
  const start = state.beginEpoch();
  assert.equal(start.principalId, null);
  assert.throws(() => state.bindPrincipal('A', { ...start }), code('ACCOUNT_CHANGED'));
  const ticket = state.bindPrincipal('A', start);
  assert.equal(state.executionGuard.isCurrent(start), false);
  assert.throws(() => state.bindPrincipal('B', start), code('ACCOUNT_CHANGED'));
  const lease = await state.acquire({ accountBinding: 'A', ticket });
  assert.equal(lease.outbox.read(), null);
  assert.equal(lease.cache.read(), null);
  assert.equal(lease.claim.read(), null);
  assert.equal(h.bytes.get(legacy), 'untouched private legacy bytes');
  assert.equal(h.storageStats.operations.some((op) => op.key === legacy), false);
});

test('same-account tabs share one native lifetime; ordinary startup does not invalidate its holder', async (t) => {
  const h = createBrowserHarness();
  const a = controller(t, h, 0).state;
  const b = controller(t, h, 1).state;
  const first = await open(a);
  first.outbox.write(draft());
  const initialMarker = [...h.bytes].find(([key]) => key.endsWith(':auth-epoch'))[1];
  await assert.rejects(open(b), code('ACCOUNT_LEASE_BUSY'));
  assert.equal(first.isCurrent(), true);
  assert.equal([...h.bytes].find(([key]) => key.endsWith(':auth-epoch'))[1], initialMarker);
  assert.equal(h.lockStats.active.length, 1);
  const release = first.release();
  assert.equal(first.isCurrent(), false);
  assert.throws(() => first.outbox.write(null), code('ACCOUNT_LEASE_LOST'));
  await release;
  const second = await open(b);
  assert.deepEqual(second.outbox.read(), draft());
  for (const request of h.lockStats.requests) assert.deepEqual(request.options, { mode: 'exclusive', ifAvailable: true });
  for (const operation of h.storageStats.operations.filter((op) => op.key?.includes(':account:'))) {
    assert.ok(operation.heldLocks.length > 0, 'account storage touched without held native lease');
  }
});

test('different-account namespaces are immutable, partitioned and independently leased', async (t) => {
  const h = createBrowserHarness();
  const a = await open(controller(t, h, 0).state, 'A:part/one');
  const b = await open(controller(t, h, 1).state, 'A/part:one');
  assert.notEqual(a.namespace, b.namespace);
  a.outbox.write(draft('A:part/one'));
  b.outbox.write(draft('A/part:one'));
  a.cache.write(snapshot('A:part/one'));
  b.cache.write(snapshot('A/part:one'));
  assert.equal(h.lockStats.active.length, 2);
  assert.equal(a.outbox.read().accountBinding, 'A:part/one');
  assert.equal(b.cache.read().account_binding, 'A/part:one');
  assert.throws(() => { a.accountBinding = b.accountBinding; }, TypeError);
  assert.throws(() => { a.keys.outbox = b.keys.outbox; }, TypeError);
  assert.throws(() => a.outbox.write(draft('A/part:one')), code('ACCOUNT_RECORD_MISMATCH'));
});

test('logout then same-account login invalidates old tickets and preserves a pending draft', async (t) => {
  const h = createBrowserHarness();
  const { state } = controller(t, h);
  const old = await open(state);
  old.outbox.write(draft());
  const oldTicket = old.executionGuard.capture();
  const raw = h.bytes.get(old.keys.outbox);
  state.beginEpoch({ broadcast: true });
  assert.equal(old.executionGuard.isCurrent(oldTicket), false);
  await old.released;
  const current = await open(state);
  assert.equal(current.accountBinding, old.accountBinding);
  assert.equal(old.executionGuard.isCurrent(current.executionGuard.capture()), false);
  assert.deepEqual(current.outbox.read(), draft());
  assert.throws(() => old.outbox.write(null), code('ACCOUNT_LEASE_LOST'));
  assert.equal(h.bytes.get(current.keys.outbox), raw);
});

for (const nextAccount of ['A', 'B']) {
  test('late acknowledgement cannot clear a new ' + nextAccount + ' draft', async (t) => {
    const h = createBrowserHarness();
    const { state } = controller(t, h);
    const old = await open(state);
    old.outbox.write(draft());
    const ack = createDeferred();
    const late = ack.promise.then(() => old.outbox.write(null));
    const denied = assert.rejects(late, code('ACCOUNT_LEASE_LOST'));
    state.beginEpoch({ broadcast: true });
    await old.released;
    const current = await open(state, nextAccount);
    if (nextAccount === 'A') current.outbox.write(null); // Synthetic confirmed original receipt.
    current.outbox.write(draft(nextAccount, 'new-grade'));
    const raw = h.bytes.get(current.keys.outbox);
    ack.resolve();
    await denied;
    assert.equal(h.bytes.get(current.keys.outbox), raw);
    assert.equal(current.outbox.read().command.request_id, 'new-grade');
  });
}

test('marker check fences delayed storage events and invalidation hides the old sink synchronously', async (t) => {
  const h = createBrowserHarness();
  let visible = 'old private state';
  const a = controller(t, h, 0, { onInvalidate: () => { visible = null; } }).state;
  const b = controller(t, h, 1).state;
  const old = await open(a);
  visible = 'old private state';
  const captured = old.executionGuard.capture();
  b.beginEpoch({ broadcast: true });
  assert.ok(h.pendingEvents > 0);
  assert.equal(old.executionGuard.isCurrent(captured), false); // No event delivery needed.
  assert.equal(visible, null);
  assert.throws(() => old.cache.read(), code('ACCOUNT_LEASE_LOST'));
});

test('storage signal alone retires old handles and never binds a replacement account', async (t) => {
  const h = createBrowserHarness();
  const a = controller(t, h, 0);
  const b = controller(t, h, 1).state;
  const old = await open(a.state);
  h.flushEvents();
  const previous = a.invalidations.length;
  b.beginEpoch({ broadcast: true });
  h.flushEvents();
  assert.ok(a.invalidations.length > previous);
  assert.equal(old.isCurrent(), false);
  assert.throws(() => a.state.executionGuard.capture(), code('ACCOUNT_CHANGED'));
  assert.equal(h.storageStats.operations.filter((op) => op.operation === 'write' && op.key.endsWith(':auth-epoch')).length, 2);
});

test('a delayed lock grant cannot upgrade stale authenticated discovery', async (t) => {
  const h = createBrowserHarness();
  const { state } = controller(t, h);
  const ticket = state.bindPrincipal('A', state.beginEpoch());
  const opening = state.acquire({ accountBinding: 'A', ticket });
  const denied = assert.rejects(opening, code('ACCOUNT_CHANGED'));
  state.beginEpoch();
  await denied;
  await Promise.resolve();
  assert.equal(h.storageStats.operations.some((op) => op.key?.includes(':account:')), false);
});

test('pagehide and dispose revoke immediately; page restoration must rebootstrap', async (t) => {
  const h = createBrowserHarness();
  const { state, tab } = controller(t, h);
  const old = await open(state);
  old.outbox.write(draft());
  tab.window.dispatchEvent(new Event('pagehide'));
  assert.equal(old.isCurrent(), false);
  tab.window.dispatchEvent(new Event('pageshow'));
  assert.throws(() => state.executionGuard.capture(), code('ACCOUNT_CHANGED'));
  await old.released;
  const next = await open(state);
  assert.deepEqual(next.outbox.read(), draft());
  state.dispose();
  assert.equal(next.isCurrent(), false);
  assert.throws(() => state.beginEpoch(), code('ACCOUNT_CONTROLLER_CLOSED'));
});

test('revision-only replay replacement retains exact original and predecessor, including backwards recovery', async (t) => {
  const h = createBrowserHarness();
  const lease = await open(controller(t, h).state);
  const original = draft('A', 'grade-one', 10);
  lease.outbox.write(original);
  const originalRaw = lease.recovery.read().pending;
  const replacement = draft('A', 'grade-one', 3);
  lease.outbox.write(replacement);
  const record = lease.recovery.read();
  assert.equal(record.original, originalRaw);
  assert.equal(record.previous, originalRaw);
  assert.deepEqual(lease.outbox.read(), replacement);
  const raw = h.bytes.get(lease.keys.outbox);
  for (const change of [
    (value) => { value.accountBinding = 'B'; },
    (value) => { value.command.request_id = 'different'; },
    (value) => { value.command.operation = 'different'; },
    (value) => { value.command.args.answer_text += '!'; },
  ]) {
    const value = structuredClone(replacement); change(value);
    assert.throws(() => lease.outbox.write(value), isBoundaryError);
    assert.equal(h.bytes.get(lease.keys.outbox), raw);
  }
});

test('acknowledgement keeps a nonrecursive tombstone, recovered by the next lease for exact receipt validation', async (t) => {
  const h = createBrowserHarness();
  const { state } = controller(t, h);
  const first = await open(state);
  first.outbox.write(draft());
  const original = first.recovery.read().pending;
  first.outbox.write(null);
  assert.equal(first.outbox.read(), null);
  assert.equal(first.recovery.read().settled.pending, original);
  await first.release();
  const next = await open(state);
  assert.deepEqual(next.outbox.read(), draft());
  assert.throws(() => next.outbox.write(draft('A', 'different')), code('ACCOUNT_OUTBOX_CONFLICT'));
  next.outbox.write(null); // Only the durable client's confirmed receipt may cause this.
  assert.equal(next.outbox.read(), null);
  assert.equal(h.storageStats.operations.some((op) => op.operation === 'remove'), false);
});

test('auth-marker race during cleanup preserves tombstone bytes for the original account', async (t) => {
  const h = createBrowserHarness();
  const a = controller(t, h, 0);
  const b = controller(t, h, 1).state;
  const old = await open(a.state);
  old.outbox.write(draft());
  a.tab.failNext('write', ({ key }) => { assert.equal(key, old.keys.outbox); b.beginEpoch({ broadcast: true }); });
  assert.throws(() => old.outbox.write(null), isBoundaryError);
  assert.equal(old.isCurrent(), false);
  assert.ok(h.bytes.get(old.keys.outbox).includes('grade-one'));
  await old.released;
  const next = await open(a.state);
  assert.deepEqual(next.outbox.read(), draft());
});

test('claim intent and exact raw backup are immutable, separate from command drafts and legacy bytes', async (t) => {
  const h = createBrowserHarness({ initialBytes: { 'legacy-local-key': 'not claimed automatically' } });
  const lease = await open(controller(t, h).state);
  const value = claim();
  lease.claim.write(value);
  lease.claim.write(structuredClone(value));
  assert.deepEqual(lease.claim.read(), value);
  assert.equal(lease.outbox.read(), null);
  lease.outbox.write(draft());
  const raw = h.bytes.get(lease.keys.claim);
  const changed = structuredClone(value); changed.request.raw_state_json += ' ';
  assert.throws(() => lease.claim.write(changed), code('ACCOUNT_CLAIM_CONFLICT'));
  assert.throws(() => lease.claim.write(claim('B')), code('ACCOUNT_RECORD_MISMATCH'));
  assert.equal(h.bytes.get(lease.keys.claim), raw);
  assert.equal(h.bytes.get('legacy-local-key'), 'not claimed automatically');
});

test('cache requires exact account and cannot rewind a known revision', async (t) => {
  const h = createBrowserHarness();
  const lease = await open(controller(t, h).state);
  lease.cache.write(snapshot());
  const raw = h.bytes.get(lease.keys.cache);
  assert.throws(() => lease.cache.write(snapshot('B')), code('ACCOUNT_RECORD_MISMATCH'));
  assert.throws(() => lease.cache.write(snapshot('A', 6)), code('STALE_ACCOUNT_CACHE'));
  assert.equal(h.bytes.get(lease.keys.cache), raw);
  const returned = lease.cache.read(); returned.state.note = 'mutated return';
  assert.equal(lease.cache.read().state.note, 'private A');
});

test('missing Web Locks denies before touching storage; rejected requests never open account slots', async (t) => {
  const h = createBrowserHarness();
  assert.throws(() => controller(t, h, 0, { locks: {} }), code('ACCOUNT_LOCKS_UNAVAILABLE'));
  assert.equal(h.storageStats.operations.length, 0);
  const { state, tab } = controller(t, h);
  tab.locksSupported = false;
  await assert.rejects(open(state), code('ACCOUNT_LOCKS_UNAVAILABLE'));
  assert.equal(h.storageStats.operations.some((op) => op.key?.includes(':account:')), false);
});

for (const fault of ['write', 'readback']) {
  test(fault + ' failure preserves a revision recovery draft and never reports an empty success', async (t) => {
    const h = createBrowserHarness();
    const { state, tab } = controller(t, h);
    const old = await open(state);
    old.outbox.write(draft());
    const original = old.recovery.read().pending;
    tab.failNext(fault, new DOMException('private error must not leak', 'QuotaExceededError'));
    assert.throws(() => old.outbox.write(draft('A', 'grade-one', 2)), isBoundaryError);
    assert.equal(old.isCurrent(), false);
    await old.released;
    const recovered = await open(state);
    const record = recovered.recovery.read();
    assert.equal(record.original, original);
    assert.ok([7, 2].includes(recovered.outbox.read().command.expected_revision));
    assert.equal(record.previous === null || record.previous === original, true);
  });
}

test('unavailable reads retire the lease and preserve every stored byte', async (t) => {
  const h = createBrowserHarness();
  const { state, tab } = controller(t, h);
  const lease = await open(state);
  lease.outbox.write(draft());
  const before = [...h.bytes];
  tab.failNext('read', new Error('secret provider text'));
  assert.throws(() => lease.outbox.read(), (error) => isBoundaryError(error) && !error.message.includes('secret'));
  assert.equal(lease.isCurrent(), false);
  assert.deepEqual([...h.bytes], before);
});

test('corrupt and wrong-account envelopes never become an empty outbox or leak their text', async (t) => {
  const h = createBrowserHarness();
  const lease = await open(controller(t, h).state);
  for (const raw of ['{ private broken JSON', '{"version":77}', JSON.stringify({
    version: 1, accountBinding: 'B', pending: null, original: null, previous: null, settled: null,
  })]) {
    h.bytes.set(lease.keys.outbox, raw);
    assert.throws(() => lease.outbox.read(), (error) => isBoundaryError(error) && !error.message.includes('private'));
    assert.throws(() => lease.outbox.write(null), isBoundaryError);
    assert.equal(h.bytes.get(lease.keys.outbox), raw);
  }
});

test('UTF-8 draft and separate journal limits are enforced without writing partial records', async (t) => {
  assert.ok(DEFAULT_STORAGE_LIMITS.draftBytes >= 5 * 1024 * 1024);
  const value = draft();
  value.command.args.answer_text = '🙂'.repeat(32);
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  assert.ok(bytes > JSON.stringify(value).length);
  const h = createBrowserHarness();
  const tooSmall = await open(controller(t, h, 0, { limits: { draftBytes: bytes - 1 } }).state);
  assert.throws(() => tooSmall.outbox.write(value), code('ACCOUNT_STORAGE_LIMIT'));
  assert.equal(h.bytes.has(tooSmall.keys.outbox), false);
  await tooSmall.release();
  const exact = await open(controller(t, h, 1, { limits: { draftBytes: bytes } }).state);
  exact.outbox.write(value);
  assert.deepEqual(exact.outbox.read(), value);
  await exact.release();
  const other = h.createTab();
  const capped = await open(controller(t, h, h.tabs.indexOf(other), { limits: { outboxBytes: 10 } }).state, 'B');
  assert.throws(() => capped.outbox.write(draft('B')), code('ACCOUNT_STORAGE_LIMIT'));
  assert.equal(h.bytes.has(capped.keys.outbox), false);
});

test('request/source IDs remain exact payload values, not new auth-identity syntax', async (t) => {
  const h = createBrowserHarness();
  const lease = await open(controller(t, h).state);
  const value = draft('A', 'request with spaces: e\u0301🙂');
  lease.outbox.write(value);
  assert.deepEqual(lease.outbox.read(), value);
  const intent = claim();
  intent.request.source_id = 'source with spaces';
  intent.request.request_id = 'claim with spaces';
  lease.claim.write(intent);
  assert.deepEqual(lease.claim.read(), intent);
});

for (const [name, change] of [
  ['sparse array', (value) => { value.command.args.bad = Array(2); }],
  ['undefined', (value) => { value.command.args.bad = undefined; }],
  ['NaN', (value) => { value.command.args.bad = NaN; }],
  ['infinity', (value) => { value.command.args.bad = Infinity; }],
  ['BigInt', (value) => { value.command.args.bad = 1n; }],
  ['cycle', (value) => { value.command.args.bad = value; }],
  ['Date', (value) => { value.command.args.bad = new Date(0); }],
  ['toJSON', (value) => { value.command.args.toJSON = () => ({ changed: true }); }],
  ['accessor', (value) => { Object.defineProperty(value.command.args, 'bad', { enumerable: true, get() { throw new Error('must not run'); } }); }],
  ['symbol', (value) => { value.command.args[Symbol('hidden')] = 'lost data'; }],
]) {
  test('rejects lossy/non-JSON ' + name + ' before touching a draft', async (t) => {
    const h = createBrowserHarness();
    const lease = await open(controller(t, h).state);
    const value = draft(); change(value);
    assert.throws(() => lease.outbox.write(value), isBoundaryError);
    assert.equal(h.bytes.has(lease.keys.outbox), false);
  });
}

for (const [limit, value] of [['jsonNodes', 3], ['jsonDepth', 2]]) {
  test(limit + ' admission failure preserves an existing slot', async (t) => {
    const h = createBrowserHarness();
    const lease = await open(controller(t, h, 0, { limits: { [limit]: value } }).state);
    assert.throws(() => lease.outbox.write(draft()), code('ACCOUNT_STORAGE_LIMIT'));
    assert.equal(h.bytes.has(lease.keys.outbox), false);
  });
}

test('a >4.5MB escaped synthetic payload fits the explicit profile in memory, not a browser-quota promise', async (t) => {
  const h = createBrowserHarness();
  const lease = await open(controller(t, h).state);
  const value = draft();
  value.command.operation = 'ingest_deck';
  value.command.args = { idempotency_key: 'grade-one', synthetic_bytes: '\u0001'.repeat(760_000) };
  const wireBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  assert.ok(wireBytes > 4_523_411 && wireBytes < DEFAULT_STORAGE_LIMITS.draftBytes);
  lease.outbox.write(value);
  const exact = lease.outbox.read();
  assert.equal(exact.command.args.synthetic_bytes, value.command.args.synthetic_bytes);
  const recovered = structuredClone(value); recovered.command.expected_revision = 2;
  lease.outbox.write(recovered);
  assert.equal(lease.outbox.read().command.expected_revision, 2);
  assert.ok(new TextEncoder().encode(h.bytes.get(lease.keys.outbox)).byteLength < DEFAULT_STORAGE_LIMITS.outboxBytes);
});

test('an async invalidation sink cannot enable account discovery', (t) => {
  const h = createBrowserHarness();
  const { state } = controller(t, h, 0, { onInvalidate: async () => {} });
  assert.throws(() => state.beginEpoch(), code('INVALID_INVALIDATION_SINK'));
  assert.throws(() => state.executionGuard.capture(), code('ACCOUNT_CHANGED'));
  assert.equal(h.bytes.size, 0);
});

test('an async storage adapter is refused without authorizing account operations', (t) => {
  const h = createBrowserHarness();
  const { state } = controller(t, h, 0, { storage: { getItem: async () => null, setItem: async () => {} } });
  assert.throws(() => state.beginEpoch(), code('ACCOUNT_STORAGE_UNAVAILABLE'));
  assert.throws(() => state.executionGuard.capture(), code('ACCOUNT_CHANGED'));
});

test('post-grant native request rejection revokes the old lease and notifies its UI sink', async (t) => {
  const h = createBrowserHarness();
  const native = createDeferred();
  let callbackLifetime;
  const locks = { request(name, options, callback) {
    assert.deepEqual(options, { mode: 'exclusive', ifAvailable: true });
    callbackLifetime = callback({ name, mode: 'exclusive' });
    return native.promise;
  } };
  const { state, invalidations } = controller(t, h, 0, { locks });
  const lease = await open(state);
  const previous = invalidations.length;
  native.reject(new DOMException('synthetic forced native release', 'AbortError'));
  await lease.released;
  await callbackLifetime;
  assert.equal(lease.isCurrent(), false);
  assert.ok(invalidations.length > previous);
  assert.throws(() => lease.outbox.read(), code('ACCOUNT_LEASE_LOST'));
});
