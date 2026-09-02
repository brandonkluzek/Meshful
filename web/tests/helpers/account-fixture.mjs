import { createMemoryStorage, createStudyStore } from "../../js/store.js";
import { CATALOG } from "../../data/catalog.js";
import { createAccountSnapshotHydrator } from "../../js/account-snapshot.js";

export const KEY = "adaptive-study-lab:web-state:v1";
export const REF = { version: "disposable-fixture-v1", digest: "sha256:" + "a".repeat(64) };
export const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// Unit double for lifecycle ordering only, not evidence for native Web Locks.
// The separate disposable composition check runs the delivered Accounts helper.
export function controllerDouble({ onInvalidate }) {
  let epoch = 0, binding = null, live = true;
  const tickets = new WeakSet();
  const capture = () => { const ticket = Object.freeze({ epoch, principalId: binding }); tickets.add(ticket); return ticket; };
  const isCurrent = (ticket) => live && tickets.has(ticket) && ticket.epoch === epoch && ticket.principalId === binding;
  const records = new Map();
  function beginEpoch() { epoch++; binding = null; live = true; onInvalidate(); return capture(); }
  return {
    beginEpoch,
    bindPrincipal(next, ticket) { if (!isCurrent(ticket)) throw new Error("stale discovery"); binding = next; epoch++; return capture(); },
    executionGuard: { capture, isCurrent },
    async acquire({ accountBinding, ticket }) {
      let held = true;
      const check = () => { if (!held || !isCurrent(ticket) || binding !== accountBinding) throw new Error("retired lease"); };
      const slot = (name) => ({
        read() { check(); return structuredClone(records.get(`${accountBinding}:${name}`) ?? null); },
        write(value) { check(); records.set(`${accountBinding}:${name}`, structuredClone(value)); },
      });
      return { accountBinding, outbox: slot("outbox"), cache: slot("cache"), claim: slot("claim"), recovery: slot("outbox"),
        isCurrent: () => held && isCurrent(ticket),
        executionGuard: { capture: () => { check(); return capture(); }, isCurrent: (value) => held && isCurrent(ticket) && isCurrent(value) },
        async release() { held = false; if (isCurrent(ticket)) beginEpoch(); },
      };
    },
    dispose() { live = false; epoch++; onInvalidate(); },
  };
}

export function accountFixture() {
  let principal = "account-a";
  const clients = [];
  const states = new Map();
  const calls = [];
  let loadHook = null, mutationHook = null;
  const server = (binding) => {
    if (!states.has(binding)) {
      const storage = createMemoryStorage();
      states.set(binding, { storage, store: createStudyStore({ catalog: CATALOG, storage }) });
    }
    return states.get(binding);
  };
  const snapshot = (binding = principal) => {
    const raw = server(binding).storage.getItem(KEY);
    return { account_binding: binding, durable_revision: raw ? JSON.parse(raw).revision : 0,
      state_json: raw, state: raw ? JSON.parse(raw) : null, catalog_ref: REF };
  };
  const options = {
    storageOptions: { siteId: "disposable-test" },
    createStorageController: controllerDouble,
    hydrateSnapshot: createAccountSnapshotHydrator(() => CATALOG),
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, data: snapshot() })),
    createDurableClient(config) {
      const binding = principal;
      const client = { config, binding, getPending: () => null,
        async load() { if (loadHook) return loadHook(binding); return snapshot(); },
        async retryPending() { throw new Error("No pending command"); },
      };
      for (const method of ["getLearningOverview", "searchLibrary", "searchMyDecks", "getDeck", "validateDeck", "getStudySession", "ingestDeck", "updateDeck", "addCards", "updateCards", "startStudySession", "submitGrade", "finishStudySession", "addLibraryDeck"]) {
        client[method] = async (...args) => {
          calls.push({ binding, method, args });
          if (mutationHook) await mutationHook(method, binding);
          return server(binding).store[method](...args);
        };
      }
      clients.push(client);
      return client;
    },
  };
  return { options, clients, calls, server, snapshot,
    setPrincipal(value) { principal = value; },
    setLoadHook(value) { loadHook = value; },
    setMutationHook(value) { mutationHook = value; },
  };
}
