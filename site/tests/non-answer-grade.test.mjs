import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createMemoryStorage as createHostedMemoryStorage,
  createStudyStore as createHostedStudyStore,
} from "../integration/core/js/store.js";
import {
  createMemoryStorage as createPublicMemoryStorage,
  createStudyStore as createPublicStudyStore,
} from "../public/study/js/store.js";

const NOW = "2026-09-03T14:00:00.000Z";
const FORBIDDEN_EVIDENCE_FIELDS = [
  "answer_id",
  "answer_text",
  "answer_origin",
  "rubric_evidence",
  "feedback",
  "misconceptions",
  "confidence",
];
const IMPLEMENTATIONS = [
  { label: "hosted", createMemoryStorage: createHostedMemoryStorage, createStudyStore: createHostedStudyStore },
  { label: "public", createMemoryStorage: createPublicMemoryStorage, createStudyStore: createPublicStudyStore },
];

function fixture(implementation, name) {
  const storage = implementation.createMemoryStorage();
  const store = implementation.createStudyStore({
    catalog: [],
    storage,
    clock: () => new Date(NOW),
  });
  store.ingestDeck({
    operation: "create",
    idempotency_key: `seed:${name}`,
    deck: {
      schema_version: "normalized-definition-deck.v2",
      deck_id: name,
      title: "Non-answer grade fixture",
      cards: [
        {
          id: "term-1",
          term: "Linear independence",
          definition: "No vector is a linear combination of the others.",
          criteria: ["Explains the no-linear-combination condition."],
        },
        {
          id: "term-2",
          term: "Span",
          definition: "All linear combinations of a set of vectors.",
          criteria: ["Explains the linear-combination set."],
        },
      ],
      edges: [],
    },
  });
  const opened = store.startStudySession({
    deck_id: name,
    limit: 2,
    idempotency_key: `start:${name}`,
  });
  return { store, storage, opened };
}

function nonAnswerInput(opened, attemptKind, idempotencyKey) {
  return {
    session_id: opened.session.session_id,
    expected_session_revision: opened.session.session_revision,
    card_id: opened.current_card.card_id,
    expected_card_revision: opened.current_card.card_revision,
    attempt_kind: attemptKind,
    idempotency_key: idempotencyKey,
  };
}

function assertNoFabricatedEvidence(value, context) {
  for (const field of FORBIDDEN_EVIDENCE_FIELDS) {
    assert.equal(Object.hasOwn(value, field), false, `${context} must omit ${field}`);
  }
}

test("canonical store mirrors remain byte-identical", async () => {
  const [hosted, publicStore] = await Promise.all([
    readFile(new URL("../integration/core/js/store.js", import.meta.url)),
    readFile(new URL("../public/study/js/store.js", import.meta.url)),
  ]);
  assert.deepEqual(hosted, publicStore);
});

for (const implementation of IMPLEMENTATIONS) {
  test(`${implementation.label} advertises Reveal and Skip without serializing capabilities`, () => {
    const storage = implementation.createMemoryStorage();
    const store = implementation.createStudyStore({ catalog: [], storage });

    assert.equal(store.getSnapshot().capabilities.revealed_attempts, true);
    assert.equal(store.getSnapshot().capabilities.skipped_attempts, true);
    assert.equal(store.getSnapshot().capabilities.self_grading, true);
    assert.equal(store.inspectAppState().capabilities.revealed_attempts, true);
    assert.equal(store.inspectAppState().capabilities.skipped_attempts, true);
    assert.deepEqual(storage.dump(), {}, "capability reads do not create learner state");
  });

  for (const attemptKind of ["reveal", "skip"]) {
    test(`${implementation.label} ${attemptKind} commits one fixed Again transition and replays exactly`, () => {
      const { store, storage, opened } = fixture(implementation, `${implementation.label}-${attemptKind}`);
      const before = store.getSnapshot();
      const sessionId = opened.session.session_id;
      const sessionBefore = before.sessions[sessionId];
      const deckBefore = before.personalDecks[sessionBefore.deckId];
      const reviewedCardId = sessionBefore.currentCardId;
      const cardBefore = deckBefore.cards[reviewedCardId];
      const input = nonAnswerInput(opened, attemptKind, `${implementation.label}:${attemptKind}:commit`);

      const result = store.submitNonAnswerGrade(input);
      const after = store.getSnapshot();
      const sessionAfter = after.sessions[sessionId];
      const deckAfter = after.personalDecks[sessionAfter.deckId];
      const cardAfter = deckAfter.cards[reviewedCardId];
      const sessionReview = sessionAfter.history.at(-1);
      const cardReview = cardAfter.reviewHistory.at(-1);

      assert.equal(result.receipt.operation, "submit_non_answer_grade");
      assert.equal(result.receipt.replayed, false);
      assert.equal(result.attempt_kind, attemptKind);
      assert.equal(result.answer_revealed, attemptKind === "reveal");
      assert.equal(result.rating, "again");
      const expectedKeys = [
        "answer_revealed",
        "attempt_kind",
        "card_id",
        "card_revision",
        "next_card",
        "rating",
        "receipt",
        "review_id",
        "schedule",
        "session",
        "session_id",
      ];
      if (attemptKind === "reveal") expectedKeys.push("reviewed_card");
      assert.deepEqual(Object.keys(result).sort(), expectedKeys.sort());
      assert.equal(Object.hasOwn(result, "reviewed_card"), attemptKind === "reveal");
      assertNoFabricatedEvidence(result, "result");

      assert.equal(after.revision, before.revision + 1);
      assert.equal(deckAfter.revision, deckBefore.revision + 1);
      assert.equal(sessionAfter.revision, sessionBefore.revision + 1);
      assert.equal(sessionAfter.cursor, sessionBefore.cursor + 1);
      assert.equal(sessionAfter.reviewsApplied, sessionBefore.reviewsApplied + 1);
      assert.equal(sessionAfter.history.length, sessionBefore.history.length + 1);
      assert.equal(cardAfter.reviewHistory.length, cardBefore.reviewHistory.length + 1);
      assert.equal(cardAfter.review.repetitions, cardBefore.review.repetitions + 1);
      assert.equal(cardAfter.review.lastRating, "again");
      assert.equal(result.schedule.previous.repetitions, cardBefore.review.repetitions);
      assert.equal(result.schedule.next.repetitions, cardBefore.review.repetitions + 1);
      assert.equal(result.schedule.next.last_rating, "again");

      for (const review of [sessionReview, cardReview]) {
        assert.equal(review.reviewId, result.review_id);
        assert.equal(review.attempt_kind, attemptKind);
        assert.equal(review.answer_revealed, attemptKind === "reveal");
        assert.equal(review.rating, "again");
        assertNoFabricatedEvidence(review, "canonical review");
      }
      const receiptResult = after.actionReceipts[`webmcp:${input.idempotency_key}`].result;
      assert.equal(receiptResult.receipt.operation, "submit_non_answer_grade");
      assertNoFabricatedEvidence(receiptResult, "stored receipt");

      const committedBytes = storage.dump();
      const replay = store.submitNonAnswerGrade(input);
      assert.equal(replay.review_id, result.review_id);
      assert.equal(replay.receipt.replayed, true);
      assert.deepEqual(storage.dump(), committedBytes, "an exact replay performs no second write");
      const replayedState = store.getSnapshot();
      assert.equal(replayedState.revision, after.revision);
      assert.equal(replayedState.sessions[sessionId].reviewsApplied, sessionAfter.reviewsApplied);
      assert.equal(replayedState.personalDecks[sessionAfter.deckId].cards[reviewedCardId].reviewHistory.length,
        cardAfter.reviewHistory.length);

      assert.throws(
        () => store.submitNonAnswerGrade({
          ...input,
          attempt_kind: attemptKind === "reveal" ? "skip" : "reveal",
        }),
        (error) => error?.code === "IDEMPOTENCY_CONFLICT",
      );
      assert.deepEqual(storage.dump(), committedBytes, "an idempotency conflict performs no write");

      const persisted = JSON.parse(Object.values(storage.dump())[0]);
      assert.equal(Object.hasOwn(persisted, "capabilities"), false,
        "runtime capabilities stay outside serialized learner state");
    });
  }

  test(`${implementation.label} accepts only the approved non-answer request shape`, () => {
    const { store, storage, opened } = fixture(implementation, `${implementation.label}-closed-input`);
    const input = nonAnswerInput(opened, "reveal", `${implementation.label}:closed-input`);
    const before = storage.dump();

    assert.throws(
      () => store.submitNonAnswerGrade({ ...input, rating: "easy" }),
      (error) => error?.code === "UNKNOWN_FIELD",
    );
    assert.throws(
      () => store.submitNonAnswerGrade({ ...input, answer_text: "Fabricated answer" }),
      (error) => error?.code === "UNKNOWN_FIELD",
    );
    assert.throws(
      () => store.submitNonAnswerGrade({ ...input, attempt_kind: "answer" }),
      (error) => error?.code === "INVALID_ARGUMENT",
    );
    assert.deepEqual(storage.dump(), before, "rejected requests perform no learner-state write");
  });
}
