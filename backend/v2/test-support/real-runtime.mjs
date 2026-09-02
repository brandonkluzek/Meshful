import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteD1 } from "../../test-support/sqlite-d1.mjs";
import { definitionCatalog, FIXED_NOW } from "../../test-support/fixtures.mjs";
import { createD1Repository, createCanonicalEngine, createLearnerService, createLearnerHandler } from "../src/index.mjs";
import { createDurableClient } from "../src/durable-client.mjs";

assert.ok(process.env.MESHFUL_CANONICAL_ROOT && process.env.MESHFUL_ACCOUNTS_ROOT,
  "Supply both authorized read-only source roots. This test never copies either delivery.");
export const canonicalRoot = resolve(process.env.MESHFUL_CANONICAL_ROOT);
export const accountsRoot = resolve(process.env.MESHFUL_ACCOUNTS_ROOT);
export const canonical = await import(pathToFileURL(join(canonicalRoot, "web/js/store.js")));
export const webmcp = await import(pathToFileURL(join(canonicalRoot, "web/js/webmcp.js")));
const accounts = await import(pathToFileURL(join(accountsRoot, "accounts/index.mjs")));
export const origin = "https://meshful.test";
export const migration = new URL("../migrations/0002_fragmented_storage.sql", import.meta.url);
export const command = (operation, args, expected_revision) => ({ request_id: args.idempotency_key ?? args.client_action_id, expected_revision, operation, args });

export async function setup(t, { catalog = definitionCatalog(), version = "synthetic-capacity-v2" } = {}) {
  const db = new SqliteD1().applyMigration().applyMigration(migration);
  t.after(() => db.close());
  const metrics = { queries: 0, batches: [], maxBindBytes: 0, maxSqlBytes: 0, maxParameters: 0 };
  const bytes = (value) => new TextEncoder().encode(value).byteLength;
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const wrap = (statement) => {
      const originalExecute = statement.execute.bind(statement);
      const originalBind = statement.bind.bind(statement);
      statement.execute = () => {
        metrics.queries++;
        metrics.maxSqlBytes = Math.max(metrics.maxSqlBytes, bytes(statement.sql));
        metrics.maxParameters = Math.max(metrics.maxParameters, statement.values.length);
        metrics.maxBindBytes = Math.max(metrics.maxBindBytes, ...statement.values.filter((v) => typeof v === "string").map(bytes));
        return originalExecute();
      };
      statement.bind = (...values) => wrap(originalBind(...values));
      return statement;
    };
    return wrap(originalPrepare(sql));
  };
  const originalBatch = db.batch.bind(db);
  db.batch = async (statements) => { metrics.batches.push(statements.length); return originalBatch(statements); };
  const resetMetrics = () => { metrics.queries = 0; metrics.batches.length = 0; metrics.maxBindBytes = 0; metrics.maxSqlBytes = 0; metrics.maxParameters = 0; };
  const repository = createD1Repository(db);
  const engine = await createCanonicalEngine({ ...canonical, toolSchemas: webmcp.WEBMCP_TOOL_SCHEMAS,
    catalogs: [{ version, catalog }], defaultCatalogVersion: version });
  let time = FIXED_NOW;
  const service = createLearnerService({ repository, engine, clock: () => time });
  const trustedRequests = new WeakSet();
  const authenticate = accounts.createSitesAuthenticator({ siteId: "local-test", allowedOrigins: [origin],
    isTrustedIngress: (request) => trustedRequests.has(request), allowProvisioning: true,
    findPrincipalByIdentity: service.findPrincipalByIdentity, provisionPrincipalForVerifiedIdentity: service.provisionPrincipalForVerifiedIdentity,
  });
  const handler = createLearnerHandler({ service, authenticate, authenticationFailureResponse: accounts.authFailureResponse, browserOrigins: [origin] });
  async function request(subject, route, { body, accountBinding, trusted = true, headers = {} } = {}) {
    const req = new Request(`${origin}/api/learner/v2/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(subject === null ? {} : { "oai-authenticated-user-id": subject, "oai-authenticated-user-email": `${subject}@example.invalid` }),
        ...(accountBinding === undefined ? {} : { "x-meshful-account": accountBinding }),
        ...(body === undefined ? {} : { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    if (trusted) trustedRequests.add(req); // Synthetic ingress ONLY, not deployment assurance.
    return handler(req);
  }
  async function call(subject, route, options) {
    const response = await request(subject, route, options);
    return { status: response.status, body: await response.json() };
  }
  function client(subject = "learner-a", options = {}) {
    let saved = null;
    const outbox = options.outbox ?? { read: () => structuredClone(saved), write: (value) => { saved = structuredClone(value); } };
    const fetchImpl = async (url, init) => {
      const response = await request(subject, url.slice("/api/learner/v2/".length), {
        body: init.body, accountBinding: init.headers["X-Meshful-Account"],
      });
      return options.afterResponse ? options.afterResponse(response, url, init) : response;
    };
    return createDurableClient({ fetchImpl, outbox });
  }
  return { db, engine, repository, service, request, call, client, metrics, resetMetrics, setTime: (value) => { time = value; } };
}
