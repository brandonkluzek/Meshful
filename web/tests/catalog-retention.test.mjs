import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { CATALOG } from "../data/catalog.js";
import { createMemoryStorage, createStudyStore } from "../js/store.js";
import { prepareLibraryCatalog } from "../js/library-catalog.js";
import { catalogId, preparedFixture } from "./helpers/library-fixture.mjs";

const KEY = "adaptive-study-lab:web-state:v1";
const NOW = "2026-08-30T12:00:00.000Z";
const V1 = "synthetic-retained.v1";
const V2 = "synthetic-retained.v2";
const clock = () => NOW;
const canonicalJson = (value) => Array.isArray(value)
  ? `[${value.map(canonicalJson).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);

function card(id, prerequisite_ids = []) {
  return { id, term: id, definition: `Synthetic definition of ${id}.`, prerequisite_ids, required_concepts: ["State the definition."] };
}

async function release(version, definitions = [["alpha", [card("alpha.one"), card("alpha.two")]], ["beta", [card("beta.child", ["alpha.one"])]]]) {
  const { feed } = await preparedFixture(definitions);
  const next = structuredClone(feed);
  next.catalog_ref.version = version;
  for (const deck of next.catalog) {
    deck.version = version;
    deck.title = `${deck.title} ${version}`;
    for (const item of deck.cards) item.definition = `${item.definition} ${version}`;
  }
  for (const entry of next.runtime_identity_map.decks) entry.catalog_deck_version = version;
  next.catalog_ref.digest = `sha256:${createHash("sha256").update(canonicalJson(next.catalog)).digest("hex")}`;
  return prepareLibraryCatalog(next);
}

function trackedStorage(initial = {}) {
  const backing = createMemoryStorage(initial);
  return {
    writes: 0,
    getItem: (key) => backing.getItem(key),
    setItem(key, value) { this.writes += 1; backing.setItem(key, value); },
    removeItem: (key) => backing.removeItem(key),
  };
}

function install(store, prepared, sourceId = "beta", key = `install:${sourceId}`) {
  return store.addLibraryDeck({ library_deck_id: catalogId(sourceId),
    expected_catalog_version: prepared.library.catalogRef.version, client_action_id: key });
}

function installed(store, sourceId) {
  return Object.values(store.getSnapshot().personalDecks).find((deck) => deck.source?.catalogDeckId === catalogId(sourceId));
}

function start(store, deckId, key = "start") {
  return store.startStudySession({ deck_id: deckId, limit: 20, idempotency_key: key });
}

function grade(store, started, key = "grade") {
  const current = started.current_card;
  return store.submitGrade({ session_id: started.session.session_id, card_id: current.card_id,
    expected_card_revision: current.card_revision, expected_session_revision: started.session.session_revision,
    answer_text: "Synthetic recall attempt.", answer_origin: "chat", rating: "good",
    rubric_evidence: current.required_concepts.map((item) => ({ rubric_item_id: item.rubric_item_id, status: "met", note: "Synthetic mechanics fixture." })),
    feedback: "Synthetic transition, not learner-outcome evidence.", misconceptions: [], confidence: 1, idempotency_key: key });
}

function unchangedFailure(storage, operation, code) {
  const bytes = storage.getItem(KEY);
  const writes = storage.writes;
  assert.throws(operation, { code });
  assert.equal(storage.getItem(KEY), bytes);
  assert.equal(storage.writes, writes);
}

test("all three saved examples, labeled mastery, history and current queue survive a 72-entry active catalog", async () => {
  const storage = trackedStorage();
  const legacy = createStudyStore({ catalog: CATALOG, storage, clock });
  const linear = CATALOG.find((deck) => deck.id === "linear-algebra-i");
  const added = legacy.addLibraryDeck({ library_deck_id: linear.id, expected_catalog_version: linear.version, client_action_id: "legacy-linear" });
  legacy.seedDemoState(added.deck.id);
  assert.equal(legacy.seedMasteredDemoDeck().added, true);
  for (const deck of CATALOG) legacy.addLibraryDeck({ library_deck_id: deck.id, expected_catalog_version: deck.version, client_action_id: `legacy:${deck.id}` });
  const session = start(legacy, added.deck.id, "legacy-session");
  grade(legacy, session, "legacy-grade");
  const before = legacy.getSnapshot();
  const bytes = storage.getItem(KEY);
  const writes = storage.writes;
  const active = await release(V2, Array.from({ length: 72 }, (_, index) => [`course-${index}`, [card(`course-${index}.term`)]]));
  const current = createStudyStore({ catalog: active, retainedCatalogs: [CATALOG], storage, clock });
  assert.deepEqual(current.getSnapshot(), before);
  assert.equal(storage.getItem(KEY), bytes);
  assert.equal(storage.writes, writes);
  assert.equal(current.searchLibrary({}, { source: "webmcp" }).total_matching, 72);
  assert.equal(current.getCatalogSnapshot().length, 72);
  assert.equal(Object.keys(before.personalDecks).length, 3);
  assert.ok(Object.values(before.personalDecks["deck-introductory-mechanics"].cards).every((item) => item.review.demoSeeded));
  assert.ok(before.personalDecks[added.deck.id].cards[session.current_card.card_id.replace(`${added.deck.id}.`, "")].reviewHistory.length);
  current.setView({ route: "decks" });
  const serialized = JSON.parse(storage.getItem(KEY));
  assert.ok(Object.values(serialized.personalDecks).every((deck) => deck.persistenceKind === "catalog-overlay-v1" && deck.catalogVersion === "1.0.0-example"));
  const reloaded = createStudyStore({ catalog: active, retainedCatalogs: [CATALOG], storage, clock });
  assert.deepEqual(reloaded.getSnapshot().personalDecks, before.personalDecks);
  assert.deepEqual(reloaded.getSnapshot().sessions, before.sessions);
  assert.deepEqual(reloaded.getSnapshot().activity, before.activity);
  assert.deepEqual(reloaded.getSnapshot().streak, before.streak);
});

test("a retained v1 queue grades, replays and reloads against v1 while same-ID Library reads show v2", async () => {
  const [old, active] = await Promise.all([release(V1), release(V2)]);
  const storage = trackedStorage();
  const previous = createStudyStore({ catalog: old, storage, clock });
  install(previous, old);
  const alpha = installed(previous, "alpha");
  grade(previous, start(previous, alpha.id, "old-session"), "old-first-grade");
  const before = previous.getSnapshot();
  const bytes = storage.getItem(KEY);
  const current = createStudyStore({ catalog: active, retainedCatalogs: [old], storage, clock });
  assert.deepEqual(current.getSnapshot(), before);
  assert.equal(storage.getItem(KEY), bytes);
  assert.equal(current.getDeck({ scope: "personal", deck_id: alpha.id }).deck.version, V1);
  assert.equal(current.getDeck({ scope: "library", deck_id: catalogId("alpha") }).deck.version, V2);
  assert.equal(current.searchLibrary({ query: V1 }, { source: "webmcp" }).total_matching, 0);
  assert.equal(current.searchLibrary({ query: V2 }, { source: "webmcp" }).total_matching, 2);
  assert.equal(current.searchLibrary({ query: V1 }).total, 0);
  assert.ok(current.getCatalogSnapshot().every((deck) => deck.version === V2));
  const next = current.getStudySession({ session_id: before.activeSessionId });
  assert.equal(next.current_card.card_id, "alpha.two");
  assert.match(next.current_card.definition_md, /synthetic-retained\.v1$/);
  const receipt = grade(current, next, "retained-second-grade");
  const after = current.getSnapshot();
  const persisted = JSON.parse(storage.getItem(KEY)).personalDecks[alpha.id];
  assert.equal(persisted.catalogVersion, V1);
  assert.equal(persisted.catalogDigest, JSON.parse(bytes).personalDecks[alpha.id].catalogDigest);
  const reloaded = createStudyStore({ catalog: active, retainedCatalogs: [old], storage, clock });
  assert.deepEqual(reloaded.getSnapshot(), after);
  const replayBytes = storage.getItem(KEY);
  assert.equal(grade(reloaded, next, "retained-second-grade").review_id, receipt.review_id);
  assert.equal(storage.getItem(KEY), replayBytes);
  assert.equal(installed(reloaded, "alpha").cards["alpha.one"].reviewHistory.length, 1);
  assert.equal(installed(reloaded, "alpha").cards["alpha.two"].reviewHistory.length, 1);
});

test("new installs use only the active closure, and cannot silently upgrade an installed edition", async () => {
  const [old, active] = await Promise.all([release(V1), release(V2)]);
  const storage = trackedStorage();
  const previous = createStudyStore({ catalog: old, storage, clock });
  install(previous, old);
  const current = createStudyStore({ catalog: active, retainedCatalogs: [old, CATALOG], storage, clock });
  unchangedFailure(storage, () => install(current, active, "beta", "do-not-upgrade"), "LIBRARY_DEPENDENCY_CONFLICT");
  unchangedFailure(storage, () => install(current, old, "beta", "no-old-installs"), "STALE_CATALOG_VERSION");
  unchangedFailure(storage, () => current.addLibraryDeck({ library_deck_id: "linear-algebra-i", expected_catalog_version: "1.0.0-example", client_action_id: "no-hidden-installs" }), "CATALOG_DECK_NOT_FOUND");
  const freshStorage = trackedStorage();
  const fresh = createStudyStore({ catalog: active, retainedCatalogs: [old, CATALOG], storage: freshStorage, clock });
  const result = install(fresh, active);
  assert.equal(freshStorage.writes, 1);
  assert.ok(result.installation.decks.every((deck) => deck.catalog_version === V2));
  assert.deepEqual(result.installation.catalog_ref, active.library.catalogRef);
  assert.ok(Object.values(fresh.getSnapshot().personalDecks).every((deck) => Object.values(deck.cards).every((item) => item.review.repetitions === 0 && !item.reviewHistory.length)));
});

test("saved get_deck and required-parent gates use the saved release's owner, not a new same-ID owner", async () => {
  const old = await release(V1, [["alpha", [card("root")]], ["beta", [card("child", ["root"])]], ["gamma", [card("spare")]]]);
  const active = await release(V2, [["alpha", [card("spare")]], ["beta", [card("child", ["root"])]], ["gamma", [card("root")]]]);
  const storage = trackedStorage();
  const previous = createStudyStore({ catalog: old, storage, clock });
  install(previous, old);
  const alpha = installed(previous, "alpha");
  const beta = installed(previous, "beta");
  grade(previous, start(previous, alpha.id, "parent-start"), "parent-grade");
  const current = createStudyStore({ catalog: active, retainedCatalogs: [old], storage, clock });
  assert.deepEqual(current.getDeck({ scope: "personal", deck_id: beta.id }).external_prerequisite_deck_ids, [catalogId("alpha")]);
  assert.deepEqual(current.getDeck({ scope: "library", deck_id: catalogId("beta") }).external_prerequisite_deck_ids, [catalogId("gamma")]);
  assert.equal(start(current, beta.id, "old-child").current_card.card_id, "child");
});

test("a reviewed v2 parent with the same card/deck IDs cannot satisfy an in-flight v1 child's gate", async () => {
  const definitions = [["alpha", [card("root")]], ["beta", [card("child", ["root"])]]];
  const [old, active] = await Promise.all([release(V1, definitions), release(V2, definitions)]);
  const oldStore = createStudyStore({ catalog: old, storage: createMemoryStorage(), clock });
  install(oldStore, old);
  const alpha = installed(oldStore, "alpha");
  const beta = installed(oldStore, "beta");
  grade(oldStore, start(oldStore, alpha.id, "old-parent"), "old-parent-grade");
  const child = start(oldStore, beta.id, "old-child");
  const v2Store = createStudyStore({ catalog: active, storage: createMemoryStorage(), clock });
  install(v2Store, active);
  grade(v2Store, start(v2Store, installed(v2Store, "alpha").id, "new-parent"), "new-parent-grade");
  // Explicit synthetic recovered state: exact v1 child and current queue,
  // but its only same-ID parent is the different, successfully reviewed v2 base.
  const mixed = oldStore.getSnapshot();
  mixed.personalDecks[alpha.id] = installed(v2Store, "alpha");
  const storage = trackedStorage({ [KEY]: JSON.stringify(mixed) });
  const current = createStudyStore({ catalog: active, retainedCatalogs: [old], storage, clock });
  unchangedFailure(storage, () => current.getStudySession({ session_id: child.session.session_id }), "PREREQUISITE_NOT_SATISFIED");
  unchangedFailure(storage, () => grade(current, child, "wrong-edition-grade"), "PREREQUISITE_NOT_SATISFIED");
  assert.equal(installed(current, "beta").cards.child.review.repetitions, 0);
});

for (const dense of [false, true]) {
  test(`${dense ? "dense" : "sparse"} saved bases fail closed when missing or drifted without a learner write`, async () => {
    const [old, active] = await Promise.all([release(V1), release(V2)]);
    const source = trackedStorage();
    const previous = createStudyStore({ catalog: old, storage: source, clock });
    install(previous, old);
    const saved = dense ? JSON.stringify(previous.getSnapshot()) : source.getItem(KEY);
    const storage = trackedStorage({ [KEY]: saved });
    unchangedFailure(storage, () => createStudyStore({ catalog: active, storage, clock }), "CATALOG_BASE_UNAVAILABLE");
    const drifted = await release(V1, [["alpha", [{ ...card("alpha.one"), definition: "Drifted target." }, card("alpha.two")]], ["beta", [card("beta.child", ["alpha.one"])]]]);
    unchangedFailure(storage, () => createStudyStore({ catalog: active, retainedCatalogs: [drifted], storage, clock }), "CATALOG_BASE_UNAVAILABLE");
    const restored = createStudyStore({ catalog: active, retainedCatalogs: [old], storage, clock });
    assert.deepEqual(restored.getSnapshot(), previous.getSnapshot());
    assert.equal(storage.writes, 0);
    restored.setView({ route: "decks" });
    assert.ok(Object.values(JSON.parse(storage.getItem(KEY)).personalDecks).every((deck) => deck.persistenceKind === "catalog-overlay-v1" && deck.catalogVersion === V1));
  });
}

test("sparse top-level identity hydrates even without the redundant libraryBase metadata copy", async () => {
  const [old, active] = await Promise.all([release(V1), release(V2)]);
  const source = createMemoryStorage();
  const previous = createStudyStore({ catalog: old, storage: source, clock });
  install(previous, old);
  const persisted = JSON.parse(source.getItem(KEY));
  for (const deck of Object.values(persisted.personalDecks)) delete deck.deckFields.libraryBase;
  const raw = JSON.stringify(persisted);
  const storage = trackedStorage({ [KEY]: raw });
  const current = createStudyStore({ catalog: active, retainedCatalogs: [old], storage, clock });
  assert.deepEqual(current.getSnapshot(), previous.getSnapshot());
  assert.equal(storage.getItem(KEY), raw);
  assert.equal(storage.writes, 0);
});

test("retention remains per-store even when prepared catalog normalization is cached", async () => {
  const [old, active] = await Promise.all([release(V1), release(V2)]);
  const storage = createMemoryStorage();
  const previous = createStudyStore({ catalog: old, storage, clock });
  install(previous, old);
  const held = createStudyStore({ catalog: active, retainedCatalogs: [old], storage, clock });
  createStudyStore({ catalog: active, retainedCatalogs: [CATALOG], storage: createMemoryStorage(), clock });
  assert.equal(held.getDeck({ scope: "personal", deck_id: installed(held, "beta").id }).deck.version, V1);
  grade(held, start(held, installed(held, "alpha").id, "isolated-start"), "isolated-grade");
  grade(held, held.getStudySession({ session_id: held.getSnapshot().activeSessionId }), "isolated-next-grade");
  assert.equal(start(held, installed(held, "beta").id, "isolated-child").current_card.card_id, "beta.child");
});

test("retained inputs still require genuine preparation and reject conflicting same-version bytes", async () => {
  const [old, active] = await Promise.all([release(V1), release(V2)]);
  const storage = trackedStorage();
  unchangedFailure(storage, () => createStudyStore({ catalog: active, retainedCatalogs: [structuredClone(old)], storage, clock }), "INVALID_LIBRARY_CATALOG");
  unchangedFailure(storage, () => createStudyStore({ catalog: active, retainedCatalogs: old, storage, clock }), "INVALID_CATALOG");
  const changed = await release(V1, [["alpha", [card("different")]]]);
  unchangedFailure(storage, () => createStudyStore({ catalog: active, retainedCatalogs: [old, changed], storage, clock }), "INVALID_CATALOG");
  assert.doesNotThrow(() => createStudyStore({ catalog: active, retainedCatalogs: [old, old], storage, clock }));
  assert.equal(storage.writes, 0);
});
