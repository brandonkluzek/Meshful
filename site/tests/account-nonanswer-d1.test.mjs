import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createD1Repository } from "../integration/backend/v7/src/index.mjs";
import { SqliteD1 } from "../integration/backend/test-support/sqlite-d1.mjs";
import {
  LIBRARY_RELEASE,
  PREVIOUS_LIBRARY_RELEASE,
  RETAINED_LIBRARY_RELEASE,
} from "../integration/library-runtime.mjs";
import { accountSiteConfig, createPreparedSiteEndpoint } from "../integration/site-runtime.mjs";

const v2Migration = new URL("../integration/backend/v2/migrations/0002_fragmented_storage.sql", import.meta.url);
const writerMigration = new URL("../drizzle/0002_meshful_study_writer_grants.sql", import.meta.url);
const releaseRoots = new Map([
  [LIBRARY_RELEASE, new URL(`../public/study/data/library-runtime/${LIBRARY_RELEASE}/`, import.meta.url)],
  [PREVIOUS_LIBRARY_RELEASE, new URL(`../public/study/data/library-runtime/${PREVIOUS_LIBRARY_RELEASE}/`, import.meta.url)],
  [RETAINED_LIBRARY_RELEASE, new URL(`../public/study/data/library-runtime/${RETAINED_LIBRARY_RELEASE}/`, import.meta.url)],
]);

function libraryAssets() {
  return { async fetch(request) {
    const pathname = new URL(request.url).pathname;
    for (const [release, root] of releaseRoots) {
      const marker = `/library-runtime/${release}/`;
      if (!pathname.includes(marker)) continue;
      const key = pathname.slice(pathname.indexOf(marker) + marker.length);
      try {
        const bytes = await readFile(new URL(key, root));
        return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
      } catch { return new Response("", { status: 404 }); }
    }
    return new Response("", { status: 404 });
  } };
}

function request(endpoint, path, { method = "GET", binding, body, grant } = {}) {
  const headers = { "x-meshful-account": binding };
  if (body !== undefined) {
    headers.origin = "https://meshful.ai";
    headers["content-type"] = "application/json";
  }
  if (grant) {
    headers["x-meshful-writer-epoch"] = String(grant.writerEpoch);
    headers["x-meshful-writer-token"] = grant.token;
  }
  return endpoint.handle(new Request(`https://meshful.ai/api/learner/v2${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

async function payload(response, status = 200) {
  assert.equal(response.status, status);
  return response.json();
}

function nonAnswerArgs(current, attemptKind, idempotencyKey) {
  return {
    session_id: current.session.session_id,
    card_id: current.current_card.card_id,
    expected_card_revision: current.current_card.card_revision,
    expected_session_revision: current.session.session_revision,
    attempt_kind: attemptKind,
    idempotency_key: idempotencyKey,
  };
}

test("signed-in Reveal and Skip commit atomically through Accounts, HTTP, writer grant and D1", async (t) => {
  const database = new SqliteD1().applyMigration().applyMigration(v2Migration).applyMigration(writerMigration);
  t.after(() => database.close());
  const repository = createD1Repository(database);
  const issuer = `urn:meshful:sites:${accountSiteConfig.siteId}`;
  const identities = {
    A: { provider: "sites-chatgpt", issuer, subject: "nonanswer-d1-a" },
    B: { provider: "sites-chatgpt", issuer, subject: "nonanswer-d1-b" },
  };
  const a = await repository.provisionPrincipalForVerifiedIdentity(identities.A);
  const b = await repository.provisionPrincipalForVerifiedIdentity(identities.B);
  let trustedSubject = identities.A.subject;
  const options = {
    database, assets: libraryAssets(), activation: {
      ...accountSiteConfig, allowProvisioning: false,
      resolveTrustedSitesRequest: async () => ({ trusted: true, authenticated: true, subject: trustedSubject }),
    },
  };
  let endpoint = createPreparedSiteEndpoint(options);

  const createArgs = {
    operation: "create",
    deck: {
      schema_version: "normalized-definition-deck.v2", deck_id: "nonanswer-d1", title: "D1 attempts",
      cards: [
        { id: "first", term: "First", definition: "First definition.", criteria: ["First criterion."] },
        { id: "second", term: "Second", definition: "Second definition.", criteria: ["Second criterion."] },
      ],
      edges: [],
    },
    idempotency_key: "nonanswer-create",
  };
  let data = (await payload(await request(endpoint, "/commands", {
    method: "POST", binding: a.principalId,
    body: { request_id: createArgs.idempotency_key, expected_revision: 0, operation: "ingest_deck", args: createArgs },
  }))).data;
  assert.equal(data.durable_revision, 1);

  const token = "a".repeat(64);
  const writer = (await payload(await request(endpoint, "/writer-grant", {
    method: "POST", binding: a.principalId,
    body: { request_id: "nonanswer-writer", action: "acquire", expected_writer_epoch: 0, grant_token: token },
  }))).data;
  const grant = { writerEpoch: writer.writer_epoch, token };

  const startArgs = { deck_id: "nonanswer-d1", limit: 2, idempotency_key: "nonanswer-start" };
  data = (await payload(await request(endpoint, "/commands", {
    method: "POST", binding: a.principalId, grant,
    body: { request_id: startArgs.idempotency_key, expected_revision: 1, operation: "start_study_session", args: startArgs },
  }))).data;
  const started = data.result;
  assert.equal(data.durable_revision, 2);

  const revealArgs = nonAnswerArgs(started, "reveal", "nonanswer-reveal");
  const revealEnvelope = { request_id: revealArgs.idempotency_key, expected_revision: 2, operation: "submit_non_answer_grade", args: revealArgs };
  const reveal = (await payload(await request(endpoint, "/commands", {
    method: "POST", binding: a.principalId, grant, body: revealEnvelope,
  }))).data;
  assert.equal(reveal.durable_revision, 3);
  assert.equal(reveal.result.attempt_kind, "reveal");
  assert.equal(Object.hasOwn(reveal.result, "answer_text"), false);
  assert.equal(reveal.result.reviewed_card.definition_md, "First definition.");

  const replay = (await payload(await request(endpoint, "/commands", {
    method: "POST", binding: a.principalId, grant, body: revealEnvelope,
  }))).data;
  assert.equal(replay.durable_revision, 3);
  assert.equal(replay.result.receipt.replayed, true);

  const skipCurrent = { session: reveal.result.session, current_card: reveal.result.next_card };
  const skipArgs = nonAnswerArgs(skipCurrent, "skip", "nonanswer-skip");
  const skip = (await payload(await request(endpoint, "/commands", {
    method: "POST", binding: a.principalId, grant,
    body: { request_id: skipArgs.idempotency_key, expected_revision: 3, operation: "submit_non_answer_grade", args: skipArgs },
  }))).data;
  assert.equal(skip.durable_revision, 4);
  assert.equal(skip.result.attempt_kind, "skip");
  assert.equal(Object.hasOwn(skip.result, "reviewed_card"), false);

  endpoint = createPreparedSiteEndpoint(options);
  const reloaded = (await payload(await request(endpoint, "/state", { binding: a.principalId }))).data;
  assert.equal(reloaded.durable_revision, 4);
  const state = JSON.parse(reloaded.state_json);
  assert.deepEqual(state.sessions[started.session.session_id].history.map((row) => row.attempt_kind), ["reveal", "skip"]);
  assert.equal(state.sessions[started.session.session_id].history.every((row) => !Object.hasOwn(row, "answer_text")), true);
  assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM meshful_v2_review_events WHERE principal_id = ?").get(a.principalId).count, 2);

  trustedSubject = identities.B.subject;
  const isolated = (await payload(await request(endpoint, "/state", { binding: b.principalId }))).data;
  assert.equal(isolated.durable_revision, 0);
  assert.equal(isolated.state_json, null);
  const crossed = await payload(await request(endpoint, "/commands", {
    method: "POST", binding: a.principalId, grant,
    body: { request_id: "cross-account-skip", expected_revision: 0, operation: "submit_non_answer_grade", args: skipArgs },
  }), 409);
  assert.equal(crossed.error.code, "ACCOUNT_CHANGED");
});
