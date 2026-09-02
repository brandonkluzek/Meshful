import test from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./helpers/app-harness.mjs";
import { accountFixture, deferred, KEY } from "./helpers/account-fixture.mjs";
import { createMemoryStorage } from "../js/store.js";

function studying(fixture) {
  const store = fixture.server("account-a").store;
  store.addLibraryDeck({ library_deck_id: "linear-algebra-i", expected_catalog_version: "1.0.0-example", client_action_id: "fixture-install" });
  const current = store.startStudySession({ deck_id: "deck-linear-algebra-i", limit: 3, idempotency_key: "fixture-start" });
  const input = { session_id: current.session.session_id, expected_session_revision: current.session.session_revision,
    card_id: current.current_card.card_id, expected_card_revision: current.current_card.card_revision,
    answer_text: "Explicitly injected mechanics test answer; not learner evidence.", answer_origin: "chat", rating: "good",
    rubric_evidence: current.current_card.required_concepts.map((item) => ({ rubric_item_id: item.rubric_item_id, status: "met", note: "Injected test." })),
    feedback: "Injected test feedback.", misconceptions: [], confidence: 0.8, idempotency_key: "fixture-grade" };
  return { current, input };
}

test("private account UI starts empty and does not read, seed, reset or import the browser workspace", async () => {
  const fixture = accountFixture();
  await withApp({ storageError: new Error("normal learner storage must not be accessed"), accountOptions: fixture.options }, async ({ view, registrations, document }) => {
    assert.equal(registrations.size, 13);
    assert.doesNotMatch(view.textContent, /Example progress|Linear Algebra/);
    assert.equal(document.querySelector("[data-reset-local]"), null);
    assert.equal(fixture.snapshot().state_json, null);
  });
});

test("Library installation is awaited before visible success and unsupported remove stays disabled", async () => {
  const fixture = accountFixture();
  const pause = deferred(), entered = deferred();
  fixture.setMutationHook(async (method) => { if (method === "addLibraryDeck") { entered.resolve(); await pause.promise; } });
  const normal = createMemoryStorage({ [KEY]: "normal-preserved" });
  await withApp({ storage: normal, accountOptions: fixture.options, hash: "#library" }, async ({ view, click, flush, document, navigate }) => {
    click('[data-add-deck="linear-algebra-i"]');
    await entered.promise;
    assert.doesNotMatch(document.querySelector("[data-toasts]").textContent, /added/);
    assert.equal(fixture.snapshot().state_json, null);
    pause.resolve(); await flush();
    assert.match(document.querySelector("[data-toasts]").textContent, /added to My Decks/);
    await navigate("#decks");
    assert.match(view.textContent, /Linear Algebra I/);
    assert.notEqual(view.querySelector("[data-request-archive]").getAttribute("disabled"), null);
    click("[data-request-archive]"); await flush();
    assert.equal(view.querySelector("[data-confirm-archive]"), null);
    assert.equal(normal.getItem(KEY), "normal-preserved");
    assert.equal(fixture.calls.filter((call) => call.method === "addLibraryDeck").length, 1);
  });
});

test("Exit awaits durable pause before navigating, and Resume keeps the same queue", async () => {
  const fixture = accountFixture();
  const { current } = studying(fixture);
  const pause = deferred(), entered = deferred();
  fixture.setMutationHook(async (method) => { if (method === "finishStudySession") { entered.resolve(); await pause.promise; } });
  await withApp({ accountOptions: fixture.options, hash: `#session/${current.session.session_id}` }, async ({ click, flush, location, view }) => {
    click("[data-pause-session]"); await entered.promise;
    assert.equal(location.hash, `#session/${current.session.session_id}`);
    pause.resolve(); await flush();
    assert.equal(location.hash, "#study");
    assert.match(view.textContent, /Resume/);
    const before = fixture.server("account-a").store.getSnapshot().sessions[current.session.session_id];
    click('[data-start-deck="deck-linear-algebra-i"]'); await flush();
    assert.equal(location.hash, `#session/${current.session.session_id}`);
    const after = fixture.server("account-a").store.getSnapshot().sessions[current.session.session_id];
    assert.deepEqual(after.queue, before.queue);
    assert.equal(after.currentCardId, before.currentCardId);
  });
});

test("a confirmed old-account grade cannot reveal, navigate or return old data after switching accounts", async () => {
  const fixture = accountFixture();
  const { current, input } = studying(fixture);
  const pause = deferred(), entered = deferred();
  fixture.setMutationHook(async (method) => { if (method === "submitGrade") { entered.resolve(); await pause.promise; } });
  await withApp({ accountOptions: fixture.options, hash: `#session/${current.session.session_id}` }, async ({ view, execute, application, flush, registrations }) => {
    const scene = view.querySelector("[data-study-card-scene]");
    const oldRead = registrations.get("get_learning_overview");
    const grading = execute("submit_grade", input);
    await entered.promise;
    fixture.setPrincipal("account-b");
    await application.reconnect();
    assert.equal(scene.isConnected, false);
    pause.resolve();
    const result = await grading;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "ACCOUNT_CHANGED_AFTER_COMMIT");
    assert.equal(result.data, undefined);
    assert.equal((await oldRead.execute({})).error.code, "ACCOUNT_CHANGED");
    assert.equal(registrations.size, 13);
    assert.equal((await execute("get_learning_overview", {})).ok, true, "new account tools are freshly registered, not duplicate-name failures");
    await flush(3000);
    assert.doesNotMatch(view.textContent, /Linear Algebra|Definition revealed|Injected test feedback/);
    assert.equal(fixture.server("account-a").store.getSnapshot().sessions[current.session.session_id].reviewsApplied, 1);
    assert.equal(fixture.snapshot("account-b").state_json, null);
  });
});

test("account switch during awaited post-grade hydration suppresses the stale DOM sink and tool result", async () => {
  const fixture = accountFixture();
  const { current, input } = studying(fixture);
  const pause = deferred(), entered = deferred();
  await withApp({ accountOptions: fixture.options, hash: `#session/${current.session.session_id}` }, async ({ view, execute, application, flush }) => {
    const scene = view.querySelector("[data-study-card-scene]");
    fixture.setLoadHook(async (binding) => {
      if (binding === "account-a") { const snapshot = fixture.snapshot(binding); entered.resolve(); await pause.promise; return snapshot; }
      return fixture.snapshot(binding);
    });
    const resultPromise = execute("submit_grade", input);
    await entered.promise;
    fixture.setPrincipal("account-b");
    await application.reconnect();
    pause.resolve();
    const result = await resultPromise;
    assert.equal(result.error.code, "ACCOUNT_CHANGED_AFTER_COMMIT");
    assert.equal(scene.classList.contains("is-flipped"), false);
    await flush(3000);
    assert.doesNotMatch(view.textContent, /Definition revealed/);
  });
});

test("durable grade/replay reveals once and clock wake never interrupts its animation", async () => {
  const fixture = accountFixture();
  const { current, input } = studying(fixture);
  await withApp({ accountOptions: fixture.options, hash: `#session/${current.session.session_id}` }, async ({ view, execute, flush, window, document }) => {
    const scene = view.querySelector("[data-study-card-scene]");
    assert.equal((await execute("submit_grade", input)).ok, true);
    assert.equal(scene.classList.contains("is-flipped"), true);
    for (const fn of window.listeners.get("focus") ?? []) await fn();
    for (const fn of document.body.listeners.get("visibilitychange") ?? []) await fn();
    await flush();
    assert.equal(view.querySelector("[data-study-card-scene]"), scene);
    assert.equal((await execute("submit_grade", input)).data.receipt.replayed, true);
    await flush(1700);
    assert.notEqual(view.querySelector("[data-study-card-scene]"), scene);
    assert.equal(fixture.server("account-a").store.getSnapshot().sessions[current.session.session_id].reviewsApplied, 1);
  });
});

test("opening Settings re-reads pending recovery instead of trapping an uncertain save behind a new ID", async () => {
  const fixture = accountFixture();
  await withApp({ accountOptions: fixture.options }, async ({ click, flush, document }) => {
    fixture.clients[0].getPending = () => ({ accountBinding: "account-a", recoveryStatus: "awaiting-confirmation" });
    click("[data-action='open-account']"); await flush();
    click("[data-open-settings]"); await flush();
    assert.ok(document.querySelector("[data-retry-account-write]"));
  });
});

test("sign-out uses the dispatcher route and immediately revokes the displayed account", async () => {
  const fixture = accountFixture();
  studying(fixture);
  await withApp({ accountOptions: fixture.options, hash: "#decks" }, async ({ click, flush, document, view, registrations }) => {
    const oldRead = registrations.get("get_learning_overview");
    assert.match(view.textContent, /Linear Algebra I/);
    click("[data-action='open-account']"); await flush();
    const link = document.querySelector("[data-account-signout]");
    assert.equal(link.getAttribute("href"), "/signout-with-chatgpt?return_to=%2F");
    assert.equal(link.getAttribute("target"), "_top");
    click("[data-account-signout]");
    assert.doesNotMatch(view.textContent, /Linear Algebra I/);
    assert.match(view.textContent, /Account access paused/);
    assert.equal((await oldRead.execute({})).error.code, "ACCOUNT_CHANGED");
    assert.equal(document.querySelector("[data-account-signout]"), null);
    await flush();
  });
});
