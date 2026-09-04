import assert from "node:assert/strict";
import test from "node:test";

import { createDurableClient } from "../public/study/backend/v7/src/durable-client.mjs";

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json" },
});

function fixture({ loseFirstDeckAcknowledgement = false } = {}) {
  let saved = null;
  let deckAttempts = 0;
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
        if (command.operation === "delete_deck") {
          deckAttempts += 1;
          if (loseFirstDeckAcknowledgement && deckAttempts === 1) throw new Error("connection lost");
          return json({ ok: true, data: {
            durable_revision: 5,
            result: {
              deleted_deck_id: command.args.deck_id,
              deleted_deck_instance_id: command.args.deck_instance_id,
              visible_effect: { type: "deck_deleted", deck_id: command.args.deck_id },
              receipt: {
                operation: "delete_deck",
                transaction_id: `durable-deletion:${command.request_id}`,
                idempotency_key: command.request_id,
                replayed: false,
              },
            },
          } });
        }
        assert.equal(command.operation, "delete_my_data");
        return json({ ok: true, data: {
          durable_revision: 5,
          result: {
            browser_cleanup_required: true,
            retained: { sign_in_binding: true, immutable_library_catalog: true },
            receipt: {
              operation: "delete_my_data",
              transaction_id: `durable-account-deletion:${command.request_id}`,
              idempotency_key: command.request_id,
              replayed: false,
            },
          },
        } });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${parsed.pathname}`);
    },
  });
  return { client, commands, readSaved: () => structuredClone(saved) };
}

function deckArgs() {
  return {
    deck_id: "deck-proof",
    deck_instance_id: "deck-instance-proof",
    expected_revision: 3,
    expected_app_revision: 7,
    expected_impact_digest: "fnv1a-proof",
    confirm_permanent_deletion: true,
    confirmation_token: "b".repeat(64),
    idempotency_key: "delete-deck-proof",
  };
}

test("an unconfirmed deck deletion retains its exact one-use confirmation for retry", async () => {
  const { client, commands, readSaved } = fixture({ loseFirstDeckAcknowledgement: true });
  await client.load();
  await assert.rejects(client.deleteDeck(deckArgs()),
    (error) => error?.code === "REQUEST_UNCONFIRMED" && error?.status === 503);

  assert.equal(readSaved().command.args.confirmation_token, "b".repeat(64));
  const deleted = await client.retryPending();
  assert.equal(deleted.deleted_deck_instance_id, "deck-instance-proof");
  assert.equal(readSaved(), null);
  assert.deepEqual(commands.map(({ request_id }) => request_id), [
    "delete-deck-proof",
    "delete-deck-proof",
  ]);
});

test("account deletion accepts only a success that preserves the declared boundary", async () => {
  const { client, readSaved } = fixture();
  await client.load();
  const deleted = await client.deleteMyData({
    expected_impact_digest: "sha256-proof",
    confirmation_token: "c".repeat(64),
    confirm_permanent_deletion: true,
    idempotency_key: "delete-account-proof",
  });

  assert.equal(deleted.browser_cleanup_required, true);
  assert.equal(deleted.retained.sign_in_binding, true);
  assert.equal(deleted.retained.immutable_library_catalog, true);
  assert.equal(readSaved(), null);
});
