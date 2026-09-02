import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStorage, createStudyStore } from "../js/store.js";
import { preparedFixture, catalogId, FIXTURE_VERSION } from "./helpers/library-fixture.mjs";

const NOW = "2026-08-30T12:00:00.000Z";
const rawCard = (id, prerequisite_ids = []) => ({
  id, term: `Term ${id}`, definition: `Definition ${id}.`,
  required_concepts: [{ id: `${id}.criterion`, text: `State ${id}.` }], prerequisite_ids,
});

async function fixture() {
  const { prepared } = await preparedFixture([
    ["alpha", [rawCard("opaque-parent")]],
    ["beta", [
      {
        ...rawCard("first"), prompt: "  Recall β.\r\n", aliases: ["β", "beta"],
        accepted_variants: [" Alternative β "], source_refs: ["opaque-source"],
        major_error_concepts: [{ rubric_item_id: "beta.error", text: "Avoid α." }],
        tags: ["original"], module_ids: ["module-one"], difficulty_hint: " intro ",
      },
      rawCard("second", ["opaque-parent", "first"]),
    ]],
  ]);
  const storage = createMemoryStorage();
  const store = createStudyStore({ catalog: prepared, storage, clock: () => NOW });
  const installed = store.addLibraryDeck({
    library_deck_id: catalogId("beta"), expected_catalog_version: FIXTURE_VERSION,
    client_action_id: "install:beta",
  });
  return { prepared, store, storage, deckId: installed.deck.id };
}

function v2FromRead(read) {
  const own = new Set(read.deck.cards.map(card => card.card_id));
  return {
    schema_version: "normalized-definition-deck.v2",
    deck_id: read.deck.deck_id, title: read.deck.title,
    cards: read.deck.cards.filter(card => !card.archived).map(card => ({
      id: card.card_id, term: card.term, definition: card.definition_md,
      criteria: card.required_concepts.map(item => item.text),
    })),
    edges: read.deck.cards.flatMap(card => card.prerequisite_ids.filter(id => own.has(id))
      .map(id => ({ from: id, to: card.card_id }))),
  };
}

function firstGrade(store, deckId) {
  const session = store.startStudySession({ deck_id: deckId, limit: 1, idempotency_key: "start:first" });
  const current = session.current_card;
  return store.submitGrade({
    session_id: session.session.session_id, card_id: current.card_id,
    expected_card_revision: current.card_revision, expected_session_revision: session.session.session_revision,
    answer_text: "Synthetic recall test.", answer_origin: "chat", rating: "good",
    rubric_evidence: current.required_concepts.map(item => ({
      rubric_item_id: item.rubric_item_id, status: "met", note: "Synthetic mechanics evidence.",
    })), feedback: "This is a scheduling test, not a grading-quality assessment.", misconceptions: [], confidence: 1,
    idempotency_key: "grade:first",
  });
}

function richAddedCard(deckId, localId) {
  return {
    card_id: `${deckId}.${localId}`, term: "Additional term", definition_md: "Additional definition.",
    prompt: null, aliases: [], required_concepts: [{ rubric_item_id: "extra-criterion", text: "State the additional definition." }],
    accepted_variants: [], major_error_concepts: [], prerequisite_ids: ["first"],
    tags: [], source_refs: [], difficulty_hint: null, module_ids: [], provenance: null, archived: false,
  };
}

test("Library read-to-v2 replacement preserves exact source identity, opaque external requirements, rich fields and recall", async () => {
  const { prepared, store, storage, deckId } = await fixture();
  firstGrade(store, deckId);
  const read = store.getDeck({ scope: "personal", deck_id: deckId });
  const before = store.getSnapshot().personalDecks[deckId];
  const args = {
    operation: "replace", target_deck_id: deckId, expected_deck_revision: read.deck.deck_revision,
    deck: v2FromRead(read),
  };
  const validation = store.validateDeck({ source: "candidate", ...args });
  assert.equal(validation.ingestible, true);
  assert.deepEqual(validation.scheduling_impact.preserved_card_ids, ["first", "second"]);
  assert.deepEqual(validation.scheduling_impact.reset_card_ids, []);
  const result = store.ingestDeck({ ...args, idempotency_key: "replace:unchanged" });
  assert.deepEqual(result.scheduling_impact, validation.scheduling_impact);
  assert.deepEqual(result.added_card_ids, []);
  assert.deepEqual(result.archived_card_ids, []);
  const reloaded = createStudyStore({ catalog: prepared, storage, clock: () => NOW });
  const after = reloaded.getSnapshot().personalDecks[deckId];
  assert.deepEqual(after.cardOrder, before.cardOrder);
  assert.deepEqual(after.libraryBase, before.libraryBase);
  for (const id of before.cardOrder) {
    for (const key of ["id", "definition", "prompt", "aliases", "requiredConcepts", "acceptedVariants", "majorErrorConcepts",
      "tags", "sourceRefs", "moduleIds", "difficultyHint", "prerequisiteIds", "review", "reviewHistory"]) {
      assert.deepEqual(after.cards[id][key], before.cards[id][key], `${id}.${key}`);
    }
  }
  const complete = reloaded.getDeck({ scope: "personal", deck_id: deckId });
  assert.deepEqual(complete.deck.cards.map(card => card.card_id), ["first", "second"]);
  assert.deepEqual(complete.deck.cards[1].prerequisite_ids, ["opaque-parent", "first"]);
  assert.deepEqual(complete.external_prerequisite_deck_ids, [catalogId("alpha")]);
});

test("material replacement resets only changed Library recall and preserves source IDs and immutable base", async () => {
  const { store, deckId } = await fixture();
  firstGrade(store, deckId);
  const read = store.getDeck({ scope: "personal", deck_id: deckId });
  const before = store.getSnapshot().personalDecks[deckId];
  const deck = v2FromRead(read);
  deck.cards[0].definition = "A materially corrected definition.";
  const result = store.ingestDeck({
    operation: "replace", target_deck_id: deckId, expected_deck_revision: read.deck.deck_revision,
    deck, idempotency_key: "replace:material",
  });
  assert.deepEqual(result.scheduling_impact.reset_card_ids, ["first"]);
  assert.deepEqual(result.scheduling_impact.new_card_ids, []);
  assert.deepEqual(result.scheduling_impact.archived_card_ids, []);
  const after = store.getSnapshot().personalDecks[deckId];
  assert.equal(after.cards["first"].review.repetitions, 0);
  assert.equal(after.cards["first"].review.hasSuccessfulRecall, false);
  assert.deepEqual(after.cards["first"].reviewHistory, before.cards["first"].reviewHistory);
  assert.deepEqual(after.libraryBase, before.libraryBase);
});

test("add_cards cannot create a personal-prefixed copy of an existing canonical Library card", async () => {
  const { store, storage, deckId } = await fixture();
  const before = store.getSnapshot();
  const bytes = storage.dump();
  assert.throws(() => store.addCards({
    deck_id: deckId, expected_deck_revision: before.personalDecks[deckId].revision,
    cards: [richAddedCard(deckId, "first")], idempotency_key: "add:alias",
  }), error => error.code === "CARD_EXISTS");
  assert.deepEqual(store.getSnapshot(), before);
  assert.deepEqual(storage.dump(), bytes);
});

test("targeted add and update retain existing canonical cards and exact prerequisites after reload", async () => {
  const { store, storage, prepared, deckId } = await fixture();
  const before = store.getSnapshot().personalDecks[deckId];
  const added = richAddedCard(deckId, "extra");
  const result = store.addCards({
    deck_id: deckId, expected_deck_revision: before.revision,
    cards: [added], idempotency_key: "add:extra",
  });
  store.updateCards({
    deck_id: deckId, expected_deck_revision: result.deck_revision,
    updates: [{ card_id: "first", patch: { tags: ["changed metadata"] } }], idempotency_key: "update:tag",
  });
  const reloaded = createStudyStore({ catalog: prepared, storage, clock: () => NOW });
  const after = reloaded.getDeck({ scope: "personal", deck_id: deckId }).deck;
  assert.deepEqual(after.cards.map(card => card.card_id), ["first", "second", added.card_id]);
  assert.deepEqual(after.cards.at(-1).prerequisite_ids, ["first"]);
  assert.deepEqual(after.cards[1].prerequisite_ids, ["opaque-parent", "first"]);
  assert.deepEqual(reloaded.getSnapshot().personalDecks[deckId].libraryBase, before.libraryBase);
});

test("a new lean-v2 card keeps its personal namespace without renaming retained Library cards", async () => {
  const { store, deckId } = await fixture();
  const read = store.getDeck({ scope: "personal", deck_id: deckId });
  const deck = v2FromRead(read);
  deck.cards.push({ id: "new-term", term: "New term", definition: "New definition.", criteria: ["State it."] });
  deck.edges.push({ from: "first", to: "new-term" });
  const result = store.ingestDeck({
    operation: "replace", target_deck_id: deckId, expected_deck_revision: read.deck.deck_revision,
    deck, idempotency_key: "replace:extra",
  });
  assert.deepEqual(result.added_card_ids, [`${deckId}.new-term`]);
  assert.deepEqual(result.archived_card_ids, []);
  assert.deepEqual(store.getDeck({ scope: "personal", deck_id: deckId }).deck.cards.at(-1).prerequisite_ids, ["first"]);
});

test("non-v2 canonical IDs stay exact through targeted edits and are never silently slugged for replacement", async () => {
  const { prepared } = await preparedFixture([
    ["alpha", [rawCard("alpha.source:one")]],
    ["beta", [rawCard("beta.child", ["alpha.source:one"])]],
  ]);
  const storage = createMemoryStorage();
  const store = createStudyStore({ catalog: prepared, storage, clock: () => NOW });
  const installed = store.addLibraryDeck({
    library_deck_id: catalogId("beta"), expected_catalog_version: FIXTURE_VERSION,
    client_action_id: "install:non-v2-identities",
  });
  const deckId = installed.deck.id;
  const read = store.getDeck({ scope: "personal", deck_id: deckId });
  assert.deepEqual(read.deck.cards.map(card => card.card_id), ["beta.child"]);
  assert.equal(store.validateDeck({ source: "stored", scope: "personal", deck_id: deckId }).ingestible, true);
  const args = {
    operation: "replace", target_deck_id: deckId, expected_deck_revision: read.deck.deck_revision,
    deck: v2FromRead(read),
  };
  const before = store.getSnapshot();
  const bytes = storage.dump();
  assert.equal(store.validateDeck({ source: "candidate", ...args }).ingestible, false);
  assert.throws(() => store.ingestDeck({ ...args, idempotency_key: "invalid-replace" }), error => error.code === "DECK_VALIDATION_BLOCKED");
  assert.deepEqual(store.getSnapshot(), before);
  assert.deepEqual(storage.dump(), bytes);
  store.updateCards({
    deck_id: deckId, expected_deck_revision: read.deck.deck_revision,
    updates: [{ card_id: "beta.child", patch: { definition_md: "Corrected child definition." } }],
    idempotency_key: "targeted:exact-source-id",
  });
  const reloaded = createStudyStore({ catalog: prepared, storage, clock: () => NOW });
  const corrected = reloaded.getDeck({ scope: "personal", deck_id: deckId }).deck.cards[0];
  assert.equal(corrected.card_id, "beta.child");
  assert.equal(corrected.definition_md, "Corrected child definition.");
  assert.deepEqual(corrected.prerequisite_ids, ["alpha.source:one"]);
});
