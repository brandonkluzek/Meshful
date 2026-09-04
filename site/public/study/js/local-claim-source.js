import { LEARNER_STORAGE_KEY } from "./browser-workspace.js";

// Explicit snapshot copying only. The normal learner key is never modified.
// A separate native lock pins this browser source to its first confirmed
// destination, including across different account-writer locks/tabs.
export function createLocalClaimSource({ siteId, storage, locks, catalogRef,
  makeId = () => crypto.randomUUID(), digest = async (raw) => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
  } } = {}) {
  const key = `meshful:local-claim:v1:${encodeURIComponent(siteId)}`;
  function fail(message) { throw new Error(message); }
  function read() {
    const raw = storage.getItem(LEARNER_STORAGE_KEY);
    if (typeof raw !== "string" || !raw) fail("There is no saved browser workspace to copy.");
    let state;
    try { state = JSON.parse(raw); }
    catch { fail("This browser’s study data could not be read."); }
    const hasDecks = state?.personalDecks && Object.keys(state.personalDecks).length > 0;
    const hasSessions = state?.sessions && Object.keys(state.sessions).length > 0;
    const hasProgress = Array.isArray(state?.activity) && state.activity.length > 0;
    if (!hasDecks && !hasSessions && !hasProgress) {
      fail("This browser has no decks or progress to add.");
    }
    return raw;
  }
  return Object.freeze({
    inspect: () => ({ rawStateJson: read(), catalogRef: structuredClone(catalogRef) }),
    async prepare({ rawStateJson, accountBinding, check }) {
      check();
      if (!locks || typeof locks.request !== "function") fail("Exclusive access to the local source is unavailable. Nothing was imported.");
      return locks.request(`${key}:source`, { mode: "exclusive", ifAvailable: true }, async (lock) => {
        check();
        if (!lock || lock.name !== `${key}:source` || lock.mode !== "exclusive") fail("Another tab is handling this local source.");
        if (read() !== rawStateJson) fail("Browser data changed after confirmation. Review it again before copying.");
        const fingerprint = await digest(rawStateJson);
        check();
        if (read() !== rawStateJson) fail("Browser data changed after confirmation. Review it again before copying.");
        const previous = storage.getItem(key);
        const record = previous === null ? { version: 1, accountBinding, sourceId: `browser:${makeId()}`, fingerprint,
          catalogRef: structuredClone(catalogRef) } : JSON.parse(previous);
        if (record.version !== 1 || record.accountBinding !== accountBinding || record.fingerprint !== fingerprint ||
            typeof record.sourceId !== "string" || JSON.stringify(record.catalogRef) !== JSON.stringify(catalogRef)) {
          fail("This browser source is already reserved for another import. Its data and original destination were preserved.");
        }
        if (previous === null) storage.setItem(key, JSON.stringify(record));
        check();
        if (storage.getItem(key) !== JSON.stringify(record)) fail("The original import destination could not be saved. Nothing was sent.");
        return { sourceId: record.sourceId, rawStateJson, catalogRef: structuredClone(catalogRef) };
      });
    },
  });
}
