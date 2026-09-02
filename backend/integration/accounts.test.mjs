import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteD1 } from "../test-support/sqlite-d1.mjs";
import { createD1Repository } from "../src/d1-repository.mjs";
import { createLearnerService } from "../src/learner-service.mjs";
import { createCanonicalEngine } from "../src/canonical-engine.mjs";
import { createLearnerHandler } from "../src/http-handler.mjs";
import { createDurableClient } from "../src/durable-client.mjs";
import { sha256 } from "../src/contracts.mjs";
import { definitionCatalog, FIXED_NOW, gradeFor } from "../test-support/fixtures.mjs";

assert.ok(process.env.MESHFUL_CANONICAL_ROOT && process.env.MESHFUL_ACCOUNTS_ROOT,
  "Set both authorized source roots. No Accounts or canonical code is copied.");
const canonicalRoot = resolve(process.env.MESHFUL_CANONICAL_ROOT);
const accountsRoot = resolve(process.env.MESHFUL_ACCOUNTS_ROOT);
const { createStudyStore, createMemoryStorage } = await import(pathToFileURL(join(canonicalRoot, "web/js/store.js")));
const { WEBMCP_TOOL_SCHEMAS } = await import(pathToFileURL(join(canonicalRoot, "web/js/webmcp.js")));
const { createSitesAuthenticator, authFailureResponse } = await import(pathToFileURL(join(accountsRoot, "accounts/index.mjs")));
const origin = "https://meshful.test";

async function setup(t) {
  const db = new SqliteD1().applyMigration(); t.after(() => db.close());
  const engine = await createCanonicalEngine({ createStudyStore, createMemoryStorage, toolSchemas: WEBMCP_TOOL_SCHEMAS,
    catalogs: [{ version: "synthetic", catalog: definitionCatalog() }], defaultCatalogVersion: "synthetic" });
  const service = createLearnerService({ repository: createD1Repository(db), engine, clock: () => FIXED_NOW });
  const trustedRequests = new WeakSet();
  const authenticate = createSitesAuthenticator({ siteId: "local-test", allowedOrigins: [origin],
    isTrustedIngress: (request) => trustedRequests.has(request), allowProvisioning: true,
    findPrincipalByIdentity: service.findPrincipalByIdentity,
    provisionPrincipalForVerifiedIdentity: service.provisionPrincipalForVerifiedIdentity,
  });
  const handler = createLearnerHandler({ service, authenticate, authenticationFailureResponse: authFailureResponse, browserOrigins: [origin] });
  async function call(subject, route, body, { trusted = true, accountBinding, headers = {} } = {}) {
    const request = new Request(`${origin}/api/learner/v1/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(subject ? { "oai-authenticated-user-id": subject, "oai-authenticated-user-email": `${subject}@example.invalid` } : {}),
        ...(accountBinding === undefined ? {} : { "x-meshful-account": accountBinding }),
        ...(body === undefined ? {} : { "content-type": "application/json", origin,
          "sec-fetch-site": "same-origin", "x-meshful-account": accountBinding ?? "" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (trusted) trustedRequests.add(request); // Local stand-in, not dispatcher evidence.
    const response = await handler(request);
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { db, call };
}
const command = (operation, args, expected_revision) => ({ request_id: args.idempotency_key ?? args.client_action_id, expected_revision, operation, args });

test("real Accounts adapter and Backend preserve 401/403 without provisioning spoofed identities", async (t) => {
  const { db, call } = await setup(t);
  const spoof = await call("attacker", "state", undefined, { trusted: false });
  assert.equal(spoof.status, 401);
  assert.equal(spoof.body.error.code, "untrusted_ingress");
  assert.equal((await db.prepare("SELECT count(*) AS n FROM meshful_principals").first()).n, 0);
  const absent = await call(null, "state");
  assert.equal(absent.status, 401);
  assert.equal(absent.body.error.code, "authentication_required");
  const csrf = await call("a", "commands", {}, { headers: { origin: "https://attacker.test" } });
  assert.equal(csrf.status, 403);
  assert.equal(csrf.body.error.code, "csrf_rejected");
});

test("fresh authenticated request contexts see the same grade; other identity and wrong-account outbox cannot act", async (t) => {
  const { db, call } = await setup(t);
  const first = await call("a", "state"); const binding = first.body.data.account_binding;
  assert.equal((await call("a", "state")).body.data.account_binding, binding);
  const install = await call("a", "commands", command("add_library_deck", {
    library_deck_id: "backend-fixture", expected_catalog_version: "1", client_action_id: "install",
  }, 0), { accountBinding: binding });
  assert.equal(install.status, 200);
  const start = await call("a", "commands", command("start_study_session", {
    deck_id: install.body.data.result.deck.id, idempotency_key: "start", limit: 1,
  }, 1), { accountBinding: binding });
  assert.equal(start.status, 200);
  const grade = command("submit_grade", gradeFor(start.body.data.result), 2);
  const committed = await call("a", "commands", grade, { accountBinding: binding });
  assert.equal(committed.status, 200);
  assert.equal((await call("a", "commands", grade, { accountBinding: binding })).body.data.result.receipt.replayed, true);
  const fresh = await call("a", "state"); assert.equal(fresh.body.data.durable_revision, 3);
  const reviews = await call("a", "reviews"); assert.equal(reviews.body.data.events.length, 1);
  assert.equal(reviews.body.data.events[0].payload.review.answer_text, grade.args.answer_text);
  const other = await call("b", "state"); const bBinding = other.body.data.account_binding;
  assert.notEqual(binding, bBinding); assert.equal(other.body.data.state, null);
  const wrongAccount = await call("b", "commands", grade, { accountBinding: binding });
  assert.equal(wrongAccount.status, 409); assert.equal(wrongAccount.body.error.code, "ACCOUNT_CHANGED");
  const foreignSession = await call("b", "commands", { ...grade, expected_revision: 0 }, { accountBinding: bBinding });
  assert.equal(foreignSession.status, 404);
  assert.equal((await call("b", "receipts/grade-1")).status, 404);
  assert.equal((await call("b", "reviews")).body.data.events.length, 0);
  assert.equal((await call("a", "state")).body.data.durable_revision, 3);
  const identities = await db.prepare("SELECT provider, issuer, subject FROM meshful_identity_bindings").all();
  assert.doesNotMatch(JSON.stringify(identities), /example\.invalid/);
});

test("record Accounts adapter source used for this local-only integration", async (t) => {
  for (const file of ["accounts/core.mjs", "accounts/sites.mjs", "accounts/index.mjs"]) {
    t.diagnostic(`${file} ${await sha256(await readFile(join(accountsRoot, file), "utf8"))}`);
  }
});

test("same tool intent recovers and replays after reload without weakening the real Accounts/canonical/SQL fingerprint", async (t) => {
  const { call } = await setup(t);
  let saved = null; let loseGradeAck = true;
  const outbox = { read: () => structuredClone(saved), write: (value) => { saved = structuredClone(value); } };
  const fetchImpl = async (url, options) => {
    const route = url.slice("/api/learner/v1/".length);
    const input = options.body ? JSON.parse(options.body) : undefined;
    const response = await call("a", route, input, { accountBinding: options.headers["X-Meshful-Account"] });
    if (input?.operation === "submit_grade" && response.status === 200 && loseGradeAck) {
      loseGradeAck = false;
      throw new Error("Local simulation: response lost after the transaction");
    }
    return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
  };
  const first = createDurableClient({ fetchImpl, outbox }); await first.load();
  const installed = await first.addLibraryDeck({ library_deck_id: "backend-fixture", expected_catalog_version: "1", client_action_id: "client-install" });
  const started = await first.startStudySession({ deck_id: installed.deck.id, idempotency_key: "client-start", limit: 1 });
  const args = gradeFor(started, "client-grade");
  await assert.rejects(first.submitGrade(args), (e) => e.code === "REQUEST_UNCONFIRMED");
  assert.equal(saved.command.expected_revision, 2);
  const second = createDurableClient({ fetchImpl, outbox });
  const result = await second.submitGrade(args); // The agent only has this tool.
  assert.equal(result.receipt.replayed, true);
  assert.equal(saved, null);
  assert.equal((await call("a", "reviews")).body.data.events.length, 1);
  assert.equal((await second.load()).durable_revision, 3);
  assert.equal((await second.submitGrade(args)).receipt.replayed, true);
  const reloaded = createDurableClient({ fetchImpl, outbox });
  await reloaded.load();
  const replayed = await reloaded.submitGrade(args);
  assert.equal(replayed.receipt.replayed, true);
  assert.equal(replayed.review_id, result.review_id);
  const before = (await call("a", "state")).body.data;
  await assert.rejects(reloaded.submitGrade({ ...args, feedback: "Different exact input" }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT");
  assert.equal(saved.command.args.feedback, "Different exact input");
  assert.deepEqual((await call("a", "state")).body.data, before);
  assert.equal((await call("a", "reviews")).body.data.events.length, 1);
});
