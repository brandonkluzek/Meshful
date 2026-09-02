import { createMemoryStorage } from "./store.js";

export const LEARNER_STORAGE_KEY = "adaptive-study-lab:web-state:v1";

// Recording is the same product with explicitly isolated, device-local data.
// It never reads/imports the normal workspace and never silently falls back to
// memory when persistent storage is denied or full.
export function createBrowserWorkspace(search, getStorage = () => globalThis.localStorage) {
  const params = new URLSearchParams(search);
  const recordingId = params.get("recording");
  if (params.has("recording") && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(recordingId ?? "")) {
    throw new Error("Use a recording name of 1–64 lowercase letters, numbers, underscores or hyphens.");
  }
  if (recordingId && params.has("demo")) {
    throw new Error("A persistent recording workspace cannot be combined with an example preview.");
  }
  const ephemeral = params.get("demo") === "empty";
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
  return {
    storage,
    recordingId,
    ephemeral,
    seedExamples: !ephemeral && !recordingId,
    label: recordingId ? `Recording: ${recordingId}` : ephemeral ? "Temporary example" : "Study data",
    savedData: () => storage.getItem(LEARNER_STORAGE_KEY),
    reset: () => storage.removeItem(LEARNER_STORAGE_KEY),
  };
}
