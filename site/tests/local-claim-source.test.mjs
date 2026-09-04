import test from "node:test";
import assert from "node:assert/strict";
import { LEARNER_STORAGE_KEY } from "../public/study/js/browser-workspace.js";
import { createLocalClaimSource } from "../public/study/js/local-claim-source.js";

function storageWith(raw = null) {
  const values = new Map(raw === null ? [] : [[LEARNER_STORAGE_KEY, raw]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("the account prompt requires meaningful guest study data", () => {
  const empty = storageWith(JSON.stringify({ personalDecks: {}, sessions: {}, activity: [] }));
  const emptySource = createLocalClaimSource({ siteId: "meshful", storage: empty, catalogRef: { version: "test", digest: "sha256:test" } });
  assert.throws(() => emptySource.inspect(), /no decks or progress to add/);

  const guest = storageWith(JSON.stringify({ personalDecks: { "deck-1": { id: "deck-1" } }, sessions: {}, activity: [] }));
  const guestSource = createLocalClaimSource({ siteId: "meshful", storage: guest, catalogRef: { version: "test", digest: "sha256:test" } });
  assert.equal(guestSource.inspect().rawStateJson, guest.getItem(LEARNER_STORAGE_KEY));
});
