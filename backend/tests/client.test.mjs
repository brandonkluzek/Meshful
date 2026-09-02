import test from "node:test";
import assert from "node:assert/strict";
import { createDurableClient } from "../src/durable-client.mjs";

const code = (expected) => (error) => error.code === expected;
const copy = (value) => JSON.parse(JSON.stringify(value));
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const state = (account = "learner-a", revision = 0) => json({ ok: true, data: {
  account_binding: account, durable_revision: revision, state: null, state_json: null,
} });
const resultFor = (id, replayed = false) => ({
  review_id: "review-1", card_id: "card-1", feedback: "Exact learner feedback",
  receipt: { transaction_id: `transaction:${id}`, idempotency_key: id, replayed, committed_at: "2026-08-30T12:00:00.000Z" },
});
const committed = (id, revision = 1, replayed = false) => json({ ok: true, data: {
  durable_revision: revision, result: resultFor(id, replayed),
} });
const grade = (id = "grade-1") => ({
  idempotency_key: id, session_id: "session-1", card_id: "card-1",
  expected_card_revision: 1, expected_session_revision: 4,
  answer_text: "A definition\r\nα  ", answer_origin: "chat", rating: "good",
  rubric_evidence: [], feedback: "The definition was recalled.", misconceptions: [], confidence: 0.9,
});

function memoryOutbox(initial = null) {
  let value = copy(initial);
  return { read: () => copy(value), write: (next) => { value = copy(next); } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("write actions require a previously loaded account and never relabel captured input during implicit load", async () => {
  let requests = 0;
  const client = createDurableClient({ outbox: memoryOutbox(), fetchImpl: async () => { requests++; return state("learner-b"); } });
  await assert.rejects(client.submitGrade(grade()), code("STATE_NOT_LOADED"));
  assert.equal(requests, 0);
  assert.equal(client.getPending(), null);
});

test("Accounts' sanitized error envelope preserves status and code", async () => {
  const client = createDurableClient({ outbox: memoryOutbox(), fetchImpl: async () =>
    json({ error: { code: "authentication_required", message: "Authentication required." } }, 401) });
  await assert.rejects(client.load(), (error) => error.code === "authentication_required" && error.status === 401);
});

test("superseded loads cannot late-bind an old account or expose its snapshot", async () => {
  const oldLoad = deferred(); const newLoad = deferred();
  let loads = 0; let bindingSent;
  const client = createDurableClient({ outbox: memoryOutbox(), fetchImpl: async (url, options) => {
    if (url.endsWith("/state")) return ++loads === 1 ? oldLoad.promise : newLoad.promise;
    bindingSent = options.headers["X-Meshful-Account"];
    return committed("b-grade");
  } });
  const stale = client.load();
  const staleRejected = assert.rejects(stale, code("STALE_CLIENT_RESPONSE"));
  const current = client.load();
  newLoad.resolve(state("learner-b"));
  assert.equal((await current).account_binding, "learner-b");
  oldLoad.resolve(state("learner-a"));
  await staleRejected;
  await client.submitGrade(grade("b-grade"));
  assert.equal(bindingSent, "learner-b");
});

test("an already bound client retires on account change without relabeling a new write", async () => {
  let account = "learner-a"; let posts = 0;
  const outbox = memoryOutbox();
  const client = createDurableClient({ outbox, fetchImpl: async (url) => {
    if (url.endsWith("/state")) return state(account);
    posts++;
    return committed("grade-1");
  } });
  await client.load(); account = "learner-b";
  await assert.rejects(client.load(), code("ACCOUNT_CHANGED"));
  await assert.rejects(client.submitGrade(grade()), code("ACCOUNT_CHANGED"));
  await assert.rejects(client.getLearningOverview({}), code("ACCOUNT_CHANGED"));
  assert.equal(posts, 0);
  assert.equal(outbox.read(), null);
});

test("a state load started before a known commit cannot return the older snapshot", async () => {
  const earlierSnapshot = deferred(); let loads = 0;
  const client = createDurableClient({ outbox: memoryOutbox(), fetchImpl: async (url) => {
    if (url.endsWith("/state")) return ++loads === 1 ? state() : earlierSnapshot.promise;
    return committed("grade-1");
  } });
  await client.load();
  const obsolete = assert.rejects(client.load(), code("STALE_CLIENT_RESPONSE"));
  await client.submitGrade(grade());
  earlierSnapshot.resolve(state());
  await obsolete;
});

test("exposes all 13 WebMCP methods plus installation, with guarded async queries", async () => {
  const calls = [];
  const client = createDurableClient({ outbox: memoryOutbox(), fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith("/state")) return state();
    return json({ ok: true, data: { durable_revision: 0, result: { query: JSON.parse(options.body).operation } } });
  } });
  const methods = [
    ["getLearningOverview", "get_learning_overview"], ["searchLibrary", "search_library"],
    ["searchMyDecks", "list_my_decks"], ["getDeck", "get_deck"],
    ["validateDeck", "validate_deck"], ["getStudySession", "get_study_session"],
  ];
  for (const [method, operation] of methods) assert.deepEqual(await client[method]({ term: "term" }), { query: operation });
  for (const method of ["ingestDeck", "updateDeck", "addCards", "updateCards", "startStudySession", "submitGrade", "finishStudySession", "addLibraryDeck"]) {
    assert.equal(typeof client[method], "function");
  }
  assert.equal(calls[0].method, "GET");
  for (const call of calls.slice(1)) {
    assert.equal(call.url, "/api/learner/v1/queries");
    assert.equal(call.method, "POST");
    assert.equal(call.headers["X-Meshful-Account"], "learner-a");
    assert.equal(call.credentials, "same-origin");
    assert.equal(call.cache, "no-store");
  }
  assert.equal(client.getPending(), null);
});

test("grade stays pending without an optimistic result until a matching receipt arrives", async () => {
  const outbox = memoryOutbox();
  const started = deferred();
  const acknowledgement = deferred();
  let sent;
  const client = createDurableClient({ outbox, fetchImpl: async (url, options) => {
    if (url.endsWith("/state")) return state();
    sent = options;
    started.resolve();
    return acknowledgement.promise;
  } });
  await client.load();
  const args = grade();
  let resolved = false;
  const operation = client.submitGrade(args).then((result) => { resolved = true; return result; });
  args.answer_text = "Caller changed its object";
  await started.promise;
  assert.equal(resolved, false);
  assert.equal(outbox.read().command.args.answer_text, "A definition\r\nα  ");
  assert.deepEqual(JSON.parse(sent.body), outbox.read().command);
  assert.equal(sent.headers["X-Meshful-Account"], outbox.read().accountBinding);
  const exposed = client.getPending(); exposed.command.args.answer_text = "Getter mutation";
  assert.equal(client.getPending().command.args.answer_text, "A definition\r\nα  ");
  await assert.rejects(client.submitGrade(grade("new-action")), code("PENDING_COMMAND"));
  await assert.rejects(client.retryPending(), code("PENDING_COMMAND"));
  acknowledgement.resolve(committed("grade-1"));
  assert.deepEqual(await operation, resultFor("grade-1"));
  assert.equal(outbox.read(), null);
  assert.equal(client.getPending(), null);
});

test("an identical concurrent tool intent joins one commit and suppresses a duplicate effect", async () => {
  const started = deferred(); const ack = deferred(); let posts = 0;
  const client = createDurableClient({ outbox: memoryOutbox(), fetchImpl: async (url) => {
    if (url.endsWith("/state")) return state();
    posts++; started.resolve(); return ack.promise;
  } });
  await client.load();
  const first = client.submitGrade(grade()); await started.promise;
  const duplicate = client.submitGrade(grade());
  assert.equal(posts, 1);
  ack.resolve(committed("grade-1"));
  assert.equal((await first).receipt.replayed, false);
  assert.equal((await duplicate).receipt.replayed, true);
  assert.equal(client.getPending(), null);
});

test("lost acknowledgement retries identical original payload after a new client and a later revision", async () => {
  const outbox = memoryOutbox();
  const posted = [];
  let currentRevision = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/state")) return state("learner-a", currentRevision);
    posted.push(options);
    if (posted.length === 1) { currentRevision = 7; throw new Error("Acknowledgement lost after commit"); }
    const input = JSON.parse(options.body);
    return committed(input.request_id, input.request_id === "grade-1" ? 1 : 8, input.request_id === "grade-1");
  };
  const first = createDurableClient({ outbox, fetchImpl });
  await first.load();
  await assert.rejects(first.submitGrade(grade()), code("REQUEST_UNCONFIRMED"));
  const original = outbox.read();
  const restored = createDurableClient({ outbox, fetchImpl });
  await assert.rejects(restored.updateDeck({ idempotency_key: "new" }), code("PENDING_COMMAND"));
  const replay = await restored.retryPending();
  assert.deepEqual(replay, resultFor("grade-1", true));
  assert.equal(posted[1].body, posted[0].body);
  assert.deepEqual(JSON.parse(posted[1].body), original.command);
  assert.equal(posted[1].headers["X-Meshful-Account"], original.accountBinding);
  await restored.updateDeck({ idempotency_key: "after-replay", title: "Edited title" });
  assert.equal(JSON.parse(posted[2].body).expected_revision, 7);
  assert.equal(restored.getPending(), null);
});

test("account switch retains the original binding and blocks retry before any command POST", async () => {
  const outbox = memoryOutbox();
  let account = "learner-a";
  let posts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/state")) return state(account);
    posts++;
    throw new Error("lost network");
  };
  const first = createDurableClient({ outbox, fetchImpl });
  await first.load();
  await assert.rejects(first.submitGrade(grade()));
  const original = outbox.read();
  account = "learner-b";
  const restored = createDurableClient({ outbox, fetchImpl });
  await assert.rejects(restored.retryPending(), code("ACCOUNT_CHANGED"));
  assert.equal(posts, 1);
  assert.deepEqual(outbox.read(), original);
  assert.equal(restored.getPending().accountBinding, "learner-a");
  await assert.rejects(restored.submitGrade(grade("other-account")), code("PENDING_COMMAND"));
});

test("409 rejection keeps the draft, action identity, and original revision across retries", async () => {
  const outbox = memoryOutbox();
  const posted = [];
  let revision = 0;
  const client = createDurableClient({ outbox, fetchImpl: async (url, options) => {
    if (url.endsWith("/state")) return state("learner-a", revision++);
    posted.push(options.body);
    return json({ ok: false, error: { code: "STALE_DURABLE_REVISION", message: "Another write changed the state" } }, 409);
  } });
  await client.load();
  await assert.rejects(client.submitGrade(grade()), code("STALE_DURABLE_REVISION"));
  const original = outbox.read();
  await assert.rejects(client.retryPending(), code("STALE_DURABLE_REVISION"));
  assert.deepEqual(outbox.read(), original);
  assert.equal(posted[1], posted[0]);
  await assert.rejects(client.submitGrade(grade("new-action")), code("PENDING_COMMAND"));
});

test("malformed acknowledgements never clear a pending grade", async () => {
  const cases = [
    () => new Response("not-json", { status: 200 }),
    () => json({ ok: true, data: { durable_revision: 1, result: {} } }),
    () => committed("different-request"),
    () => json({ ok: true, data: { durable_revision: "1", result: resultFor("grade-1") } }),
    () => json({ ok: true, data: { durable_revision: Infinity, result: resultFor("grade-1") } }),
    () => json({ ok: true, data: { durable_revision: 1, result: { receipt: { idempotency_key: "grade-1", replayed: "false" } } } }),
    () => committed("grade-1", 5),
    () => json({ ok: true, data: { durable_revision: 1, result: resultFor("grade-1") } }, 503),
  ];
  for (const badReply of cases) {
    const outbox = memoryOutbox();
    const client = createDurableClient({ outbox, fetchImpl: async (url) => url.endsWith("/state") ? state() : badReply() });
    await client.load();
    await assert.rejects(client.submitGrade(grade()), code("MALFORMED_RESPONSE"));
    assert.equal(outbox.read().command.request_id, "grade-1");
    assert.equal(client.getPending().command.expected_revision, 0);
    await assert.rejects(client.submitGrade(grade("new-action")), code("PENDING_COMMAND"));
  }
});

test("outbox failure before send blocks mutation and preserves an exportable in-memory draft", async () => {
  const outbox = memoryOutbox();
  const write = outbox.write;
  outbox.write = () => { throw new Error("Storage full"); };
  let posts = 0;
  const client = createDurableClient({ outbox, fetchImpl: async (url) => {
    if (url.endsWith("/state")) return state();
    posts++;
    return committed("grade-1");
  } });
  await client.load();
  await assert.rejects(client.submitGrade(grade()), code("OUTBOX_UNAVAILABLE"));
  assert.equal(posts, 0);
  assert.equal(client.getPending().recoveryStatus, "outbox-write-failed");
  assert.equal(client.getPending().command.args.answer_text, grade().answer_text);
  await assert.rejects(client.submitGrade(grade("new-action")), code("PENDING_COMMAND"));
  outbox.write = write;
  assert.deepEqual(await client.retryPending(), resultFor("grade-1"));
  assert.equal(posts, 1);
  assert.equal(outbox.read(), null);
});

test("a no-op outbox cannot send a grade whose recovery draft was never saved", async () => {
  let posts = 0;
  const client = createDurableClient({ outbox: { read: () => null, write() {} }, fetchImpl: async (url) => {
    if (url.endsWith("/state")) return state();
    posts++;
    return committed("grade-1");
  } });
  await client.load();
  await assert.rejects(client.submitGrade(grade()), code("OUTBOX_UNAVAILABLE"));
  assert.equal(posts, 0);
  assert.equal(client.getPending().command.args.answer_text, grade().answer_text);
});

test("another client cannot overwrite a draft created after its own initialization", async () => {
  const outbox = memoryOutbox(); const started = deferred(); const ack = deferred();
  let posts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/state")) return state();
    if (++posts === 1) { started.resolve(); return ack.promise; }
    return committed("other-grade");
  };
  const first = createDurableClient({ outbox, fetchImpl });
  const second = createDurableClient({ outbox, fetchImpl });
  await first.load(); await second.load();
  const firstWrite = first.submitGrade(grade()); await started.promise;
  const original = outbox.read();
  await assert.rejects(second.submitGrade(grade("other-grade")), code("OUTBOX_CONFLICT"));
  assert.equal(posts, 1);
  assert.deepEqual(outbox.read(), original);
  assert.equal(second.getPending().command.request_id, "other-grade");
  ack.resolve(committed("grade-1"));
  await firstWrite;
});

test("a late acknowledgement cannot clear a different newer or account-switched draft", async () => {
  const outbox = memoryOutbox(); const started = deferred(); const ack = deferred();
  let posts = 0;
  const client = createDurableClient({ outbox, fetchImpl: async (url) => {
    if (url.endsWith("/state")) return state("learner-a", posts ? 1 : 0);
    posts++; started.resolve(); return ack.promise;
  } });
  await client.load();
  const writing = client.submitGrade(grade()); await started.promise;
  const otherDraft = { accountBinding: "learner-b", command: {
    request_id: "other-grade", expected_revision: 0, operation: "submit_grade", args: grade("other-grade"),
  } };
  outbox.write(otherDraft); // Simulate an unleased/shared adapter; do not erase it.
  ack.resolve(committed("grade-1"));
  assert.deepEqual(await writing, resultFor("grade-1"));
  assert.deepEqual(outbox.read(), otherDraft);
  assert.equal(client.getPending().recoveryStatus, "committed-outbox-pending");
  await assert.rejects(client.retryPending(), code("OUTBOX_CONFLICT"));
  assert.deepEqual(outbox.read(), otherDraft);
  assert.equal(client.getPending().command.request_id, "grade-1");
  assert.equal(client.getPending().recoveryStatus, "committed-outbox-pending");
  assert.equal(posts, 1);
});

test("outbox failure after known commit returns success, blocks new writes, and allows replay", async () => {
  const outbox = memoryOutbox();
  const write = outbox.write;
  outbox.write = (value) => { if (value === null) throw new Error("Cannot clear storage"); write(value); };
  const posted = [];
  const client = createDurableClient({ outbox, fetchImpl: async (url, options) => {
    if (url.endsWith("/state")) return state("learner-a", posted.length ? 1 : 0);
    posted.push(options.body);
    return committed("grade-1", 1, posted.length > 1);
  } });
  await client.load();
  assert.deepEqual(await client.submitGrade(grade()), resultFor("grade-1"));
  assert.equal(client.getPending().recoveryStatus, "committed-outbox-pending");
  assert.equal(outbox.read().command.request_id, "grade-1");
  await assert.rejects(client.submitGrade(grade("new-action")), code("PENDING_COMMAND"));
  outbox.write = write;
  assert.deepEqual(await client.retryPending(), resultFor("grade-1", true));
  assert.equal(posted[1], posted[0]);
  assert.equal(client.getPending(), null);
  assert.equal(outbox.read(), null);
});

test("receipt-recovery draft failures before or after persistence remain retryable without a reload", async () => {
  for (const failure of ["write-before", "write-after", "read-after"]) {
    const outbox = memoryOutbox(); const baseRead = outbox.read; const baseWrite = outbox.write;
    let failReplacement = true; let failRead = false; const posted = [];
    outbox.read = () => {
      if (failRead) { failRead = false; throw new Error("Readback failed after saving"); }
      return baseRead();
    };
    outbox.write = (value) => {
      if (value?.command.expected_revision === 0 && failReplacement) {
        failReplacement = false;
        if (failure === "write-before") throw new Error("Not saved");
        baseWrite(value);
        if (failure === "write-after") throw new Error("Saved but acknowledgement failed");
        failRead = true;
      } else baseWrite(value);
    };
    const client = createDurableClient({ outbox, fetchImpl: async (url, options) => {
      if (url.endsWith("/state")) return state("learner-a", 4);
      if (url.includes("/receipts/")) {
        assert.equal(options.headers["X-Meshful-Account"], "learner-a");
        return committed("grade-1", 1, true);
      }
      const command = JSON.parse(options.body); posted.push(command);
      if (command.expected_revision !== 0) return json({ ok: false, error: {
        code: "IDEMPOTENCY_CONFLICT", message: "The key already committed with its original revision",
      } }, 409);
      return committed("grade-1", 1, true);
    } });
    await client.load();
    await assert.rejects(client.submitGrade(grade()), code("OUTBOX_UNAVAILABLE"));
    assert.equal(client.getPending().command.expected_revision, 0);
    assert.deepEqual(client.getPending().command.args, grade());
    assert.equal(baseRead().command.expected_revision, failure === "write-before" ? 4 : 0);
    const replay = await client.submitGrade(grade());
    assert.equal(replay.receipt.replayed, true);
    assert.equal(posted.length, 2);
    assert.deepEqual(posted[1], { ...posted[0], expected_revision: 0 });
    assert.equal(baseRead(), null);
    assert.equal(client.getPending(), null);
  }
});

test("Library installation uses client_action_id and a confirmed canonical receipt", async () => {
  let command;
  const client = createDurableClient({ outbox: memoryOutbox(), fetchImpl: async (url, options) => {
    if (url.endsWith("/state")) return state("learner-a", 2);
    command = JSON.parse(options.body);
    return committed("install-1", 3);
  } });
  await client.load();
  const args = { client_action_id: "install-1", library_deck_id: "library-math", expected_catalog_version: "catalog-v1" };
  assert.deepEqual(await client.addLibraryDeck(args), resultFor("install-1"));
  assert.deepEqual(command, { request_id: "install-1", expected_revision: 2, operation: "add_library_deck", args });
});

test("a failed replay cannot erase knowledge that the original command committed", async () => {
  const outbox = memoryOutbox();
  const write = outbox.write;
  outbox.write = (value) => { if (value === null) throw new Error("Cannot clear storage"); write(value); };
  let posts = 0;
  const client = createDurableClient({ outbox, fetchImpl: async (url) => {
    if (url.endsWith("/state")) return state("learner-a", posts ? 1 : 0);
    if (++posts > 1) throw new Error("Replay acknowledgement lost");
    return committed("grade-1");
  } });
  await client.load();
  assert.deepEqual(await client.submitGrade(grade()), resultFor("grade-1"));
  await assert.rejects(client.retryPending(), code("REQUEST_UNCONFIRMED"));
  assert.equal(client.getPending().recoveryStatus, "committed-outbox-pending");
  outbox.write = () => { throw new Error("Cannot save recovery draft"); };
  await assert.rejects(client.retryPending(), code("OUTBOX_UNAVAILABLE"));
  assert.equal(client.getPending().recoveryStatus, "committed-outbox-pending");
  assert.equal(posts, 2);
});

test("explicit synchronous outbox is mandatory and malformed saved commands fail closed", async () => {
  assert.throws(() => createDurableClient(), code("OUTBOX_REQUIRED"));
  assert.throws(() => createDurableClient({ outbox: { read() { throw new Error("locked"); }, write() {} } }), code("OUTBOX_UNAVAILABLE"));
  assert.throws(() => createDurableClient({ outbox: { read: async () => null, write() {} } }), code("OUTBOX_UNAVAILABLE"));
  const corrupted = memoryOutbox({ accountBinding: "learner-a", command: { request_id: "wrong", expected_revision: 0, operation: "submit_grade", args: grade() } });
  assert.throws(() => createDurableClient({ outbox: corrupted }), code("OUTBOX_UNAVAILABLE"));
  assert.equal(corrupted.read().command.request_id, "wrong");
  let posts = 0;
  const client = createDurableClient({ outbox: { read: () => null, write: async () => {} }, fetchImpl: async (url) => {
    if (url.endsWith("/state")) return state();
    posts++;
    return committed("grade-1");
  } });
  await client.load();
  await assert.rejects(client.submitGrade(grade()), code("OUTBOX_UNAVAILABLE"));
  assert.equal(posts, 0);
});
