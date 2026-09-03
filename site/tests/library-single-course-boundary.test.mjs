import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createMemoryStorage, createStudyStore } from "../public/study/js/store.js";
import { createWebsiteLocalStore, loadWebsiteLibrary } from "../public/study/js/library-loader.js";
import { prepareLibraryCatalogResolver as preparePublicLibraryCatalogResolver } from "../public/study/js/library-catalog.js";
import {
  createCanonicalEngine, createD1Repository, createLearnerService,
} from "../integration/backend/v7/src/index.mjs";
import { SqliteD1 } from "../integration/backend/test-support/sqlite-d1.mjs";
import { contextFor } from "../integration/backend/test-support/fixtures.mjs";
import { createMemoryStorage as createHostedMemoryStorage, createStudyStore as createHostedStudyStore } from "../integration/core/js/store.js";
import { WEBMCP_TOOL_SCHEMAS } from "../integration/core/js/webmcp.js";
import {
  BACKEND_EXPECTED_CATALOG_PINS,
  LIBRARY_ASSET_BASE_PATH,
  LIBRARY_EXPECTED_PINS,
  LIBRARY_INDEX_SHA256,
  LIBRARY_RELEASE,
  LIBRARY_RESOLUTION_BUDGET,
  PREVIOUS_LIBRARY_ASSET_BASE_PATH,
  PREVIOUS_LIBRARY_EXPECTED_PINS,
  PREVIOUS_LIBRARY_INDEX_SHA256,
  PREVIOUS_LIBRARY_RELEASE,
  RETAINED_LIBRARY_ASSET_BASE_PATH,
  RETAINED_LIBRARY_EXPECTED_PINS,
  RETAINED_LIBRARY_INDEX_SHA256,
  RETAINED_LIBRARY_RELEASE,
  createLibraryAssetReader,
  createReviewedLibraryResolver,
} from "../integration/library-runtime.mjs";

const NOW = "2026-09-02T18:00:00.000Z";
const STATE_KEY = "adaptive-study-lab:web-state:v1";
const ALGORITHMS = "academic-reviewed-v1:algorithms-i";
const PROOFS = "academic-reviewed-v1:mathematical-proof-and-foundations";
const DISCRETE = "academic-reviewed-v1:discrete-mathematics";
const INDEX_URL = new URL("https://meshful.test/study/data/library-releases.json");
const publicRoot = new URL("../public/", import.meta.url);
const v2Migration = new URL("../integration/backend/v2/migrations/0002_fragmented_storage.sql", import.meta.url);
const writerMigration = new URL("../drizzle/0002_meshful_study_writer_grants.sql", import.meta.url);
const releaseRoots = new Map([
  [LIBRARY_RELEASE, new URL(`../public/study/data/library-runtime/${LIBRARY_RELEASE}/`, import.meta.url)],
  [PREVIOUS_LIBRARY_RELEASE, new URL(`../public/study/data/library-runtime/${PREVIOUS_LIBRARY_RELEASE}/`, import.meta.url)],
  [RETAINED_LIBRARY_RELEASE, new URL(`../public/study/data/library-runtime/${RETAINED_LIBRARY_RELEASE}/`, import.meta.url)],
]);

function trackedStorage(initial = {}) {
  const memory = createMemoryStorage(initial);
  let writes = 0;
  return {
    storage: {
      getItem: (key) => memory.getItem(key),
      setItem(key, value) { writes += 1; memory.setItem(key, value); },
      removeItem: (key) => memory.removeItem(key),
      dump: () => memory.dump(),
    },
    writes: () => writes,
  };
}

function websiteFetcher(reads = []) {
  return async function fetchWebsiteAsset(input) {
    const url = new URL(input);
    reads.push(url.pathname);
    const relative = url.pathname.replace(/^\/+/, "");
    if (url.origin !== INDEX_URL.origin || !relative.startsWith("study/data/") || relative.includes("..")) {
      return new Response("", { status: 404 });
    }
    try {
      const bytes = await readFile(new URL(relative, publicRoot));
      return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
    } catch {
      return new Response("", { status: 404 });
    }
  };
}

function libraryAssets(reads = []) {
  return {
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      reads.push(pathname);
      for (const [release, root] of releaseRoots) {
        const marker = `/library-runtime/${release}/`;
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
    },
  };
}

async function createPublicReviewedLibraryResolver(assets) {
  const readAsset = createLibraryAssetReader(assets, { basePath: LIBRARY_ASSET_BASE_PATH });
  const previousReadAsset = createLibraryAssetReader(assets, { basePath: PREVIOUS_LIBRARY_ASSET_BASE_PATH });
  const retainedReadAsset = createLibraryAssetReader(assets, { basePath: RETAINED_LIBRARY_ASSET_BASE_PATH });
  const indexBytes = await readAsset("index.json");
  const previousIndexBytes = await previousReadAsset("index.json");
  const retainedIndexBytes = await retainedReadAsset("index.json");
  return preparePublicLibraryCatalogResolver({
    indexBytes,
    expectedIndexSha256: LIBRARY_INDEX_SHA256,
    expectedPins: LIBRARY_EXPECTED_PINS,
    readAsset,
    retainedIndexes: [
      {
        indexBytes: previousIndexBytes,
        expectedIndexSha256: PREVIOUS_LIBRARY_INDEX_SHA256,
        expectedPins: PREVIOUS_LIBRARY_EXPECTED_PINS,
        readAsset: previousReadAsset,
      },
      {
        indexBytes: retainedIndexBytes,
        expectedIndexSha256: RETAINED_LIBRARY_INDEX_SHA256,
        expectedPins: RETAINED_LIBRARY_EXPECTED_PINS,
        readAsset: retainedReadAsset,
      },
    ],
    resolutionBudget: LIBRARY_RESOLUTION_BUDGET,
  });
}

async function browserResolverSettings(resolver, stateJson = null) {
  const resolveTransaction = ({ constructorCatalogRef = resolver.constructorCatalogRef, ...request } = {}) =>
    resolver.resolveTransaction({ constructorCatalogRef, ...request });
  const initial = await resolveTransaction({
    stateJson,
    intent: { kind: "query", operation: "hydrate_confirmed_state", args: {} },
  });
  return {
    catalog: initial.storeCatalogView,
    retainedCatalogs: initial.retainedCatalogViews,
    constructorCatalogRef: resolver.constructorCatalogRef,
    resolveTransaction,
  };
}

function add(store, catalogId, key, version = LIBRARY_RELEASE) {
  return store.addLibraryDeck({
    library_deck_id: catalogId,
    expected_catalog_version: version,
    client_action_id: key,
  });
}

function externalAndInternalParents(deck) {
  const local = new Set(deck.cardOrder);
  const parents = deck.cardOrder.flatMap((id) => deck.cards[id]?.prerequisiteIds ?? []);
  return {
    local,
    internal: parents.filter((id) => local.has(id)),
    external: parents.filter((id) => !local.has(id)),
  };
}

function assertOnlyLocalBlockers(availability, deckId, catalogId) {
  const row = availability.decks.find((deck) => deck.deck_id === deckId);
  assert.ok(row);
  assert.ok(row.eligible_new_count > 0, "cross-course parents do not remove every new-card root");
  assert.ok(row.blocked_new_count > 0, "within-course learning order remains gated");
  assert.equal(row.eligible_new_count + row.blocked_new_count, 140);
  assert.ok(availability.blockers.items.length > 0);
  for (const item of availability.blockers.items) {
    assert.ok(item.unmet_prerequisites.length > 0);
    for (const parent of item.unmet_prerequisites) {
      assert.equal(parent.owner_deck_id, deckId);
      assert.equal(parent.catalog_deck_id, catalogId);
    }
  }
}

function command(operation, args, expectedRevision) {
  return {
    request_id: args.client_action_id ?? args.idempotency_key,
    expected_revision: expectedRevision,
    operation,
    args,
  };
}

test("public and hosted canonical store/catalog mirrors remain byte-identical", async () => {
  const pairs = [
    [new URL("../public/study/js/store.js", import.meta.url), new URL("../integration/core/js/store.js", import.meta.url)],
    [new URL("../public/study/js/library-catalog.js", import.meta.url), new URL("../integration/core/js/library-catalog.js", import.meta.url)],
  ];
  for (const [publicFile, hostedFile] of pairs) {
    assert.deepEqual(await readFile(publicFile), await readFile(hostedFile));
  }
});

test("one Library action resolves, installs and replays only the selected course while retaining local order metadata", async () => {
  const reads = [];
  const resolver = await createPublicReviewedLibraryResolver(libraryAssets(reads));
  const catalogSettings = await browserResolverSettings(resolver);
  const tracked = trackedStorage();
  const store = createWebsiteLocalStore({
    catalogSettings, storage: tracked.storage, clock: () => new Date(NOW),
  });
  const args = {
    library_deck_id: ALGORITHMS,
    expected_catalog_version: LIBRARY_RELEASE,
    client_action_id: "single-course:add-algorithms",
  };
  const result = await store.addLibraryDeck(args);
  const state = store.getSnapshot();
  const deck = state.personalDecks[result.deck.id];
  const relationships = externalAndInternalParents(deck);

  assert.equal(tracked.writes(), 1);
  assert.deepEqual(result.installation.decks.map((item) => item.catalog_deck_id), [ALGORITHMS]);
  assert.equal(Object.keys(state.personalDecks).length, 1);
  assert.ok(relationships.external.length > 0, "immutable cross-course IDs remain available for saved-data compatibility");
  assert.ok(relationships.internal.length > 0, "within-course prerequisite IDs remain intact");
  assert.deepEqual(state.activity.find((event) => event.type === "deck_added")?.installedDeckIds, [result.deck.id]);
  assert.doesNotMatch(JSON.stringify(result), /mathematical-proof-and-foundations|discrete-mathematics/);
  assert.doesNotMatch(JSON.stringify(state.actionReceipts[args.client_action_id]),
    /mathematical-proof-and-foundations|discrete-mathematics/);
  assert.deepEqual(await store.addLibraryDeck(args), result, "the exact action replays its original receipt");
  assert.equal(tracked.writes(), 1, "replay performs no second learner-state write");
  assert.deepEqual(reads.filter((path) => path.includes("/decks/")), [
    `/study/data/library-runtime/${LIBRARY_RELEASE}/decks/algorithms-i.json`,
  ], "the browser resolver reads exactly the selected course chunk");

  const savedBeforeRead = tracked.storage.getItem(STATE_KEY);
  const availability = store.getStudyAvailability({ deck_id: result.deck.id, blocked_limit: 50 });
  assertOnlyLocalBlockers(availability, result.deck.id, ALGORITHMS);
  assert.doesNotMatch(JSON.stringify(availability),
    /mathematical-proof-and-foundations|discrete-mathematics|PARENT_NOT_INSTALLED|PARENT_BASE_CONFLICT|PARENT_AMBIGUOUS|PARENT_DECK_ARCHIVED/);
  assert.equal(tracked.storage.getItem(STATE_KEY), savedBeforeRead, "availability is a byte-preserving projection");
  const firstBlockerPage = store.getStudyAvailability({ deck_id: result.deck.id, blocked_limit: 1 });
  assert.match(firstBlockerPage.blockers.next_cursor, /^availability-v2:deck-local-v1:/);
  assert.throws(() => store.getStudyAvailability({
    deck_id: result.deck.id,
    blocked_limit: 1,
    blocked_cursor: `availability-v1:${availability.app_revision}:${encodeURIComponent(result.deck.id)}:1`,
  }), (error) => error?.code === "STALE_AVAILABILITY_CURSOR");
  assert.throws(() => store.getStudyAvailability({
    deck_id: result.deck.id,
    blocked_limit: 1,
    blocked_cursor: firstBlockerPage.blockers.next_cursor.replace("deck-local-v1", "outside-course-v1"),
  }), (error) => error?.code === "STALE_AVAILABILITY_CURSOR");

  const complete = store.getDeck({ scope: "personal", deck_id: result.deck.id });
  assert.equal(complete.cross_deck_edge_count, 0);
  assert.deepEqual(complete.external_prerequisite_deck_ids, []);
  const rawExternalCard = deck.cardOrder.map((id) => deck.cards[id])
    .find((card) => (card.prerequisiteIds ?? []).some((id) => !relationships.local.has(id)));
  assert.ok(rawExternalCard);
  const projectedExternalCard = complete.deck.cards.find((card) => card.card_id === rawExternalCard.id);
  assert.ok(projectedExternalCard);
  assert.deepEqual(projectedExternalCard.prerequisite_ids,
    (rawExternalCard.prerequisiteIds ?? []).filter((id) => relationships.local.has(id)));
  assert.ok(!store.validateDeck({ source: "stored", scope: "personal", deck_id: result.deck.id })
    .warnings.some((warning) => warning.code === "EXTERNAL_PREREQUISITES_UNVERIFIED"));
  const librarySearch = store.searchLibrary({ query: "Algorithms I", limit: 10 }, { source: "webmcp" });
  assert.equal(librarySearch.items.find((item) => item.deck_id === ALGORITHMS)?.cross_deck_edge_count, 0);
  const libraryComplete = await store.getDeck({ scope: "library", deck_id: ALGORITHMS });
  assert.equal(libraryComplete.cross_deck_edge_count, 0);
  assert.deepEqual(libraryComplete.external_prerequisite_deck_ids, []);
  assert.doesNotMatch(JSON.stringify(libraryComplete), /discrete-mathematics\.master-theorem-statement/);
  assert.deepEqual(reads.filter((path) => path.includes("/decks/")), [
    `/study/data/library-runtime/${LIBRARY_RELEASE}/decks/algorithms-i.json`,
  ], "repeat selected-course reads use the one verified chunk without loading its former closure");

  const started = store.startStudySession({
    deck_id: result.deck.id, limit: 20, idempotency_key: "single-course:start-algorithms",
  });
  assert.ok(started.current_card);
  const selected = deck.cards[started.current_card.card_id];
  assert.equal((selected.prerequisiteIds ?? []).filter((id) => relationships.local.has(id)).length, 0,
    "a first queue never skips a same-course parent");
});

test("a closure-shaped saved account keeps every installed course and exact bytes while cross-course recall stops gating", async () => {
  const initialSettings = await loadWebsiteLibrary({ indexUrl: INDEX_URL, fetcher: websiteFetcher() });
  const tracked = trackedStorage();
  const store = createWebsiteLocalStore({
    catalogSettings: initialSettings, storage: tracked.storage, clock: () => new Date(NOW),
  });
  await add(store, PROOFS, "closure-shape:add-proofs");
  await add(store, DISCRETE, "closure-shape:add-discrete");
  const algorithms = await add(store, ALGORITHMS, "closure-shape:add-algorithms");
  const expectedState = store.getSnapshot();
  const raw = tracked.storage.getItem(STATE_KEY);
  assert.equal(Object.keys(expectedState.personalDecks).length, 3);

  const reloadReads = [];
  const reloadedSettings = await loadWebsiteLibrary({
    indexUrl: INDEX_URL, fetcher: websiteFetcher(reloadReads), storedStateJson: raw,
  });
  const reloaded = createWebsiteLocalStore({
    catalogSettings: reloadedSettings, storage: tracked.storage, clock: () => new Date(NOW),
  });
  assert.deepEqual(reloaded.getSnapshot(), expectedState);
  assert.equal(tracked.storage.getItem(STATE_KEY), raw);
  const availability = reloaded.getStudyAvailability({ deck_id: algorithms.deck.id, blocked_limit: 50 });
  assertOnlyLocalBlockers(availability, algorithms.deck.id, ALGORITHMS);
  assert.equal(tracked.storage.getItem(STATE_KEY), raw, "the compatibility read does not rewrite the old saved shape");
  assert.deepEqual(reloadReads.filter((path) => path.includes("/decks/")), [],
    "the browser reload reuses the prepared catalog without dependency fetches");
});

test("custom personal external references stay raw but are inert while same-deck parents still gate", () => {
  const catalog = [{
    id: "custom-parent", version: "1", title: "Custom parent", cards: [{
      id: "parent", term: "Parent", definition: "A synthetic parent definition.", required_concepts: ["State the parent."],
    }],
  }, {
    id: "custom-child", version: "1", title: "Custom child", cards: [{
      id: "local-parent", term: "Local parent", definition: "A local parent definition.", required_concepts: ["State the local parent."],
    }, {
      id: "external-only", term: "External only", definition: "An external-only child definition.", required_concepts: ["State the child."],
      prerequisite_ids: ["deck-custom-parent.parent", "unresolved.external"],
    }, {
      id: "mixed-child", term: "Mixed child", definition: "A mixed child definition.", required_concepts: ["State the mixed child."],
      prerequisite_ids: ["deck-custom-parent.parent", "local-parent"],
    }],
  }];
  const store = createStudyStore({ catalog, storage: createMemoryStorage(), clock: () => new Date(NOW) });
  add(store, "custom-parent", "custom:add-parent", "1");
  const child = add(store, "custom-child", "custom:add-child", "1");
  const availability = store.getStudyAvailability({ deck_id: child.deck.id, blocked_limit: 10 });
  assert.equal(availability.decks[0].eligible_new_count, 2);
  assert.equal(availability.decks[0].blocked_new_count, 1);
  assert.equal(availability.blockers.items[0].term, "Mixed child");
  assert.equal(availability.blockers.items[0].unmet_prerequisites.length, 1);
  assert.equal(availability.blockers.items[0].unmet_prerequisites[0].owner_deck_title, "Custom child");
  assert.equal(availability.blockers.items[0].unmet_prerequisites[0].reason, "PARENT_RECALL_REQUIRED");

  const snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.personalDecks[child.deck.id].cards["external-only"].prerequisiteIds,
    ["deck-custom-parent.parent", "unresolved.external"]);
  const complete = store.getDeck({ scope: "personal", deck_id: child.deck.id });
  const exposedExternal = complete.deck.cards.find((card) => card.card_id === `${child.deck.id}.external-only`);
  const exposedMixed = complete.deck.cards.find((card) => card.card_id === `${child.deck.id}.mixed-child`);
  assert.deepEqual(exposedExternal.prerequisite_ids, []);
  assert.deepEqual(exposedMixed.prerequisite_ids, [`${child.deck.id}.local-parent`]);
  assert.equal(complete.cross_deck_edge_count, 0);
  assert.deepEqual(complete.external_prerequisite_deck_ids, []);
});

test("a retained closure-shaped receipt replays byte-for-byte without reinstalling historical courses", async () => {
  const catalogSettings = await loadWebsiteLibrary({ indexUrl: INDEX_URL, fetcher: websiteFetcher() });
  const tracked = trackedStorage();
  const store = createWebsiteLocalStore({ catalogSettings, storage: tracked.storage, clock: () => new Date(NOW) });
  const proofs = await add(store, PROOFS, "legacy-receipt:add-proofs");
  const discrete = await add(store, DISCRETE, "legacy-receipt:add-discrete");
  const args = {
    library_deck_id: ALGORITHMS,
    expected_catalog_version: LIBRARY_RELEASE,
    client_action_id: "legacy-receipt:add-algorithms",
  };
  const algorithms = await store.addLibraryDeck(args);
  const serialized = JSON.parse(tracked.storage.getItem(STATE_KEY));
  const receipt = serialized.actionReceipts[args.client_action_id];
  receipt.result.installation.decks = [
    proofs.installation.decks[0],
    discrete.installation.decks[0],
    algorithms.installation.decks[0],
  ];
  receipt.result.historical_closure_receipt = true;
  tracked.storage.setItem(STATE_KEY, JSON.stringify(serialized));
  const rawBeforeReplay = tracked.storage.getItem(STATE_KEY);
  const writesBeforeReplay = tracked.writes();

  const reloadedSettings = await loadWebsiteLibrary({
    indexUrl: INDEX_URL,
    fetcher: websiteFetcher(),
    storedStateJson: rawBeforeReplay,
  });
  const reloaded = createWebsiteLocalStore({
    catalogSettings: reloadedSettings, storage: tracked.storage, clock: () => new Date(NOW),
  });
  const replay = await reloaded.addLibraryDeck(args);
  assert.equal(replay.historical_closure_receipt, true);
  assert.deepEqual(replay.installation.decks.map((item) => item.catalog_deck_id), [PROOFS, DISCRETE, ALGORITHMS]);
  assert.equal(tracked.writes(), writesBeforeReplay);
  assert.equal(tracked.storage.getItem(STATE_KEY), rawBeforeReplay);
  assert.equal(Object.keys(reloaded.getSnapshot().personalDecks).length, 3);
});

test("a selected-course asset failure commits nothing and an identical retry remains exact-once", async () => {
  let failSelected = true;
  const delegate = libraryAssets();
  const assets = {
    async fetch(request) {
      const url = new URL(request.url);
      if (failSelected && url.pathname.endsWith("/decks/algorithms-i.json")) {
        return new Response("", { status: 404 });
      }
      return delegate.fetch(request);
    },
  };
  const resolver = await createPublicReviewedLibraryResolver(assets);
  const catalogSettings = await browserResolverSettings(resolver);
  const tracked = trackedStorage();
  const store = createWebsiteLocalStore({ catalogSettings, storage: tracked.storage, clock: () => new Date(NOW) });
  const args = {
    library_deck_id: ALGORITHMS,
    expected_catalog_version: LIBRARY_RELEASE,
    client_action_id: "selected-failure:add-algorithms",
  };
  await assert.rejects(() => store.addLibraryDeck(args), (error) => error?.code === "CATALOG_BASE_UNAVAILABLE");
  assert.equal(tracked.writes(), 0);
  assert.equal(Object.keys(store.getSnapshot().personalDecks).length, 0);
  failSelected = false;
  const committed = await store.addLibraryDeck(args);
  assert.equal(tracked.writes(), 1);
  assert.equal(Object.keys(store.getSnapshot().personalDecks).length, 1);
  assert.deepEqual((await store.addLibraryDeck(args)), committed);
  assert.equal(tracked.writes(), 1);
});

test("each of the 72 reviewed courses installs alone and has an initial deck-local root", async () => {
  const catalogSettings = await loadWebsiteLibrary({ indexUrl: INDEX_URL, fetcher: websiteFetcher() });
  assert.equal(catalogSettings.browseCatalog.length, 72);
  for (const summary of catalogSettings.browseCatalog) {
    const store = createStudyStore({
      catalog: catalogSettings.catalog,
      retainedCatalogs: catalogSettings.retainedCatalogs,
      storage: createMemoryStorage(),
      clock: () => new Date(NOW),
    });
    const installed = add(store, summary.id, `all-courses:${summary.id}`, summary.version);
    const snapshot = store.getSnapshot();
    const availability = store.getStudyAvailability({ deck_id: installed.deck.id });
    assert.equal(Object.keys(snapshot.personalDecks).length, 1, summary.id);
    assert.equal(installed.installation.decks.length, 1, summary.id);
    assert.equal(installed.installation.decks[0].catalog_deck_id, summary.id);
    assert.ok(availability.decks[0].eligible_new_count > 0, `${summary.id} has no deck-local root`);
  }
});

test("the selected hosted D1 command persists one course and starts it without a cross-course installation", {
  timeout: 120_000,
}, async (t) => {
  const reads = [];
  const resolver = await createReviewedLibraryResolver(libraryAssets(reads));
  const engine = await createCanonicalEngine({
    createStudyStore: createHostedStudyStore,
    createMemoryStorage: createHostedMemoryStorage,
    toolSchemas: WEBMCP_TOOL_SCHEMAS,
    catalogResolver: resolver,
    expectedCatalogPins: BACKEND_EXPECTED_CATALOG_PINS,
    expectedResolutionBudget: LIBRARY_RESOLUTION_BUDGET,
  });
  const database = new SqliteD1().applyMigration().applyMigration(v2Migration).applyMigration(writerMigration);
  t.after(() => database.close());
  const service = createLearnerService({
    repository: createD1Repository(database), engine, clock: () => NOW,
  });
  const learner = await contextFor(service, "single-course-d1");
  const writerToken = "a".repeat(64);
  await service.mutateWriterGrant(learner, {
    request_id: "single-course-d1:writer-acquire",
    action: "acquire",
    expected_writer_epoch: 0,
    grant_token: writerToken,
  });
  const writerGrant = { writerEpoch: 1, token: writerToken };
  const args = {
    library_deck_id: ALGORITHMS,
    expected_catalog_version: LIBRARY_RELEASE,
    client_action_id: "single-course-d1:add-algorithms",
  };
  const installed = await service.command(learner, command("add_library_deck", args, 0));
  assert.equal(installed.durable_revision, 1);
  assert.deepEqual(installed.result.installation.decks.map((item) => item.catalog_deck_id), [ALGORITHMS]);
  const replay = await service.command(learner, command("add_library_deck", args, 0));
  assert.equal(replay.durable_revision, 1);
  assert.equal(replay.result.receipt.replayed, true);
  assert.deepEqual(await service.getWriterGrant(learner), {
    schema_version: 1,
    account_binding: learner.principalId,
    writer_epoch: 1,
    active: true,
  }, "Library Add neither inspects nor changes the active Study writer");

  const saved = await service.getState(learner);
  assert.equal(Object.keys(JSON.parse(saved.state_json).personalDecks).length, 1);
  const startArgs = {
    deck_id: installed.result.deck.id,
    limit: 20,
    idempotency_key: "single-course-d1:start-algorithms",
  };
  await assert.rejects(service.command(learner, command("start_study_session", startArgs, 1)),
    (error) => error?.code === "WRITER_GRANT_REQUIRED");
  const started = await service.command(learner, command("start_study_session", startArgs, 1), writerGrant);
  assert.equal(started.durable_revision, 2);
  assert.ok(started.result.current_card);
  const beforeArchive = JSON.parse((await service.getState(learner)).state_json);
  const beforeArchiveRevision = beforeArchive.revision;
  const activeSession = beforeArchive.sessions[started.result.session.session_id];
  const savedQueue = structuredClone(activeSession.queue);
  const archiveArgs = {
    deck_id: installed.result.deck.id,
    archived: true,
    expected_revision: installed.result.deck.revision,
    client_action_id: "single-course-d1:archive-active-algorithms",
  };
  const archived = await service.command(learner,
    command("set_deck_archived", archiveArgs, 2));
  assert.equal(archived.durable_revision, 3);
  assert.equal(archived.result.deck.archived, true);
  const afterArchive = JSON.parse((await service.getState(learner)).state_json);
  assert.equal(afterArchive.revision, beforeArchiveRevision + 1,
    "one durable Archive remains one canonical app revision");
  assert.equal(archived.result.receipt.previous_app_revision, beforeArchiveRevision);
  assert.equal(archived.result.receipt.app_revision, afterArchive.revision);
  assert.equal(afterArchive.activeSessionId, null);
  assert.equal(afterArchive.sessions[activeSession.id].status, "paused");
  assert.deepEqual(afterArchive.sessions[activeSession.id].queue, savedQueue,
    "same-deck Archive preserves the fixed Study queue");
  assert.equal(afterArchive.sessions[activeSession.id].reviewsApplied, activeSession.reviewsApplied);
  assert.deepEqual(afterArchive.activity.slice(-2).map((event) => event.type), [
    "study_paused", "deck_archived",
  ]);
  assert.equal((await service.command(learner,
    command("set_deck_archived", archiveArgs, 2))).result.receipt.replayed, true);

  const restoreArgs = {
    deck_id: archiveArgs.deck_id,
    archived: false,
    expected_revision: archived.result.deck.revision,
    client_action_id: "single-course-d1:restore-algorithms",
  };
  const restored = await service.command(learner,
    command("set_deck_archived", restoreArgs, 3));
  assert.equal(restored.durable_revision, 4);
  assert.equal(restored.result.deck.archived, false);
  assert.equal(Object.keys(JSON.parse((await service.getState(learner)).state_json).personalDecks).length, 1);
  assert.equal((await service.getWriterGrant(learner)).writer_epoch, 1);
  assert.equal((await service.getWriterGrant(learner)).active, true,
    "Archive and Restore do not release or replace the Study writer");
  assert.deepEqual(reads.filter((path) => path.includes("/decks/")), [
    `/study/data/library-runtime/${LIBRARY_RELEASE}/decks/algorithms-i.json`,
  ]);
});
