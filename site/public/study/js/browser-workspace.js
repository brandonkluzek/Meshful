import { createMemoryStorage } from "./store.js";

export const LEARNER_STORAGE_KEY = "adaptive-study-lab:web-state:v1";
export const GRAPH_PIN_STORAGE_KEY = "adaptive-study.graph-pins.web-v1";

// Recording is the same product with explicitly isolated, device-local data.
// It never reads/imports the normal workspace and never silently falls back to
// memory when persistent storage is denied or full.
export function createBrowserWorkspace(search, getStorage = () => globalThis.localStorage) {
  const params = new URLSearchParams(search);
  const recordingId = params.get("recording");
  const showcase = params.get("demo") === "showcase";
  if (params.has("recording") && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(recordingId ?? "")) {
    throw new Error("Use a recording name of 1–64 lowercase letters, numbers, underscores or hyphens.");
  }
  if (recordingId && params.has("demo")) {
    throw new Error("A persistent recording workspace cannot be combined with an example preview.");
  }
  const ephemeral = params.get("demo") === "empty" || showcase;
  const backing = ephemeral ? createMemoryStorage() : getStorage();
  if (!backing || typeof backing.getItem !== "function" || typeof backing.setItem !== "function" || typeof backing.removeItem !== "function") {
    throw new Error("Browser storage is unavailable. Allow storage, then retry; your saved data will not be replaced.");
  }
  const keyFor = (key) => recordingId ? `${key}:recording:${recordingId}` : key;
  const storage = {
    getItem: (key) => backing.getItem(keyFor(key)),
    setItem: (key, value) => backing.setItem(keyFor(key), value),
    removeItem: (key) => backing.removeItem(keyFor(key)),
  };
  const backingKeys = () => {
    const keys = [];
    if (Number.isSafeInteger(backing.length) && typeof backing.key === "function") {
      for (let index = 0; index < backing.length; index += 1) {
        const key = backing.key(index);
        if (typeof key === "string") keys.push(key);
      }
    }
    return keys;
  };
  const ownedKeys = () => {
    const suffix = recordingId ? `:recording:${recordingId}` : "";
    const learnerKey = keyFor(LEARNER_STORAGE_KEY);
    const graphPrefix = `${GRAPH_PIN_STORAGE_KEY}.`;
    const graphs = backingKeys().filter((key) => {
      if (!key.startsWith(graphPrefix)) return false;
      return recordingId ? key.endsWith(suffix) : !key.includes(":recording:");
    });
    return [...new Set([learnerKey, ...graphs])];
  };
  const deleteData = () => {
    if (ephemeral) return { deleted_keys: [], scope: "temporary" };
    const targets = ownedKeys();
    const before = new Map(targets.map((key) => [key, backing.getItem(key)]));
    const removed = [];
    try {
      for (const key of targets) {
        backing.removeItem(key);
        if (backing.getItem(key) !== null) throw new Error("Browser storage did not confirm deletion.");
        removed.push(key);
      }
    } catch (error) {
      try {
        for (const [key, value] of before) {
          if (value === null) backing.removeItem(key);
          else backing.setItem(key, value);
        }
      } catch {
        throw new Error("Browser data deletion was not confirmed and rollback could not be verified. Do not reload this page.");
      }
      throw error;
    }
    return { deleted_keys: removed, scope: recordingId ? "recording" : "browser-local" };
  };
  return {
    storage,
    recordingId,
    ephemeral,
    showcase,
    seedExamples: showcase,
    label: recordingId ? `Recording: ${recordingId}` : showcase ? "Demo data" : ephemeral ? "Temporary example" : "Study data",
    savedData: () => storage.getItem(LEARNER_STORAGE_KEY),
    deleteData,
    reset: deleteData,
  };
}
