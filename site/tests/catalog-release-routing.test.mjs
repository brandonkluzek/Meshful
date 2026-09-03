import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createCanonicalEngine } from "../integration/backend/v5/src/canonical-engine.mjs";
import { createMemoryStorage, createStudyStore } from "../integration/core/js/store.js";
import { WEBMCP_TOOL_SCHEMAS } from "../integration/core/js/webmcp.js";
import {
  BACKEND_EXPECTED_CATALOG_PINS,
  LIBRARY_EXPECTED_PINS,
  LIBRARY_RELEASE,
  LIBRARY_RESOLUTION_BUDGET,
  PREVIOUS_LIBRARY_RELEASE,
  RETAINED_LIBRARY_EXPECTED_PINS,
  RETAINED_LIBRARY_RELEASE,
  createReviewedLibraryResolver,
} from "../integration/library-runtime.mjs";

const runtimeRoot = new URL(`../public/study/data/library-runtime/${LIBRARY_RELEASE}/`, import.meta.url);
const previousRoot = new URL(`../public/study/data/library-runtime/${PREVIOUS_LIBRARY_RELEASE}/`, import.meta.url);
const retainedRoot = new URL(`../public/study/data/library-runtime/${RETAINED_LIBRARY_RELEASE}/`, import.meta.url);
const releaseRoots = new Map([
  [LIBRARY_RELEASE, runtimeRoot],
  [PREVIOUS_LIBRARY_RELEASE, previousRoot],
  [RETAINED_LIBRARY_RELEASE, retainedRoot],
]);

function libraryAssets() {
  return { async fetch(request) {
    const pathname = new URL(request.url).pathname;
    for (const [version, root] of releaseRoots) {
      const marker = `/library-runtime/${version}/`;
      if (!pathname.includes(marker)) continue;
      const key = pathname.slice(pathname.indexOf(marker) + marker.length);
      try {
        const bytes = await readFile(new URL(key, root));
        return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
      } catch {
        return new Response("", { status: 404 });
      }
    }
    return new Response("", { status: 404 });
  } };
}

test("an actual retained-v1 account installs from the current public release without replacing its saved v1 deck", async () => {
  const resolver = await createReviewedLibraryResolver(libraryAssets());
  const oldResolved = await resolver.resolveTransaction({
    constructorCatalogRef: RETAINED_LIBRARY_EXPECTED_PINS.constructorRef,
    stateJson: null,
    intent: { kind: "command", operation: "add_library_deck", args: {
      library_deck_id: "academic-reviewed-v1:linear-algebra-i",
      expected_catalog_version: RETAINED_LIBRARY_RELEASE,
    } },
  });
  const oldStorage = createMemoryStorage();
  const oldStore = createStudyStore({
    catalog: oldResolved.storeCatalogView,
    retainedCatalogs: oldResolved.retainedCatalogViews,
    storage: oldStorage,
    clock: () => new Date("2026-09-02T16:00:00.000Z"),
  });
  oldStore.addLibraryDeck({
    library_deck_id: "academic-reviewed-v1:linear-algebra-i",
    expected_catalog_version: RETAINED_LIBRARY_RELEASE,
    client_action_id: "retained:add-linear-algebra",
  });
  const oldStateJson = Object.values(oldStorage.dump())[0];
  const oldState = JSON.parse(oldStateJson);
  const oldDeckId = Object.keys(oldState.personalDecks)[0];
  const oldDeckBytes = JSON.stringify(oldState.personalDecks[oldDeckId]);

  const engine = await createCanonicalEngine({
    createStudyStore,
    createMemoryStorage,
    toolSchemas: WEBMCP_TOOL_SCHEMAS,
    catalogResolver: resolver,
    expectedCatalogPins: BACKEND_EXPECTED_CATALOG_PINS,
    expectedResolutionBudget: LIBRARY_RESOLUTION_BUDGET,
  });
  await assert.rejects(engine.query({
    revision: 1,
    stateJson: '{"bad":true}',
    catalogRef: RETAINED_LIBRARY_EXPECTED_PINS.constructorRef,
  }, {
    operation: "search_library",
    args: { query: "Algorithms", limit: 10 },
    now: "2026-09-02T16:04:00.000Z",
  }), (error) => error?.code === "UNSUPPORTED_SCHEMA_VERSION",
  "Library reads must never blank or bypass an incompatible saved state");
  const transition = await engine.transition({
    revision: 1,
    stateJson: oldStateJson,
    catalogRef: RETAINED_LIBRARY_EXPECTED_PINS.constructorRef,
  }, {
    operation: "add_library_deck",
    args: {
      library_deck_id: "academic-reviewed-v1:algorithms-i",
      expected_catalog_version: LIBRARY_RELEASE,
      client_action_id: "promote:add-algorithms",
    },
    requestId: "promote:add-algorithms",
    now: "2026-09-02T16:05:00.000Z",
  });

  assert.deepEqual(transition.catalogRef, LIBRARY_EXPECTED_PINS.constructorRef);
  const promoted = JSON.parse(transition.stateJson);
  assert.equal(JSON.stringify(promoted.personalDecks[oldDeckId]), oldDeckBytes,
    "the retained v1 sparse deck and its learner fields remain byte-equivalent");
  assert.equal(Object.values(promoted.personalDecks).some((deck) =>
    (deck.deckFields ?? deck).title === "Algorithms I"), true);
});
