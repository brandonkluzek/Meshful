import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryStorage, createStudyStore } from "../js/store.js";

// Synthetic mechanics fixtures only: no learner state, provider grading, or corpus.
const NOW = "2026-08-31T12:00:00.000Z";
const ZONE = "America/Chicago";
const KEY = "adaptive-study-lab:web-state:v1";

function seedDeck(store, deckId = "history", ids = ["a"]) {
  store.ingestDeck({
    operation: "create", idempotency_key: `seed:${deckId}`,
    deck: {
      schema_version: "normalized-definition-deck.v2", deck_id: deckId, title: deckId,
      cards: ids.map(id => ({
        id, term: `Synthetic ${id}`, definition: `The defining property of ${id}.`,
        criteria: [`State the defining property of ${id}.`],
      })),
      edges: [],
    },
  });
}

function fixture({ at = NOW, cards = ["a"], catalog = [], seed = true } = {}) {
  const storage = createMemoryStorage();
  let instant = at;
  const clock = () => instant;
  const store = createStudyStore({ catalog, storage, clock, timeZone: ZONE });
  if (seed) seedDeck(store, "history", cards);
  return { store, storage, catalog, clock, setTime: value => { instant = value; } };
}

function reload(f) {
  return { ...f, store: createStudyStore({
    catalog: f.catalog, storage: f.storage, clock: f.clock, timeZone: ZONE,
  }) };
}

function recover(f, change) {
  const raw = f.store.getSnapshot();
  change(raw);
  // Dense, disposable recovery input, not a persisted source or fixture artifact.
  raw.schemaVersion = 1;
  delete raw.persistenceFormat;
  const storage = createMemoryStorage({ [KEY]: JSON.stringify(raw) });
  return reload({ ...f, storage });
}

function readOnlyActivity(f, args = {}) {
  const before = f.store.getSnapshot();
  const bytes = f.storage.dump();
  const result = f.store.getStudyActivity(args);
  assert.equal(result.as_of, new Date(f.clock()).toISOString());
  assert.equal(result.app_revision, before.revision);
  assert.equal(result.time_zone, ZONE);
  assert.equal(result.history.basis, "retained-review-records");
  assert.equal(result.review_count, result.days.reduce((sum, day) => sum + day.review_count, 0));
  assert.equal(result.example_review_count, result.days.reduce((sum, day) => sum + day.example_review_count, 0));
  assert.deepEqual(f.store.getSnapshot(), before, "aggregation must not mutate the recovered or live snapshot");
  assert.deepEqual(f.storage.dump(), bytes, "aggregation must not rewrite storage, receipts, or histories");
  return result;
}

function assertPartial(result) {
  assert.equal(result.history.status, "partial");
  assert.ok(Array.isArray(result.history.issues));
  assert.ok(result.history.issues.length > 0 && result.history.issues.length <= 64);
  const codes = result.history.issues.map(issue => {
    assert.equal(typeof issue.code, "string");
    assert.ok(issue.code.length > 0 && issue.code.length <= 80);
    assert.ok(Number.isSafeInteger(issue.count) && issue.count > 0);
    return issue.code;
  });
  assert.equal(new Set(codes).size, codes.length, "issues are summarized by bounded code, not individual records");
}

function commit(f, key, deckId = "history") {
  const started = f.store.startStudySession({
    deck_id: deckId, limit: 1, idempotency_key: `start:${key}`,
  });
  const card = started.current_card;
  return f.store.submitGrade({
    session_id: started.session.session_id, card_id: card.card_id,
    expected_session_revision: started.session.session_revision,
    expected_card_revision: card.card_revision,
    answer_text: "Synthetic retained answer.", answer_origin: "chat", rating: "good",
    rubric_evidence: card.required_concepts.map(item => ({
      rubric_item_id: item.rubric_item_id, status: "met", note: "Injected mechanics evidence only.",
    })),
    feedback: "Synthetic fixture, not model grading.", misconceptions: [], confidence: 1,
    idempotency_key: `grade:${key}`,
  });
}

function reuseCardReviewId(raw, deckId, cardId, reviewId) {
  for (const record of raw.personalDecks[deckId].cards[cardId].reviewHistory) record.reviewId = reviewId;
  for (const session of Object.values(raw.sessions)) {
    if (session.deckId !== deckId) continue;
    for (const record of session.history) {
      if (record.transition === "grade_submitted" && record.cardId === cardId) record.reviewId = reviewId;
    }
  }
  for (const event of raw.activity) {
    if (event.type === "grade_submitted" && event.deckId === deckId && event.cardId === cardId) {
      event.reviewId = reviewId;
    }
  }
}

function removeLatestGradeEvidence(raw, receipt) {
  const session = raw.sessions[receipt.session_id];
  const card = Object.values(raw.personalDecks[session.deckId].cards)
    .find(candidate => candidate.reviewHistory.some(record => record.reviewId === receipt.review_id));
  assert.ok(card);
  card.reviewHistory = card.reviewHistory.filter(record => record.reviewId !== receipt.review_id);
  // Losing the whole newest session isolates card-schedule evidence coverage;
  // an empty session with reviewsApplied:1 would already flag a counter mismatch.
  delete raw.sessions[receipt.session_id];
  raw.activity = [];
  raw.actionReceipts = {};
  raw.actionReceiptOrder = [];
}

function legacyPreview(f, key) {
  const started = f.store.startStudySession({
    deck_id: "history", mode: "new", limit: 1, client_action_id: `legacy-start:${key}`,
  });
  const captured = f.store.captureAnswer({
    session_id: started.session.id, card_id: started.current_card.id,
    answer: "Synthetic retained answer.", expected_session_revision: started.session.revision,
    client_action_id: `legacy-capture:${key}`,
  });
  const preview = f.store.previewReview({
    session_id: started.session.id, card_id: started.current_card.id, capture_id: captured.capture_id,
    assessment: { verdict: "correct", confidence: 0.9, feedback: "Synthetic recall.", misconceptions: [] },
  });
  return { started, captured, preview };
}

function legacyApply(f, prepared, key) {
  return f.store.applyReview({
    review_token: prepared.preview.review_token,
    expected_session_revision: prepared.preview.session_revision,
    client_action_id: `legacy-apply:${key}`,
  });
}

test("activity counts an actual legacy apply, never its capture or preview", () => {
  const f = fixture();
  const prepared = legacyPreview(f, "apply-only");
  assert.equal(readOnlyActivity(f).review_count, 0);
  const applied = legacyApply(f, prepared, "apply-only");
  assert.equal(applied.phase, "applied");
  const raw = f.store.getSnapshot();
  const history = raw.sessions[prepared.started.session.id].history;
  assert.equal(history.filter(record => record.transition === "answer_committed").length, 1);
  assert.equal(history.filter(record => record.transition === "review_previewed").length, 1);
  assert.equal(history.filter(record => record.transition === "applied").length, 1);
  assert.equal(raw.personalDecks.history.cards["history.a"].reviewHistory.length, 0);
  for (const current of [f, reload(f)]) {
    const result = readOnlyActivity(current);
    assert.equal(result.review_count, 1);
    assert.equal(result.history.legacy_timestamp_count, 1);
  }
});

test("distinct identical ID-less legacy applied rows retain their separate row identities", () => {
  const f = fixture();
  const prepared = legacyPreview(f, "identical-legacy-rows");
  legacyApply(f, prepared, "identical-legacy-rows");
  const recovered = recover(f, raw => {
    const session = raw.sessions[prepared.started.session.id];
    const row = session.history.find(record => record.transition === "applied");
    assert.equal(row.reviewId, undefined);
    session.history.push(structuredClone(row));
    session.reviewsApplied += 1;
    raw.personalDecks.history.cards["history.a"].review.repetitions += 1;
  });
  const rows = recovered.store.getSnapshot().sessions[prepared.started.session.id].history
    .filter(record => record.transition === "applied");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], rows[1], "distinct retained rows can have identical card, time, rating, and assessment");
  for (const current of [recovered, reload(recovered)]) {
    const result = readOnlyActivity(current);
    assert.equal(result.review_count, 2);
    assert.equal(result.days.at(-1).review_count, 2);
    assert.equal(result.history.legacy_timestamp_count, 2, "the unit is ID-less applied rows, not cards or dates");
  }
});

test("legacy activity keeps the stored preview scheduling date across a midnight apply", () => {
  const previewAt = "2026-08-31T04:59:00.000Z"; // August 30, 23:59 in Chicago.
  const appliedAt = "2026-08-31T05:01:00.000Z";
  const f = fixture({ at: previewAt });
  const prepared = legacyPreview(f, "stored-time");
  f.setTime(appliedAt);
  legacyApply(f, prepared, "stored-time");
  const raw = f.store.getSnapshot();
  const record = raw.sessions[prepared.started.session.id].history.find(item => item.transition === "applied");
  assert.equal(record.at, previewAt, "the historical API stores scheduling time, not later application time");
  assert.equal(raw.personalDecks.history.cards["history.a"].review.lastReviewedAt, previewAt);
  const result = readOnlyActivity(reload(f), { days: 2 });
  assert.deepEqual(result.days, [
    { date: "2026-08-30", review_count: 1, example_review_count: 0 },
    { date: "2026-08-31", review_count: 0, example_review_count: 0 },
  ]);
  assert.equal(result.history.legacy_timestamp_count, 1);
});

test("one atomic grade has two retained copies but contributes exactly once after reload", () => {
  const f = fixture();
  const receipt = commit(f, "atomic");
  const raw = f.store.getSnapshot();
  const cardRecord = raw.personalDecks.history.cards["history.a"].reviewHistory[0];
  const sessionRecords = raw.sessions[receipt.session_id].history.filter(item => item.transition === "grade_submitted");
  assert.equal(cardRecord.reviewId, receipt.review_id);
  assert.equal(sessionRecords.length, 1);
  assert.equal(sessionRecords[0].reviewId, cardRecord.reviewId);
  for (const current of [f, reload(f)]) {
    const result = readOnlyActivity(current);
    assert.equal(result.review_count, 1);
    assert.equal(result.history.status, "consistent");
    assert.equal(result.history.legacy_timestamp_count, 0);
  }
});

test("a recovered card-only history is countable without sessions, activity, or receipts", () => {
  const f = fixture();
  commit(f, "card-only");
  const recovered = recover(f, raw => {
    raw.sessions = {};
    raw.activeSessionId = null;
    raw.activity = [];
    raw.actionReceipts = {};
    raw.actionReceiptOrder = [];
  });
  assert.equal(readOnlyActivity(recovered).review_count, 1);
  assert.equal(readOnlyActivity(reload(recovered)).review_count, 1);
});

test("a retained atomic session record still counts when its card-history copy is absent", () => {
  const f = fixture();
  commit(f, "session-only");
  const recovered = recover(f, raw => {
    raw.personalDecks.history.cards["history.a"].reviewHistory = [];
    raw.activity = [];
    raw.actionReceipts = {};
    raw.actionReceiptOrder = [];
  });
  assert.equal(readOnlyActivity(recovered).review_count, 1);
});

test("archiving a reviewed card and deck does not erase their dated activity", () => {
  const f = fixture({ cards: ["a", "b"] });
  commit(f, "archive");
  const before = f.store.getSnapshot().personalDecks.history.cards["history.a"].reviewHistory;
  f.store.updateCards({
    deck_id: "history", expected_deck_revision: f.store.getSnapshot().personalDecks.history.revision,
    updates: [{ card_id: "history.a", patch: { archived: true } }], idempotency_key: "archive-card",
  });
  f.store.setDeckArchived({
    deck_id: "history", archived: true,
    expected_revision: f.store.getSnapshot().personalDecks.history.revision, client_action_id: "archive-deck",
  });
  const after = f.store.getSnapshot().personalDecks.history;
  assert.equal(after.archived, true);
  assert.equal(after.cards["history.a"].archived, true);
  assert.deepEqual(after.cards["history.a"].reviewHistory, before);
  assert.equal(readOnlyActivity(f).review_count, 1);
  assert.equal(readOnlyActivity(reload(f)).review_count, 1);
});

test("a material scheduling reset preserves old activity and counts the next grade separately", () => {
  const f = fixture();
  commit(f, "before-reset");
  const before = f.store.getSnapshot().personalDecks.history.cards["history.a"].reviewHistory;
  f.store.updateCards({
    deck_id: "history", expected_deck_revision: f.store.getSnapshot().personalDecks.history.revision,
    updates: [{ card_id: "history.a", patch: { definition_md: "A materially revised defining property." } }],
    idempotency_key: "reset-definition",
  });
  const reset = f.store.getSnapshot().personalDecks.history.cards["history.a"];
  assert.equal(reset.review.repetitions, 0);
  assert.deepEqual(reset.reviewHistory, before);
  assert.equal(readOnlyActivity(reload(f)).review_count, 1);
  commit(f, "after-reset");
  assert.equal(readOnlyActivity(reload(f)).review_count, 2);
});

test("missing latest history stays partial when an older pre-reset review happens to match the repetition count", () => {
  const earlierAt = "2026-08-30T12:00:00.000Z";
  const f = fixture({ at: earlierAt });
  const earlier = commit(f, "coverage-before-reset");
  f.setTime(NOW);
  f.store.updateCards({
    deck_id: "history", expected_deck_revision: f.store.getSnapshot().personalDecks.history.revision,
    updates: [{ card_id: "history.a", patch: { definition_md: "A revised latest-history target." } }],
    idempotency_key: "coverage-reset",
  });
  const latest = commit(f, "coverage-after-reset");
  const before = f.store.getSnapshot().personalDecks.history.cards["history.a"];
  assert.equal(before.reviewHistory.length, 2);
  assert.equal(before.review.repetitions, 1);
  assert.equal(before.review.lastReviewedAt, NOW);
  const recovered = recover(f, raw => removeLatestGradeEvidence(raw, latest));
  const kept = recovered.store.getSnapshot().personalDecks.history.cards["history.a"];
  assert.deepEqual(kept.review, before.review, "recovery does not change the latest actual schedule");
  assert.equal(kept.reviewHistory.length, 1);
  assert.equal(kept.reviewHistory[0].reviewId, earlier.review_id);
  assert.equal(kept.reviewHistory[0].submittedAt, earlierAt);
  for (const current of [recovered, reload(recovered)]) {
    const result = readOnlyActivity(current, { days: 2 });
    assertPartial(result);
    assert.equal(result.review_count, 1);
    assert.deepEqual(result.days, [
      { date: "2026-08-30", review_count: 1, example_review_count: 0 },
      { date: "2026-08-31", review_count: 0, example_review_count: 0 },
    ]);
  }
});

test("reused review IDs in different deck or card contexts are not globally collapsed", () => {
  const f = fixture({ cards: ["a", "b"] });
  commit(f, "context-a");
  commit(f, "context-b");
  seedDeck(f.store, "other", ["a"]);
  commit(f, "context-other", "other");
  const recovered = recover(f, raw => {
    for (const deck of Object.values(raw.personalDecks)) {
      for (const card of Object.values(deck.cards)) {
        for (const record of card.reviewHistory) record.reviewId = "review-reused-across-contexts";
      }
    }
    for (const session of Object.values(raw.sessions)) {
      for (const record of session.history) {
        if (record.transition === "grade_submitted") record.reviewId = "review-reused-across-contexts";
      }
    }
    raw.activity = [];
    raw.actionReceipts = {};
    raw.actionReceiptOrder = [];
  });
  assert.equal(readOnlyActivity(recovered).review_count, 3);
});

test("compatible modern pairs with a reused review ID on the same card at different times count twice", () => {
  const f = fixture();
  const first = commit(f, "same-card-first");
  f.setTime("2026-09-03T12:00:00.000Z");
  const second = commit(f, "same-card-second");
  assert.equal(second.card_id, first.card_id);
  assert.notEqual(second.review_id, first.review_id);
  const recovered = recover(f, raw => {
    reuseCardReviewId(raw, "history", "history.a", "review-reused-same-card");
  });
  assert.equal(recovered.store.getSnapshot().personalDecks.history.cards["history.a"].reviewHistory.length, 2);
  for (const current of [recovered, reload(recovered)]) {
    const result = readOnlyActivity(current);
    assert.equal(result.history.status, "consistent");
    assert.equal(result.review_count, 2, "four compatible retained copies represent two committed events");
    assert.deepEqual(result.days.filter(day => day.review_count > 0), [
      { date: "2026-08-31", review_count: 1, example_review_count: 0 },
      { date: "2026-09-03", review_count: 1, example_review_count: 0 },
    ]);
  }
});

const brokenHistoryCases = [
  ["missing histories", (card, session) => { delete card.reviewHistory; delete session.history; }],
  ["non-array card history", (card) => { card.reviewHistory = { damaged: true }; }],
  ["non-array session history", (_card, session) => { session.history = "damaged"; }],
  ["malformed retained records", (card) => {
    card.reviewHistory = [
      null, 17, "damaged", { reviewId: "missing-time", rating: "good" },
      { reviewId: "invalid-time", submittedAt: "not-a-date", rating: "good" },
      { reviewId: "invalid-rating", submittedAt: NOW, rating: "certain" },
    ];
  }],
];

for (const [name, damage] of brokenHistoryCases) {
  test(`${name} are partial, not reviews inferred from counters, updatedAt, receipts, or activity`, () => {
    const f = fixture();
    const receipt = commit(f, `damaged:${name.replaceAll(" ", "-")}`);
    const recovered = recover(f, raw => {
      const card = raw.personalDecks.history.cards["history.a"];
      const session = raw.sessions[receipt.session_id];
      card.reviewHistory = [];
      session.history = [];
      card.review.repetitions = 17;
      card.review.lastReviewedAt = "2026-08-30T12:00:00.000Z";
      card.updatedAt = NOW;
      session.reviewsApplied = 17;
      session.updatedAt = NOW;
      damage(card, session);
    });
    const result = readOnlyActivity(recovered);
    assertPartial(result);
    assert.equal(result.review_count, 0);
    assert.ok(result.days.every(day => day.review_count === 0));
    assert.equal(result.example_review_count, 0);
  });
}

for (const [field, value] of [
  ["at", "2026-08-30T12:00:00.000Z"], ["rating", "hard"], ["cardRevision", 2],
]) {
  test(`conflicting ${field} copies quarantine only the ambiguous anchored review`, () => {
    const f = fixture({ cards: ["a", "b"] });
    const ambiguous = commit(f, `conflict:${field}`);
    commit(f, `unaffected:${field}`);
    const recovered = recover(f, raw => {
      const session = raw.sessions[ambiguous.session_id];
      const record = session.history.find(item => item.reviewId === ambiguous.review_id);
      record[field] = value;
    });
    const result = readOnlyActivity(recovered, { days: 2 });
    assertPartial(result);
    assert.equal(result.review_count, 1, "the conflicting group contributes no confident count; the other grade remains");
    assert.deepEqual(result.days, [
      { date: "2026-08-30", review_count: 0, example_review_count: 0 },
      { date: "2026-08-31", review_count: 1, example_review_count: 0 },
    ]);
  });
}

test("partial compatible matches survive opposite unmatched conflicts within the same review-ID group", () => {
  const f = fixture({ cards: ["a", "b"] });
  const matched = commit(f, "partial-matched");
  const unrelated = commit(f, "partial-unrelated");
  f.setTime("2026-09-03T12:00:00.000Z");
  const conflicting = commit(f, "partial-conflicting");
  assert.equal(conflicting.card_id, matched.card_id);
  assert.notEqual(unrelated.card_id, matched.card_id);
  const recovered = recover(f, raw => {
    reuseCardReviewId(raw, "history", "history.a", "review-partially-compatible");
    const row = raw.sessions[conflicting.session_id].history.find(record => record.transition === "grade_submitted");
    row.at = "2026-09-02T12:00:00.000Z";
    raw.activity = [];
  });
  for (const current of [recovered, reload(recovered)]) {
    const result = readOnlyActivity(current);
    assertPartial(result);
    assert.equal(result.review_count, 2, "keep the compatible pair in the conflicted group and the unrelated matched grade");
    assert.deepEqual(result.days.filter(day => day.review_count > 0), [
      { date: "2026-08-31", review_count: 2, example_review_count: 0 },
    ]);
  }
});

function demoFixture() {
  const catalog = [{
    id: "history-demo", title: "Synthetic history demo", version: "1",
    cards: ["a", "b"].map(id => ({ id, term: id, definition: `Synthetic definition ${id}.` })),
    edges: [],
  }];
  const f = fixture({ catalog, seed: false });
  const installed = f.store.addLibraryDeck({
    library_deck_id: "history-demo", expected_catalog_version: "1", client_action_id: "install-demo",
  });
  f.store.seedDemoState(installed.deck.id);
  return { ...f, deckId: installed.deck.id };
}

test("actual seeded demo counters remain separate from retained learner review counts", () => {
  const f = demoFixture();
  const cards = Object.values(f.store.getSnapshot().personalDecks[f.deckId].cards);
  assert.ok(cards.some(card => card.review.demoSeeded && card.review.repetitions > 0));
  assert.ok(cards.every(card => card.reviewHistory.length === 0));
  const result = readOnlyActivity(reload(f));
  assert.equal(result.review_count, 0);
  assert.equal(result.example_review_count, 18, "the older offset-seven example is outside the seven-date window");
  assert.ok(result.days.every(day => day.review_count === 0));
});

test("an actual grade after demo seeding counts as real even though scheduleBefore was seeded", () => {
  const f = demoFixture();
  const receipt = commit(f, "after-demo", f.deckId);
  const cards = Object.values(f.store.getSnapshot().personalDecks[f.deckId].cards);
  const reviewed = cards.find(card => card.reviewHistory.some(item => item.reviewId === receipt.review_id));
  assert.equal(reviewed.reviewHistory[0].scheduleBefore.demoSeeded, true);
  assert.notEqual(reviewed.review.demoSeeded, true);
  const result = readOnlyActivity(reload(f));
  assert.equal(result.review_count, 1);
  assert.equal(result.example_review_count, 18);
});

test("a seeded predecessor does not permanently excuse missing latest actual-grade history", () => {
  const f = demoFixture();
  const earlier = commit(f, "seeded-coverage-before-reset", f.deckId);
  const laterAt = "2026-09-01T12:00:00.000Z";
  f.setTime(laterAt);
  f.store.updateCards({
    deck_id: f.deckId, expected_deck_revision: f.store.getSnapshot().personalDecks[f.deckId].revision,
    updates: [{ card_id: earlier.card_id, patch: { definition_md: "A revised post-demo history target." } }],
    idempotency_key: "seeded-coverage-reset",
  });
  const latest = commit(f, "seeded-coverage-after-reset", f.deckId);
  assert.equal(latest.card_id, earlier.card_id);
  const before = Object.values(f.store.getSnapshot().personalDecks[f.deckId].cards)
    .find(card => card.reviewHistory.some(record => record.reviewId === latest.review_id));
  assert.equal(before.review.repetitions, 1);
  assert.equal(before.review.lastReviewedAt, laterAt);
  assert.notEqual(before.review.demoSeeded, true);
  const recovered = recover(f, raw => removeLatestGradeEvidence(raw, latest));
  const kept = Object.values(recovered.store.getSnapshot().personalDecks[f.deckId].cards)
    .find(card => card.reviewHistory.some(record => record.reviewId === earlier.review_id));
  assert.deepEqual(kept.review, before.review);
  assert.equal(kept.reviewHistory.length, 1);
  assert.equal(kept.reviewHistory[0].scheduleBefore.demoSeeded, true);
  for (const current of [recovered, reload(recovered)]) {
    const result = readOnlyActivity(current, { days: 2 });
    assertPartial(result);
    assert.equal(result.review_count, 1);
    assert.deepEqual(result.days, [
      { date: "2026-08-31", review_count: 1, example_review_count: 0 },
      { date: "2026-09-01", review_count: 0, example_review_count: 0 },
    ]);
  }
});

test("only explicit nonnegative integer demo counts contribute to example activity", () => {
  const f = fixture();
  const recovered = recover(f, raw => {
    const event = (extra) => ({ type: "demo_review_activity", demo: true, at: NOW, ...extra });
    raw.activity = [
      event({ reviewCount: 3 }), event({ reviewCount: 0 }), event({}),
      event({ reviewCount: "4" }), event({ reviewCount: 1.5 }), event({ reviewCount: -4 }),
      event({ reviewCount: 9, at: "not-a-date" }),
      { type: "grade_submitted", at: NOW, reviewCount: 8 },
      { type: "review_applied", at: NOW, reviewCount: 8 },
    ];
  });
  const result = readOnlyActivity(recovered);
  assert.equal(result.review_count, 0);
  assert.equal(result.example_review_count, 3);
});
