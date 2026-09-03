import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CATALOG } from "../public/study/data/catalog.js";
import { createAccountSnapshotHydrator } from "../public/study/js/account-snapshot.js";
import { createMemoryStorage, createStudyStore } from "../public/study/js/store.js";
import { WEBMCP_TOOL_NAMES } from "../public/study/js/webmcp.js";

const NOW = "2026-09-02T12:00:00.000Z";

function masteredFutureDeck() {
  const storage = createMemoryStorage();
  const store = createStudyStore({ catalog: CATALOG, storage, clock: () => new Date(NOW) });
  const primary = CATALOG.find((deck) => deck.id === "linear-algebra-i");
  const added = store.addLibraryDeck({
    library_deck_id: primary.id,
    expected_catalog_version: primary.version,
    client_action_id: "preferred-demo:add-primary",
  });
  store.seedDemoState(added.deck.id);
  const seeded = store.seedMasteredDemoDeck();
  return { store, storage, deckId: seeded.deck.id };
}

function reviewProjection(deck) {
  return Object.fromEntries(Object.entries(deck.cards).map(([cardId, card]) => [cardId, card.review]));
}

function cardForAgentId(deck, cardId) {
  return Object.values(deck.cards).find((card) =>
    card.id === cardId || `${deck.id}.${card.id}` === cardId,
  );
}

test("zero-due continuous start keeps every FSRS review byte and orders nearest future work", () => {
  const { store, deckId } = masteredFutureDeck();
  const before = store.getSnapshot();
  const schedulerBefore = store.inspectAppState().scheduler;
  const beforeReviews = reviewProjection(before.personalDecks[deckId]);
  const availability = store.getStudyAvailability({ deck_id: deckId }).decks[0];

  assert.equal(availability.due_count, 0);
  assert.equal(availability.eligible_new_count, 0);
  assert.ok(availability.practice_count > 0);
  assert.ok(new Date(availability.next_due_at) > new Date(NOW));

  const expectedQueue = Object.values(before.personalDecks[deckId].cards)
    .filter((card) => !card.archived && card.review.repetitions > 0 && new Date(card.review.dueAt) > new Date(NOW))
    .sort((left, right) => new Date(left.review.dueAt) - new Date(right.review.dueAt))
    .slice(0, 12)
    .map((card) => card.id);
  const input = {
    deck_id: deckId,
    limit: 12,
    idempotency_key: "preferred-demo:start-future",
  };
  const started = store.startStudySession(input);
  const after = store.getSnapshot();

  assert.equal(started.session.due_segment_total, 0);
  assert.equal(started.session.queue_phase, "continuous");
  assert.equal(started.session.queue_phase_position, 1);
  assert.deepEqual(after.sessions[started.session.session_id].queue, expectedQueue);
  assert.deepEqual(reviewProjection(after.personalDecks[deckId]), beforeReviews);
  assert.deepEqual(store.inspectAppState().scheduler, schedulerBefore);
  assert.equal(schedulerBefore.id, "fsrs-6-default-v1");
  assert.equal(schedulerBefore.desired_retention, 0.9);
});

test("replaying the same continuous start adds no second session or write", () => {
  const { store, storage, deckId } = masteredFutureDeck();
  const input = {
    deck_id: deckId,
    limit: 12,
    idempotency_key: "preferred-demo:replay-future",
  };
  const started = store.startStudySession(input);
  const bytesAfterStart = storage.dump();
  const replayed = store.startStudySession(input);

  assert.equal(replayed.session.session_id, started.session.session_id);
  assert.equal(replayed.receipt.replayed, true);
  assert.deepEqual(storage.dump(), bytesAfterStart);
  assert.equal(Object.keys(store.getSnapshot().sessions).length, 1);
});

test("an answered early-practice card takes one ordinary FSRS transition and exact replay takes none", () => {
  const { store, storage, deckId } = masteredFutureDeck();
  const started = store.startStudySession({
    deck_id: deckId,
    limit: 12,
    idempotency_key: "preferred-demo:start-graded-practice",
  });
  const before = cardForAgentId(store.getSnapshot().personalDecks[deckId], started.current_card.card_id);
  assert.ok(before);
  const input = {
    session_id: started.session.session_id,
    expected_session_revision: started.session.session_revision,
    card_id: started.current_card.card_id,
    expected_card_revision: started.current_card.card_revision,
    answer_text: "Injected provider-free mechanics answer, not learner evidence.",
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: started.current_card.required_concepts.map((item) => ({
      rubric_item_id: item.rubric_item_id,
      status: "met",
      note: "Injected continuous-study mechanics evidence.",
    })),
    feedback: "Injected continuous-study mechanics feedback.",
    misconceptions: [],
    confidence: 1,
    idempotency_key: "preferred-demo:grade-practice",
  };
  const applied = store.submitGrade(input);
  const after = cardForAgentId(store.getSnapshot().personalDecks[deckId], started.current_card.card_id);
  assert.ok(after);

  assert.equal(applied.schedule.previous.due_at, before.review.dueAt);
  assert.equal(applied.schedule.next.repetitions, before.review.repetitions + 1);
  assert.equal(after.review.repetitions, before.review.repetitions + 1);
  assert.equal(after.review.lastReviewedAt, NOW);
  assert.notEqual(after.review.dueAt, before.review.dueAt);
  assert.equal(after.reviewHistory.length, (before.reviewHistory?.length ?? 0) + 1);

  const bytesAfterGrade = storage.dump();
  const replayed = store.submitGrade(input);
  assert.equal(replayed.receipt.replayed, true);
  assert.deepEqual(storage.dump(), bytesAfterGrade);
});

test("the confirmed-account read model retains zero-due practice availability without a write API", async () => {
  const { store, storage, deckId } = masteredFutureDeck();
  const raw = Object.values(storage.dump())[0];
  const hydrate = createAccountSnapshotHydrator(async () => CATALOG);
  const model = await hydrate({
    state_json: raw,
    durable_revision: store.getSnapshot().revision,
    catalog_ref: null,
  });
  const projected = model.reads.getStudyAvailability({ deck_id: deckId });

  assert.equal(model.kind, "confirmed-account-read-model.v1");
  assert.equal(projected.app_revision, model.snapshot.revision);
  assert.equal(projected.decks[0].due_count, 0);
  assert.ok(projected.decks[0].practice_count > 0);
  assert.equal(Object.hasOwn(model.snapshot, "getStudyAvailability"), false);
  assert.equal(Object.values(storage.dump())[0], raw);
});

test("the no-due and completion CTAs explicitly keep optional practice in the selected deck", async () => {
  const app = await readFile(new URL("../public/study/js/app.js", import.meta.url), "utf8");
  const noWork = app.match(/function renderStudyNoWork[\s\S]*?\n}\n\nfunction renderSessionComplete/)?.[0] ?? "";
  const completion = app.match(/function renderSessionComplete[\s\S]*?\n}\n\nfunction emptyState/)?.[0] ?? "";

  assert.match(app, /function isExtraPracticeOnly\(availability\)/);
  assert.match(noWork, /extraPracticeOnly \? "No reviews due"/);
  assert.match(noWork, /extraPracticeOnly \? "Practice anyway"/);
  assert.match(app, /activeExtraPracticeOnly \? "Practice anyway" : "Start studying"/);
  assert.match(completion, /const canContinue = canStartAvailable\(available\);/);
  assert.match(completion, /isExtraPracticeOnly\(available\) \? "Keep practicing" : "Continue studying"/);
  assert.match(completion, /data-start-deck="\$\{escapeAttribute\(deck\.id\)\}" data-continue-study>\$\{continueLabel\}/);
  assert.doesNotMatch(completion, /alternate|continueDeck/);
});

test("the tool guidance and UI preserve the real assessment-feedback-next order", async () => {
  const [app, webmcp, gradingGuide] = await Promise.all([
    readFile(new URL("../public/study/js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/study/js/webmcp.js", import.meta.url), "utf8"),
    readFile(new URL("../public/study/js/grading-guide.js", import.meta.url), "utf8"),
  ]);
  const presentation = app.match(/async function presentStudyGradeCommit[\s\S]*?\n}\n\nasync function handleVisibleEffect/)?.[0] ?? "";

  assert.match(presentation, /renderDefinition\(definition,[\s\S]*?revealStudyCardFaces\(scene\);[\s\S]*?next\.dataset\.advanceStudyCard = "true"/);
  assert.match(presentation, /next\.textContent = nextLabel;[\s\S]*?actions\.replaceChildren\(next\);/);
  assert.match(app, /if \(!completesReveal && view\.querySelector\("\[data-study-advance-pending\]"\)\) return;/);
  assert.match(app, /data-study-live-status[\s\S]*?Review the definition, then choose Next card when you are ready\./);
  assert.match(webmcp, /reveals the just-graded definition and keeps it visible until the learner selects Next card/);
  assert.match(webmcp, /Give the saved specific feedback in chat while that definition is visible/);
  assert.match(webmcp, /Do not introduce the next term or call get_study_session merely to bypass the learner-controlled transition/);
  assert.match(gradingGuide, /keep its definition\/rubric private and do not ask it yet/);
  assert.match(gradingGuide, /the learner explicitly selects Next card before answering the newly displayed term/);
  assert.equal(WEBMCP_TOOL_NAMES.length, 13);
});
