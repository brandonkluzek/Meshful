import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStorage, createStudyStore } from "../js/store.js";
import { createBrowserWorkspace } from "../js/browser-workspace.js";
import { withApp } from "./helpers/app-harness.mjs";
import { accountFixture, KEY } from "./helpers/account-fixture.mjs";

// Synthetic, namespaced learner state and injected mechanical judgments only.
// These checks exercise the real app/core, not a model or hosted account.
const SEARCH = "?recording=availability-ui-test";
const CATALOG_OPTIONS = { catalog: [], seedExamples: false };
const NativeDate = Date;
async function withClock(callback) {
  let wall = NativeDate.parse("2026-08-31T16:00:00.000Z");
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [wall])); }
    static now() { return wall; }
  };
  try { await callback({ advance: (ms) => { wall += ms; }, now: () => wall }); }
  finally { globalThis.Date = NativeDate; }
}

function fixture() {
  const storage = createMemoryStorage({ [KEY]: "normal-learner-bytes-must-stay-untouched" });
  const scoped = createBrowserWorkspace(SEARCH, () => storage).storage;
  return { storage, scoped, store: createStudyStore({ catalog: [], storage: scoped }) };
}

function seed(store, id, { title = id, count = 1, edges = [] } = {}) {
  store.ingestDeck({ operation: "create", idempotency_key: `seed:${id}`, deck: {
    schema_version: "normalized-definition-deck.v2", deck_id: id, title,
    cards: Array.from({ length: count }, (_, index) => ({ id: `term${index + 1}`, term: `${title} term ${index + 1}`,
      definition: `PRIVATE_DEFINITION ${id} ${index + 1}`, criteria: [`PRIVATE_CRITERION ${id} ${index + 1}`] })), edges,
  } });
}

function start(store, id, limit = 1, key = id) {
  return store.startStudySession({ deck_id: id, limit, idempotency_key: `start:${key}` });
}
function injectedGrade(current, key, rating = "good") {
  return { session_id: current.session.session_id, expected_session_revision: current.session.session_revision,
    card_id: current.current_card.card_id, expected_card_revision: current.current_card.card_revision,
    answer_origin: "chat", answer_text: "Injected mechanics fixture, not learner evidence.", rating,
    rubric_evidence: current.current_card.required_concepts.map((item) => ({ rubric_item_id: item.rubric_item_id,
      status: rating === "again" ? "missed" : "met", note: "Provider-free mechanics assertion." })),
    feedback: "Injected mechanics feedback.", misconceptions: [], confidence: 1, idempotency_key: `grade:${key}` };
}
function review(store, id, rating = "good") {
  const opened = start(store, id);
  store.submitGrade(injectedGrade(opened, id, rating));
  return opened.session.session_id;
}
function pause(store, current, key) {
  return store.finishStudySession({ session_id: current.session.session_id,
    expected_session_revision: current.session.session_revision, disposition: "pause", idempotency_key: `pause:${key}` });
}
function setDue(scoped, id, timestamp) {
  // Fixture construction, not an app mutation or reconstructed learner history.
  const raw = JSON.parse(scoped.getItem(KEY));
  for (const card of Object.values(raw.personalDecks[id].cards)) {
    if (card.review.repetitions > 0) card.review.dueAt = new Date(timestamp).toISOString();
  }
  scoped.setItem(KEY, JSON.stringify(raw));
}
function saved(f) { return JSON.parse(f.scoped.getItem(KEY)); }
function assertLearningUnchanged(before, after) {
  assert.deepEqual(after.personalDecks, before.personalDecks);
  assert.deepEqual(after.sessions, before.sessions);
}
async function mount(f, callback, options = {}) {
  await withApp({ storage: f.storage, search: SEARCH, catalogOptions: CATALOG_OPTIONS, ...options }, callback);
  assert.equal(f.storage.getItem(KEY), "normal-learner-bytes-must-stay-untouched");
}

test("home chooses eligible new work over an alphabetically earlier future-only deck; My Decks labels it ready", async () => withClock(async () => {
  const f = fixture();
  seed(f.store, "future", { title: "A future-only course" }); review(f.store, "future");
  seed(f.store, "ready", { title: "B ready course", count: 2 });
  await mount(f, async ({ view, navigate, errors }) => {
    assert.equal(view.querySelector("[data-start-deck]").dataset.startDeck, "ready");
    assert.match(view.textContent, /2\s*new cards ready/);
    assert.doesNotMatch(view.textContent, /PRIVATE_DEFINITION|PRIVATE_CRITERION/);
    await navigate("#decks");
    const ready = view.querySelector('[data-start-deck="ready"]').closest(".deck-card");
    assert.match(ready.textContent, /2 new ready/);
    assert.doesNotMatch(ready.textContent, /Up to date|Current/);
    assert.match(view.querySelector('[data-start-deck="future"]').closest(".deck-card").textContent, /Next review/);
    assert.deepEqual(errors, []);
  });
}));

test("known future-only checks do not create empty sessions and explain the next review", async () => withClock(async () => {
  const f = fixture(); seed(f.store, "future"); review(f.store, "future");
  await mount(f, async ({ view, click, flush, location }) => {
    const before = saved(f);
    for (let i = 0; i < 3; i++) { click('[data-start-deck="future"]'); await flush(); }
    assert.equal(location.hash, "#study");
    assert.match(view.textContent, /Nothing ready in this deck/);
    assert.match(view.textContent, /No reviews due now.*Next review/s);
    assert.doesNotMatch(view.textContent, /Session complete|Answer in chat/);
    assertLearningUnchanged(before, saved(f));
  });
}));

test("blocked children are not counted ready, and guidance reveals no definitions or rubric", async () => withClock(async () => {
  const f = fixture();
  seed(f.store, "blocked", { title: "Blocked course", count: 2, edges: [{ from: "term1", to: "term2" }] });
  review(f.store, "blocked", "again");
  await mount(f, async ({ view, click, flush }) => {
    assert.match(view.textContent, /1 awaiting prerequisites/);
    assert.doesNotMatch(view.textContent, /1 new ready/);
    const before = saved(f);
    click('[data-start-deck="blocked"]'); await flush();
    assert.match(view.textContent, /Prerequisites need attention/);
    assert.match(view.querySelector(".study-prerequisites").textContent, /Blocked course term 2.*Blocked course term 1.*Review this prerequisite first/s);
    assert.match(view.textContent, /Next review/);
    assert.doesNotMatch(view.textContent, /PRIVATE_DEFINITION|PRIVATE_CRITERION|Session complete|Answer in chat/);
    assertLearningUnchanged(before, saved(f));
  });
}));

test("mixed ready and blocked new cards show separate truthful counts", async () => withClock(async () => {
  const f = fixture(); seed(f.store, "mixed", { count: 3, edges: [{ from: "term1", to: "term2" }] });
  await mount(f, async ({ view, click, flush }) => {
    assert.match(view.textContent, /2\s*new cards ready/);
    assert.match(view.textContent, /2 new ready · 1 awaiting prerequisites/);
    click('[data-start-deck="mixed"]'); await flush();
    const state = f.store.getSnapshot();
    assert.equal(state.sessions[state.activeSessionId].queue.length, 2);
    assert.deepEqual(state.sessions[state.activeSessionId].queue, ["mixed.term1", "mixed.term3"]);
  });
}));

test("a 12-card batch exposes explicit same-deck Continue for card 13 without rewriting its completed receipt", async () => withClock(async () => {
  const f = fixture(); seed(f.store, "thirteen", { count: 13 });
  await mount(f, async ({ view, click, flush, execute, location }) => {
    click('[data-start-deck="thirteen"]'); await flush();
    const id = f.store.getSnapshot().activeSessionId;
    let lastInput;
    for (let i = 0; i < 12; i++) {
      const current = f.store.getStudySession({ session_id: id });
      lastInput = injectedGrade(current, `batch:${i}`);
      assert.equal((await execute("submit_grade", lastInput)).ok, true);
      if (i === 11) {
        assert.equal(view.querySelector("[data-study-card-scene]").classList.contains("is-flipped"), true);
        assert.equal(view.querySelector("[data-continue-study]"), null, "no early continuation during the final reveal");
      }
      await flush(1600);
    }
    assert.match(view.textContent, /Session complete/);
    assert.match(view.querySelector("[data-study-remaining]").textContent, /1 new ready/);
    assert.ok(view.querySelector("[data-continue-study]"));
    const completed = structuredClone(f.store.getSnapshot().sessions[id]);
    click("[data-continue-study]"); click("[data-continue-study]"); await flush();
    const state = f.store.getSnapshot();
    assert.notEqual(state.activeSessionId, id);
    assert.equal(state.sessions[state.activeSessionId].deckId, "thirteen");
    assert.equal(state.sessions[state.activeSessionId].queue.length, 1);
    assert.equal(Object.keys(state.sessions).length, 2, "double click creates one successor batch");
    assert.deepEqual(state.sessions[id], completed);
    const nextHash = location.hash;
    assert.equal((await execute("submit_grade", lastInput)).data.receipt.replayed, true);
    await flush(2000);
    assert.equal(location.hash, nextHash);
    assert.equal(view.querySelector("[data-study-card-scene]").classList.contains("is-flipped"), false);
    assert.deepEqual(f.store.getSnapshot().sessions[id], completed);
  });
}));

test("a newly unlocked child appears only in an explicit new batch after the committed parent reveal", async () => withClock(async () => {
  const f = fixture(); seed(f.store, "chain", { count: 2, edges: [{ from: "term1", to: "term2" }] });
  await mount(f, async ({ view, click, flush, execute }) => {
    click('[data-start-deck="chain"]'); await flush();
    const id = f.store.getSnapshot().activeSessionId;
    assert.deepEqual(f.store.getSnapshot().sessions[id].queue, ["chain.term1"]);
    const current = f.store.getStudySession({ session_id: id });
    await execute("submit_grade", injectedGrade(current, "unlocks"));
    assert.match(view.querySelector("[data-study-definition]").textContent, /PRIVATE_DEFINITION chain 1/);
    assert.equal(f.store.getSnapshot().sessions[id].status, "completed");
    await flush(1600);
    assert.match(view.textContent, /1 new ready/);
    click("[data-continue-study]"); await flush();
    const state = f.store.getSnapshot();
    assert.deepEqual(state.sessions[state.activeSessionId].queue, ["chain.term2"]);
    assert.deepEqual(state.sessions[id].queue, ["chain.term1"]);
    assert.equal(state.sessions[id].reviewsApplied, 1);
  });
}));

test("switching from active A to empty B pauses A, creates no empty B batch, and offers exact return", async () => withClock(async () => {
  const f = fixture(); seed(f.store, "b", { title: "B future" }); review(f.store, "b");
  seed(f.store, "a", { title: "A active", count: 3 });
  const opened = start(f.store, "a", 2);
  const before = f.store.getSnapshot().sessions[opened.session.session_id];
  await mount(f, async ({ click, flush, view, location }) => {
    click('[data-start-deck="b"]'); await flush();
    const paused = f.store.getSnapshot();
    assert.equal(paused.activeSessionId, null);
    assert.equal(paused.sessions[before.id].status, "paused");
    assert.equal(Object.keys(paused.sessions).length, 2);
    assert.match(view.textContent, /Nothing ready in this deck/);
    assert.match(view.textContent, /Return to A active/);
    click('[data-start-deck="a"]'); await flush();
    const resumed = f.store.getSnapshot().sessions[before.id];
    assert.equal(location.hash, `#session/${before.id}`);
    assert.equal(resumed.status, "active");
    assert.deepEqual(resumed.queue, before.queue);
    assert.equal(resumed.currentCardId, before.currentCardId);
    assert.equal(resumed.cursor, before.cursor);
    assert.equal(resumed.reviewsApplied, before.reviewsApplied);
  });
}));

test("a selected paused queue keeps home priority over due work elsewhere", async () => withClock(async (clock) => {
  const f = fixture(); seed(f.store, "due", { title: "A due" }); review(f.store, "due");
  setDue(f.scoped, "due", clock.now() - 1);
  seed(f.store, "paused", { title: "Z paused", count: 2 });
  const opened = start(f.store, "paused", 2); pause(f.store, opened, "selected");
  f.store.setView({ route: "study", selectedDeckId: "paused" });
  await mount(f, async ({ view, click, flush, location }) => {
    assert.equal(view.querySelector("[data-start-deck]").dataset.startDeck, "paused");
    assert.equal(view.querySelector("[data-resume-session]").dataset.resumeSession, opened.session.session_id);
    click('[data-start-deck="paused"]'); await flush();
    assert.equal(location.hash, `#session/${opened.session.session_id}`);
  });
}));

test("viewing a paused deck while another queue is active explains the conflict before an explicit switch", async () => withClock(async () => {
  const f = fixture(); seed(f.store, "a", { title: "A active" }); seed(f.store, "b", { title: "B paused" });
  const b = start(f.store, "b"); pause(f.store, b, "b");
  const a = start(f.store, "a");
  await mount(f, async ({ view, click, flush, location }) => {
    assert.match(view.textContent, /Another session is active/);
    assert.match(view.textContent, /Switch decks/);
    assert.doesNotMatch(view.textContent, /Prerequisites need attention/);
    click('[data-start-deck="b"]'); await flush();
    assert.equal(location.hash, `#session/${b.session.session_id}`);
    const state = f.store.getSnapshot();
    assert.equal(state.sessions[b.session.session_id].status, "active");
    assert.equal(state.sessions[a.session.session_id].status, "paused");
    assert.equal(Object.keys(state.sessions).length, 2);
  }, { hash: `#session/${b.session.session_id}` });
}));

test("preflight rereads changed eligibility rather than starting from stale home counts", async () => withClock(async () => {
  const f = fixture(); seed(f.store, "race");
  await mount(f, async ({ view, click, flush }) => {
    assert.match(view.textContent, /1\s*new card ready/);
    review(f.store, "race"); // An external, already committed fixture action.
    const before = saved(f);
    click('[data-start-deck="race"]'); await flush();
    assert.match(view.textContent, /Nothing ready in this deck/);
    assertLearningUnchanged(before, saved(f));
  });
}));

test("a real confirmed-read/start race renders the canonical empty outcome truthfully, then stops repeating empty starts", async () => withClock(async () => {
  const f = accountFixture(); const server = f.server("account-a").store;
  seed(server, "race");
  let raced = false;
  f.setMutationHook((method) => {
    if (method === "startStudySession" && !raced) { raced = true; review(server, "race"); }
  });
  await withApp({ accountOptions: f.options, catalogOptions: CATALOG_OPTIONS }, async ({ view, click, flush }) => {
    click('[data-start-deck="race"]'); await flush();
    assert.equal(f.calls.filter((call) => call.method === "startStudySession").length, 1);
    assert.match(view.textContent, /Nothing ready in this deck/);
    assert.match(view.textContent, /No cards were reviewed in this batch/);
    assert.doesNotMatch(view.textContent, /Session complete|Your reviewed cards are scheduled|Answer in chat/);
    const before = server.getSnapshot();
    click('[data-start-deck="race"]'); await flush();
    assert.equal(f.calls.filter((call) => call.method === "startStudySession").length, 1);
    assert.deepEqual(server.getSnapshot().sessions, before.sessions);
  });
}));

for (const page of ["home", "decks", "completion"]) {
  test(`idle ${page} refreshes when the next review becomes due, with no learner-state write`, async () => withClock(async (clock) => {
    const f = fixture(); seed(f.store, "future"); const sessionId = review(f.store, "future");
    setDue(f.scoped, "future", clock.now() + 60_000);
    const hash = page === "home" ? "#study" : page === "decks" ? "#decks" : `#session/${sessionId}`;
    await mount(f, async ({ view, flush }) => {
      assert.match(view.textContent, /Next review/);
      const before = f.scoped.getItem(KEY);
      clock.advance(60_100); await flush(60_100);
      assert.match(view.textContent, /1 review due/);
      if (page === "completion") assert.ok(view.querySelector("[data-continue-study]"));
      assert.equal(f.scoped.getItem(KEY), before);
    }, { hash });
  }));
}

test("due-boundary and wake refreshes do not interrupt an active reveal or append to its fixed queue", async () => withClock(async (clock) => {
  const f = fixture(); seed(f.store, "future"); review(f.store, "future");
  setDue(f.scoped, "future", clock.now() + 500);
  seed(f.store, "active", { count: 2 }); const current = start(f.store, "active", 2);
  await mount(f, async ({ view, execute, flush, window }) => {
    const scene = view.querySelector("[data-study-card-scene]");
    await execute("submit_grade", injectedGrade(current, "preserve-reveal"));
    clock.advance(700);
    for (const callback of window.listeners.get("focus") ?? []) callback();
    await flush(700);
    assert.equal(view.querySelector("[data-study-card-scene]"), scene);
    assert.equal(scene.classList.contains("is-flipped"), true);
    assert.deepEqual(f.store.getSnapshot().sessions[current.session.session_id].queue, ["active.term1", "active.term2"]);
    clock.advance(900); await flush(900);
    assert.notEqual(view.querySelector("[data-study-card-scene]"), scene);
    assert.equal(f.store.getSnapshot().activeSessionId, current.session.session_id);
    assert.equal(f.store.getSnapshot().sessions[current.session.session_id].reviewsApplied, 1);
  }, { hash: `#session/${current.session.session_id}` });
}));
