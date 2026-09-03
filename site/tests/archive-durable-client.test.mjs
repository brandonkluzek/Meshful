import assert from "node:assert/strict";
import test from "node:test";

import { createDurableClient } from "../public/study/backend/v5/src/durable-client.mjs";

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json" },
});

function fixture({ archiveMode = "active" } = {}) {
  let saved = null;
  const commands = [];
  const client = createDurableClient({
    outbox: {
      read: () => structuredClone(saved),
      write: (value) => { saved = structuredClone(value); },
    },
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url, "https://meshful.test");
      if ((init.method ?? "GET") === "GET" && parsed.pathname.endsWith("/state")) {
        return json({ ok: true, data: {
          account_binding: "account-A",
          durable_revision: 4,
          catalog_ref: { version: "release-1", digest: `sha256:${"a".repeat(64)}` },
          state: null,
          state_json: null,
        } });
      }
      if (init.method === "POST" && parsed.pathname.endsWith("/commands")) {
        const command = JSON.parse(init.body);
        commands.push(command);
        if (command.operation === "set_deck_archived") {
          if (archiveMode === "lost") throw new Error("connection lost");
          if (archiveMode === "malformed") return json({ ok: true, data: {
            durable_revision: 5,
            result: {
              deck: { id: "wrong-deck", archived: false, revision: 4 },
              visible_effect: { type: "deck_restored", deck_id: "wrong-deck" },
              app_revision: 8,
              receipt: {
                client_action_id: command.request_id,
                operation: "set_deck_archived",
                previous_app_revision: 7,
                app_revision: 8,
                transaction_id: `durable-archive:${command.request_id}`,
                idempotency_key: command.request_id,
                replayed: false,
                committed_at: "2026-09-02T12:00:00.000Z",
              },
            },
          } });
          if (archiveMode === "stale") return json({ ok: false, error: {
            code: "STALE_REVISION",
            message: "The authenticated request did not satisfy the learner contract",
            retryable: false,
          } }, 409);
          return json({ ok: false, error: {
            code: "DECK_IN_ACTIVE_SESSION",
            message: "The authenticated request did not satisfy the learner contract",
            retryable: false,
          } }, 409);
        }
        assert.equal(command.operation, "finish_study_session");
        return json({ ok: true, data: {
          durable_revision: 5,
          result: {
            ok: true,
            receipt: { idempotency_key: command.request_id, replayed: false },
          },
        } });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${parsed.pathname}`);
    },
  });
  return { client, commands, readSaved: () => structuredClone(saved) };
}

test("a definitively rejected active-session archive does not block finishing that session", async () => {
  const { client, commands, readSaved } = fixture();
  await client.load();
  await assert.rejects(client.setDeckArchived({
    deck_id: "deck-proof",
    archived: true,
    expected_revision: 3,
    client_action_id: "archive-active",
  }), (error) => error?.code === "DECK_IN_ACTIVE_SESSION" && error?.status === 409);

  assert.equal(client.getPending(), null);
  assert.equal(readSaved(), null);
  const finished = await client.finishStudySession({
    session_id: "session-active",
    idempotency_key: "finish-after-archive",
  });
  assert.equal(finished.receipt.idempotency_key, "finish-after-archive");
  assert.deepEqual(commands.map(({ operation }) => operation), [
    "set_deck_archived",
    "finish_study_session",
  ]);
});

test("an unconfirmed archive still keeps its exact recovery draft", async () => {
  const { client, commands, readSaved } = fixture({ archiveMode: "lost" });
  await client.load();
  await assert.rejects(client.setDeckArchived({
    deck_id: "deck-proof",
    archived: true,
    expected_revision: 3,
    client_action_id: "archive-unconfirmed",
  }), (error) => error?.code === "REQUEST_UNCONFIRMED" && error?.status === 503);

  assert.equal(client.getPending().command.operation, "set_deck_archived");
  assert.equal(readSaved().command.request_id, "archive-unconfirmed");
  assert.deepEqual(commands.map(({ operation }) => operation), ["set_deck_archived"]);
});

test("a stale inner deck revision clears before another save", async () => {
  const { client, commands, readSaved } = fixture({ archiveMode: "stale" });
  await client.load();
  await assert.rejects(client.setDeckArchived({
    deck_id: "deck-proof",
    archived: true,
    expected_revision: 3,
    client_action_id: "archive-stale",
  }), (error) => error?.code === "STALE_REVISION" && error?.status === 409);

  assert.equal(client.getPending(), null);
  assert.equal(readSaved(), null);
  await client.finishStudySession({
    session_id: "session-active",
    idempotency_key: "finish-after-stale",
  });
  assert.deepEqual(commands.map(({ operation }) => operation), [
    "set_deck_archived",
    "finish_study_session",
  ]);
});

test("a mismatched archive success preserves the exact recovery draft", async () => {
  const { client, commands, readSaved } = fixture({ archiveMode: "malformed" });
  await client.load();
  await assert.rejects(client.setDeckArchived({
    deck_id: "deck-proof",
    archived: true,
    expected_revision: 3,
    client_action_id: "archive-malformed",
  }), (error) => error?.code === "INVALID_SERVER_RESPONSE" && error?.status === 502);

  assert.equal(client.getPending().command.request_id, "archive-malformed");
  assert.equal(readSaved().command.args.deck_id, "deck-proof");
  assert.deepEqual(commands.map(({ operation }) => operation), ["set_deck_archived"]);
});
