import { LEARNER_STORAGE_KEY } from "./browser-workspace.js";
import { createStudyStore } from "./store.js";

// Reuse the canonical sparse-content hydration, not its mutation API. No local
// state is read/written. Any migration requiring a write belongs on the server.
export function createAccountSnapshotHydrator(resolveCatalog) {
  return async (data, { check = () => {} } = {}) => {
    const raw = data.state_json;
    if (!(raw === null || typeof raw === "string")) throw new Error("Invalid account snapshot.");
    check();
    const resolved = await resolveCatalog(data.catalog_ref, {
      empty: raw === null && data.durable_revision === 0,
      storedStateJson: raw,
      check,
    });
    check();
    const catalog = resolved?.catalog ?? resolved;
    const retainedCatalogs = resolved?.catalog ? resolved.retainedCatalogs ?? [] : [];
    if (!catalog || !Array.isArray(retainedCatalogs)) throw new Error("The exact account catalog release is unavailable.");
    const reader = createStudyStore({ catalog, retainedCatalogs, storage: {
      getItem: (key) => key === LEARNER_STORAGE_KEY ? raw : null,
      setItem: () => { throw new Error("This account needs a server-owned state migration; no local transition was applied."); },
      removeItem: () => { throw new Error("Account snapshots are read-only."); },
    } });
    // The capability is deliberately outside the serializable snapshot. Do
    // not return the reader/store: only these explicitly allowlisted, read-only
    // projections may be retained by the epoch-bound Website runtime.
    return Object.freeze({
      kind: "confirmed-account-read-model.v1",
      snapshot: reader.getSnapshot(),
      reads: Object.freeze({
        getStudyAvailability: (args) => reader.getStudyAvailability(args),
        getStudyActivity: (args) => reader.getStudyActivity(args),
      }),
    });
  };
}
