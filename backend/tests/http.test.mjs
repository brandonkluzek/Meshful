import test from "node:test";
import assert from "node:assert/strict";
import { SqliteD1 } from "../test-support/sqlite-d1.mjs";
import { createD1Repository } from "../src/d1-repository.mjs";
import { createLearnerService } from "../src/learner-service.mjs";
import { createLearnerHandler } from "../src/http-handler.mjs";
import { contextFor, FIXED_NOW, persistenceFixtureEngine } from "../test-support/fixtures.mjs";

const origin = "https://meshful.test";
async function setup(t, options = {}) {
  const db = new SqliteD1().applyMigration(); t.after(() => db.close());
  const service = createLearnerService({ repository: createD1Repository(db), engine: persistenceFixtureEngine(), clock: () => FIXED_NOW });
  const a = await contextFor(service); const b = await contextFor(service, "learner-b");
  const handler = createLearnerHandler({ service, authenticate: async () => a, browserOrigins: [origin], ...options });
  return { handler, service, a, b };
}
const body = { request_id: "write-1", expected_revision: 0, operation: "fixture_write", args: { idempotency_key: "write-1", value: "private" } };
function post(a, overrides = {}) {
  return new Request(`${origin}/api/learner/v1/commands`, {
    method: "POST", body: JSON.stringify(body), headers: {
      "content-type": "application/json", origin, "x-meshful-account": a.principalId,
      ...overrides,
    },
  });
}

test("handler requires a verified resolver and does not infer user identity from request headers", async (t) => {
  assert.throws(() => createLearnerHandler({ service: {} }), (e) => e.code === "AUTH_ADAPTER_REQUIRED");
  const { handler } = await setup(t, { authenticate: async () => null });
  const response = await handler(new Request(`${origin}/api/learner/v1/state`, { headers: { "oai-authenticated-user-id": "spoof" } }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
});

test("private responses disable caching; account guard compares but never selects an owner", async (t) => {
  const { handler, service, a, b } = await setup(t);
  const rejected = await handler(post(a, { "x-meshful-account": b.principalId }));
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.code, "ACCOUNT_CHANGED");
  assert.equal((await service.getState(a)).state, null);
  const response = await handler(post(a));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal((await service.getState(b)).state, null);
  const foreignRecovery = await handler(new Request(`${origin}/api/learner/v1/receipts/write-1`, {
    headers: { "x-meshful-account": b.principalId },
  }));
  assert.equal(foreignRecovery.status, 409);
  assert.equal((await foreignRecovery.json()).error.code, "ACCOUNT_CHANGED");
  const ownRecovery = await handler(new Request(`${origin}/api/learner/v1/receipts/write-1`, {
    headers: { "x-meshful-account": a.principalId },
  }));
  assert.equal(ownRecovery.status, 200);
  assert.equal((await ownRecovery.json()).data.result.receipt.replayed, true);
});

test("cross-origin, missing-origin, unsupported content type, and oversized bodies fail before mutation", async (t) => {
  const { handler, service, a } = await setup(t, { maxBodyBytes: 400 });
  assert.equal((await handler(post(a, { origin: "https://attacker.test" }))).status, 403);
  assert.equal((await handler(post(a, { "sec-fetch-site": "cross-site" }))).status, 403);
  const missing = post(a); missing.headers.delete("origin");
  assert.equal((await handler(missing)).status, 403);
  assert.equal((await handler(post(a, { "content-type": "text/plain" }))).status, 415);
  const oversized = new Request(`${origin}/api/learner/v1/commands`, {
    method: "POST", headers: post(a).headers, body: JSON.stringify({ padding: "α".repeat(401) }),
  });
  assert.equal((await handler(oversized)).status, 413);
  assert.equal((await service.getState(a)).state, null);
});

test("invalid JSON, unknown endpoints, and SQL errors do not return raw exception data", async (t) => {
  const { handler, a } = await setup(t);
  const bad = new Request(`${origin}/api/learner/v1/commands`, { method: "POST", headers: post(a).headers, body: "{" });
  assert.equal((await handler(bad)).status, 400);
  assert.equal((await handler(new Request(`${origin}/api/learner/v1/nope`))).status, 404);
  const failing = createLearnerHandler({ service: { async getState() { throw new Error("SELECT private_answer secret@example.invalid"); } },
    authenticate: async () => a, browserOrigins: [origin] });
  const response = await failing(new Request(`${origin}/api/learner/v1/state`));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /SELECT|private_answer|secret@/);
});

test("authentication failure adapter handles only resolver errors", async (t) => {
  const { a } = await setup(t);
  let handled = 0;
  const failure = () => { handled++; return new Response('{"error":{"code":"csrf_rejected"}}', { status: 403 }); };
  const handler = createLearnerHandler({ service: {}, authenticate: async () => { throw new Error("auth"); }, authenticationFailureResponse: failure });
  assert.equal((await handler(new Request(`${origin}/api/learner/v1/state`))).status, 403);
  assert.equal(handled, 1);
  const storageFailure = createLearnerHandler({ service: { async getState() { throw new Error("storage"); } }, authenticate: async () => a,
    authenticationFailureResponse: failure, browserOrigins: [origin] });
  assert.equal((await storageFailure(new Request(`${origin}/api/learner/v1/state`))).status, 503);
  assert.equal(handled, 1);
});
