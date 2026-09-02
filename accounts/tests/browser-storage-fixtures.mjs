// Synthetic browser primitives: no timers, polling, network, or filesystem I/O.
export function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function createBrowserHarness({ origin = 'https://meshful.test', initialBytes = {} } = {}) {
  const defaultOrigin = new URL(origin).origin;
  const initial = initialBytes instanceof Map ? initialBytes : Object.entries(initialBytes);
  const bytes = new Map([...initial].map(([key, value]) => [String(key), String(value)]));
  const stores = new Map([[defaultOrigin, bytes]]);
  const tabs = [];
  const holders = new Map();
  const events = [];
  const storageStats = { operations: [], events: [] };
  const lockStats = { requests: [], grants: 0, busy: 0, releases: 0, rejections: 0 };
  Object.defineProperty(lockStats, 'active', { enumerable: true, get: () => (
    [...holders.values()].map(({ tabId, origin: siteOrigin, name }) => ({ tabId, origin: siteOrigin, name }))
  ) });
  function storageOperation(tab, operation, details, work) {
    const record = { tabId: tab.id, origin: tab.origin, operation, ...details,
      heldLocks: [...holders.values()]
        .filter((held) => held.tabId === tab.id && held.origin === tab.origin)
        .map((held) => held.name),
    };
    storageStats.operations.push(record);
    try {
      const value = work(record);
      record.outcome ??= 'ok';
      return value;
    } catch (error) {
      record.outcome = 'threw'; record.errorName = error?.name;
      throw error;
    }
  }
  function enqueueStorageEvent(writer, key, oldValue, newValue) {
    for (const receiver of tabs) {
      if (receiver === writer || receiver.origin !== writer.origin) continue;
      const event = new Event('storage');
      for (const [field, value] of Object.entries({ key, oldValue, newValue,
        url: writer.window.location.href, storageArea: receiver.storage,
      })) Object.defineProperty(event, field, { value, enumerable: true });
      events.push({ writer, receiver, event });
    }
  }
  function createTab({ origin: tabOrigin = defaultOrigin, url } = {}) {
    const location = new URL(url ?? (new URL(tabOrigin).origin + '/study'));
    const tab = { id: 'tab-' + (tabs.length + 1), origin: location.origin,
      window: new EventTarget(), navigator: {}, faults: {}, locksSupported: true,
    };
    if (!stores.has(tab.origin)) stores.set(tab.origin, new Map());
    const stored = stores.get(tab.origin);
    const queuedFaults = new Map();
    const pendingReadback = new Set();
    tab.failNext = (operation, failure) => {
      const queue = queuedFaults.get(operation) ?? [];
      queue.push(failure); queuedFaults.set(operation, queue);
    };
    function fault(operation, details = {}) {
      const queue = queuedFaults.get(operation);
      const failure = queue?.length ? queue.shift() : tab.faults[operation];
      if (failure === undefined || failure === null) return undefined;
      if (typeof failure === 'function') return failure({ tabId: tab.id, ...details });
      if (failure instanceof Error || failure instanceof DOMException) throw failure;
      throw new TypeError('Fault ' + operation + ' must be an Error or function.');
    }
    function readOverride(value, fallback) {
      if (value === undefined) return fallback;
      if (value === null || typeof value === 'string') return value;
      throw new TypeError('Storage read fault overrides must be string or null.');
    }
    tab.storage = Object.freeze({
      get length() { return stored.size; },
      key(index) { return [...stored.keys()][Number(index)] ?? null; },
      getItem(rawKey) {
        const key = String(rawKey);
        return storageOperation(tab, 'read', { key }, () => {
          const storedValue = stored.get(key) ?? null;
          const value = readOverride(fault('read', { key, storedValue }), storedValue);
          if (!pendingReadback.delete(key)) return value;
          return readOverride(fault('readback', { key, storedValue: value }), value);
        });
      },
      setItem(rawKey, rawValue) {
        const key = String(rawKey);
        const value = String(rawValue);
        return storageOperation(tab, 'write', { key, value }, (record) => {
          const oldValue = stored.get(key) ?? null;
          const result = fault('write', { key, value, oldValue });
          pendingReadback.add(key);
          if (result === false) { record.outcome = 'dropped'; return; }
          if (result !== undefined) throw new TypeError('Write fault must return false or undefined.');
          stored.set(key, value);
          if (oldValue !== value) enqueueStorageEvent(tab, key, oldValue, value);
        });
      },
      removeItem(rawKey) {
        const key = String(rawKey);
        return storageOperation(tab, 'remove', { key }, (record) => {
          const oldValue = stored.get(key) ?? null;
          const result = fault('remove', { key, oldValue });
          pendingReadback.add(key);
          if (result === false) { record.outcome = 'dropped'; return; }
          if (result !== undefined) throw new TypeError('Remove fault must return false or undefined.');
          stored.delete(key);
          if (oldValue !== null) enqueueStorageEvent(tab, key, oldValue, null);
        });
      },
    });
    tab.window.location = location;
    tab.window.navigator = tab.navigator;
    Object.defineProperty(tab.window, 'localStorage', { get: () => (
      storageOperation(tab, 'getStorage', {}, () => { fault('getStorage'); return tab.storage; })
    ) });
    tab.getStorage = () => tab.window.localStorage;
    tab.locks = Object.freeze({
      async request(rawName, options, callback) {
        const name = String(rawName);
        const record = { tabId: tab.id, origin: tab.origin, name, options: { ...options } };
        lockStats.requests.push(record);
        try {
          if (!tab.locksSupported || fault('lockRequest', { name, options }) === false) {
            throw new DOMException('Synthetic Web Locks unavailable.', 'NotSupportedError');
          }
          if (typeof callback !== 'function') throw new TypeError('A lock callback is required.');
          if (!options || options.ifAvailable !== true ||
              (options.mode !== undefined && options.mode !== 'exclusive') ||
              options.steal === true || Object.hasOwn(options, 'signal')) {
            throw new DOMException('Fixture supports only exclusive ifAvailable locks.', 'NotSupportedError');
          }
        } catch (error) {
          record.acquisition = 'rejected'; record.errorName = error?.name;
          lockStats.rejections += 1; throw error;
        }
        await Promise.resolve();
        const key = JSON.stringify([tab.origin, name]);
        if (holders.has(key)) {
          record.acquisition = 'busy'; lockStats.busy += 1;
          return await callback(null);
        }
        holders.set(key, { tabId: tab.id, origin: tab.origin, name });
        record.acquisition = 'granted'; lockStats.grants += 1;
        try { return await callback(Object.freeze({ name, mode: 'exclusive' })); }
        finally { holders.delete(key); record.released = true; lockStats.releases += 1; }
      },
    });
    Object.defineProperty(tab.navigator, 'locks', { get: () => tab.locksSupported ? tab.locks : undefined });
    tabs.push(tab);
    return tab;
  }
  const harness = { tabs, createTab, bytes, lockStats, storageStats,
    get pendingEvents() { return events.length; },
    flushEvents() {
      const batch = events.splice(0);
      for (const { writer, receiver, event } of batch) {
        storageStats.events.push({ writerId: writer.id, receiverId: receiver.id,
          key: event.key, oldValue: event.oldValue, newValue: event.newValue,
        });
        receiver.window.dispatchEvent(event);
      }
      return batch.length;
    },
  };
  createTab(); createTab();
  return harness;
}
