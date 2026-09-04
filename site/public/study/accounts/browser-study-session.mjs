// Browser-only account/session coordination. Authentication and server-side
// ownership remain mandatory. The study-intent marker is only a revocation
// signal; the native Study Web Lock is the sole browser study-writer authority.
// Short account commands use a distinct lock and recovery slot so installing or
// archiving a deck cannot take over, release, or wait behind an active Study.
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

function synchronous(value, code = 'SYNCHRONOUS_STORAGE_REQUIRED') {
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {});
    fail(code);
  }
  return value;
}

function exactLock(lock, name) {
  return Boolean(lock && lock.name === name && lock.mode === 'exclusive');
}

export function createAccountSessionController(options = {}) {
  const siteId = opaqueId(options.siteId);
  const limits = storageLimits(options.limits);
  const accountCommandWaitMs = options.accountCommandWaitMs ?? 5_000;
  if (typeof options.onInvalidate !== 'function') fail('INVALID_INVALIDATION_SINK');
  if (!Number.isSafeInteger(accountCommandWaitMs) || accountCommandWaitMs < 1 || accountCommandWaitMs > 30_000) {
    fail('INVALID_STORAGE_CONFIGURATION');
  }

  let locks;
  let storage;
  let events;
  try {
    // Read-only account browsing does not need a Web Lock. Study acquisition
    // validates this capability before it signals or touches an account slot.
    locks = Object.hasOwn(options, 'locks') ? options.locks : globalThis.navigator?.locks;
    storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage;
    events = options.eventTarget ?? globalThis.window;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' ||
        typeof storage.removeItem !== 'function') {
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
  const writers = new Set();
  const mutationRunners = new WeakMap();
  let marker = null;
  let phase = 'idle';
  let principal = null;
  let disposed = false;
  let channel = null;

  function retireAccount(reason) {
    phase = 'idle';
    principal = null;
    marker = null;
    fence.changePrincipal(null);
    for (const writer of [...writers]) writer.close('ACCOUNT_CHANGED');
    try {
      synchronous(options.onInvalidate(Object.freeze({ reason })), 'INVALID_INVALIDATION_SINK');
      return true;
    } catch { return false; }
  }

  function get(key) {
    let raw;
    try { raw = synchronous(storage.getItem(key)); }
    catch { retireAccount('storage-unavailable'); fail('ACCOUNT_STORAGE_UNAVAILABLE'); }
    if (raw !== null && typeof raw !== 'string') {
      retireAccount('storage-unavailable');
      fail('SYNCHRONOUS_STORAGE_REQUIRED');
    }
    return raw;
  }

  function set(key, raw) {
    try { synchronous(storage.setItem(key, raw)); }
    catch { retireAccount('storage-unavailable'); fail('ACCOUNT_STORAGE_UNAVAILABLE'); }
    if (get(key) !== raw) {
      retireAccount('storage-unavailable');
      fail('ACCOUNT_STORAGE_UNCONFIRMED');
    }
  }

  function remove(key) {
    try { synchronous(storage.removeItem(key)); }
    catch { retireAccount('storage-unavailable'); fail('ACCOUNT_STORAGE_UNAVAILABLE'); }
    if (get(key) !== null) {
      retireAccount('storage-unavailable');
      fail('ACCOUNT_STORAGE_UNCONFIRMED');
    }
  }

  function readEpochMarker() {
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
      if (marker !== null && readEpochMarker() === marker) return true;
    } catch { /* Corrupt or unavailable storage cannot establish an epoch. */ }
    retireAccount('auth-epoch-invalidated');
    return false;
  }

  function checkBound(accountBinding, ticket) {
    return checkEpoch(ticket) && phase === 'bound' && principal === accountBinding &&
      ticket?.principalId === accountBinding;
  }

  const executionGuard = Object.freeze({
    capture() {
      const ticket = fence.capture();
      if (!checkEpoch(ticket)) fail('ACCOUNT_CHANGED');
      return ticket;
    },
    isCurrent: checkEpoch,
  });

  function notifyStudyIntent(intentKey, intentMarker) {
    if (!channel) return;
    try { channel.postMessage({ type: 'meshful-study-intent-v1', intentKey, intentMarker }); }
    catch { /* Storage event plus lock queuing remain authoritative. */ }
  }

  function receiveStorage(event) {
    if (event.storageArea && event.storageArea !== storage) return;
    if (event.key === epochKey || event.key === null) {
      if (phase !== 'idle') checkEpoch(fence.capture());
    }
    if (event.key !== null && !event.key?.endsWith(':study-intent')) return;
    for (const writer of [...writers]) writer.observeIntent(event.key);
  }

  function receiveMessage(event) {
    if (event.data?.type === 'meshful-auth-invalidated-v1') {
      // Messages can revoke, never bind a principal or grant a study lease.
      if (phase !== 'idle' && event.data.marker !== marker) retireAccount('remote-auth-change');
      return;
    }
    if (event.data?.type !== 'meshful-study-intent-v1' ||
        typeof event.data.intentKey !== 'string' || typeof event.data.intentMarker !== 'string') return;
    // The message is only a prompt to re-read durable same-origin intent bytes.
    for (const writer of [...writers]) writer.observeIntent(event.data.intentKey);
  }

  const pagehide = () => { retireAccount('page-hidden'); };
  events.addEventListener('storage', receiveStorage);
  events.addEventListener('pagehide', pagehide);
  try {
    const factory = Object.hasOwn(options, 'channelFactory') ? options.channelFactory
      : typeof globalThis.BroadcastChannel === 'function' ? (name) => new BroadcastChannel(name) : null;
    if (factory) {
      // Keep the predecessor channel name for auth invalidation compatibility.
      channel = factory(`${prefix}:auth-invalidations`);
      channel.addEventListener('message', receiveMessage);
    }
  } catch { channel = null; }

  function beginEpoch({ broadcast = false } = {}) {
    if (disposed) fail('ACCOUNT_CONTROLLER_CLOSED');
    if (!retireAccount('auth-transition')) fail('INVALID_INVALIDATION_SINK');
    if (typeof broadcast !== 'boolean') fail('INVALID_STORAGE_CONFIGURATION');
    let next = null;
    try {
      next = readEpochMarker();
      if (next === null || broadcast) {
        next = `v1:${opaqueId(nonce())}`;
        set(epochKey, next);
      }
      marker = next;
      phase = 'bootstrap';
      return executionGuard.capture();
    } finally {
      if (broadcast && channel) {
        try { channel.postMessage({ type: 'meshful-auth-invalidated-v1', marker: next }); }
        catch { /* Storage signal remains. */ }
      }
    }
  }

  function bindPrincipal(accountBinding, bootstrapTicket) {
    if (!checkEpoch(bootstrapTicket) || phase !== 'bootstrap' || bootstrapTicket.principalId !== null) {
      fail('ACCOUNT_CHANGED');
    }
    try { opaqueId(accountBinding); }
    catch (error) { retireAccount('invalid-account'); throw error; }
    principal = accountBinding;
    phase = 'bound';
    return fence.changePrincipal(accountBinding);
  }

  function browse({ accountBinding, ticket } = {}) {
    if (!checkBound(accountBinding, ticket)) fail('ACCOUNT_CHANGED');
    const guard = Object.freeze({
      capture() {
        if (!checkBound(accountBinding, ticket)) fail('ACCOUNT_CHANGED');
        return fence.capture();
      },
      isCurrent(value) {
        return checkBound(accountBinding, ticket) && fence.isCurrent(value);
      },
    });
    return Object.freeze({
      accountBinding,
      executionGuard: guard,
      isCurrent(value = ticket) { return checkBound(accountBinding, ticket) && fence.isCurrent(value); },
    });
  }

  function inspectRecoveries({ accountBinding, ticket } = {}) {
    if (!checkBound(accountBinding, ticket)) fail('ACCOUNT_CHANGED');
    const namespace = `${prefix}:account:${encodeURIComponent(accountBinding)}`;
    const codec = createRecordCodec(limits, accountBinding);
    const inspect = (key) => {
      const record = codec.outbox(get(key));
      const recoverable = record.pending !== null ? record : record.settled;
      return recoverable ? codec.draft(recoverable.pending) : null;
    };
    const discovered = Object.freeze({
      study: inspect(`${namespace}:outbox`),
      accountCommand: inspect(`${namespace}:account-command-outbox`),
      claim: (() => {
        const raw = get(`${namespace}:claim`);
        return raw === null ? null : codec.claim(raw);
      })(),
    });
    if (!checkBound(accountBinding, ticket)) fail('ACCOUNT_CHANGED');
    return discovered;
  }

  function acquireWriter({ accountBinding, ticket, onSuperseded, kind }) {
    if (!checkBound(accountBinding, ticket)) fail('ACCOUNT_CHANGED');
    let lockRequest;
    try { lockRequest = locks?.request; } catch { fail('ACCOUNT_LOCKS_UNAVAILABLE'); }
    if (typeof lockRequest !== 'function' || typeof globalThis.AbortController !== 'function') {
      fail('ACCOUNT_LOCKS_UNAVAILABLE');
    }
    const study = kind === 'study';
    const accountCommand = kind === 'account-command';
    if (!study && !accountCommand && kind !== 'claim') fail('INVALID_STORAGE_CONFIGURATION');
    if (study && typeof onSuperseded !== 'function') fail('INVALID_STUDY_INVALIDATION_SINK');
    // Claims retain the historical whole-state writer boundary. Account
    // commands may overlap Study and queue behind their own short lane; D1's
    // durable revision compare-and-swap still resolves cross-lane races.
    if ([...writers].some((writer) => {
      if (writer.closed) return false;
      // Study/account-command overlap and account-command serialization are
      // the only permitted combinations. Claims still exclude every writer.
      return !((study && writer.kind === 'account-command') ||
        (accountCommand && ['study', 'account-command'].includes(writer.kind)));
    })) {
      fail(study ? 'STUDY_LEASE_BUSY' : 'ACCOUNT_LEASE_BUSY');
    }

    const namespace = `${prefix}:account:${encodeURIComponent(accountBinding)}`;
    const keys = Object.freeze({
      // Keep Study/claim on the historical slot so an older uncertain action is
      // still recoverable. New short commands get their own exact draft.
      outbox: accountCommand ? `${namespace}:account-command-outbox` : `${namespace}:outbox`,
      cache: `${namespace}:cache`, claim: `${namespace}:claim`,
    });
    // Retain the historical Study lock name while separating short commands.
    const lockName = accountCommand ? `${namespace}:account-command` : `${namespace}:writer`;
    // Queue short commands on a dedicated outer lock, then acquire the existing
    // lane lock fail-fast. Claims never take the queue lock, so they keep their
    // historical writer -> account-command order and remain exclusive.
    const queueLockName = accountCommand ? `${namespace}:account-command-queue` : null;
    const requestLockName = queueLockName ?? lockName;
    // A claim spans both authority lanes in this fixed order. Study never takes
    // the account-command queue or lane and therefore remains able to overlap.
    const secondaryLockName = kind === 'claim' || accountCommand
      ? `${namespace}:account-command`
      : null;
    const intentKey = study ? `${namespace}:study-intent` : null;
    const leaseId = opaqueId(nonce());
    const intentMarker = study ? `v1:${opaqueId(nonce())}` : null;
    const codec = createRecordCodec(limits, accountBinding);
    const opened = deferred();
    // A synchronous intent-storage failure can close the state before this
    // function returns the acquisition promise. Observe that internal reject;
    // callers still receive the original storage error thrown by set().
    opened.promise.catch(() => {});
    const held = deferred();
    const released = deferred();
    const armed = deferred();
    const aborter = new AbortController();
    const presentationTickets = new WeakSet();
    let presentationGeneration = 0;
    let accountCommandWaitTimer = null;

    const state = {
      kind,
      active: false,
      closed: false,
      draining: false,
      invalidationSinkFailed: false,
      tasks: new Set(),
      intentKey,
      intentMarker,
      close(code) {
        if (state.closed) return;
        if (accountCommandWaitTimer !== null) {
          clearTimeout(accountCommandWaitTimer);
          accountCommandWaitTimer = null;
        }
        state.active = false;
        state.closed = true;
        presentationGeneration += 1;
        writers.delete(state);
        try { aborter.abort(); } catch { /* A granted lock still exits through held. */ }
        held.resolve();
        opened.reject(new AccountStorageError(code));
      },
      observeIntent(changedKey) {
        if (!study || state.closed || (changedKey !== null && changedKey !== intentKey)) return;
        let current;
        try { current = get(intentKey); }
        catch { state.close('ACCOUNT_STORAGE_UNAVAILABLE'); return; }
        if (current === intentMarker) return;
        if (!state.active) {
          state.close('STUDY_SUPERSEDED');
          return;
        }
        state.beginDrain('study-superseded');
      },
      beginDrain(reason, notify = true) {
        if (state.closed || state.draining) return;
        state.draining = true;
        presentationGeneration += 1;
        if (notify) {
          try {
            synchronous(onSuperseded(Object.freeze({ reason, accountBinding })), 'INVALID_STUDY_INVALIDATION_SINK');
          } catch {
            // Study guard is already revoked; writer safety does not depend on
            // this sink. Website can inspect this status and force a reload.
            state.invalidationSinkFailed = true;
          }
        }
        state.maybeFinishDrain();
      },
      maybeFinishDrain() {
        if (state.draining && state.tasks.size === 0) {
          state.close(study ? 'STUDY_SUPERSEDED' : 'ACCOUNT_LEASE_LOST');
        }
      },
    };
    writers.add(state);

    function assertStorageAuthority() {
      if (!state.active || state.closed || !checkBound(accountBinding, ticket)) {
        fail(study ? 'STUDY_LEASE_LOST' : 'ACCOUNT_LEASE_LOST');
      }
    }

    function observeOwnIntent() {
      if (!study) return true;
      state.observeIntent(intentKey);
      return !state.draining && !state.closed;
    }

    function assertPresentationAuthority() {
      assertStorageAuthority();
      if (!observeOwnIntent()) fail('STUDY_SUPERSEDED');
    }

    function read(key) {
      assertStorageAuthority();
      const raw = get(key);
      assertStorageAuthority();
      return raw;
    }

    function write(key, raw) {
      assertStorageAuthority();
      if (state.tasks.size === 0) {
        fail(study ? 'STUDY_MUTATION_REQUIRED' : 'ACCOUNT_MUTATION_REQUIRED');
      }
      set(key, raw);
      assertStorageAuthority();
    }

    function guarded(work) {
      assertStorageAuthority();
      const result = work();
      assertStorageAuthority();
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
      clear: () => guarded(() => {
        if (state.tasks.size === 0) fail('ACCOUNT_MUTATION_REQUIRED');
        remove(keys.claim);
      }),
    });

    const writerGuard = Object.freeze({
      capture() {
        assertPresentationAuthority();
        const value = Object.freeze({ leaseId, generation: presentationGeneration });
        presentationTickets.add(value);
        return value;
      },
      isCurrent(value) {
        try {
          assertPresentationAuthority();
          return Boolean(value && presentationTickets.has(value) &&
            value.leaseId === leaseId && value.generation === presentationGeneration);
        } catch { return false; }
      },
    });

    function invalidMutation(code) {
      state.tasks.clear();
      state.beginDrain('invalid-mutation', false);
      state.maybeFinishDrain();
      fail(code);
    }

    function trackMutation(work, requiredSlot) {
      if (typeof work !== 'function') fail(study ? 'INVALID_STUDY_MUTATION' : 'INVALID_ACCOUNT_MUTATION');
      assertPresentationAuthority();
      if (state.tasks.size !== 0) fail(study ? 'STUDY_MUTATION_BUSY' : 'ACCOUNT_MUTATION_BUSY');
      // Install a synchronous placeholder before invoking caller code so a
      // re-entrant takeover cannot release native authority between the first
      // durable write and adoption of the returned promise.
      const slot = Object.freeze({ leaseId });
      state.tasks.add(slot);
      let result;
      try { result = work(); }
      catch (error) {
        state.tasks.delete(slot);
        state.maybeFinishDrain();
        throw error;
      }
      let then;
      try { then = result?.then; }
      catch (error) {
        state.tasks.delete(slot);
        state.beginDrain('invalid-mutation', false);
        state.maybeFinishDrain();
        throw error;
      }
      if (!result || typeof then !== 'function') {
        invalidMutation(study ? 'STUDY_MUTATION_PROMISE_REQUIRED' : 'ACCOUNT_MUTATION_PROMISE_REQUIRED');
      }
      const task = new Promise((resolve, reject) => {
        try { then.call(result, resolve, reject); }
        catch (error) { reject(error); }
      });
      // Rejection still reaches an awaiter, while an accidentally ignored
      // public task cannot itself create an unhandled-rejection side channel.
      task.catch(() => {});
      // Backend's durable client writes the exact outbox draft synchronously
      // before its first await. Claim transport likewise persists its immutable
      // intent first. Refuse callbacks that cross an async boundary without it.
      try {
        if (requiredSlot === 'outbox' && outbox.read() === null) {
          invalidMutation('ACCOUNT_MUTATION_DRAFT_REQUIRED');
        }
        if (requiredSlot === 'claim' && claim.read() === null) {
          invalidMutation('ACCOUNT_CLAIM_INTENT_REQUIRED');
        }
      } catch (error) {
        state.tasks.delete(slot);
        state.beginDrain('invalid-mutation', false);
        state.maybeFinishDrain();
        throw error;
      }
      state.tasks.delete(slot);
      state.tasks.add(task);
      const cleanup = () => {
        state.tasks.delete(task);
        if (study && !state.closed) state.observeIntent(intentKey);
        state.maybeFinishDrain();
      };
      // Do not create an ignored rejecting child with finally(). The caller
      // receives the original task and remains responsible for its outcome.
      task.then(cleanup, cleanup);
      return task;
    }

    let lease;
    lease = Object.freeze({
      accountBinding, namespace, keys, lockName, intentKey, leaseId, limits, kind,
      executionGuard: writerGuard, outbox, cache, claim,
      recovery: Object.freeze({ read: () => guarded(() => codec.outbox(read(keys.outbox))) }),
      isCurrent() {
        try { assertPresentationAuthority(); return true; }
        catch { return false; }
      },
      isDraining() { return state.draining && !state.closed; },
      invalidationSinkFailed() { return state.invalidationSinkFailed; },
      runMutation(work) { return trackMutation(work, 'outbox'); },
      release() {
        if (!state.closed) state.beginDrain('study-released', false);
        return released.promise;
      },
      released: released.promise,
    });
    mutationRunners.set(lease, trackMutation);

    function finished() {
      if (!state.closed) state.close(study ? 'STUDY_LEASE_LOST' : 'ACCOUNT_LEASE_LOST');
      released.resolve();
    }

    // Register the native request before signaling takeover. Claims hold the
    // historical writer lock before fail-fast acquisition of account-command.
    // Short commands queue on their private outer lock and then acquire only
    // account-command, so no writer acquires claim locks in the opposite order.
    let request;
    try {
      const requestOptions = study
        ? { mode: 'exclusive', signal: aborter.signal }
        : accountCommand
          ? { mode: 'exclusive', signal: aborter.signal }
          : { mode: 'exclusive', ifAvailable: true };
      const failedOpen = (code) => Object.freeze({ failedOpen: code });
      request = lockRequest.call(locks, requestLockName, requestOptions, async (lock) => {
        await armed.promise;
        if (state.closed || !checkBound(accountBinding, ticket)) {
          return failedOpen('ACCOUNT_CHANGED');
        }
        if (lock === null) {
          return failedOpen(study ? 'ACCOUNT_LOCKS_UNAVAILABLE' : 'ACCOUNT_LEASE_BUSY');
        }
        if (!exactLock(lock, requestLockName)) {
          return failedOpen('ACCOUNT_LOCKS_UNAVAILABLE');
        }
        if (study && get(intentKey) !== intentMarker) {
          return failedOpen('STUDY_SUPERSEDED');
        }
        if (secondaryLockName) {
          const secondary = lockRequest.call(locks, secondaryLockName, {
            mode: 'exclusive',
            ifAvailable: true,
          }, async (secondaryLock) => {
            if (state.closed || !checkBound(accountBinding, ticket)) {
              return failedOpen('ACCOUNT_CHANGED');
            }
            if (secondaryLock === null) return failedOpen('ACCOUNT_LEASE_BUSY');
            if (!exactLock(secondaryLock, secondaryLockName)) {
              return failedOpen('ACCOUNT_LOCKS_UNAVAILABLE');
            }
            if (accountCommandWaitTimer !== null) {
              clearTimeout(accountCommandWaitTimer);
              accountCommandWaitTimer = null;
            }
            state.active = true;
            opened.resolve(lease);
            return held.promise;
          });
          if (!secondary || typeof secondary.then !== 'function') {
            fail('ACCOUNT_LOCKS_UNAVAILABLE');
          }
          return secondary;
        }
        state.active = true;
        opened.resolve(lease);
        return held.promise;
      });
      if (!request || typeof request.then !== 'function') fail('ACCOUNT_LOCKS_UNAVAILABLE');
      request.then((outcome) => {
        if (!state.closed && outcome?.failedOpen) state.close(outcome.failedOpen);
        finished();
      }, () => {
        if (!state.closed) state.close(checkBound(accountBinding, ticket) ? 'ACCOUNT_LOCKS_UNAVAILABLE' : 'ACCOUNT_CHANGED');
        finished();
      });
      if (state.closed) {
        armed.resolve();
        return opened.promise;
      }
      if (accountCommand) {
        accountCommandWaitTimer = setTimeout(() => {
          if (!state.active && !state.closed) state.close('ACCOUNT_LEASE_BUSY');
        }, accountCommandWaitMs);
      }
    } catch {
      armed.resolve();
      state.close('ACCOUNT_LOCKS_UNAVAILABLE');
      finished();
      return opened.promise;
    }
    try {
      if (study) {
        // This marker only selects the latest accepted contender. It grants no
        // storage or identity authority and is rechecked after native grant.
        set(intentKey, intentMarker);
        notifyStudyIntent(intentKey, intentMarker);
      }
      armed.resolve();
    } catch (error) {
      armed.resolve();
      state.close(error?.code ?? 'ACCOUNT_STORAGE_UNAVAILABLE');
      throw error;
    }
    return opened.promise;
  }

  function acquireStudy({ accountBinding, ticket, onSuperseded } = {}) {
    return acquireWriter({ accountBinding, ticket, onSuperseded, kind: 'study' });
  }

  async function runExclusiveMutation({ accountBinding, ticket, purpose } = {}, operation = {}) {
    if (purpose !== 'account-command' && purpose !== 'claim') fail('INVALID_ACCOUNT_MUTATION_PURPOSE');
    if (!operation || typeof operation !== 'object' || Array.isArray(operation) ||
        Object.keys(operation).some((key) => key !== 'prepare' && key !== 'mutate') ||
        (operation.prepare !== undefined && typeof operation.prepare !== 'function') ||
        typeof operation.mutate !== 'function') fail('INVALID_ACCOUNT_MUTATION');
    const lease = await acquireWriter({
      accountBinding,
      ticket,
      kind: purpose === 'account-command' ? 'account-command' : 'claim',
    });
    try {
      const runner = mutationRunners.get(lease);
      if (!runner) fail('ACCOUNT_LEASE_LOST');
      const access = Object.freeze({
        accountBinding: lease.accountBinding,
        executionGuard: lease.executionGuard,
        outbox: lease.outbox,
        claim: lease.claim,
        recovery: lease.recovery,
      });
      // Preparation may construct and load Backend's fresh durable client, but
      // storage writes remain disabled until the tracked mutate callback.
      const prepared = operation.prepare ? await operation.prepare(access) : undefined;
      if (!lease.isCurrent()) fail('ACCOUNT_LEASE_LOST');
      return await runner(() => operation.mutate(access, prepared),
        purpose === 'claim' ? 'claim' : 'outbox');
    } finally {
      mutationRunners.delete(lease);
      await lease.release();
    }
  }

  function deletePrincipalBrowserData({ accountBinding, ticket, receipt } = {}) {
    if (!checkBound(accountBinding, ticket)) fail('ACCOUNT_CHANGED');
    if (receipt?.operation !== 'delete_my_data' || typeof receipt?.replayed !== 'boolean' ||
        typeof receipt?.idempotency_key !== 'string' || !receipt.idempotency_key) {
      fail('ACCOUNT_DELETION_RECEIPT_REQUIRED');
    }
    const namespace = `${prefix}:account:${encodeURIComponent(accountBinding)}`;
    let entries;
    try {
      const length = synchronous(storage.length);
      if (!Number.isSafeInteger(length) || length < 0 || typeof storage.key !== 'function' ||
          typeof storage.removeItem !== 'function') fail('ACCOUNT_STORAGE_UNAVAILABLE');
      entries = [];
      for (let index = 0; index < length; index += 1) {
        const key = synchronous(storage.key(index));
        if (typeof key === 'string' && key.startsWith(`${namespace}:`)) {
          entries.push([key, synchronous(storage.getItem(key))]);
        }
      }
      for (const [key] of entries) {
        synchronous(storage.removeItem(key));
        if (synchronous(storage.getItem(key)) !== null) fail('ACCOUNT_STORAGE_UNCONFIRMED');
      }
    } catch (error) {
      let restored = true;
      for (const [key, value] of entries ?? []) {
        if (value === null) continue;
        try {
          synchronous(storage.setItem(key, value));
          if (synchronous(storage.getItem(key)) !== value) restored = false;
        } catch { restored = false; }
      }
      if (!restored) {
        retireAccount('storage-rollback-failed');
        fail('ACCOUNT_STORAGE_ROLLBACK_FAILED');
      }
      if (error instanceof AccountStorageError) throw error;
      fail('ACCOUNT_STORAGE_UNAVAILABLE');
    }
    beginEpoch({ broadcast: true });
    return Object.freeze({ accountBinding, removedKeys: entries.length });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    retireAccount('disposed');
    events.removeEventListener('storage', receiveStorage);
    events.removeEventListener('pagehide', pagehide);
    try { channel?.close(); } catch { /* No data deletion. */ }
  }

  return Object.freeze({
    beginEpoch, bindPrincipal, browse, inspectRecoveries, acquireStudy, runExclusiveMutation,
    deletePrincipalBrowserData, executionGuard, dispose, limits,
  });
}
