import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryStorage, createStudyStore } from "../integration/core/js/store.js";

function fixture(name) {
  const store = createStudyStore({
    catalog: [],
    storage: createMemoryStorage(),
    clock: () => new Date("2026-09-03T14:00:00.000Z"),
  });
  store.ingestDeck({
    operation: "create",
    idempotency_key: `seed:${name}`,
    deck: {
      schema_version: "normalized-definition-deck.v2",
      deck_id: name,
      title: "Manual grading fixture",
      cards: [{
        id: "term-1",
        term: "Linear independence",
        definition: "No vector is a linear combination of the others.",
        criteria: ["Explains the no-linear-combination condition."],
      }],
      edges: [],
    },
  });
  const opened = store.startStudySession({
    deck_id: name,
    limit: 1,
    idempotency_key: `start:${name}`,
  });
  return { store, opened };
}

function selfGradeInput(current, idempotencyKey = "self-grade:one") {
  return {
    session_id: current.session.session_id,
    expected_session_revision: current.session.session_revision,
    card_id: current.current_card.card_id,
    expected_card_revision: current.current_card.card_revision,
    rating: "good",
    idempotency_key: idempotencyKey,
  };
}

function agentGradeInput(current, idempotencyKey = "agent-grade:one") {
  return {
    session_id: current.session.session_id,
    expected_session_revision: current.session.session_revision,
    card_id: current.current_card.card_id,
    expected_card_revision: current.current_card.card_revision,
    answer_text: "They are independent when none can be made from the others.",
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: current.current_card.required_concepts.map((item) => ({
      rubric_item_id: item.rubric_item_id,
      status: "met",
      note: "The learner stated the required condition.",
    })),
    feedback: "Correct.",
    misconceptions: [],
    confidence: 1,
    idempotency_key: idempotencyKey,
  };
}

test("submitSelfGrade stores a typed learner choice without fabricated answer evidence", () => {
  const { store, opened } = fixture("manual-self-grade-contract");
  const input = selfGradeInput(opened);
  const result = store.submitSelfGrade(input);

  assert.equal(result.grading_mode, "self");
  assert.equal(result.answer_revealed, true);
  assert.equal(result.rating, "good");
  assert.equal(result.receipt.operation, "submit_self_grade");
  for (const field of ["answer_id", "answer_text", "answer_origin", "rubric_evidence", "feedback", "misconceptions", "confidence"]) {
    assert.equal(Object.hasOwn(result, field), false, `${field} is agent evidence and must be absent`);
  }

  const session = store.getSnapshot().sessions[opened.session.session_id];
  const review = session.history.at(-1);
  assert.equal(session.reviewsApplied, 1);
  assert.equal(review.grading_mode, "self");
  assert.equal(review.answer_revealed, true);
  assert.equal(review.rating, "good");
  assert.equal(Object.hasOwn(review, "answer_text"), false);

  const replay = store.submitSelfGrade(input);
  assert.equal(replay.review_id, result.review_id);
  assert.equal(replay.receipt.replayed, true);
  assert.equal(store.getSnapshot().sessions[opened.session.session_id].reviewsApplied, 1);
  assert.throws(
    () => store.submitSelfGrade({ ...input, rating: "easy" }),
    (error) => error?.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("agent and self-grade races can commit only one review", () => {
  const selfFirst = fixture("manual-race-self-first");
  const selfCurrent = selfFirst.opened;
  selfFirst.store.submitSelfGrade(selfGradeInput(selfCurrent, "race:self-first"));
  assert.throws(
    () => selfFirst.store.submitGrade(agentGradeInput(selfCurrent, "race:agent-late")),
    (error) => ["SESSION_NOT_ACTIVE", "INVALID_SESSION_PHASE", "STALE_REVISION"].includes(error?.code),
  );
  assert.equal(selfFirst.store.getSnapshot().sessions[selfCurrent.session.session_id].reviewsApplied, 1);

  const agentFirst = fixture("manual-race-agent-first");
  const agentCurrent = agentFirst.opened;
  agentFirst.store.submitGrade(agentGradeInput(agentCurrent, "race:agent-first"));
  assert.throws(
    () => agentFirst.store.submitSelfGrade(selfGradeInput(agentCurrent, "race:self-late")),
    (error) => ["SESSION_NOT_ACTIVE", "INVALID_SESSION_PHASE", "STALE_REVISION"].includes(error?.code),
  );
  assert.equal(agentFirst.store.getSnapshot().sessions[agentCurrent.session.session_id].reviewsApplied, 1);
});
