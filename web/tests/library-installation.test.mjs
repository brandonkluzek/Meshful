import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStorage, createStudyStore } from "../js/store.js";
import { isPreparedLibraryCatalog, prepareLibraryCatalog } from "../js/library-catalog.js";
import { catalogId, FIXTURE_VERSION, preparedFixture } from "./helpers/library-fixture.mjs";

const NOW = "2026-08-30T12:00:00.000Z";
const KEY = "adaptive-study-lab:web-state:v1";
const DIAMOND = ["alpha", "beta", "delta", "gamma"].map(catalogId);

function trackedStorage(initial = {}) {
  const backing = createMemoryStorage(initial);
  const storage = {
    reads: 0, attempts: [], writes: [], failWrites: false,
    getItem(key) { storage.reads += 1; return backing.getItem(key); },
    setItem(key, value) {
      storage.attempts.push({ key, value });
      if (storage.failWrites) {
        throw Object.assign(new Error("Synthetic storage quota exhausted"), { name: "QuotaExceededError" });
      }
      backing.setItem(key, value);
      storage.writes.push({ key, value });
    },
    removeItem: (key) => backing.removeItem(key),
    dump: () => backing.dump(),
  };
  return storage;
}

function runtime(prepared, initial = {}) {
  const storage = trackedStorage(initial);
  const store = createStudyStore({ catalog: prepared, storage, clock: () => NOW });
  return { store, storage };
}

function install(store, sourceId = "gamma", key = `install:${sourceId}`) {
  return store.addLibraryDeck({
    library_deck_id: catalogId(sourceId),
    expected_catalog_version: FIXTURE_VERSION,
    client_action_id: key,
  });
}

function readDeck(store, deckId) {
  return store.getDeck({ scope: "personal", deck_id: deckId });
}

function start(store, deckId, key) {
  return store.startStudySession({ deck_id: deckId, limit: 20, idempotency_key: key });
}

function grade(store, started, key) {
  const card = started.current_card;
  return store.submitGrade({
    session_id: started.session.session_id,
    card_id: card.card_id,
    expected_card_revision: card.card_revision,
    expected_session_revision: started.session.session_revision,
    answer_text: "Synthetic recalled definition.", answer_origin: "chat", rating: "good",
    rubric_evidence: card.required_concepts.map((item) => ({
      rubric_item_id: item.rubric_item_id, status: "met", note: "Synthetic mechanics test.",
    })),
    feedback: "Synthetic scheduling evidence, not a semantic evaluation.",
    misconceptions: [], confidence: 1, idempotency_key: key,
  });
}

function installedDeck(state, sourceId) {
  const matches = Object.values(state.personalDecks)
    .filter((deck) => deck.libraryBase?.catalogDeckId === catalogId(sourceId));
  assert.equal(matches.length, 1);
  return matches[0];
}

function rawCard(id, prerequisite_ids = []) {
  return { id, term: id, definition: `Synthetic definition of ${id}.`, required_concepts: ["State the definition."], prerequisite_ids };
}

test("one setItem installs the full parent-first diamond with actual IDs and one receipt/effect", async () => {
  const { feed, prepared } = await preparedFixture();
  const { store, storage } = runtime(prepared);
  const result = install(store);
  const state = store.getSnapshot();

  assert.equal(storage.writes.length, 1);
  assert.equal(storage.writes[0].key, KEY);
  assert.equal(state.revision, 1);
  assert.equal(Object.keys(state.personalDecks).length, 4);
  assert.deepEqual(result.installation.decks.map((deck) => deck.catalog_deck_id), DIAMOND);
  assert.equal(new Set(result.installation.decks.map((deck) => deck.deck_id)).size, 4);
  assert.deepEqual(result.installation.catalog_ref, feed.catalog_ref);
  assert.equal(result.installation.dependency_graph_sha256, feed.dependency_graph_sha256);
  for (const record of result.installation.decks) {
    const deck = state.personalDecks[record.deck_id];
    const base = prepared.library.decks[record.catalog_deck_id];
    assert.equal(deck.libraryBase.catalogDeckId, record.catalog_deck_id);
    assert.equal(record.payload_sha256, base.payloadDigest);
    assert.match(record.normalized_digest, /^fnv1a-/);
    assert.equal(record.catalog_version, FIXTURE_VERSION);
    assert.equal(record.already_installed, false);
    for (const card of Object.values(deck.cards)) {
      assert.equal(card.review.repetitions, 0, "installation must not invent mastery");
      assert.deepEqual(card.reviewHistory, []);
    }
  }
  assert.equal(result.deck.id, result.installation.decks.at(-1).deck_id);
  assert.equal(state.view.selectedDeckId, result.deck.id);
  assert.deepEqual(result.visible_effect, { type: "deck_added", deck_id: result.deck.id });
  assert.deepEqual(state.actionReceiptOrder, ["install:gamma"]);
  assert.deepEqual(state.actionReceipts["install:gamma"].result, result);
  assert.equal(state.activity.filter((event) => event.type === "deck_added").length, 1);
});

test("installation records allocated IDs instead of guessing a colliding personal ID", async () => {
  const { prepared } = await preparedFixture();
  const obstacle = createStudyStore({
    catalog: [{ id: "academic-reviewed-v1-alpha", title: "Unrelated synthetic deck", version: "1", cards: [rawCard("unrelated")] }],
    storage: createMemoryStorage(), clock: () => NOW,
  });
  const prior = obstacle.addLibraryDeck({
    library_deck_id: "academic-reviewed-v1-alpha", expected_catalog_version: "1", client_action_id: "unrelated-install",
  });
  assert.equal(prior.deck.id, "deck-academic-reviewed-v1-alpha");
  const seed = obstacle.getSnapshot();
  const { store, storage } = runtime(prepared, { [KEY]: JSON.stringify(seed) });
  const result = install(store);
  const state = store.getSnapshot();
  const alpha = result.installation.decks.find((record) => record.catalog_deck_id === catalogId("alpha"));

  assert.equal(storage.writes.length, 1);
  assert.equal(Object.keys(state.personalDecks).length, 5);
  assert.notEqual(alpha.deck_id, prior.deck.id);
  assert.equal(state.personalDecks[alpha.deck_id].libraryBase.catalogDeckId, catalogId("alpha"));
  assert.deepEqual(state.personalDecks[prior.deck.id], seed.personalDecks[prior.deck.id]);
});

test("exact installation replay writes nothing and changed input conflicts", async () => {
  const { prepared } = await preparedFixture();
  const { store, storage } = runtime(prepared);
  const result = install(store);
  const before = storage.getItem(KEY);

  assert.deepEqual(install(store), result);
  assert.equal(storage.writes.length, 1);
  assert.equal(storage.getItem(KEY), before);
  assert.throws(() => install(store, "beta", "install:gamma"), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(storage.getItem(KEY), before);
  assert.equal(storage.writes.length, 1);

  const reused = install(store, "gamma", "intentional-reuse");
  assert.equal(storage.writes.length, 2);
  assert.equal(reused.already_installed, true);
  assert.ok(reused.installation.decks.every((record) => record.already_installed));
  assert.deepEqual(reused.installation.decks.map((record) => record.deck_id), result.installation.decks.map((record) => record.deck_id));
  assert.equal(Object.keys(store.getSnapshot().personalDecks).length, 4);
  assert.equal(store.getSnapshot().activity.filter((event) => event.type === "deck_added").length, 1);
});

test("adding a second branch reuses the exact parent IDs, history and schedules", async () => {
  const { prepared } = await preparedFixture();
  const { store, storage } = runtime(prepared);
  install(store, "beta");
  const alphaId = installedDeck(store.getSnapshot(), "alpha").id;
  grade(store, start(store, alphaId, "start-alpha"), "grade-alpha");
  const before = store.getSnapshot();
  const beforeWrites = storage.writes.length;
  const result = install(store);
  const after = store.getSnapshot();

  assert.equal(storage.writes.length, beforeWrites + 1);
  assert.deepEqual(result.installation.decks.map((record) => record.already_installed), [true, true, false, false]);
  for (const sourceId of ["alpha", "beta"]) {
    assert.deepEqual(installedDeck(after, sourceId), installedDeck(before, sourceId));
  }
  assert.equal(installedDeck(after, "alpha").cards["alpha.root"].reviewHistory.length, 1);
});

test("sparse reload retains exact raw pins, normalized fingerprints, IDs and source strings", async () => {
  const { feed, prepared } = await preparedFixture();
  const first = runtime(prepared);
  const result = install(first.store);
  const alphaId = installedDeck(first.store.getSnapshot(), "alpha").id;
  grade(first.store, start(first.store, alphaId, "start-alpha"), "grade-alpha");
  const original = first.store.getSnapshot();
  const persisted = JSON.parse(first.storage.getItem(KEY));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.persistenceFormat, "sparse-library-v1");
  for (const record of result.installation.decks) {
    const overlay = persisted.personalDecks[record.deck_id];
    assert.equal(overlay.persistenceKind, "catalog-overlay-v1");
    assert.equal(overlay.catalogDigest, record.normalized_digest);
    assert.equal(overlay.catalogVersion, FIXTURE_VERSION);
    assert.equal(Object.hasOwn(overlay, "cards"), false);
    assert.deepEqual(overlay.deckFields.libraryBase, original.personalDecks[record.deck_id].libraryBase);
  }

  // A newly prepared, equivalent reference exercises normalization, not just
  // the same-reference cache shared by successive store constructions.
  const fresh = await preparedFixture();
  assert.notEqual(fresh.prepared, prepared);
  const second = runtime(fresh.prepared, first.storage.dump());
  assert.equal(second.storage.writes.length, 0);
  assert.deepEqual(second.store.getSnapshot(), original);
  for (const source of feed.catalog) {
    const deck = installedDeck(original, source.cards[0].canonical_deck_id);
    const actual = readDeck(second.store, deck.id).deck.cards;
    assert.deepEqual(actual.map((card) => card.card_id), source.cards.map((card) => card.id));
    assert.deepEqual(actual.map((card) => card.prerequisite_ids), source.cards.map((card) => card.prerequisite_ids));
    assert.deepEqual(actual.map((card) => card.definition_md), source.cards.map((card) => card.definition));
    assert.deepEqual(actual.map((card) => card.required_concepts.map((item) => item.text)), source.cards.map((card) => card.required_concepts));
  }
  assert.equal(second.storage.getItem(KEY), first.storage.getItem(KEY));
});

for (const variant of ["raw-content-drift", "source-pin-drift", "unprepared-raw-catalog", "missing-catalog", "normalized-fingerprint-drift"]) {
  test(`sparse reload rejects ${variant} without changing saved bytes`, async () => {
    const { prepared } = await preparedFixture();
    const original = runtime(prepared);
    install(original.store);
    let catalog = prepared;
    let raw = original.storage.getItem(KEY);
    if (variant === "raw-content-drift") {
      const definitions = prepared.catalog.map((deck) => [deck.cards[0].canonical_deck_id, structuredClone(deck.cards)]);
      definitions[0][1][0].definition = "Changed synthetic base under the same release version.";
      catalog = (await preparedFixture(definitions)).prepared;
    } else if (variant === "source-pin-drift") {
      const { feed } = await preparedFixture();
      const changedPin = `sha256:${"f".repeat(64)}`;
      feed.source_card_index["alpha.root"].artifact_sha256 = changedPin;
      for (const reference of Object.values(feed.source_reference_map)) {
        if (reference.artifact_path === "synthetic-private-source-canary/alpha.json") reference.artifact_sha256 = changedPin;
      }
      catalog = await prepareLibraryCatalog(feed);
      assert.deepEqual(catalog.library.catalogRef, prepared.library.catalogRef);
    } else if (variant === "unprepared-raw-catalog") catalog = prepared.catalog;
    else if (variant === "missing-catalog") catalog = [];
    else {
      const state = JSON.parse(raw);
      state.personalDecks[Object.keys(state.personalDecks)[0]].catalogDigest = "fnv1a-tampered";
      raw = JSON.stringify(state);
    }
    const storage = trackedStorage({ [KEY]: raw });
    assert.throws(() => createStudyStore({ catalog, storage, clock: () => NOW }), { code: "CATALOG_BASE_UNAVAILABLE" });
    assert.equal(storage.writes.length, 0);
    assert.equal(storage.getItem(KEY), raw);
  });
}

const dependencyFailures = [
  ["archived dependency deck", "LIBRARY_DEPENDENCY_ARCHIVED", (state, deck) => { deck.archived = true; }],
  ["archived parent card", "LIBRARY_DEPENDENCY_ARCHIVED", (state, deck) => { deck.cards["beta.branch"].archived = true; }],
  ["missing canonical parent", "LIBRARY_DEPENDENCY_CONFLICT", (state, deck) => {
    delete deck.cards["beta.branch"]; deck.cardOrder = [];
  }],
  ["missing immutable base proof", "LIBRARY_DEPENDENCY_CONFLICT", (state, deck) => { delete deck.libraryBase; }],
  ["conflicting base identity", "LIBRARY_DEPENDENCY_CONFLICT", (state, deck) => {
    deck.libraryBase = structuredClone(installedDeck(state, "alpha").libraryBase);
  }],
  ["duplicate existing base", "LIBRARY_DEPENDENCY_CONFLICT", (state, deck) => {
    state.personalDecks["duplicate-beta"] = { ...structuredClone(deck), id: "duplicate-beta" };
  }],
];

for (const [name, code, damage] of dependencyFailures) {
  test(`${name} aborts the complete closure without a partial mutation`, async () => {
    const { prepared } = await preparedFixture();
    const seed = runtime(prepared);
    install(seed.store, "beta");
    const state = seed.store.getSnapshot();
    damage(state, installedDeck(state, "beta"));
    const raw = JSON.stringify(state);
    const { store, storage } = runtime(prepared, { [KEY]: raw });
    assert.throws(() => install(store), { code });
    assert.equal(storage.writes.length, 0);
    assert.equal(storage.getItem(KEY), raw);
    assert.deepEqual(store.getSnapshot(), state);
    assert.equal(Object.hasOwn(store.getSnapshot().actionReceipts, "install:gamma"), false);
  });
}

test("exact persisted installation replay precedes a later dependency archive conflict", async () => {
  const { prepared } = await preparedFixture();
  const first = runtime(prepared);
  const result = install(first.store);
  const state = first.store.getSnapshot();
  installedDeck(state, "alpha").archived = true;
  const raw = JSON.stringify(state);
  const { store, storage } = runtime(prepared, { [KEY]: raw });

  assert.deepEqual(install(store), result);
  assert.equal(storage.writes.length, 0);
  assert.throws(() => install(store, "gamma", "new-install-intent"), { code: "LIBRARY_DEPENDENCY_ARCHIVED" });
  assert.equal(storage.getItem(KEY), raw);
  assert.equal(storage.writes.length, 0);
});

test("one failing persistence attempt rolls back the entire proposed closure and receipt", async () => {
  const { prepared } = await preparedFixture();
  const { store, storage } = runtime(prepared);
  install(store, "alpha");
  const before = store.getSnapshot();
  const raw = storage.getItem(KEY);
  const writes = storage.writes.length;
  const attempts = storage.attempts.length;
  storage.failWrites = true;

  assert.throws(() => install(store), { name: "QuotaExceededError" });
  assert.equal(storage.attempts.length, attempts + 1);
  assert.equal(storage.writes.length, writes);
  assert.equal(storage.getItem(KEY), raw);
  assert.deepEqual(store.getSnapshot(), before);
  assert.equal(Object.hasOwn(store.getSnapshot().actionReceipts, "install:gamma"), false);

  storage.failWrites = false;
  assert.equal(install(store).installation.decks.length, 4);
  assert.equal(storage.writes.length, writes + 1);
});

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

for (const variant of ["plain-copy", "shallow-frozen-copy", "deep-frozen-copy", "shared-fields-copy", "forged-content-with-original-pins"]) {
  test(`prepared-reference trust rejects ${variant} before touching storage`, async () => {
    const { prepared } = await preparedFixture();
    let copy = structuredClone(prepared);
    if (variant === "shallow-frozen-copy") Object.freeze(copy);
    else if (variant === "deep-frozen-copy") deepFreeze(copy);
    else if (variant === "shared-fields-copy") copy = Object.freeze({ ...prepared });
    else if (variant === "forged-content-with-original-pins") {
      copy.catalog[0].cards[0].definition = "Forged content retaining the original SHA claims.";
      Object.freeze(copy);
    }
    const storage = trackedStorage();
    assert.equal(isPreparedLibraryCatalog(copy), false);
    assert.throws(() => createStudyStore({ catalog: copy, storage, clock: () => NOW }), { code: "INVALID_LIBRARY_CATALOG" });
    assert.equal(storage.reads, 0);
    assert.equal(storage.writes.length, 0);
  });
}

test("genuine prepared references stay immutable and cached catalogs do not alias public snapshots", async () => {
  const { prepared } = await preparedFixture();
  assert.equal(isPreparedLibraryCatalog(prepared), true);
  assert.throws(() => { prepared.catalog[0].cards[0].definition = "mutated"; }, TypeError);
  const first = runtime(prepared);
  const snapshot = first.store.getCatalogSnapshot();
  snapshot[0].cards[0].definition = "mutated public snapshot";
  snapshot[0].libraryBase.payloadDigest = "mutated public metadata";
  const second = runtime(prepared);
  const installed = install(second.store, "alpha");
  assert.equal(readDeck(second.store, installed.deck.id).deck.cards[0].definition_md, prepared.catalog[0].cards[0].definition);
  assert.equal(installed.installation.decks[0].payload_sha256, prepared.library.decks[catalogId("alpha")].payloadDigest);
});

test("canonical external parent IDs cannot alias a local card through a personal-deck prefix", async () => {
  const externalParent = "deck-academic-reviewed-v1-beta.x";
  const { prepared } = await preparedFixture([
    ["alpha", [rawCard(externalParent)]],
    ["beta", [rawCard("x"), rawCard("y", [externalParent])]],
  ]);
  const first = runtime(prepared);
  const result = install(first.store, "beta");
  assert.equal(result.deck.id, "deck-academic-reviewed-v1-beta");
  const local = start(first.store, result.deck.id, "start-local-x");
  assert.equal(local.current_card.card_id, "x");
  grade(first.store, local, "grade-local-x");
  const blocked = start(first.store, result.deck.id, "check-child-still-blocked");
  assert.equal(blocked.session.status, "completed");
  assert.equal(blocked.current_card, undefined);
  const state = first.store.getSnapshot();
  assert.equal(installedDeck(state, "alpha").cards[externalParent].review.repetitions, 0);
  assert.equal(installedDeck(state, "beta").cards.x.review.lastRating, "good");

  const second = runtime(prepared, first.storage.dump());
  const alphaId = installedDeck(second.store.getSnapshot(), "alpha").id;
  const exact = start(second.store, alphaId, "start-exact-external-parent");
  assert.equal(exact.current_card.card_id, externalParent);
  grade(second.store, exact, "grade-exact-external-parent");
  const unlocked = start(second.store, result.deck.id, "start-unlocked-child");
  assert.equal(unlocked.current_card.card_id, "y");
  assert.deepEqual(unlocked.current_card.prerequisite_ids, [externalParent]);
});

test("legacy repair mode respects required first-introduction gates and later exact parent mastery", async () => {
  const { prepared } = await preparedFixture();
  const { store } = runtime(prepared);
  const result = install(store);
  const repair = (key) => store.startStudySession({
    deck_id: result.deck.id, mode: "repair", focus_card_ids: ["gamma.tip"], client_action_id: key,
  });
  const blocked = repair("repair-before-parents");
  assert.equal(blocked.session.status, "completed");
  assert.ok(blocked.current_card == null);
  assert.equal(installedDeck(store.getSnapshot(), "gamma").cards["gamma.tip"].review.repetitions, 0);

  for (const sourceId of ["alpha", "beta", "delta"]) {
    const deckId = installedDeck(store.getSnapshot(), sourceId).id;
    grade(store, start(store, deckId, `start:${sourceId}`), `grade:${sourceId}`);
  }
  const available = repair("repair-after-exact-parents");
  assert.equal(available.session.status, "active");
  assert.equal(available.current_card.id, "gamma.tip");
});

test("adding a personal card cannot rewrite a canonical external parent through a legacy prefix alias", async () => {
  const externalParent = "deck-academic-reviewed-v1-beta.x";
  const { prepared } = await preparedFixture([
    ["alpha", [rawCard(externalParent)]],
    ["beta", [rawCard("x"), rawCard("y", [externalParent])]],
  ]);
  const first = runtime(prepared);
  const result = install(first.store, "beta");
  const addedId = `${result.deck.id}.extra`;
  first.store.addCards({
    deck_id: result.deck.id, expected_deck_revision: result.deck.revision,
    cards: [{ card_id: addedId, term: "Extra synthetic card", definition_md: "An additional personal definition.", required_concepts: ["State the extra definition."], prerequisite_ids: [] }],
    idempotency_key: "add-synthetic-extra",
  });
  for (const store of [first.store, runtime(prepared, first.storage.dump()).store]) {
    const read = readDeck(store, result.deck.id);
    assert.deepEqual(read.deck.cards.map((card) => card.card_id), ["x", "y", addedId]);
    assert.deepEqual(read.deck.cards.find((card) => card.card_id === "y").prerequisite_ids, [externalParent]);
    assert.equal(read.cross_deck_edge_count, 1);
    assert.equal(read.prerequisite_edge_count, 0);
  }
});

test("private fixture maps and source paths never enter prepared state, receipts or deck reads", async () => {
  const { feed, prepared } = await preparedFixture();
  const { store, storage } = runtime(prepared);
  const result = install(store);
  const output = JSON.stringify({
    prepared,
    state: store.getSnapshot(),
    persisted: storage.dump(),
    receipt: result,
    catalog: store.getCatalogSnapshot(),
    deckReads: result.installation.decks.map((record) => readDeck(store, record.deck_id)),
  });
  for (const privateValue of ["synthetic-private-source-canary/", "source_card_index", "source_reference_map", "runtime_identity_map", "artifact_path", "json_pointer"]) {
    assert.equal(output.includes(privateValue), false, privateValue);
  }
  assert.ok(output.includes("private-source-sha256:"), "opaque source references must remain intact");
  assert.equal(feed.audience, "private");
  assert.equal(feed.public_release_approved, false);
  assert.equal(feed.rights_status, "not-cleared");
  assert.equal(feed.current_runtime_compatible, false);
});
