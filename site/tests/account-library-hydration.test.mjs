import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createReviewedLibraryResolver,
  LIBRARY_EXPECTED_PINS,
  LIBRARY_RELEASE,
  PREVIOUS_LIBRARY_RELEASE,
  RETAINED_LIBRARY_RELEASE,
} from "../integration/library-runtime.mjs";
import { createMemoryStorage, createStudyStore } from "../integration/core/js/store.js";
import { createAccountSnapshotHydrator } from "../public/study/js/account-snapshot.js";
import { createWebsiteAccountCatalogLoader } from "../public/study/js/library-loader.js";

const runtimeRoot = new URL(`../public/study/data/library-runtime/${LIBRARY_RELEASE}/`, import.meta.url);
const previousRuntimeRoot = new URL(`../public/study/data/library-runtime/${PREVIOUS_LIBRARY_RELEASE}/`, import.meta.url);
const retainedRuntimeRoot = new URL(`../public/study/data/library-runtime/${RETAINED_LIBRARY_RELEASE}/`, import.meta.url);
const releaseRoots = new Map([
  [LIBRARY_RELEASE, runtimeRoot],
  [PREVIOUS_LIBRARY_RELEASE, previousRuntimeRoot],
  [RETAINED_LIBRARY_RELEASE, retainedRuntimeRoot],
]);
const publicRoot = new URL("../public/", import.meta.url);
const releaseIndexUrl = new URL("https://meshful.test/study/data/library-releases.json");

function serverAssets() {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      for (const [release, assetRoot] of releaseRoots) {
        const marker = `/study/data/library-runtime/${release}/`;
        if (!url.pathname.includes(marker)) continue;
        const key = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
        try {
          const bytes = await readFile(new URL(key, assetRoot));
          return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
        } catch {
          return new Response("", { status: 404 });
        }
      }
      return new Response("", { status: 404 });
    },
  };
}

function websiteFetcher({ missing = null, drift = null } = {}) {
  const reads = [];
  return {
    reads,
    async fetch(url) {
      const location = new URL(url);
      reads.push(location.pathname);
      const relative = location.pathname.replace(/^\//, "");
      if (missing && location.pathname.endsWith(missing)) return new Response("", { status: 404 });
      try {
        let bytes = await readFile(new URL(relative, publicRoot));
        if (drift && location.pathname.endsWith(drift)) {
          bytes = Uint8Array.from(bytes);
          bytes[bytes.length - 2] ^= 1;
        }
        return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
      } catch {
        return new Response("", { status: 404 });
      }
    },
  };
}

async function committedAlgorithmsState() {
  const resolver = await createReviewedLibraryResolver(serverAssets());
  const resolved = await resolver.resolveTransaction({
    constructorCatalogRef: LIBRARY_EXPECTED_PINS.constructorRef,
    stateJson: null,
    intent: {
      kind: "command",
      operation: "add_library_deck",
      args: {
        library_deck_id: "academic-reviewed-v1:algorithms-i",
        expected_catalog_version: LIBRARY_RELEASE,
      },
    },
  });
  const storage = createMemoryStorage();
  const store = createStudyStore({
    catalog: resolved.storeCatalogView,
    retainedCatalogs: resolved.retainedCatalogViews,
    storage,
    clock: () => new Date("2026-09-02T14:41:58.892Z"),
  });
  let writes = 0;
  const add = (args) => {
    writes += 1;
    return store.addLibraryDeck(args);
  };
  const result = add({
    library_deck_id: "academic-reviewed-v1:algorithms-i",
    expected_catalog_version: LIBRARY_RELEASE,
    client_action_id: "add-deck:one-confirmed-write",
  });
  const saved = Object.values(storage.dump());
  assert.equal(saved.length, 1);
  return { raw: saved[0], result, writes };
}

async function hydratorFor(fetcher) {
  const loadAccountCatalog = await createWebsiteAccountCatalogLoader({
    indexUrl: releaseIndexUrl,
    fetcher: fetcher.fetch,
  });
  return createAccountSnapshotHydrator((ref, { storedStateJson, check }) =>
    loadAccountCatalog({ constructorCatalogRef: ref, storedStateJson, check }));
}

test("empty account bootstrap uses the pinned thin resolver without loading deck chunks", async () => {
  const fetcher = websiteFetcher();
  const hydrate = await hydratorFor(fetcher);
  const model = await hydrate({
    account_binding: "account-A",
    durable_revision: 0,
    catalog_ref: LIBRARY_EXPECTED_PINS.constructorRef,
    state_json: null,
  }, { check: () => {} });
  assert.equal(model.kind, "confirmed-account-read-model.v1");
  assert.deepEqual(model.snapshot.personalDecks, {});
  assert.equal(fetcher.reads.filter((path) => path.includes("/decks/")).length, 0);
  assert.equal(fetcher.reads.some((path) => path.includes(`/library/${LIBRARY_RELEASE}/`)), false,
    "account hydration must not substitute the monolithic browse feed");
});

test("a confirmed Algorithms install reloads only the selected course without a second write", async () => {
  const committed = await committedAlgorithmsState();
  assert.equal(committed.writes, 1);
  assert.deepEqual(committed.result.installation.decks.map(({ catalog_deck_id }) => catalog_deck_id), [
    "academic-reviewed-v1:algorithms-i",
  ]);

  const fetcher = websiteFetcher();
  const hydrate = await hydratorFor(fetcher);
  const data = {
    account_binding: "account-A",
    durable_revision: 1,
    catalog_ref: LIBRARY_EXPECTED_PINS.constructorRef,
    state_json: committed.raw,
  };
  const first = await hydrate(data, { check: () => {} });
  const second = await hydrate(data, { check: () => {} });
  const titles = Object.values(first.snapshot.personalDecks)
    .map((deck) => deck.title)
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(titles, ["Algorithms I"]);
  assert.deepEqual(second.snapshot, first.snapshot);
  assert.equal(committed.writes, 1, "reload must not replay addLibraryDeck");
  assert.deepEqual(fetcher.reads.filter((path) => path.includes("/decks/")), [
    `/study/data/library-runtime/${LIBRARY_RELEASE}/decks/algorithms-i.json`,
  ]);
});

test("missing or drifted exact deck chunks fail closed without rewriting saved bytes", async () => {
  const committed = await committedAlgorithmsState();
  const original = committed.raw;
  const data = {
    account_binding: "account-A",
    durable_revision: 1,
    catalog_ref: LIBRARY_EXPECTED_PINS.constructorRef,
    state_json: original,
  };

  const missing = await hydratorFor(websiteFetcher({ missing: "/decks/algorithms-i.json" }));
  await assert.rejects(missing(data, { check: () => {} }), (error) =>
    error?.code === "CATALOG_BASE_UNAVAILABLE");

  const drifted = await hydratorFor(websiteFetcher({ drift: "/decks/algorithms-i.json" }));
  await assert.rejects(drifted(data, { check: () => {} }), (error) =>
    error?.code === "LIBRARY_CATALOG_INTEGRITY");
  assert.equal(committed.raw, original);
  assert.equal(committed.writes, 1);
});
