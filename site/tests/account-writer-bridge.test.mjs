import assert from "node:assert/strict";
import test from "node:test";

import { createAccountSessionController } from "../public/study/accounts/browser-study-session.mjs";
import { createAccountRuntime } from "../public/study/js/account-runtime.js";

const CATALOG_REF = Object.freeze({ version: "release", digest: "sha256:" + "a".repeat(64) });

function browserPrimitives() {
  const bytes = new Map();
  return {
    bytes,
    storage: {
      getItem: (key) => bytes.get(String(key)) ?? null,
      setItem: (key, value) => bytes.set(String(key), String(value)),
      removeItem: (key) => bytes.delete(String(key)),
    },
    locks: {
      request(name, _options, callback) {
        return callback(Object.freeze({ name, mode: "exclusive" }));
      },
    },
    eventTarget: new EventTarget(),
  };
}

function snapshotData(revision = 0, raw = null) {
  return {
    account_binding: "account-A",
    durable_revision: revision,
    state_json: raw,
    catalog_ref: CATALOG_REF,
  };
}

function createHarness({ active = false, submitError = null, persistedClaim = false } = {}) {
  const calls = [];
  const claimRequests = [];
  const durableGrants = [];
  let writerActive = active;
  let writerEpoch = active ? 4 : 0;
  let durableRevision = 0;
  const primitives = browserPrimitives();
  const claimKey = "meshful:accounts:v2:site:account:account-A:claim";
  if (persistedClaim) {
    primitives.storage.setItem(claimKey, JSON.stringify({
      accountBinding: "account-A",
      request: {
        request_id: "claim:reconnect",
        expected_revision: 0,
        source_id: "browser-source",
        catalog_ref: CATALOG_REF,
        raw_state_json: "{\"revision\":0}",
      },
    }));
  }
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url, "https://meshful.ai").pathname;
    if (path.endsWith("/state")) return Response.json({ ok: true, data: snapshotData(durableRevision) });
    if (path.endsWith("/claims")) {
      claimRequests.push({ headers: new Headers(options.headers), body: JSON.parse(options.body) });
      durableRevision = 1;
      const body = claimRequests.at(-1).body;
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.raw_state_json));
      const sourceDigest = "sha256:" + [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return Response.json({ ok: true, data: {
        account_binding: "account-A", durable_revision: 1, catalog_ref: CATALOG_REF,
        result: { source_id: body.source_id, source_digest: sourceDigest,
          receipt: { operation: "claim_local_state", idempotency_key: body.request_id, replayed: false } },
      } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const writerClient = {
    async status() { calls.push("status"); return { schema_version: 1, account_binding: "account-A", writer_epoch: writerEpoch, active: writerActive }; },
    async acquire(input) { calls.push("acquire"); writerEpoch += 1; writerActive = true; return { writer_epoch: writerEpoch, active: true, writerGrant: { writerEpoch, token: input.token } }; },
    async takeover(input) { calls.push("takeover"); writerEpoch += 1; writerActive = true; return { writer_epoch: writerEpoch, active: true, writerGrant: { writerEpoch, token: input.token } }; },
    async validate(grant) { calls.push("validate"); return { schema_version: 1, account_binding: "account-A", writer_epoch: grant.writerEpoch, active: true, current: true }; },
    async release(input) { calls.push("release"); writerEpoch += 1; writerActive = false; return { writer_epoch: writerEpoch, active: false, writerGrant: null, receipt: { idempotency_key: input.requestId, replayed: false } }; },
  };
  const runtime = createAccountRuntime({
    createSessionController: createAccountSessionController,
    createStudyWriterClient: () => writerClient,
    generateWriterToken: () => "b".repeat(64),
    createDurableClient: ({ writerGrant, outbox }) => {
      durableGrants.push(writerGrant ?? null);
      const command = (operation, args, id) => {
        outbox.write({
          accountBinding: "account-A",
          command: {
            request_id: id,
            expected_revision: durableRevision,
            operation,
            args,
          },
        });
        return Promise.resolve().then(() => {
          durableRevision += 1;
          outbox.write(null);
          return { receipt: { operation, idempotency_key: id, replayed: false } };
        });
      };
      return {
        getPending: () => null,
        load: async () => ({ account_binding: "account-A", durable_revision: durableRevision }),
        startStudySession: (args) => {
          assert.ok(writerGrant, "Study clients remain writer-bound");
          return command("start_study_session", args, args.idempotency_key).then((result) => ({
            ...result,
            session: { status: "active" },
          }));
        },
        submitGrade: (args) => {
          assert.ok(writerGrant, "Study clients remain writer-bound");
          if (!submitError) return command("submit_grade", args, args.idempotency_key);
          outbox.write({
            accountBinding: "account-A",
            command: {
              request_id: args.idempotency_key,
              expected_revision: durableRevision,
              operation: "submit_grade",
              args,
            },
          });
          return Promise.resolve().then(() => {
            outbox.write(null);
            throw Object.assign(new Error(submitError), { code: submitError });
          });
        },
        addLibraryDeck: (args) => {
          assert.equal(writerGrant, undefined,
            "an account command client must not receive the Study grant");
          return command("add_library_deck", args, args.client_action_id);
        },
      };
    },
    hydrateSnapshot: async (data) => ({ personalDecks: {}, sessions: {}, activeSessionId: null, activity: [], revision: data.durable_revision }),
    storageOptions: { siteId: "site", ...primitives },
    fetchImpl,
    makeId: (() => { let id = 0; return () => `id-${++id}`; })(),
    localClaimSource: {
      inspect: () => ({ rawStateJson: "{\"revision\":0}", catalogRef: CATALOG_REF }),
      prepare: ({ rawStateJson }) => ({ sourceId: "browser-source", rawStateJson, catalogRef: CATALOG_REF }),
    },
  });
  return { runtime, calls, claimRequests, durableGrants, primitives, claimKey };
}

test("the account bridge acquires, validates, and releases the server writer inside the native lease", async () => {
  const harness = createHarness();
  const session = await harness.runtime.connect();
  await session.beginStudy();
  await session.store.startStudySession({ deck_id: "deck", limit: 1, idempotency_key: "start" });
  await session.releaseStudy();
  assert.deepEqual(harness.calls, ["status", "acquire", "validate", "release"]);
  harness.runtime.dispose();
});

test("an active remote writer requires an explicit takeover", async () => {
  const harness = createHarness({ active: true });
  const session = await harness.runtime.connect();
  await assert.rejects(session.beginStudy(), (error) => error?.code === "WRITER_ALREADY_ACTIVE");
  await session.takeOverStudy();
  await session.releaseStudy();
  assert.deepEqual(harness.calls, ["status", "status", "takeover", "release"]);
  harness.runtime.dispose();
});

test("Library Add does not inspect, acquire, take over, validate, or release an active Study writer", async () => {
  const harness = createHarness({ active: true });
  const session = await harness.runtime.connect();
  const result = await session.store.addLibraryDeck({
    library_deck_id: "academic-reviewed-v1:algorithms-i",
    expected_catalog_version: "release",
    client_action_id: "add-with-remote-study",
  });
  assert.equal(result.receipt.idempotency_key, "add-with-remote-study");
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.durableGrants, [null]);
  harness.runtime.dispose();
});

test("a remotely archived active deck retires the stale Study presentation after a truthful conflict", async () => {
  const harness = createHarness({ submitError: "SESSION_NOT_ACTIVE" });
  const session = await harness.runtime.connect();
  await session.beginStudy();
  await assert.rejects(session.store.submitGrade({
    session_id: "session", card_id: "card", expected_card_revision: 1,
    expected_session_revision: 1, answer_text: "answer", answer_origin: "chat",
    rating: "good", rubric_evidence: [], feedback: "correct", misconceptions: [], confidence: 0.9,
    idempotency_key: "grade-after-remote-archive",
  }), (error) => error?.code === "SESSION_NOT_ACTIVE");
  assert.equal(session.isStudyCurrent(), false);
  assert.equal(session.getRecovery().command, null);
  assert.deepEqual(harness.calls, ["status", "acquire", "release"]);
  harness.runtime.dispose();
});

test("an explicit local-data claim carries the same server writer grant and preserves its body", async () => {
  const harness = createHarness();
  const session = await harness.runtime.connect();
  const preview = await session.previewLocalClaim();
  await session.confirmLocalClaim(preview, "account-A");
  assert.equal(harness.claimRequests.length, 1);
  assert.equal(harness.claimRequests[0].headers.get("x-meshful-writer-epoch"), "1");
  assert.equal(harness.claimRequests[0].headers.get("x-meshful-writer-token"), "b".repeat(64));
  assert.equal(harness.claimRequests[0].body.raw_state_json, "{\"revision\":0}");
  assert.deepEqual(harness.calls, ["status", "acquire", "validate", "release"]);
  harness.runtime.dispose();
});

test("reconnect discovers a persisted local-data claim and an explicit retry clears it only after confirmation", async () => {
  const harness = createHarness({ persistedClaim: true });
  const session = await harness.runtime.connect();
  assert.deepEqual(session.getRecovery().claim, { pending: true });
  assert.equal(harness.claimRequests.length, 0, "reconnect does not upload browser data without confirmation");

  await session.retryLocalClaim();
  assert.equal(harness.claimRequests.length, 1);
  assert.equal(harness.claimRequests[0].body.request_id, "claim:reconnect");
  assert.equal(harness.primitives.storage.getItem(harness.claimKey), null);
  assert.equal(session.getRecovery().claim, null);
  assert.deepEqual(harness.calls, ["status", "acquire", "validate", "release"]);
  harness.runtime.dispose();
});

test("a blocked reconnect retry never takes over an active writer and preserves the persisted local-data claim", async () => {
  const harness = createHarness({ active: true, persistedClaim: true });
  const session = await harness.runtime.connect();
  await assert.rejects(session.retryLocalClaim(), (error) => error?.code === "WRITER_ALREADY_ACTIVE");
  assert.equal(harness.claimRequests.length, 0);
  assert.notEqual(harness.primitives.storage.getItem(harness.claimKey), null);
  assert.deepEqual(session.getRecovery().claim, { pending: true });
  assert.deepEqual(harness.calls, ["status"]);
  harness.runtime.dispose();
});
