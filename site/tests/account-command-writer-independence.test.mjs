import assert from "node:assert/strict";
import test from "node:test";

import { createDurableClient } from "../integration/backend/v7/src/durable-client.mjs";
import { createLearnerHandler } from "../integration/backend/v7/src/http-handler.mjs";

const CATALOG_REF = Object.freeze({ version: "release-v2", digest: `sha256:${"b".repeat(64)}` });
const WRITER = Object.freeze({ writerEpoch: 7, token: "a".repeat(64) });

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json" },
});

function memoryOutbox() {
  let saved = null;
  return {
    outbox: {
      read: () => structuredClone(saved),
      write: (value) => { saved = structuredClone(value); },
    },
    read: () => structuredClone(saved),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function stateData(accountBinding, durableRevision) {
  return {
    schema_version: 2,
    snapshot_encoding: "canonical-json.v1",
    account_binding: accountBinding,
    durable_revision: durableRevision,
    catalog_ref: durableRevision === 0 ? null : CATALOG_REF,
    state_json: null,
  };
}

function commandResult(command, durableRevision, { replayed = false } = {}) {
  const receipt = {
    idempotency_key: command.request_id,
    replayed,
  };
  if (command.operation !== "set_deck_archived") {
    return { durable_revision: durableRevision, result: { ok: true, receipt } };
  }
  const appRevision = command.args.expected_revision + 1;
  return {
    durable_revision: durableRevision,
    result: {
      deck: {
        id: command.args.deck_id,
        archived: command.args.archived,
        revision: command.args.expected_revision + 1,
      },
      visible_effect: {
        type: command.args.archived ? "deck_archived" : "deck_restored",
        deck_id: command.args.deck_id,
      },
      app_revision: appRevision,
      receipt: {
        ...receipt,
        operation: command.operation,
        client_action_id: command.request_id,
        previous_app_revision: appRevision - 1,
        app_revision: appRevision,
        transaction_id: `durable-archive:${command.request_id}`,
      },
    },
  };
}

function headerValue(request, name) {
  return new Headers(request.headers).get(name);
}

test("v7 sends Study writer proof only for Study commands, never Add, Archive, or Restore", async () => {
  const recovery = memoryOutbox();
  const commands = [];
  let durableRevision = 0;
  const client = createDurableClient({
    outbox: recovery.outbox,
    writerGrant: WRITER,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(url, "https://meshful.test").pathname;
      if (path.endsWith("/state")) return json({ ok: true, data: stateData("account-A", durableRevision) });
      assert.ok(path.endsWith("/commands"));
      const command = JSON.parse(init.body);
      assert.equal(command.expected_revision, durableRevision);
      commands.push({ command, headers: init.headers });
      durableRevision += 1;
      return json({ ok: true, data: commandResult(command, durableRevision) });
    },
  });

  await client.load();
  await client.addLibraryDeck({
    library_deck_id: "library:algorithms",
    expected_catalog_version: "release-v2",
    client_action_id: "account-lane:add",
  });
  await client.setDeckArchived({
    deck_id: "deck-algorithms",
    archived: true,
    expected_revision: 1,
    client_action_id: "account-lane:archive",
  });
  await client.setDeckArchived({
    deck_id: "deck-algorithms",
    archived: false,
    expected_revision: 2,
    client_action_id: "account-lane:restore",
  });
  await client.startStudySession({
    deck_id: "deck-other",
    idempotency_key: "study-lane:start",
  });
  await client.submitSelfGrade({
    session_id: "session-1",
    card_id: "deck-other.card-1",
    expected_card_revision: 1,
    expected_session_revision: 1,
    rating: "good",
    idempotency_key: "study-lane:self-grade",
  });

  assert.deepEqual(commands.map(({ command }) => command.operation), [
    "add_library_deck",
    "set_deck_archived",
    "set_deck_archived",
    "start_study_session",
    "submit_self_grade",
  ]);
  for (const request of commands.slice(0, 3)) {
    assert.equal(headerValue(request, "x-meshful-writer-epoch"), null);
    assert.equal(headerValue(request, "x-meshful-writer-token"), null);
  }
  for (const request of commands.slice(3)) {
    assert.equal(headerValue(request, "x-meshful-writer-epoch"), "7");
    assert.equal(headerValue(request, "x-meshful-writer-token"), WRITER.token);
  }
  assert.equal(recovery.read(), null);
});

test("an unbound v7 client preserves a Study draft without sending it", async () => {
  const recovery = memoryOutbox();
  let commandCalls = 0;
  const client = createDurableClient({
    outbox: recovery.outbox,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(url, "https://meshful.test").pathname;
      if (path.endsWith("/state")) return json({ ok: true, data: stateData("account-A", 0) });
      if (init.method === "POST" && path.endsWith("/commands")) commandCalls += 1;
      throw new Error("Study transport must not run without a writer grant");
    },
  });
  await client.load();
  await assert.rejects(client.startStudySession({
    deck_id: "deck-A",
    idempotency_key: "study-without-writer",
  }), (error) => error?.code === "CLIENT_CONFIGURATION");
  assert.equal(commandCalls, 0);
  assert.equal(client.getPending().command.operation, "start_study_session");
  assert.equal(recovery.read().command.request_id, "study-without-writer");
});

test("a remotely paused same-deck session is a truthful terminal Study conflict", async () => {
  const recovery = memoryOutbox();
  const handler = createLearnerHandler({
    service: {
      async getState() { return stateData("account-A", 4); },
      async command() {
        throw Object.assign(new Error("session was paused by Archive"), { code: "SESSION_NOT_ACTIVE" });
      },
    },
    authenticate: async () => ({ principalId: "account-A" }),
  });
  const client = createDurableClient({
    outbox: recovery.outbox,
    writerGrant: WRITER,
    fetchImpl: (url, init) => handler(new Request(new URL(url, "https://meshful.test"), init)),
  });
  await client.load();
  await assert.rejects(client.submitGrade({
    session_id: "session-A",
    card_id: "card-A",
    expected_card_revision: 1,
    expected_session_revision: 1,
    answer_text: "answer",
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: [],
    feedback: "correct",
    misconceptions: [],
    confidence: 0.9,
    idempotency_key: "grade:after-archive",
  }), (error) => error?.code === "SESSION_NOT_ACTIVE" && error?.status === 409);
  assert.equal(client.getPending(), null,
    "a confirmed session conflict cannot become an unrecoverable Grade draft");
  assert.equal(recovery.read(), null);
});

test("an active-session start conflict clears its draft before the next Grade", async () => {
  const recovery = memoryOutbox();
  const operations = [];
  let durableRevision = 4;
  const client = createDurableClient({
    outbox: recovery.outbox,
    writerGrant: WRITER,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(url, "https://meshful.test").pathname;
      if (path.endsWith("/state")) {
        return json({ ok: true, data: stateData("account-A", durableRevision) });
      }
      assert.ok(path.endsWith("/commands"));
      const command = JSON.parse(init.body);
      operations.push(command.operation);
      if (command.operation === "start_study_session") {
        return json({ ok: false, error: {
          code: "ACTIVE_SESSION_EXISTS",
          message: "the account already has an active session",
        } }, 409);
      }
      assert.equal(command.operation, "submit_grade");
      assert.equal(command.expected_revision, durableRevision);
      durableRevision += 1;
      return json({ ok: true, data: commandResult(command, durableRevision) });
    },
  });

  await client.load();
  await assert.rejects(client.startStudySession({
    deck_id: "deck-A",
    idempotency_key: "start:already-active",
  }), (error) => error?.code === "ACTIVE_SESSION_EXISTS" && error?.status === 409);
  assert.equal(client.getPending(), null,
    "a confirmed active-session conflict cannot stay ahead of a later Grade");
  assert.equal(recovery.read(), null);

  const graded = await client.submitGrade({
    session_id: "session-A",
    card_id: "card-A",
    expected_card_revision: 1,
    expected_session_revision: 1,
    answer_text: "answer",
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: [],
    feedback: "correct",
    misconceptions: [],
    confidence: 0.9,
    idempotency_key: "grade:after-active-session-conflict",
  });
  assert.equal(graded.receipt.idempotency_key, "grade:after-active-session-conflict");
  assert.deepEqual(operations, ["start_study_session", "submit_grade"]);
  assert.equal(client.getPending(), null);
  assert.equal(recovery.read(), null);
});

test("an unexpected active-session conflict on a Grade remains recoverable", async () => {
  const recovery = memoryOutbox();
  const client = createDurableClient({
    outbox: recovery.outbox,
    writerGrant: WRITER,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(url, "https://meshful.test").pathname;
      if (path.endsWith("/state")) {
        return json({ ok: true, data: stateData("account-A", 4) });
      }
      assert.equal(JSON.parse(init.body).operation, "submit_grade");
      return json({ ok: false, error: {
        code: "ACTIVE_SESSION_EXISTS",
        message: "unexpected conflict for this operation",
      } }, 409);
    },
  });

  await client.load();
  await assert.rejects(client.submitGrade({
    session_id: "session-A",
    card_id: "card-A",
    expected_card_revision: 1,
    expected_session_revision: 1,
    answer_text: "answer",
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: [],
    feedback: "correct",
    misconceptions: [],
    confidence: 0.9,
    idempotency_key: "grade:unexpected-active-session-conflict",
  }), (error) => error?.code === "ACTIVE_SESSION_EXISTS" && error?.status === 409);
  assert.equal(client.getPending().command.operation, "submit_grade");
  assert.equal(recovery.read().command.operation, "submit_grade",
    "only a rejected start may be cleared by ACTIVE_SESSION_EXISTS");
});

test("the integrated v8 Study client retries only its initial SERVICE_BUSY state load", async () => {
  const recovery = memoryOutbox();
  const waits = [];
  let stateReads = 0;
  const client = createDurableClient({
    outbox: recovery.outbox,
    writerGrant: WRITER,
    randomImpl: () => 0,
    sleepImpl: async (delay) => { waits.push(delay); },
    fetchImpl: async () => {
      stateReads += 1;
      if (stateReads < 3) {
        return json({ ok: false, error: {
          code: "SERVICE_BUSY",
          message: "retry the initial read",
        } }, 503);
      }
      return json({ ok: true, data: stateData("account-A", 0) });
    },
  });

  await client.load();
  assert.equal(stateReads, 3);
  assert.deepEqual(waits, [60, 160]);
  assert.equal(client.getPending(), null);
  assert.equal(recovery.read(), null);
});

function uncertainArchiveFixture() {
  const recovery = memoryOutbox();
  const requests = [];
  let durableRevision = 0;
  let committed = null;
  let mutationCount = 0;
  let accountBinding = "account-A";
  const client = createDurableClient({
    outbox: recovery.outbox,
    writerGrant: WRITER,
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url, "https://meshful.test");
      if (parsed.pathname.endsWith("/state")) {
        return json({ ok: true, data: stateData(accountBinding, durableRevision) });
      }
      if (parsed.pathname.endsWith("/commands")) {
        const command = JSON.parse(init.body);
        requests.push({ command, headers: init.headers });
        if (committed) {
          return json({ ok: true, data: commandResult(committed, durableRevision, { replayed: true }) });
        }
        mutationCount += 1;
        durableRevision += 1;
        committed = command;
        throw new TypeError("synthetic acknowledgement loss");
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${parsed.pathname}`);
    },
  });
  return {
    client,
    recovery,
    requests,
    mutationCount: () => mutationCount,
    switchAccount: () => { accountBinding = "account-B"; },
  };
}

test("a lost Archive acknowledgement replays the exact unbound command once", async () => {
  const fixture = uncertainArchiveFixture();
  await fixture.client.load();
  const args = {
    deck_id: "deck-A",
    archived: true,
    expected_revision: 3,
    client_action_id: "archive:lost-ack",
  };
  await assert.rejects(fixture.client.setDeckArchived(args),
    (error) => error?.code === "REQUEST_UNCONFIRMED");
  assert.deepEqual(fixture.client.getPending().command.args, args);
  const recovered = await fixture.client.retryPending();
  assert.equal(recovered.receipt.replayed, true);
  assert.equal(fixture.mutationCount(), 1);
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests[0].command, fixture.requests[1].command);
  for (const request of fixture.requests) {
    assert.equal(headerValue(request, "x-meshful-writer-epoch"), null);
    assert.equal(headerValue(request, "x-meshful-writer-token"), null);
  }
  assert.equal(fixture.client.getPending(), null);
  assert.equal(fixture.recovery.read(), null);
});

test("account replacement blocks uncertain Archive recovery and preserves its original draft", async () => {
  const fixture = uncertainArchiveFixture();
  await fixture.client.load();
  await assert.rejects(fixture.client.setDeckArchived({
    deck_id: "deck-A",
    archived: true,
    expected_revision: 3,
    client_action_id: "archive:account-A",
  }), (error) => error?.code === "REQUEST_UNCONFIRMED");
  fixture.switchAccount();
  await assert.rejects(fixture.client.retryPending(), (error) => error?.code === "ACCOUNT_CHANGED");
  assert.equal(fixture.requests.length, 1, "no account-B command was sent");
  assert.equal(fixture.client.getPending().accountBinding, "account-A");
  assert.equal(fixture.recovery.read().accountBinding, "account-A");
});

test("a durable Archive race with no receipt is definitively stale and clears its draft", async () => {
  const recovery = memoryOutbox();
  const requests = [];
  const client = createDurableClient({
    outbox: recovery.outbox,
    writerGrant: WRITER,
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url, "https://meshful.test");
      requests.push({ path: parsed.pathname, query: parsed.search, headers: init.headers });
      if (parsed.pathname.endsWith("/state")) {
        return json({ ok: true, data: stateData("account-A", 4) });
      }
      if (parsed.pathname.endsWith("/commands")) {
        return json({ ok: false, error: {
          code: "STALE_DURABLE_REVISION",
          message: "reload",
        } }, 409);
      }
      if (parsed.pathname.endsWith("/receipts")) {
        return json({ ok: false, error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }
      throw new Error(`Unexpected request: ${parsed.pathname}`);
    },
  });
  await client.load();
  await assert.rejects(client.setDeckArchived({
    deck_id: "deck-A",
    archived: true,
    expected_revision: 3,
    client_action_id: "archive:stale-durable",
  }), (error) => error?.code === "STALE_DURABLE_REVISION");
  assert.deepEqual(requests.slice(1).map(({ path }) => path), [
    "/api/learner/v2/commands",
    "/api/learner/v2/receipts",
  ]);
  assert.equal(new Headers(requests[1].headers).get("x-meshful-writer-token"), null);
  assert.equal(client.getPending(), null);
  assert.equal(recovery.read(), null);
});

test("simultaneous Add and Grade settle either stale loser and permit one exact retry", async (t) => {
  for (const delayedOperation of ["submit_grade", "add_library_deck"]) {
    await t.test(`${delayedOperation} loses revision CAS`, async () => {
      const delayed = deferred();
      const release = deferred();
      const requests = [];
      let durableRevision = 0;
      let delayedOnce = false;
      const fetchImpl = async (url, init = {}) => {
        const parsed = new URL(url, "https://meshful.test");
        if (parsed.pathname.endsWith("/state")) {
          return json({ ok: true, data: stateData("account-A", durableRevision) });
        }
        if (parsed.pathname.endsWith("/receipts")) {
          return json({ ok: false, error: { code: "NOT_FOUND", message: "missing" } }, 404);
        }
        assert.ok(parsed.pathname.endsWith("/commands"));
        const command = JSON.parse(init.body);
        requests.push({ command, headers: init.headers });
        if (command.operation === delayedOperation && !delayedOnce) {
          delayedOnce = true;
          delayed.resolve();
          await release.promise;
        }
        if (command.expected_revision !== durableRevision) {
          return json({ ok: false, error: {
            code: "STALE_DURABLE_REVISION",
            message: "another lane committed",
          } }, 409);
        }
        durableRevision += 1;
        return json({ ok: true, data: commandResult(command, durableRevision) });
      };
      const studyRecovery = memoryOutbox();
      const accountRecovery = memoryOutbox();
      const study = createDurableClient({
        outbox: studyRecovery.outbox,
        writerGrant: WRITER,
        fetchImpl,
      });
      const account = createDurableClient({ outbox: accountRecovery.outbox, fetchImpl });
      await Promise.all([study.load(), account.load()]);
      const studyArgs = {
        session_id: "session-A",
        card_id: "card-A",
        expected_card_revision: 1,
        expected_session_revision: 1,
        answer_text: "answer",
        answer_origin: "chat",
        rating: "good",
        rubric_evidence: [],
        feedback: "correct",
        misconceptions: [],
        confidence: 0.9,
        idempotency_key: "race:grade",
      };
      const addArgs = {
        library_deck_id: "library:algorithms",
        expected_catalog_version: "release-v2",
        client_action_id: "race:add",
      };
      const delayedCall = delayedOperation === "submit_grade"
        ? () => study.submitGrade(studyArgs)
        : () => account.addLibraryDeck(addArgs);
      const winnerCall = delayedOperation === "submit_grade"
        ? () => account.addLibraryDeck(addArgs)
        : () => study.submitGrade(studyArgs);
      const retryCall = delayedCall;

      const stale = delayedCall();
      await delayed.promise;
      await winnerCall();
      release.resolve();
      await assert.rejects(stale, (error) => error?.code === "STALE_DURABLE_REVISION");
      const loser = delayedOperation === "submit_grade" ? study : account;
      assert.equal(loser.getPending(), null, "receipt absence proves the stale draft did not commit");
      await loser.load();
      await retryCall();
      assert.equal(durableRevision, 2, "one Add and one Grade commit exactly once");

      for (const request of requests) {
        const token = headerValue(request, "x-meshful-writer-token");
        assert.equal(token, request.command.operation === "submit_grade" ? WRITER.token : null);
      }
    });
  }
});
