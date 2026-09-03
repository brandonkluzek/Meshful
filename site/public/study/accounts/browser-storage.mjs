// Browser-only cooperative storage boundary. No authentication or HTTP client.
import { createAccountStateFence } from './browser-state.mjs';
import {
  AccountStorageError, DEFAULT_STORAGE_LIMITS, createRecordCodec, fail, opaqueId, storageLimits,
} from './browser-storage-records.mjs';
export { AccountStorageError, DEFAULT_STORAGE_LIMITS };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function synchronous(value) {
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {});
    fail('SYNCHRONOUS_STORAGE_REQUIRED');
  }
  return value;
}

export function createAccountStorageController(options = {}) {
  const siteId = opaqueId(options.siteId);
  const limits = storageLimits(options.limits);
  if (typeof options.onInvalidate !== 'function') fail('INVALID_INVALIDATION_SINK');
  let locks;
  let storage;
  let events;
  try {
    locks = options.locks ?? globalThis.navigator?.locks;
    if (!locks || typeof locks.request !== 'function') fail('ACCOUNT_LOCKS_UNAVAILABLE');
    storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage;
    events = options.eventTarget ?? globalThis.window;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      fail('ACCOUNT_STORAGE_UNAVAILABLE');
    }
    if (!events || typeof events.addEventListener !== 'function' || typeof events.removeEventListener !== 'function') {
      fail('ACCOUNT_INVALIDATION_UNAVAILABLE');
    }
  } catch (error) {
    if (error instanceof AccountStorageError) throw error;
    fail('ACCOUNT_STORAGE_UNAVAILABLE');
  }
  const nonce = options.nonce ?? (() => globalThis.crypto.randomUUID());
  if (typeof nonce !== 'function') fail('INVALID_STORAGE_CONFIGURATION');
  const prefix = `meshful:accounts:v2:${encodeURIComponent(siteId)}`;
  const epochKey = `${prefix}:auth-epoch`;
  const fence = createAccountStateFence();
  const leases = new Set();
  let marker = null;
  let phase = 'idle';
  let principal = null;
  let disposed = false;
  let channel = null;

  function retire(reason) {
    phase = 'idle';
    principal = null;
    marker = null;
    fence.changePrincipal(null);
    for (const lease of [...leases]) lease.close('ACCOUNT_CHANGED');
    try {
      synchronous(options.onInvalidate(Object.freeze({ reason })));
      return true;
    } catch { return false; } // Already revoked; a broken DOM sink never enables access.
  }
  function get(key) {
    let raw;
    try { raw = synchronous(storage.getItem(key)); }
    catch { retire('storage-unavailable'); fail('ACCOUNT_STORAGE_UNAVAILABLE'); }
    if (raw !== null && typeof raw !== 'string') {
      retire('storage-unavailable'); fail('SYNCHRONOUS_STORAGE_REQUIRED');
    }
    return raw;
  }
  function set(key, raw) {
    try { synchronous(storage.setItem(key, raw)); }
    catch { retire('storage-unavailable'); fail('ACCOUNT_STORAGE_UNAVAILABLE'); }
    if (get(key) !== raw) {
      retire('storage-unavailable'); fail('ACCOUNT_STORAGE_UNCONFIRMED');
    }
  }
  function readMarker() {
    const raw = get(epochKey);
    if (raw !== null) {
      if (!raw.startsWith('v1:')) fail('ACCOUNT_STORAGE_CORRUPT');
      opaqueId(raw.slice(3));
    }
    return raw;
  }
  function checkEpoch(ticket) {
    if (disposed || phase === 'idle' || !fence.isCurrent(ticket)) return false;
    try {
      if (marker !== null && readMarker() === marker) return true;
    } catch { /* Corrupt/unavailable storage cannot establish an epoch. */ }
    retire('auth-epoch-invalidated');
    return false;
  }
  const executionGuard = Object.freeze({
    capture() {
      const ticket = fence.capture();
      if (!checkEpoch(ticket)) fail('ACCOUNT_CHANGED');
      return ticket;
    },
    isCurrent: checkEpoch,
  });
  function receiveStorage(event) {
    if (event.storageArea && event.storageArea !== storage) return;
    if (event.key !== epochKey && event.key !== null) return;
    if (phase !== 'idle') checkEpoch(fence.capture());
  }
  function receiveMessage(event) {
    if (event.data?.type !== 'meshful-auth-invalidated-v1') return;
    // Messages can revoke, never bind a principal or grant a lease.
    if (phase !== 'idle' && event.data.marker !== marker) retire('remote-auth-change');
  }
  const pagehide = () => { retire('page-hidden'); };
  events.addEventListener('storage', receiveStorage);
  events.addEventListener('pagehide', pagehide);
  try {
    const factory = Object.hasOwn(options, 'channelFactory') ? options.channelFactory
      : typeof globalThis.BroadcastChannel === 'function' ? (name) => new BroadcastChannel(name) : null;
    if (factory) {
      channel = factory(`${prefix}:auth-invalidations`);
      channel.addEventListener('message', receiveMessage);
    }
  } catch { channel = null; } // Storage events + per-operation marker checks remain required.

  function beginEpoch({ broadcast = false } = {}) {
    if (disposed) fail('ACCOUNT_CONTROLLER_CLOSED');
    if (!retire('auth-transition')) fail('INVALID_INVALIDATION_SINK');
    if (typeof broadcast !== 'boolean') fail('INVALID_STORAGE_CONFIGURATION');
    let next = null;
    try {
      next = readMarker();
      if (next === null || broadcast) {
        next = `v1:${opaqueId(nonce())}`;
        set(epochKey, next);
      }
      marker = next;
      phase = 'bootstrap';
      return executionGuard.capture();
    } finally {
      if (broadcast && channel) {
        try { channel.postMessage({ type: 'meshful-auth-invalidated-v1', marker: next }); } catch { /* Storage signal remains. */ }
      }
    }
  }
  function bindPrincipal(accountBinding, bootstrapTicket) {
    if (!checkEpoch(bootstrapTicket) || phase !== 'bootstrap' || bootstrapTicket.principalId !== null) {
      fail('ACCOUNT_CHANGED');
    }
    try { opaqueId(accountBinding); } catch (error) { retire('invalid-account'); throw error; }
    principal = accountBinding;
    phase = 'bound';
    // Do not re-read/adopt a newer shared marker and discard discovery provenance.
    return fence.changePrincipal(accountBinding);
  }
  async function acquire({ accountBinding, ticket } = {}) {
    if (!checkEpoch(ticket) || phase !== 'bound' || accountBinding !== principal || ticket.principalId !== accountBinding) {
      fail('ACCOUNT_CHANGED');
    }
    if (leases.size) fail('ACCOUNT_LEASE_BUSY');
    const namespace = `${prefix}:account:${encodeURIComponent(accountBinding)}`;
    const keys = Object.freeze({ outbox: `${namespace}:outbox`, cache: `${namespace}:cache`, claim: `${namespace}:claim` });
    const lockName = `${namespace}:writer`;
    const leaseId = opaqueId(nonce());
    const codec = createRecordCodec(limits, accountBinding);
    const opened = deferred();
    const held = deferred();
    const released = deferred();
    const state = {
      active: false, closed: false,
      close(code) {
        if (state.closed) return;
        state.active = false; // Revoke synchronously BEFORE releasing native authority.
        state.closed = true;
        leases.delete(state);
        held.resolve();
        opened.reject(new AccountStorageError(code));
      },
    };
    leases.add(state);
    function assertCurrent() {
      if (!state.active || state.closed || !checkEpoch(ticket)) fail('ACCOUNT_LEASE_LOST');
    }
    function read(key) {
      assertCurrent();
      const raw = get(key);
      assertCurrent();
      return raw;
    }
    function write(key, raw) {
      assertCurrent();
      set(key, raw);
      assertCurrent();
    }
    function guarded(work) {
      assertCurrent();
      const result = work();
      assertCurrent();
      return result;
    }
    const outbox = Object.freeze({
      read: () => guarded(() => {
        const pending = codec.active(codec.outbox(read(keys.outbox)), leaseId);
        return pending ? codec.draft(pending.pending) : null;
      }),
      write: (record) => guarded(() => {
        const raw = read(keys.outbox);
        const next = codec.nextOutbox(raw, record, leaseId);
        if (next !== raw) write(keys.outbox, next);
      }),
    });
    const cache = Object.freeze({
      read: () => guarded(() => {
        const raw = read(keys.cache);
        return raw === null ? null : codec.snapshot(raw);
      }),
      write: (value) => guarded(() => {
        const next = codec.encode(value, limits.cacheBytes);
        const snapshot = codec.snapshot(next);
        const raw = read(keys.cache);
        if (raw !== null && codec.snapshot(raw).durable_revision > snapshot.durable_revision) fail('STALE_ACCOUNT_CACHE');
        if (raw !== next) write(keys.cache, next);
      }),
    });
    const claim = Object.freeze({
      read: () => guarded(() => {
        const raw = read(keys.claim);
        return raw === null ? null : codec.claim(raw);
      }),
      write: (value) => guarded(() => {
        const next = codec.encode(value, limits.claimBytes);
        codec.claim(next);
        const raw = read(keys.claim);
        if (raw !== null) {
          codec.claim(raw);
          if (raw !== next) fail('ACCOUNT_CLAIM_CONFLICT');
        } else write(keys.claim, next);
      }),
    });
    const guard = Object.freeze({
      capture() { assertCurrent(); return fence.capture(); },
      isCurrent(value) {
        try { assertCurrent(); return fence.isCurrent(value); } catch { return false; }
      },
    });
    const lease = Object.freeze({
      accountBinding, namespace, keys, lockName, limits,
      executionGuard: guard, outbox, cache, claim,
      recovery: Object.freeze({ read: () => guarded(() => codec.outbox(read(keys.outbox))) }),
      isCurrent() { try { assertCurrent(); return true; } catch { return false; } },
      release() {
        if (!state.closed) retire('lease-released');
        return released.promise;
      },
      released: released.promise,
    });
    function finished() {
      if (!state.closed) retire('native-lease-lost');
      state.close('ACCOUNT_LEASE_LOST');
      released.resolve();
    }
    try {
      // Only native Web Locks are supported in production. Never steal or use TTL/CAS.
      const request = locks.request(lockName, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (state.closed || !checkEpoch(ticket)) { state.close('ACCOUNT_CHANGED'); return; }
        if (lock === null) { state.close('ACCOUNT_LEASE_BUSY'); return; }
        if (!lock || lock.name !== lockName || lock.mode !== 'exclusive') {
          state.close('ACCOUNT_LOCKS_UNAVAILABLE'); return;
        }
        state.active = true;
        opened.resolve(lease);
        return held.promise; // The lock outlives every await until release/invalidation.
      });
      if (!request || typeof request.then !== 'function') fail('ACCOUNT_LOCKS_UNAVAILABLE');
      request.then(finished, () => {
        if (state.active && !state.closed) retire('native-lease-lost');
        state.close('ACCOUNT_LOCKS_UNAVAILABLE');
        finished();
      });
    } catch {
      state.close('ACCOUNT_LOCKS_UNAVAILABLE');
      finished();
    }
    return opened.promise;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    retire('disposed');
    events.removeEventListener('storage', receiveStorage);
    events.removeEventListener('pagehide', pagehide);
    try { channel?.close(); } catch { /* No data deletion. */ }
  }
  return Object.freeze({ beginEpoch, bindPrincipal, acquire, executionGuard, dispose, limits });
}
