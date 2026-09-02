import { LEARNER_STORAGE_KEY } from "./browser-workspace.js";
import { createStudyStore } from "./store.js";

// Reuse the canonical sparse-content hydration, not its mutation API. No local
// state is read/written. Any migration requiring a write belongs on the server.
export function createAccountSnapshotHydrator(resolveCatalog) {
  return async (data) => {
    const catalog = await resolveCatalog(data.catalog_ref, { empty: data.state_json === null && data.durable_revision === 0 });
    if (!catalog) throw new Error("The exact account catalog release is unavailable.");
    const raw = data.state_json;
    if (!(raw === null || typeof raw === "string")) throw new Error("Invalid account snapshot.");
    const reader = createStudyStore({ catalog, storage: {
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
