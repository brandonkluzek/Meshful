import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { SqliteD1 } from "../../test-support/sqlite-d1.mjs";
import { contextFor, FIXED_NOW } from "../../test-support/fixtures.mjs";
import { RESOLUTION_BUDGET } from "../../v3/test-support/pinned-resolver.mjs";
import {
  createCanonicalEngine, createD1Repository, createDurableClient, createLearnerHandler, createLearnerService,
} from "../src/index.mjs";
import { loadRetainedResolver } from "../test-support/two-release-resolver.mjs";

assert.ok(process.env.MESHFUL_CANONICAL_ROOT,
  "Supply the authorized canonical source root");
const canonicalRoot = resolve(process.env.MESHFUL_CANONICAL_ROOT);
const canonical = await import(pathToFileURL(join(canonicalRoot, "web/js/store.js")));
const webmcp = await import(pathToFileURL(join(canonicalRoot, "web/js/webmcp.js")));
const migration = new URL("../../v2/migrations/0002_fragmented_storage.sql", import.meta.url);
const code = (expected) => (error) => error?.code === expected;

function command(operation, args, expectedRevision) {
  return {
    request_id: args.client_action_id ?? args.idempotency_key,
    expected_revision: expectedRevision,
    operation,
    args,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(status < 400 ? { ok: true, data } : { ok: false, error: data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function browserFetch(service, context, { loseRequestId } = {}) {
  let lost = false;
  return async (rawUrl, init) => {
    const url = new URL(rawUrl, "https://meshful.test");
    try {
      let data;
      if (url.pathname.endsWith("/state")) data = await service.getState(context);
      else if (url.pathname.endsWith("/commands")) {
        const input = JSON.parse(init.body);
        data = await service.command(context, input);
        if (!lost && input.request_id === loseRequestId) {
          lost = true;
          throw Object.assign(new Error("simulated lost acknowledgement"), { afterCommit: true });
        }
      } else if (url.pathname.endsWith("/receipts")) {
        data = await service.getReceipt(context, url.searchParams.get("request_id"));
      } else throw Object.assign(new Error("unsupported route"), { code: "NOT_FOUND", status: 404 });
      return json(data);
    } catch (error) {
      if (error.afterCommit) throw error;
      return json({ code: error.code ?? "SERVICE_UNAVAILABLE", message: "request rejected" }, error.status ?? 503);
    }
  };
}

test("Website-only archive and restore retain canonical D1 transaction, replay, rollback, and account isolation", {
  timeout: 120_000,
}, async (t) => {
  const library = await loadRetainedResolver();
  const engine = await createCanonicalEngine({
    ...canonical,
    toolSchemas: webmcp.WEBMCP_TOOL_SCHEMAS,
    catalogResolver: library.resolver,
    expectedCatalogPins: library.expectedCatalogPins,
    expectedResolutionBudget: RESOLUTION_BUDGET,
  });
  const db = new SqliteD1().applyMigration().applyMigration(migration);
  t.after(() => db.close());
  const service = createLearnerService({
    repository: createD1Repository(db), engine, clock: () => FIXED_NOW,
  });
  const a = await contextFor(service, "archive-a");
  const b = await contextFor(service, "archive-b");

  const installArgs = {
    library_deck_id: library.root.catalogDeckId,
    expected_catalog_version: library.root.catalogVersion,
    client_action_id: "archive:install",
  };
  const installed = await service.command(a, command("add_library_deck", installArgs, 0));
  const deck = installed.result.deck;
  const studyDeckId = installed.result.installation.decks[0].deck_id;
  const archiveArgs = {
    deck_id: deck.id,
    archived: true,
    expected_revision: deck.revision,
    client_action_id: "archive:commit",
  };
  const archived = await service.command(a, command("set_deck_archived", archiveArgs, 1));
  assert.equal(archived.durable_revision, 2);
  assert.equal(archived.result.deck.archived, true);
  assert.deepEqual(archived.result.visible_effect, { type: "deck_archived", deck_id: deck.id });
  assert.equal(archived.result.receipt.transaction_id, `durable-archive:${archiveArgs.client_action_id}`);
  assert.equal(archived.result.receipt.idempotency_key, archiveArgs.client_action_id);
  assert.equal(archived.result.receipt.replayed, false);

  const replay = await service.command(a, command("set_deck_archived", archiveArgs, 1));
  assert.equal(replay.result.receipt.replayed, true);
  assert.equal((await service.getState(a)).durable_revision, 2);
  await assert.rejects(service.command(a, command("set_deck_archived", {
    ...archiveArgs,
    archived: false,
    client_action_id: "archive:stale-restore",
  }, 1)), code("STALE_DURABLE_REVISION"));
  assert.equal((await service.getState(a)).durable_revision, 2);

  await assert.rejects(service.command(b, command("set_deck_archived", {
    ...archiveArgs,
    client_action_id: "archive:cross-account",
  }, 0)), code("DECK_NOT_FOUND"));
  assert.equal((await service.getState(b)).durable_revision, 0);
  await assert.rejects(service.getState({ ...b, principalId: a.principalId }), code("FORBIDDEN"));

  const restoreArgs = {
    deck_id: deck.id,
    archived: false,
    expected_revision: archived.result.deck.revision,
    client_action_id: "archive:restore",
  };
  const restored = await service.command(a, command("set_deck_archived", restoreArgs, 2));
  assert.equal(restored.durable_revision, 3);
  assert.equal(restored.result.deck.archived, false);

  const listed = await service.query(a, {
    operation: "list_my_decks",
    args: { status: "active", sort: "title", limit: 50 },
  });
  const otherDeck = listed.result.items.find((candidate) =>
    candidate.deck_id !== deck.id && candidate.deck_id !== studyDeckId);
  assert.ok(otherDeck, "The prerequisite closure supplies a second account-owned deck");
  const lostArgs = {
    deck_id: otherDeck.deck_id,
    archived: true,
    expected_revision: otherDeck.deck_revision,
    client_action_id: "archive:lost-ack",
  };
  let saved = null;
  const client = createDurableClient({
    fetchImpl: browserFetch(service, a, { loseRequestId: lostArgs.client_action_id }),
    outbox: {
      read: () => structuredClone(saved),
      write: (value) => { saved = structuredClone(value); },
    },
  });
  await client.load();
  await assert.rejects(client.setDeckArchived(lostArgs), code("REQUEST_UNCONFIRMED"));
  assert.equal(client.getPending().command.request_id, lostArgs.client_action_id);
  const recovered = await client.setDeckArchived(lostArgs);
  assert.equal(recovered.receipt.replayed, true);
  assert.equal(client.getPending(), null);
  assert.equal((await service.getState(a)).durable_revision, 4);

  const active = await service.query(a, {
    operation: "list_my_decks",
    args: { status: "active", sort: "title", limit: 50 },
  });
  const studyDeck = active.result.items.find((candidate) => candidate.deck_id === studyDeckId);
  assert.ok(studyDeck);
  const started = await service.command(a, command("start_study_session", {
    deck_id: studyDeck.deck_id,
    limit: 1,
    idempotency_key: "archive:active-session-start",
  }, 4));
  assert.equal(started.durable_revision, 5);
  const blockedArchive = command("set_deck_archived", {
    deck_id: studyDeck.deck_id,
    archived: true,
    expected_revision: studyDeck.deck_revision,
    client_action_id: "archive:active-session-blocked",
  }, 5);
  await assert.rejects(service.command(a, blockedArchive), code("DECK_IN_ACTIVE_SESSION"));
  assert.equal((await service.getState(a)).durable_revision, 5);
  await assert.rejects(service.getReceipt(a, blockedArchive.request_id), code("NOT_FOUND"));

  const handler = createLearnerHandler({
    service,
    authenticate: async () => a,
    browserOrigins: ["https://meshful.test"],
  });
  const response = await handler(new Request("https://meshful.test/api/learner/v2/commands", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://meshful.test",
      "sec-fetch-site": "same-origin",
      "x-meshful-account": a.principalId,
    },
    body: JSON.stringify(blockedArchive),
  }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: {
      code: "DECK_IN_ACTIVE_SESSION",
      message: "The authenticated request did not satisfy the learner contract",
      retryable: false,
    },
  });

  let browserDraft = null;
  const postOperations = [];
  const httpClient = createDurableClient({
    outbox: {
      read: () => structuredClone(browserDraft),
      write: (value) => { browserDraft = structuredClone(value); },
    },
    fetchImpl: async (rawUrl, init) => {
      const headers = new Headers(init.headers);
      if (init.method === "POST") {
        headers.set("origin", "https://meshful.test");
        headers.set("sec-fetch-site", "same-origin");
        postOperations.push(JSON.parse(init.body).operation);
      }
      return handler(new Request(new URL(rawUrl, "https://meshful.test"), {
        ...init,
        headers,
      }));
    },
  });
  await httpClient.load();
  await assert.rejects(httpClient.setDeckArchived(blockedArchive.args), code("DECK_IN_ACTIVE_SESSION"));
  assert.deepEqual(postOperations, ["set_deck_archived"]);
  assert.equal(httpClient.getPending(), null);
  assert.equal(browserDraft, null);

  const finished = await httpClient.finishStudySession({
    session_id: started.result.session.session_id,
    disposition: "end",
    expected_session_revision: started.result.session.session_revision,
    idempotency_key: "archive:finish-blocking-session",
  });
  assert.equal(finished.status, "finished");
  assert.deepEqual(postOperations, ["set_deck_archived", "finish_study_session"]);
  assert.equal(httpClient.getPending(), null);

  const afterFinish = await httpClient.setDeckArchived(blockedArchive.args);
  assert.equal(afterFinish.deck.archived, true);
  assert.equal(afterFinish.receipt.replayed, false);
  assert.deepEqual(postOperations,
    ["set_deck_archived", "finish_study_session", "set_deck_archived"]);

  const staleInnerArgs = {
    deck_id: deck.id,
    archived: true,
    expected_revision: 1,
    client_action_id: "archive:stale-inner",
  };
  await assert.rejects(httpClient.setDeckArchived(staleInnerArgs), code("STALE_REVISION"));
  assert.equal(httpClient.getPending(), null);
  assert.equal(browserDraft, null);
  const correctInner = await httpClient.setDeckArchived({
    ...staleInnerArgs,
    expected_revision: restored.result.deck.revision,
    client_action_id: "archive:after-stale-inner",
  });
  assert.equal(correctInner.deck.archived, true);

  const beforeOuterRace = await httpClient.searchMyDecks({ status: "active", sort: "title", limit: 50 });
  const outerTarget = beforeOuterRace.items.find((candidate) => candidate.deck_id !== otherDeck.deck_id);
  assert.ok(outerTarget);
  const externalRestore = await service.command(a, command("set_deck_archived", {
    deck_id: deck.id,
    archived: false,
    expected_revision: correctInner.deck.revision,
    client_action_id: "archive:external-race",
  }, 8));
  assert.equal(externalRestore.durable_revision, 9);
  const staleOuterArgs = {
    deck_id: outerTarget.deck_id,
    archived: true,
    expected_revision: outerTarget.deck_revision,
    client_action_id: "archive:stale-outer",
  };
  await assert.rejects(httpClient.setDeckArchived(staleOuterArgs), code("STALE_DURABLE_REVISION"));
  assert.equal(httpClient.getPending(), null);
  assert.equal(browserDraft, null);
  await httpClient.load();
  const afterOuterRefresh = await httpClient.setDeckArchived(staleOuterArgs);
  assert.equal(afterOuterRefresh.deck.archived, true);
  assert.equal(afterOuterRefresh.receipt.replayed, false);

  let raceDraft = null;
  let raceRequestId = null;
  let raceCommandPosts = 0;
  let raceReceiptGets = 0;
  const raceClient = createDurableClient({
    outbox: {
      read: () => structuredClone(raceDraft),
      write: (value) => { raceDraft = structuredClone(value); },
    },
    fetchImpl: async (rawUrl, init) => {
      const url = new URL(rawUrl, "https://meshful.test");
      const headers = new Headers(init.headers);
      if (init.method === "POST") {
        headers.set("origin", "https://meshful.test");
        headers.set("sec-fetch-site", "same-origin");
      }
      if (init.method === "POST" && url.pathname.endsWith("/commands")) {
        const input = JSON.parse(init.body);
        if (input.request_id === raceRequestId) {
          raceCommandPosts += 1;
          await service.command(a, input);
          return json({
            code: "STALE_DURABLE_REVISION",
            message: "request rejected",
          }, 409);
        }
      }
      if (init.method === "GET" && url.pathname.endsWith("/receipts")) raceReceiptGets += 1;
      return handler(new Request(url, { ...init, headers }));
    },
  });
  await raceClient.load();
  const raceDecks = await raceClient.searchMyDecks({ status: "active", sort: "title", limit: 50 });
  const raceTarget = raceDecks.items[0];
  assert.ok(raceTarget);
  raceRequestId = "archive:same-id-race";
  const raceResult = await raceClient.setDeckArchived({
    deck_id: raceTarget.deck_id,
    archived: true,
    expected_revision: raceTarget.deck_revision,
    client_action_id: raceRequestId,
  });
  assert.equal(raceCommandPosts, 1);
  assert.equal(raceReceiptGets, 1);
  assert.equal(raceResult.deck.id, raceTarget.deck_id);
  assert.equal(raceResult.deck.archived, true);
  assert.equal(raceResult.receipt.replayed, true);
  assert.equal(raceClient.getPending(), null);
  assert.equal(raceDraft, null);
});

test("a mismatched Archive success preserves the exact recovery draft", async () => {
  const args = {
    deck_id: "deck-requested",
    archived: true,
    expected_revision: 1,
    client_action_id: "archive:mismatched-success",
  };
  let saved = null;
  let commandPosts = 0;
  const client = createDurableClient({
    outbox: {
      read: () => structuredClone(saved),
      write: (value) => { saved = structuredClone(value); },
    },
    fetchImpl: async (rawUrl, init) => {
      const url = new URL(rawUrl, "https://meshful.test");
      if (url.pathname.endsWith("/state")) {
        return json({
          schema_version: 2,
          snapshot_encoding: "canonical-json.v1",
          account_binding: "principal-response-integrity",
          durable_revision: 0,
          catalog_ref: null,
          state_json: null,
        });
      }
      commandPosts += 1;
      assert.equal(JSON.parse(init.body).request_id, args.client_action_id);
      return json({
        schema_version: 1,
        durable_revision: 1,
        catalog_ref: null,
        result: {
          deck: { id: "deck-WRONG", archived: false, revision: 2 },
          visible_effect: { type: "deck_restored", deck_id: "deck-WRONG" },
          app_revision: 2,
          receipt: {
            client_action_id: args.client_action_id,
            operation: "set_deck_archived",
            previous_app_revision: 1,
            app_revision: 2,
            transaction_id: `durable-archive:${args.client_action_id}`,
            idempotency_key: args.client_action_id,
            replayed: false,
            committed_at: FIXED_NOW,
          },
        },
      });
    },
  });
  await client.load();
  await assert.rejects(client.setDeckArchived(args), code("INVALID_SERVER_RESPONSE"));
  assert.equal(commandPosts, 1);
  assert.equal(client.getPending().command.request_id, args.client_action_id);
  assert.deepEqual(saved, client.getPending() && {
    accountBinding: client.getPending().accountBinding,
    command: client.getPending().command,
  });
});

test("Archive draft settlement uses the exact terminal allowlist", async () => {
  async function rejected(codeValue, status) {
    const args = {
      deck_id: "deck-settlement",
      archived: true,
      expected_revision: 1,
      client_action_id: `archive:settlement:${codeValue.toLowerCase()}`,
    };
    let saved = null;
    const client = createDurableClient({
      outbox: {
        read: () => structuredClone(saved),
        write: (value) => { saved = structuredClone(value); },
      },
      fetchImpl: async (rawUrl) => new URL(rawUrl, "https://meshful.test").pathname.endsWith("/state")
        ? json({
          schema_version: 2,
          snapshot_encoding: "canonical-json.v1",
          account_binding: "principal-settlement",
          durable_revision: 0,
          catalog_ref: null,
          state_json: null,
        })
        : json({ code: codeValue, message: "request rejected" }, status),
    });
    await client.load();
    await assert.rejects(client.setDeckArchived(args), code(codeValue));
    return { pending: client.getPending(), saved };
  }

  for (const [codeValue, status] of [
    ["INVALID_TOOL_INPUT", 400],
    ["REQUEST_ID_MISMATCH", 400],
    ["DECK_NOT_FOUND", 404],
    ["STALE_REVISION", 409],
    ["DECK_IN_ACTIVE_SESSION", 409],
  ]) {
    const result = await rejected(codeValue, status);
    assert.equal(result.pending, null, `${codeValue} must settle the exact draft`);
    assert.equal(result.saved, null, `${codeValue} must clear the exact outbox slot`);
  }

  for (const [codeValue, status] of [
    ["ACCOUNT_CHANGED", 409],
    ["FORBIDDEN", 403],
    ["ORIGIN_REJECTED", 403],
    ["CATALOG_UNAVAILABLE", 409],
    ["INPUT_TOO_LARGE", 413],
    ["SERVICE_BUSY", 503],
  ]) {
    const result = await rejected(codeValue, status);
    assert.equal(result.pending.command.request_id,
      `archive:settlement:${codeValue.toLowerCase()}`, `${codeValue} must preserve recovery`);
    assert.ok(result.saved, `${codeValue} must retain the account-scoped outbox slot`);
  }
});
