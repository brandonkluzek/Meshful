import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryStorage, createStudyStore } from "../js/store.js";

const NOW = "2026-08-31T12:00:00.000Z";
const KEY = "adaptive-study-lab:web-state:v1";
const ZONE = "America/Chicago";

// Deliberately ambiguous, synthetic dense recovery input. This is not authored
// deck acceptance, learner data, or permission to change review matching.
function recoveryFixture(entries) {
  const row = {
    reviewId: "review-alias-diagnostic", cardRevision: 1,
    submittedAt: NOW, rating: "good",
  };
  const raw = {
    schemaVersion: 1, revision: 7, updatedAt: NOW,
    personalDecks: {
      edge: {
        id: "edge", title: "Synthetic alias progress", revision: 1,
        archived: false, createdAt: NOW, updatedAt: NOW,
        cardOrder: entries.map(([id]) => id), edges: [],
        cards: Object.fromEntries(entries.map(([id, repetitions]) => [id, {
          id, term: "Synthetic a", archived: false, contentRevision: 1,
          review: { repetitions, lastReviewedAt: NOW, lastRating: "good" },
          reviewHistory: [structuredClone(row)],
        }])),
      },
    },
    sessions: {
      "alias-session": {
        id: "alias-session", deckId: "edge", mode: "scheduled", revision: 2,
        queue: ["edge.a"], cursor: 1, currentCardId: null,
        status: "completed", phase: "complete", capture: null,
        startedAt: NOW, updatedAt: NOW, finishedAt: NOW, reviewsApplied: 1,
        history: [{
          reviewId: row.reviewId, cardId: "edge.a", cardRevision: 1,
          transition: "grade_submitted", at: NOW, rating: "good",
        }],
      },
    },
    activeSessionId: null,
    streak: { current: 0, longest: 0, lastActivityDate: null },
    activity: [], view: { route: "study", selectedDeckId: "edge" },
    actionReceipts: {}, actionReceiptOrder: [],
  };
  const bytes = `${JSON.stringify(raw, null, 2)}\n`;
  const memory = createMemoryStorage({ [KEY]: bytes, "synthetic-unrelated-key": "preserve verbatim" });
  let writes = 0;
  const storage = {
    ...memory,
    setItem(key, value) { writes += 1; memory.setItem(key, value); },
    removeItem(key) { writes += 1; memory.removeItem(key); },
  };
  const open = () => createStudyStore({ catalog: [], storage, clock: () => NOW, timeZone: ZONE });
  return { store: open(), storage, open, raw, bytes, writes: () => writes };
}

function assertDiagnosticRead(f, expectedIssues) {
  const before = f.store.getSnapshot();
  const bytes = f.storage.dump();
  const result = f.store.getStudyActivity({ days: 1 });
  const expectedCount = Object.keys(f.raw.personalDecks.edge.cards).length;
  assert.equal(result.review_count, expectedCount, "retain current one-to-one matching and unmatched-card multiplicity");
  assert.equal(result.example_review_count, 0);
  assert.equal(result.history.status, Object.keys(expectedIssues).length ? "partial" : "consistent");
  assert.equal(result.history.legacy_timestamp_count, 0);
  assert.deepEqual(Object.fromEntries(result.history.issues.map(issue => [issue.code, issue.count])), expectedIssues);
  assert.equal(result.history.issues.length, Object.keys(expectedIssues).length, "diagnostics are summarized once per code");
  assert.deepEqual(result.days, [{ date: "2026-08-31", review_count: expectedCount, example_review_count: 0 }]);
  assert.equal(result.as_of, NOW);
  assert.equal(result.app_revision, f.raw.revision);
  assert.equal(result.time_zone, ZONE);
  assert.deepEqual(f.store.getStudyActivity({ days: 1 }), result, "cached reads retain counts and diagnostics");
  assert.deepEqual(f.open().getStudyActivity({ days: 1 }), result, "reload preserves alias ordering and diagnostics");
  assert.deepEqual(f.store.getSnapshot(), before);
  assert.deepEqual(f.storage.dump(), bytes);
  assert.equal(f.storage.getItem(KEY), f.bytes, "even original recovery whitespace must remain byte-identical");
  assert.equal(f.writes(), 0, "open and read operations must not repair or persist the ambiguous state");
  return result;
}

for (const order of [["a", "edge.a"], ["edge.a", "a"]]) {
  test(`invalid alias progress is reported with insertion order ${order.join(" then ")}`, () => {
    const values = { a: -1, "edge.a": 0 };
    const f = recoveryFixture(order.map(id => [id, values[id]]));
    assert.deepEqual(f.raw.personalDecks.edge.cards.a.reviewHistory, f.raw.personalDecks.edge.cards["edge.a"].reviewHistory);
    assertDiagnosticRead(f, { AMBIGUOUS_CARD_IDENTITY: 1, INVALID_CARD_PROGRESS: 1 });
  });

  test(`two invalid alias entries produce two progress diagnostics with order ${order.join(" then ")}`, () => {
    const values = { a: -1, "edge.a": -2 };
    const f = recoveryFixture(order.map(id => [id, values[id]]));
    assertDiagnosticRead(f, { AMBIGUOUS_CARD_IDENTITY: 1, INVALID_CARD_PROGRESS: 2 });
  });
}

for (const [label, repetitions] of [["null", null], ["string", "2"], ["fractional", 0.5]]) {
  for (const order of [["a", "edge.a"], ["edge.a", "a"]]) {
    test(`${label} progress stays invalid regardless of alias insertion order ${order.join(" then ")}`, () => {
      const values = { a: repetitions, "edge.a": 0 };
      const f = recoveryFixture(order.map(id => [id, values[id]]));
      assertDiagnosticRead(f, { AMBIGUOUS_CARD_IDENTITY: 1, INVALID_CARD_PROGRESS: 1 });
    });
  }
}

for (const [label, repetitions] of [["negative", -1], ["null", null], ["string", "2"], ["fractional", 0.5]]) {
  test(`an ordinary ${label} invalid singleton receives exactly one progress diagnostic`, () => {
    const f = recoveryFixture([["edge.a", repetitions]]);
    assertDiagnosticRead(f, { INVALID_CARD_PROGRESS: 1 });
  });
}

test("valid alias entries retain the ambiguity diagnostic and matching count without invalid progress", () => {
  const f = recoveryFixture([["a", 0], ["edge.a", 0]]);
  assertDiagnosticRead(f, { AMBIGUOUS_CARD_IDENTITY: 1 });
});
