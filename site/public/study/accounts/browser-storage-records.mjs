// Browser-only storage envelopes. No provider, network, scheduler or auth code.
export class AccountStorageError extends Error {
  constructor(code) {
    super(code.replaceAll('_', ' ').toLowerCase());
    this.name = 'AccountStorageError';
    this.code = code;
  }
}

export function fail(code) { throw new AccountStorageError(code); }

export const DEFAULT_STORAGE_LIMITS = Object.freeze({
  // A ceiling is not a browser quota guarantee. Large writes may still fail.
  draftBytes: 5 * 1024 * 1024,
  outboxBytes: 32 * 1024 * 1024,
  cacheBytes: 1_000_000,
  claimBytes: 4_500_000,
  jsonNodes: 100_000,
  jsonDepth: 64,
});

export function storageLimits(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !Object.hasOwn(DEFAULT_STORAGE_LIMITS, key))) {
    fail('INVALID_STORAGE_CONFIGURATION');
  }
  const limits = { ...DEFAULT_STORAGE_LIMITS, ...options };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_STORAGE_CONFIGURATION');
  }
  if (limits.jsonDepth > 128) fail('INVALID_STORAGE_CONFIGURATION');
  return Object.freeze(limits);
}

export function opaqueId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 ||
      /[\x00-\x20\x7f]/.test(value)) fail('INVALID_ACCOUNT_BINDING');
  try { encodeURIComponent(value); } catch { fail('INVALID_ACCOUNT_BINDING'); }
  return value;
}

export function createRecordCodec(limits, accountBinding) {
  const encoder = new TextEncoder();
  function bounded(raw, bytes) {
    if (typeof raw !== 'string') fail('ACCOUNT_STORAGE_CORRUPT');
    if (encoder.encode(raw).byteLength > bytes) fail('ACCOUNT_STORAGE_LIMIT');
    return raw;
  }
  function encode(input, bytes) {
    let nodes = 0;
    const active = new Set();
    function visit(value, depth) {
      if (++nodes > limits.jsonNodes || depth > limits.jsonDepth) fail('ACCOUNT_STORAGE_LIMIT');
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (!value || typeof value !== 'object' || active.has(value)) fail('INVALID_STORAGE_RECORD');
      if (Object.getOwnPropertySymbols(value).length) fail('INVALID_STORAGE_RECORD');
      const array = Array.isArray(value);
      const proto = Object.getPrototypeOf(value);
      if (!array && proto !== Object.prototype && proto !== null) fail('INVALID_STORAGE_RECORD');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors).filter((key) => !(array && key === 'length'));
      if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) {
        fail('INVALID_STORAGE_RECORD');
      }
      active.add(value);
      const result = array ? [] : Object.create(null);
      for (const key of keys.sort()) {
        const descriptor = descriptors[key];
        if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('INVALID_STORAGE_RECORD');
        result[key] = visit(descriptor.value, depth + 1);
      }
      active.delete(value);
      return result;
    }
    return bounded(JSON.stringify(visit(input, 0)), bytes);
  }
  function parse(raw, bytes) {
    bounded(raw, bytes);
    let value;
    try { value = JSON.parse(raw); } catch { fail('ACCOUNT_STORAGE_CORRUPT'); }
    encode(value, bytes);
    return value;
  }
  function keys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== expected.length ||
        expected.some((key) => !Object.hasOwn(value, key))) fail('ACCOUNT_STORAGE_CORRUPT');
  }
  function binding(value) {
    if (value !== accountBinding) fail('ACCOUNT_RECORD_MISMATCH');
  }
  function text(value) {
    // Transport/business schemas belong to Backend. Preserve exact request IDs.
    if (typeof value !== 'string' || value.length === 0) fail('ACCOUNT_STORAGE_CORRUPT');
  }
  function draft(raw) {
    const value = parse(raw, limits.draftBytes);
    keys(value, ['accountBinding', 'command']);
    binding(value.accountBinding);
    keys(value.command, ['request_id', 'expected_revision', 'operation', 'args']);
    text(value.command.request_id);
    text(value.command.operation);
    if (!Number.isSafeInteger(value.command.expected_revision) || value.command.expected_revision < 0 ||
        !value.command.args || typeof value.command.args !== 'object' || Array.isArray(value.command.args)) {
      fail('ACCOUNT_STORAGE_CORRUPT');
    }
    return value;
  }
  function intent(raw) {
    const value = draft(raw);
    delete value.command.expected_revision;
    return encode(value, limits.draftBytes);
  }
  const empty = () => ({ version: 1, accountBinding, pending: null, original: null, previous: null, settled: null });
  function outbox(raw) {
    if (raw === null) return empty();
    const value = parse(raw, limits.outboxBytes);
    keys(value, ['version', 'accountBinding', 'pending', 'original', 'previous', 'settled']);
    binding(value.accountBinding);
    if (value.version !== 1) fail('ACCOUNT_STORAGE_CORRUPT');
    function history(record) {
      if (record.pending === null || record.original === null || intent(record.pending) !== intent(record.original) ||
          (record.previous !== null && intent(record.previous) !== intent(record.pending))) fail('ACCOUNT_STORAGE_CORRUPT');
    }
    if (value.pending !== null) history(value);
    else if (value.original !== null || value.previous !== null) fail('ACCOUNT_STORAGE_CORRUPT');
    if (value.settled !== null) {
      keys(value.settled, ['pending', 'original', 'previous', 'leaseId']);
      opaqueId(value.settled.leaseId);
      history(value.settled);
    }
    return value;
  }
  function active(value, leaseId) {
    return value.pending !== null ? value : value.settled?.leaseId !== leaseId ? value.settled : null;
  }
  function nextOutbox(raw, record, leaseId) {
    const value = outbox(raw);
    const pending = active(value, leaseId);
    if (record === null) {
      if (!pending) return raw;
      return encode({ ...empty(), settled: {
        pending: pending.pending, original: pending.original, previous: pending.previous, leaseId,
      } }, limits.outboxBytes);
    }
    const next = encode(record, limits.draftBytes);
    draft(next);
    if (pending && intent(pending.pending) !== intent(next)) fail('ACCOUNT_OUTBOX_CONFLICT');
    if (value.pending === next) return raw;
    return encode({ ...empty(), pending: next, original: pending?.original ?? next,
      previous: pending && pending.pending !== next ? pending.pending : pending?.previous ?? null,
    }, limits.outboxBytes);
  }
  function snapshot(raw) {
    const value = parse(raw, limits.cacheBytes);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ACCOUNT_STORAGE_CORRUPT');
    binding(value.account_binding);
    if (!Number.isSafeInteger(value.durable_revision) || value.durable_revision < 0) fail('ACCOUNT_STORAGE_CORRUPT');
    return value;
  }
  function claim(raw) {
    const value = parse(raw, limits.claimBytes);
    keys(value, ['accountBinding', 'request']);
    binding(value.accountBinding);
    keys(value.request, ['request_id', 'expected_revision', 'source_id', 'catalog_ref', 'raw_state_json']);
    text(value.request.request_id);
    text(value.request.source_id);
    if (!Number.isSafeInteger(value.request.expected_revision) || value.request.expected_revision < 0 ||
        typeof value.request.raw_state_json !== 'string') fail('ACCOUNT_STORAGE_CORRUPT');
    return value;
  }
  return Object.freeze({ encode, draft, intent, outbox, active, nextOutbox, snapshot, claim });
}
