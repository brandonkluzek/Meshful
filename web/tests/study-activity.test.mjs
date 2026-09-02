import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createMemoryStorage, createStudyStore } from "../js/store.js";
import { WEBMCP_TOOL_NAMES, WEBMCP_TOOL_SCHEMAS } from "../js/webmcp.js";

const NOW = "2026-08-31T12:00:00.000Z";
const KEY = "adaptive-study-lab:web-state:v1";

function fixture({ at = NOW, timeZone = "America/Chicago" } = {}) {
  const memory = createMemoryStorage();
  let instant = at;
  let writes = 0;
  let clockReads = 0;
  let failWrite = false;
  const storage = {
    ...memory,
    setItem(key, value) {
      if (failWrite) throw Object.assign(new Error("Synthetic quota failure"), { code: "TEST_QUOTA" });
      writes += 1;
      memory.setItem(key, value);
    },
  };
  const clock = () => { clockReads += 1; return instant; };
  const open = (zone = timeZone, adapter = storage) => createStudyStore({ catalog: [], storage: adapter, clock, timeZone: zone });
  return {
    store: open(), storage, clock, open,
    at(value) { instant = value; }, fail(value) { failWrite = value; },
    writes: () => writes, clockReads: () => clockReads,
  };
}

function seed(store, deckId = "activity", cardCount = 3) {
  return store.ingestDeck({
    operation: "create", idempotency_key: `seed:${deckId}`,
    deck: {
      schema_version: "normalized-definition-deck.v2", deck_id: deckId, title: "Synthetic activity fixture",
      cards: Array.from({ length: cardCount }, (_, i) => ({
        id: `term-${i}`, term: `Synthetic term ${i}`,
        definition: `Private canonical definition ${i}.`, criteria: [`Private criterion ${i}.`],
      })), edges: [],
    },
  });
}

function start(store, key, deckId = "activity", limit = 1) {
  return store.startStudySession({ deck_id: deckId, limit, idempotency_key: `start:${key}` });
}

function gradeInput(current, key, rating = "good") {
  return {
    session_id: current.session.session_id, card_id: current.current_card.card_id,
    expected_session_revision: current.session.session_revision,
    expected_card_revision: current.current_card.card_revision,
    answer_text: "Private synthetic learner answer.", answer_origin: "chat", rating,
    rubric_evidence: current.current_card.required_concepts.map(item => ({
      rubric_item_id: item.rubric_item_id, status: "met", note: "Private synthetic evidence.",
    })),
    feedback: "Private synthetic feedback; no model-quality claim.",
    misconceptions: [], confidence: 1, idempotency_key: `grade:${key}`,
  };
}

function grade(store, current, key, rating = "good") {
  return store.submitGrade(gradeInput(current, key, rating));
}

test("all 210 committed reviews survive the capped recent feed in a read-only weekly projection", () => {
  const f = fixture();
  for (let d = 0; d < 5; d += 1) {
    const deckId = `activity-cap-${d}`;
    seed(f.store, deckId, 42);
    let current = start(f.store, deckId, deckId, 42);
    for (let i = 0; i < 42; i += 1) {
      const applied = grade(f.store, current, `${deckId}:${i}`);
      current = { session: applied.session, current_card: applied.next_card };
    }
    assert.equal(current.session.status, "completed");
  }
  const snapshot = f.store.getSnapshot();
  assert.equal(snapshot.activity.length, 200);
  assert.equal(snapshot.activity.filter(event => event.type === "grade_submitted").length, 192);
  assert.equal(Object.values(snapshot.personalDecks).flatMap(deck => Object.values(deck.cards))
    .reduce((sum, card) => sum + card.reviewHistory.length, 0), 210);
  const before = f.storage.dump();
  const writes = f.writes();
  const result = f.store.getStudyActivity();
  assert.equal(result.review_count, 210);
  assert.equal(result.example_review_count, 0);
  assert.equal(result.as_of, NOW);
  assert.equal(result.app_revision, snapshot.revision);
  assert.equal(result.time_zone, "America/Chicago");
  assert.equal(result.days.length, 7);
  assert.deepEqual(result.days.at(-1), { date: "2026-08-31", review_count: 210, example_review_count: 0 });
  assert.equal(result.days.reduce((sum, day) => sum + day.review_count, 0), 210);
  assert.deepEqual(result.history, {
    basis: "retained-review-records", scope: "all-retained-history", status: "consistent", lifetime_completeness: "unknown",
    legacy_timestamp_count: 0, issues: [],
  });
  assert.deepEqual(f.open().getStudyActivity(), result);
  assert.deepEqual(f.store.getSnapshot(), snapshot);
  assert.deepEqual(f.storage.dump(), before);
  assert.equal(f.writes(), writes);
  assert.doesNotMatch(JSON.stringify(result), /Private|answer_text|rubric|feedback|session_id|card_id/);
});

function recover(f, mutate) {
  const snapshot = f.store.getSnapshot();
  mutate(snapshot);
  snapshot.schemaVersion = 1;
  delete snapshot.persistenceFormat;
  const storage = createMemoryStorage({ [KEY]: JSON.stringify(snapshot) });
  const store = createStudyStore({ catalog: [], storage, clock: f.clock, timeZone: "America/Chicago" });
  return { store, storage };
}

test("empty activity is a bounded, unknown-lifetime read, with one clock sample and no writes", () => {
  const f = fixture();
  const before = f.storage.dump();
  const clockReads = f.clockReads();
  const result = f.store.getStudyActivity();
  assert.equal(f.clockReads(), clockReads + 1);
  assert.deepEqual(Object.keys(result).sort(), [
    "app_revision", "as_of", "days", "example_review_count", "history", "review_count", "time_zone",
  ]);
  assert.deepEqual(result.days.map(day => day.date), [
    "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31",
  ]);
  assert.ok(result.days.every(day => day.review_count === 0 && day.example_review_count === 0));
  assert.equal(result.history.status, "consistent");
  assert.equal(result.history.lifetime_completeness, "unknown");
  assert.equal(result.history.scope, "all-retained-history");
  assert.deepEqual(result.history.issues, []);
  assert.deepEqual(f.storage.dump(), before);
  assert.equal(f.writes(), 0);
});

test("activity accepts only an optional integer day window, never query-side owner or timezone selectors", () => {
  const f = fixture();
  for (const value of [null, 0, 367, -1, 1.5, "7", NaN, Infinity]) {
    assert.throws(() => f.store.getStudyActivity({ days: value }), { code: "INVALID_ARGUMENT" });
  }
  for (const args of [{ time_zone: "UTC" }, { deck_id: "activity" }, { principal_id: "other" }]) {
    assert.throws(() => f.store.getStudyActivity(args), { code: "UNKNOWN_FIELD" });
  }
  for (const value of [1, 7, 366]) assert.equal(f.store.getStudyActivity({ days: value }).days.length, value);
  assert.equal(f.writes(), 0);
});

test("failed grade and exact retry/replay count one original review without shifting its date", () => {
  const f = fixture();
  seed(f.store);
  const current = start(f.store, "retry");
  const args = gradeInput(current, "retry");
  const before = f.storage.dump();
  f.fail(true);
  assert.throws(() => f.store.submitGrade(args), { code: "TEST_QUOTA" });
  assert.equal(f.store.getStudyActivity().review_count, 0);
  assert.deepEqual(f.storage.dump(), before);
  f.fail(false);
  const committed = f.store.submitGrade(args);
  assert.equal(committed.receipt.replayed, false);
  assert.equal(f.store.getStudyActivity().review_count, 1);
  const saved = f.storage.dump();
  f.at("2026-09-01T12:00:00.000Z");
  assert.equal(f.store.submitGrade(args).receipt.replayed, true);
  const nextDay = f.store.getStudyActivity({ days: 2 });
  assert.deepEqual(nextDay.days, [
    { date: "2026-08-31", review_count: 1, example_review_count: 0 },
    { date: "2026-09-01", review_count: 0, example_review_count: 0 },
  ]);
  assert.equal(nextDay.history.status, "consistent");
  assert.deepEqual(f.storage.dump(), saved);
  assert.deepEqual(f.open().getStudyActivity({ days: 2 }), nextDay);
});

test("actual review dates follow local civil midnight, not UTC midnight", () => {
  const times = [
    "2026-08-30T23:55:00.000Z", "2026-08-31T00:05:00.000Z",
    "2026-08-31T04:58:00.000Z", "2026-08-31T05:02:00.000Z",
  ];
  const f = fixture({ at: times[0] });
  seed(f.store, "activity", 4);
  let current = start(f.store, "civil", "activity", 4);
  for (const [index, time] of times.entries()) {
    f.at(time);
    const result = grade(f.store, current, `civil:${index}`);
    current = { session: result.session, current_card: result.next_card };
  }
  assert.deepEqual(f.store.getStudyActivity({ days: 2 }).days, [
    { date: "2026-08-30", review_count: 3, example_review_count: 0 },
    { date: "2026-08-31", review_count: 1, example_review_count: 0 },
  ]);
  assert.equal(f.store.getStudyActivity({ days: 1 }).review_count, 1);
});

for (const [label, before, after, dates] of [
  ["spring DST gap", "2026-03-08T07:59:00.000Z", "2026-03-08T08:01:00.000Z", ["2026-03-07", "2026-03-08"]],
  ["fall repeated hour", "2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z", ["2026-10-31", "2026-11-01"]],
]) {
  test(`${label} preserves two committed instants on one civil date`, () => {
    const f = fixture({ at: before });
    seed(f.store, "activity", 2);
    const first = grade(f.store, start(f.store, label, "activity", 2), `${label}:1`);
    f.at(after);
    grade(f.store, { session: first.session, current_card: first.next_card }, `${label}:2`);
    const result = f.store.getStudyActivity({ days: 2 });
    assert.deepEqual(result.days.map(day => day.date), dates);
    assert.deepEqual(result.days.map(day => day.review_count), [0, 2]);
    assert.equal(result.history.status, "consistent");
  });
}

test("calendar windows include leap days, and alias/zone projection never rewrites raw history", () => {
  const f = fixture({ at: "2024-03-01T05:59:00.000Z" }); // Feb29 Chicago, Mar1 UTC.
  seed(f.store);
  grade(f.store, start(f.store, "zones"), "zones");
  const saved = f.storage.dump();
  const local = f.store.getStudyActivity({ days: 2 });
  assert.deepEqual(local.days.map(day => day.date), ["2024-02-28", "2024-02-29"]);
  assert.deepEqual(f.open("US/Central").getStudyActivity({ days: 2 }), local);
  const utc = f.open("UTC").getStudyActivity({ days: 2 });
  assert.equal(utc.time_zone, "UTC");
  assert.deepEqual(utc.days.map(day => day.date), ["2024-02-29", "2024-03-01"]);
  assert.equal(local.days[1].review_count, 1);
  assert.equal(utc.days[1].review_count, 1);
  assert.deepEqual(f.storage.dump(), saved);
});

test("future records later today are excluded at minus1ms, included at equality, and never mutated", () => {
  const f = fixture();
  seed(f.store);
  grade(f.store, start(f.store, "clock-back"), "clock-back");
  const saved = f.storage.dump();
  f.at("2026-08-31T11:59:59.999Z");
  const before = f.store.getStudyActivity({ days: 1 });
  assert.equal(before.review_count, 0);
  assert.equal(before.days[0].date, "2026-08-31");
  assert.equal(before.history.status, "partial");
  assert.deepEqual(before.history.issues, [{ code: "FUTURE_REVIEW_RECORD", count: 1 }]);
  f.at(NOW);
  const equal = f.store.getStudyActivity({ days: 1 });
  assert.equal(equal.review_count, 1);
  assert.equal(equal.history.status, "consistent");
  f.at("2026-08-31T12:00:00.001Z");
  assert.equal(f.store.getStudyActivity({ days: 1 }).review_count, 1);
  assert.deepEqual(f.storage.dump(), saved);
});

test("legacy metadata and issue counts cover all retained history, not just the returned window", () => {
  const f = fixture();
  seed(f.store);
  const receipt = grade(f.store, start(f.store, "legacy-scope"), "legacy-scope");
  const { store, storage } = recover(f, raw => {
    raw.personalDecks.activity.cards["activity.term-0"].reviewHistory = [];
    raw.personalDecks.activity.cards["activity.term-0"].review.lastReviewedAt = "2026-09-01T12:00:00.000Z";
    raw.personalDecks.activity.cards["activity.term-0"].review.repetitions = 2;
    const session = raw.sessions[receipt.session_id];
    session.history = ["2026-07-01T12:00:00.000Z", "2026-09-01T12:00:00.000Z"].map(at => ({
      transition: "applied", cardId: "activity.term-0", at, rating: "good",
    }));
    session.reviewsApplied = 2;
    raw.activity = [];
  });
  const saved = storage.dump();
  const result = store.getStudyActivity({ days: 1 });
  assert.equal(result.review_count, 0);
  assert.equal(result.history.scope, "all-retained-history");
  assert.equal(result.history.legacy_timestamp_count, 2);
  assert.deepEqual(result.history.issues, [{ code: "FUTURE_REVIEW_RECORD", count: 1 }]);
  assert.equal(store.getStudyActivity({ days: 366 }).review_count, 1);
  assert.equal(store.getStudyActivity({ days: 366 }).history.legacy_timestamp_count, 2);
  assert.deepEqual(storage.dump(), saved);
});

test("a read-only confirmed snapshot can project fresh civil days without a durable read operation", () => {
  const f = fixture();
  seed(f.store);
  grade(f.store, start(f.store, "confirmed"), "confirmed");
  const raw = f.storage.getItem(KEY);
  let writes = 0;
  const adapter = {
    getItem: key => key === KEY ? raw : null,
    setItem() { writes += 1; throw new Error("Read model cannot write"); },
    removeItem() { writes += 1; throw new Error("Read model cannot remove"); },
  };
  const reader = f.open("America/Chicago", adapter);
  const initial = reader.getStudyActivity();
  assert.equal(initial.review_count, 1);
  f.at("2026-09-09T12:00:00.000Z");
  const later = reader.getStudyActivity();
  assert.equal(later.review_count, 0);
  assert.equal(later.app_revision, initial.app_revision);
  assert.equal(later.as_of, "2026-09-09T12:00:00.000Z");
  assert.equal(reader.getStudyActivity({ days: 366 }).review_count, 1);
  assert.equal(writes, 0);
  assert.equal(f.storage.getItem(KEY), raw);
});

test("another writer refreshes the count cache; unavailable storage never becomes a zero fallback", () => {
  const f = fixture();
  seed(f.store);
  const second = f.open();
  assert.equal(second.getStudyActivity().review_count, 0);
  grade(f.store, start(f.store, "other-writer"), "other-writer");
  assert.equal(second.getStudyActivity().review_count, 1);
  assert.equal(second.getStudyActivity().app_revision, f.store.getSnapshot().revision);
  let unreadable = false;
  const guarded = f.open("America/Chicago", {
    ...f.storage,
    getItem(key) { if (unreadable) throw new Error("Storage unavailable"); return f.storage.getItem(key); },
  });
  assert.equal(guarded.getStudyActivity().review_count, 1);
  unreadable = true;
  assert.throws(() => guarded.getStudyActivity(), /Storage unavailable/);
});

test("mutating returned day rows or diagnostics cannot contaminate the count cache", () => {
  const f = fixture();
  seed(f.store);
  grade(f.store, start(f.store, "return-copy"), "return-copy");
  const first = f.store.getStudyActivity();
  first.days[0].review_count = 999;
  first.history.issues.push({ code: "INVENTED", count: 30 });
  first.history.status = "partial";
  const next = f.store.getStudyActivity();
  assert.equal(next.review_count, 1);
  assert.equal(next.days[0].review_count, 0);
  assert.equal(next.history.status, "consistent");
  assert.deepEqual(next.history.issues, []);
});

test("activity projection adds no wire tool or input/output constraint", () => {
  const stripDescriptionAnnotations = value => Array.isArray(value)
    ? value.map(stripDescriptionAnnotations)
    : (!value || typeof value !== "object") ? value
      : Object.fromEntries(Object.entries(value)
        .filter(([key, child]) => !(key === "description" && typeof child === "string"))
        .map(([key, child]) => [key, stripDescriptionAnnotations(child)]));
  assert.equal(WEBMCP_TOOL_NAMES.length, 13);
  assert.equal(Object.keys(WEBMCP_TOOL_SCHEMAS).length, 13);
  assert.equal(createHash("sha256")
    .update(JSON.stringify(stripDescriptionAnnotations(WEBMCP_TOOL_SCHEMAS)))
    .digest("hex"),
  "50708cab1727763ce19805361dc0d574fd3faa6654401aaba3a34c591ccd23eb");
});

test("legacy dates without a timezone or valid calendar date are not invented actual timestamps", () => {
  const f = fixture();
  seed(f.store);
  const receipt = grade(f.store, start(f.store, "invalid-dates"), "invalid-dates");
  const { store } = recover(f, raw => {
    raw.personalDecks.activity.cards["activity.term-0"].reviewHistory = [];
    raw.personalDecks.activity.cards["activity.term-0"].review.repetitions = 0;
    const session = raw.sessions[receipt.session_id];
    session.history = [
      "2026-08-31", "2026-08-31T12:00:00", "2026-02-30T12:00:00.000Z",
      "2026-08-31T24:00:00.000Z", null, 1788177600000,
    ].map(at => ({ transition: "applied", cardId: "activity.term-0", at, rating: "good" }));
    session.reviewsApplied = session.history.length;
    raw.activity = [];
  });
  const result = store.getStudyActivity();
  assert.equal(result.review_count, 0);
  assert.equal(result.history.legacy_timestamp_count, 0);
  assert.equal(result.history.status, "partial");
  assert.deepEqual(result.history.issues, [{ code: "INVALID_SESSION_REVIEW", count: 6 }]);
});

test("explicit timestamp offsets reconcile equal instants without a stored timestamp rewrite", () => {
  const f = fixture();
  seed(f.store);
  const receipt = grade(f.store, start(f.store, "offsets"), "offsets");
  const { store, storage } = recover(f, raw => {
    raw.sessions[receipt.session_id].history.find(row => row.transition === "grade_submitted")
      .at = "2026-08-31T07:00:00.000-05:00";
  });
  const saved = storage.dump();
  assert.equal(store.getStudyActivity().review_count, 1);
  assert.equal(store.getStudyActivity().history.status, "consistent");
  assert.deepEqual(storage.dump(), saved);
});

test("explicit future example weights stay separate; malformed and overflowing counts stay disclosed", () => {
  const f = fixture();
  const { store, storage } = recover(f, raw => {
    raw.activity = [
      { type: "demo_review_activity", at: NOW, reviewCount: 3 },
      { type: "demo_review_activity", at: "2026-08-31T12:00:00.001Z", reviewCount: 4 },
      { type: "demo_review_activity", at: "2026-07-01T12:00:00.000Z" },
      { type: "demo_review_activity", at: NOW, reviewCount: Number.MAX_SAFE_INTEGER },
    ];
  });
  const saved = storage.dump();
  const result = store.getStudyActivity({ days: 1 });
  assert.equal(result.review_count, 0);
  assert.equal(result.example_review_count, 3);
  assert.deepEqual(result.history.issues, [
    { code: "FUTURE_EXAMPLE_REVIEW", count: 4 }, { code: "INVALID_EXAMPLE_EVENT", count: 2 },
  ]);
  f.at("2026-08-31T12:00:00.001Z");
  const later = store.getStudyActivity({ days: 1 });
  assert.equal(later.example_review_count, 7);
  assert.equal(later.review_count, 0);
  assert.deepEqual(storage.dump(), saved);
});
