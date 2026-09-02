import test from "node:test";
import assert from "node:assert/strict";
import { createStudyStore, createMemoryStorage } from "../js/store.js";
import { registerWebMCPTools, WEBMCP_TOOL_NAMES } from "../js/webmcp.js";
import { preparedFixture, catalogId, FIXTURE_VERSION } from "./helpers/library-fixture.mjs";

const PARENT = "source.parent:foundation";
const CHILD = "source.child:dependent";
const rawCard = (id, prerequisite_ids = []) => ({
  id, term: `Term ${id}`, definition: `Canonical **${id}** definition.`,
  required_concepts: [{ id: `${id}.criterion`, text: "State the canonical definition." }], prerequisite_ids,
});

async function fixture() {
  const { prepared } = await preparedFixture([
    ["alpha", [rawCard(PARENT)]], ["beta", [rawCard(CHILD, [PARENT])]],
  ]);
  const storage = createMemoryStorage();
  const store = createStudyStore({ catalog: prepared, storage, clock: () => "2026-08-30T12:00:00.000Z" });
  const installed = store.addLibraryDeck({
    library_deck_id: catalogId("beta"), expected_catalog_version: FIXTURE_VERSION, client_action_id: "install:wire",
  });
  const effects = [];
  const definitions = [];
  const hadDocument = Object.hasOwn(globalThis, "document");
  const previous = globalThis.document;
  try {
    globalThis.document = { modelContext: { registerTool(tool) { definitions.push(tool); } } };
    const registration = await registerWebMCPTools({ store, onVisibleEffect: effect => effects.push(effect) });
    assert.equal(registration.supported, true);
  } finally {
    if (hadDocument) globalThis.document = previous;
    else delete globalThis.document;
  }
  assert.deepEqual(definitions.map(tool => tool.name), [...WEBMCP_TOOL_NAMES]);
  assert.equal(definitions.length, 13);
  const invoke = (name, args = {}) => definitions.find(tool => tool.name === name).execute(args);
  return { store, storage, effects, invoke, parentId: installed.installation.decks[0].deck_id, childId: installed.deck.id };
}

test("actual 13-tool registration accepts complete canonical Library cards and summary-only browsing", async () => {
  const f = await fixture();
  const before = f.storage.dump();
  const listing = await f.invoke("search_library", {});
  assert.equal(listing.ok, true);
  assert.equal(listing.data.items.length, 2);
  assert.ok(listing.data.items.every(item => !Object.hasOwn(item, "cards")));
  const mine = await f.invoke("list_my_decks", {});
  assert.equal(mine.ok, true);
  assert.equal(mine.data.items.length, 2);
  for (const [scope, deck_id] of [["library", catalogId("beta")], ["personal", f.childId]]) {
    const read = await f.invoke("get_deck", { scope, deck_id });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.data.complete, true);
    assert.equal(read.data.deck.cards[0].card_id, CHILD);
    assert.deepEqual(read.data.deck.cards[0].prerequisite_ids, [PARENT]);
    assert.equal(read.data.deck.cards[0].required_concepts[0].rubric_item_id, `${CHILD}.criterion`);
    assert.deepEqual(read.data.external_prerequisite_deck_ids, [catalogId("alpha")]);
  }
  const validation = await f.invoke("validate_deck", { source: "stored", scope: "personal", deck_id: f.childId });
  assert.equal(validation.ok, true);
  assert.equal(validation.data.ingestible, true);
  assert.deepEqual(f.storage.dump(), before);
  assert.deepEqual(f.effects, []);
});

test("registered study actions enforce required parents, commit one canonical grade and return one full reveal without navigation", async () => {
  const f = await fixture();
  const view = f.store.getSnapshot().view;
  const blocked = await f.invoke("start_study_session", { deck_id: f.childId, idempotency_key: "start:blocked" });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.data.session.status, "completed");
  assert.equal(blocked.data.current_card, undefined);
  const started = await f.invoke("start_study_session", { deck_id: f.parentId, limit: 1, idempotency_key: "start:parent" });
  assert.equal(started.ok, true, JSON.stringify(started));
  const current = started.data.current_card;
  assert.equal(current.card_id, PARENT);
  const args = {
    session_id: started.data.session.session_id, card_id: current.card_id,
    expected_session_revision: started.data.session.session_revision, expected_card_revision: current.card_revision,
    answer_text: "Synthetic recall attempt.", answer_origin: "chat", rating: "good",
    rubric_evidence: current.required_concepts.map(item => ({ rubric_item_id: item.rubric_item_id, status: "met", note: "Synthetic mechanics test." })),
    feedback: "Injected grade, not a semantic grading evaluation.", misconceptions: [], confidence: 1, idempotency_key: "grade:parent",
  };
  const graded = await f.invoke("submit_grade", args);
  assert.equal(graded.ok, true, JSON.stringify(graded));
  const gradeEffects = f.effects.filter(effect => effect.type === "study_grade_committed");
  assert.equal(gradeEffects.length, 1);
  assert.equal(gradeEffects[0].reviewed_card.card_id, PARENT);
  assert.equal(gradeEffects[0].reviewed_card.definition_md, current.definition_md);
  const committed = f.storage.dump();
  const effectCount = f.effects.length;
  const replayed = await f.invoke("submit_grade", args);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.data.review_id, graded.data.review_id);
  assert.equal(f.effects.length, effectCount);
  assert.deepEqual(f.storage.dump(), committed);
  const child = await f.invoke("start_study_session", { deck_id: f.childId, limit: 1, idempotency_key: "start:child" });
  assert.equal(child.ok, true, JSON.stringify(child));
  assert.equal(child.data.current_card.card_id, CHILD);
  const inspected = await f.invoke("get_study_session", { session_id: child.data.session.session_id });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.data.current_card.definition_md, child.data.current_card.definition_md);
  assert.deepEqual(f.store.getSnapshot().view, view);
  assert.equal(f.store.getSnapshot().personalDecks[f.parentId].cards[PARENT].review.repetitions, 1);
});

test("registered targeted edits accept exact source IDs and reject legacy prefix aliases without side effects", async () => {
  const f = await fixture();
  const before = f.store.getSnapshot();
  const bytes = f.storage.dump();
  const bad = await f.invoke("update_cards", {
    deck_id: f.childId, expected_deck_revision: before.personalDecks[f.childId].revision,
    updates: [{ card_id: `${f.childId}.${CHILD}`, patch: { tags: ["wrong identity"] } }], idempotency_key: "update:alias",
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "CARD_NOT_FOUND");
  assert.deepEqual(f.storage.dump(), bytes);
  assert.deepEqual(f.effects, []);
  const good = await f.invoke("update_cards", {
    deck_id: f.childId, expected_deck_revision: before.personalDecks[f.childId].revision,
    updates: [{ card_id: CHILD, patch: { tags: ["exact identity"] } }], idempotency_key: "update:exact",
  });
  assert.equal(good.ok, true, JSON.stringify(good));
  const read = await f.invoke("get_deck", { scope: "personal", deck_id: f.childId });
  assert.equal(read.data.deck.cards[0].card_id, CHILD);
  assert.deepEqual(read.data.deck.cards[0].prerequisite_ids, [PARENT]);
  assert.deepEqual(read.data.deck.cards[0].tags, ["exact identity"]);
  assert.deepEqual(f.store.getSnapshot().view, before.view);
  assert.equal(f.effects.length, 1);
});
