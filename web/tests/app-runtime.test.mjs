import test from "node:test";
import assert from "node:assert/strict";
import { CATALOG } from "../data/catalog.js";
import { createMemoryStorage, createStudyStore } from "../js/store.js";
import { withApp } from "./helpers/app-harness.mjs";
import { createBrowserWorkspace } from "../js/browser-workspace.js";

const KEY = "adaptive-study-lab:web-state:v1";

function fixture() {
  const storage = createMemoryStorage();
  const store = createStudyStore({ catalog: CATALOG, storage });
  for (const id of ["linear-algebra-i", "introductory-mechanics"]) {
    store.addLibraryDeck({ library_deck_id: id, expected_catalog_version: "1.0.0-example", client_action_id: `test-install:${id}` });
  }
  return { storage, store };
}

function start(store, deck = "deck-linear-algebra-i") {
  return store.startStudySession({ deck_id: deck, limit: 3, idempotency_key: `test-start:${deck}` });
}

function injectedGrade(current, key = "test-grade") {
  return {
    session_id: current.session.session_id,
    expected_session_revision: current.session.session_revision,
    card_id: current.current_card.card_id,
    expected_card_revision: current.current_card.card_revision,
    answer_text: "An explicitly injected test answer, not a learner or model-quality result.",
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: current.current_card.required_concepts.map((item) => ({ rubric_item_id: item.rubric_item_id, status: "met", note: "Provider-free mechanics fixture." })),
    feedback: "Injected mechanics fixture feedback.",
    misconceptions: [], confidence: 0.9, idempotency_key: key,
  };
}

for (const [label, value] of [["corrupt", "{not-json"], ["incompatible", JSON.stringify({ schemaVersion: 999 })]]) {
  test(`${label} startup displays recovery without changing saved bytes or registering writable tools`, async () => {
    const storage = createMemoryStorage({ [KEY]: value });
    await withApp({ storage }, async ({ view, registrations, click, navigations }) => {
      assert.match(view.textContent, /could not open/i);
      assert.ok(view.querySelector("[data-retry-startup]"));
      assert.equal(registrations.size, 0);
      assert.equal(storage.getItem(KEY), value);
      click("[data-retry-startup]");
      assert.deepEqual(navigations, ["reload"]);
      assert.equal(storage.getItem(KEY), value);
    });
  });
}

test("a denied localStorage getter reaches recovery rather than leaving a blank loading screen", async () => {
  await withApp({ storageError: new Error("Storage permission denied") }, async ({ view, document }) => {
    assert.match(view.textContent, /could not open/i);
    assert.equal(document.querySelector("[data-loading]").hidden, true);
  });
});

test("a first-render write failure reaches recovery before registering tools and preserves saved data", async () => {
  const original = "normal-workspace-must-not-be-read-or-changed";
  const backing = createMemoryStorage({ [KEY]: original });
  const storage = { ...backing, setItem() { throw new Error("Storage is full"); } };
  await withApp({ storage, search: "?recording=read-only-test", hash: "#library" }, async ({ view, registrations }) => {
    assert.match(view.textContent, /could not open/i);
    assert.equal(registrations.size, 0);
    assert.equal(backing.getItem(KEY), original);
    assert.equal(backing.getItem(`${KEY}:recording:read-only-test`), null);
  });
});

test("reopening the active deck preserves its session revision and queue", async () => {
  const { storage, store } = fixture();
  const opened = start(store);
  const before = store.getSnapshot().sessions[opened.session.session_id];
  await withApp({ storage, hash: "#decks" }, async ({ click, flush, location }) => {
    click('[data-start-deck="deck-linear-algebra-i"]');
    await flush();
    assert.equal(location.hash, `#session/${before.id}`);
    assert.deepEqual(store.getSnapshot().sessions[before.id], before);
  });
});

test("a failed pause keeps the learner on the active card and does not start another queue", async () => {
  const { storage: backing, store } = fixture();
  const opened = start(store);
  let denyWrite = false;
  const storage = { ...backing, setItem(key, value) { if (denyWrite) throw new Error("Storage is full"); backing.setItem(key, value); } };
  await withApp({ storage, hash: `#session/${opened.session.session_id}` }, async ({ click, flush, location, view }) => {
    const before = backing.getItem(KEY);
    denyWrite = true;
    click("[data-pause-session]");
    await flush();
    assert.equal(location.hash, `#session/${opened.session.session_id}`);
    assert.equal(backing.getItem(KEY), before);
    assert.match(view.textContent, /Answer in chat/);
  });
  assert.equal(store.getSnapshot().sessions[opened.session.session_id].status, "active");
});

test("a successful grade reveals once, a replay does not advance twice, and Graph lights the reviewed local ID", async () => {
  const { storage, store } = fixture();
  const opened = start(store);
  await withApp({ storage, hash: `#session/${opened.session.session_id}` }, async ({ view, execute, flush, navigate }) => {
    const scene = view.querySelector("[data-study-card-scene]");
    assert.equal(scene.classList.contains("is-flipped"), false);
    const input = injectedGrade(opened);
    const result = await execute("submit_grade", input);
    assert.equal(result.ok, true);
    assert.equal(scene.classList.contains("is-flipped"), true);
    assert.equal(scene.querySelector("[data-study-definition]").textContent, opened.current_card.definition_md);
    const replay = await execute("submit_grade", input);
    assert.equal(replay.data.receipt.replayed, true);
    await flush(1600);
    assert.equal(view.querySelector("[data-study-card-scene]").classList.contains("is-flipped"), false);
    assert.equal(store.getSnapshot().sessions[opened.session.session_id].reviewsApplied, 1);
    await navigate("#graph/deck-linear-algebra-i");
    assert.ok(view.querySelector(".is-pulsing"), "the graded card's prerequisite routes pulse after a target commit");
  });
});

for (const reducedMotion of [false, true]) {
  test(`a pending metadata refresh cannot interrupt the grade reveal (${reducedMotion ? "reduced" : "normal"} motion)`, async () => {
    const { storage, store } = fixture();
    const opened = start(store);
    await withApp({ storage, reducedMotion, hash: `#session/${opened.session.session_id}` }, async ({ view, execute, flush }) => {
      const other = store.getSnapshot().personalDecks["deck-introductory-mechanics"];
      const update = await execute("update_deck", {
        deck_id: other.id, expected_deck_revision: other.revision,
        patch: { title: "Mechanics metadata update" }, idempotency_key: "pending-metadata",
      });
      assert.equal(update.ok, true);
      const scene = view.querySelector("[data-study-card-scene]");
      assert.equal((await execute("submit_grade", injectedGrade(opened))).ok, true);
      await flush(0);
      assert.equal(view.querySelector("[data-study-card-scene]"), scene);
      assert.equal(scene.classList.contains("is-flipped"), true);
      assert.equal(scene.querySelector("[data-study-definition]").textContent, opened.current_card.definition_md);
      await flush(1600);
      assert.notEqual(view.querySelector("[data-study-card-scene]"), scene);
      assert.equal(store.getSnapshot().sessions[opened.session.session_id].reviewsApplied, 1);
    });
  });
}

test("a grade never reveals a stale visible session or card", async () => {
  for (const mismatch of ["session", "card"]) {
    const { storage, store } = fixture();
    const opened = start(store);
    await withApp({ storage, hash: `#session/${opened.session.session_id}` }, async ({ view, execute, flush, location }) => {
      const scene = view.querySelector("[data-study-card-scene]");
      if (mismatch === "session") scene.closest("[data-session-id]").dataset.sessionId = "stale-session";
      else scene.dataset.cardId = "stale-card";
      const beforeHash = location.hash;
      const result = await execute("submit_grade", injectedGrade(opened));
      assert.equal(result.ok, true);
      assert.equal(scene.classList.contains("is-flipped"), false);
      assert.equal(scene.querySelector("[data-study-definition]").textContent, "");
      await flush();
      assert.equal(location.hash, beforeHash);
    });
  }
});

test("an ended session update re-renders the current view without a route change", async () => {
  const { storage, store } = fixture();
  const opened = start(store);
  await withApp({ storage, hash: `#session/${opened.session.session_id}` }, async ({ execute, flush, view, location }) => {
    const result = await execute("finish_study_session", { session_id: opened.session.session_id, expected_session_revision: opened.session.session_revision, disposition: "end", idempotency_key: "test-end-visible" });
    assert.equal(result.ok, true);
    await flush();
    assert.match(view.textContent, /Session ended/);
    assert.doesNotMatch(view.textContent, /Answer in chat/);
    assert.equal(location.hash, `#session/${opened.session.session_id}`);
  });
});

test("normal My Decks retains the gold completed-course demonstration with explicit example provenance", async () => {
  const storage = createMemoryStorage();
  await withApp({ storage, hash: "#decks" }, async ({ view }) => {
    const completed = view.querySelector(".is-mastered");
    assert.match(completed.textContent, /Introductory Mechanics/);
    assert.match(completed.textContent, /100% mastered/);
    assert.match(completed.textContent, /Example progress/);
    assert.doesNotMatch(completed.textContent, /Studied \w+/);
  });
});

test("recording storage also isolates graph pins and rejects invalid names before reading normal data", () => {
  const backing = createMemoryStorage({ normal: "untouched" });
  const workspace = createBrowserWorkspace("?recording=qa-pins", () => backing);
  workspace.storage.setItem("graph-pin", "pin");
  assert.equal(backing.getItem("graph-pin"), null);
  assert.equal(backing.getItem("graph-pin:recording:qa-pins"), "pin");
  for (const query of ["?recording=", "?recording=../normal", "?recording=qa&demo=empty"]) {
    assert.throws(() => createBrowserWorkspace(query, () => { throw new Error("should not read storage"); }), (error) => !error.message.includes("should not read storage"));
  }
  assert.equal(backing.getItem("normal"), "untouched");
});

test("Reset in a recording workspace touches only that namespace and keeps its URL", async () => {
  const { storage } = fixture();
  const normal = storage.getItem(KEY);
  const key = `${KEY}:recording:reset-test`;
  await withApp({ storage, search: "?recording=reset-test" }, async ({ navigate, click, flush, navigations }) => {
    await navigate("#library");
    click('[data-add-deck="linear-algebra-i"]');
    await flush();
    assert.notEqual(storage.getItem(key), null);
    globalThis.confirm = () => true;
    click("[data-reset-local]");
    assert.equal(storage.getItem(key), null);
    assert.equal(storage.getItem(KEY), normal);
    assert.deepEqual(navigations, ["/?recording=reset-test#study"]);
  });
});

test("Exit pauses the exact queue; the home Resume action activates that same session", async () => {
  const { storage, store } = fixture();
  const opened = start(store);
  const id = opened.session.session_id;
  const before = store.getSnapshot().sessions[id];
  await withApp({ storage, hash: `#session/${id}` }, async ({ click, flush, view }) => {
    click("[data-pause-session]");
    await flush();
    const paused = store.getSnapshot();
    assert.equal(paused.activeSessionId, null);
    assert.equal(paused.sessions[id].status, "paused");
    assert.deepEqual(paused.sessions[id].queue, before.queue);
    assert.equal(paused.sessions[id].currentCardId, before.currentCardId);
    assert.match(view.textContent, /Resume session/);
    click("[data-resume-session]");
    await flush();
    const resumed = store.getSnapshot();
    assert.equal(resumed.activeSessionId, id);
    assert.equal(resumed.sessions[id].revision, before.revision + 2);
    assert.deepEqual(resumed.sessions[id].history, before.history);
    assert.match(view.textContent, /Answer in chat/);
  });
});

test("starting another deck pauses the current session and opens the requested deck", async () => {
  const { storage, store } = fixture();
  const opened = start(store);
  await withApp({ storage, hash: "#decks" }, async ({ click, flush, location }) => {
    click('[data-start-deck="deck-introductory-mechanics"]');
    await flush();
    const snapshot = store.getSnapshot();
    assert.equal(snapshot.sessions[opened.session.session_id].status, "paused");
    assert.equal(snapshot.sessions[snapshot.activeSessionId].deckId, "deck-introductory-mechanics");
    assert.equal(location.hash, `#session/${snapshot.activeSessionId}`);
  });
});

for (const disposition of ["pause", "end"]) {
  test(`${disposition === "pause" ? "Paused" : "Ended"} sessions never invite an answer or expose a definition`, async () => {
    const { storage, store } = fixture();
    const opened = start(store);
    store.finishStudySession({ session_id: opened.session.session_id, expected_session_revision: opened.session.session_revision, disposition, idempotency_key: `test-${disposition}` });
    await withApp({ storage, hash: `#session/${opened.session.session_id}` }, async ({ view }) => {
      assert.doesNotMatch(view.textContent, /Answer in chat|Define the term in your own words/);
      assert.equal(view.querySelector("[data-study-definition]"), null);
      assert.match(view.textContent, disposition === "pause" ? /Session paused/ : /Session ended/);
    });
  });
}

test("Study activity counts committed grades, not just legacy reviews", async () => {
  const { storage, store } = fixture();
  store.submitGrade(injectedGrade(start(store)));
  await withApp({ storage }, async ({ view }) => {
    assert.match(view.textContent, /1 recorded review/);
    assert.equal(view.querySelectorAll('[data-level="1"]').length, 1);
  });
});

test("recording starts unseeded, survives reload, and never imports or changes normal storage", async () => {
  const { storage } = fixture();
  const normal = storage.getItem(KEY);
  const search = "?recording=runtime-test";
  const recordingKey = `${KEY}:recording:runtime-test`;
  await withApp({ storage, search }, async ({ view, navigate, click, flush, execute }) => {
    assert.match(view.textContent, /Your next session starts with a deck/);
    const empty = await execute("get_learning_overview", {});
    assert.equal(empty.ok, true);
    await navigate("#library");
    click('[data-add-deck="linear-algebra-i"]');
    await flush();
    await navigate("#decks");
    click('[data-start-deck="deck-linear-algebra-i"]');
    await flush();
    const scoped = createStudyStore({ catalog: CATALOG, storage: {
      getItem: () => storage.getItem(recordingKey),
      setItem: (_, value) => storage.setItem(recordingKey, value),
      removeItem: () => storage.removeItem(recordingKey),
    } });
    const snapshot = scoped.getSnapshot();
    const current = scoped.getStudySession({ session_id: snapshot.activeSessionId });
    const receipt = await execute("submit_grade", injectedGrade(current));
    assert.equal(receipt.ok, true);
    await flush(1600);
    assert.equal(scoped.getSnapshot().sessions[snapshot.activeSessionId].reviewsApplied, 1);
    assert.equal(scoped.getSnapshot().activity.some((entry) => entry.demo), false);
  });
  assert.equal(storage.getItem(KEY), normal);
  await withApp({ storage, search }, async ({ view }) => {
    assert.match(view.textContent, /1 recorded review/);
    assert.match(view.textContent, /Resume session/);
    assert.doesNotMatch(view.textContent, /Introductory Mechanics/);
  });
  assert.equal(storage.getItem(KEY), normal);
});
