import test from "node:test";
import assert from "node:assert/strict";
import { createLearnerHandler } from "../src/http-handler.mjs";
import { MAX_COMMAND_NODES } from "../src/capacity.mjs";

const context = { principalId: "synthetic-a", transport: "sites-browser" };
const origin = "https://meshful.test";
const request = (body) => new Request(`${origin}/api/learner/v2/queries`, {
  method: "POST", headers: { "content-type": "application/json", origin, "x-meshful-account": context.principalId }, body,
});
const makeHandler = (service) => createLearnerHandler({ service, authenticate: async () => context, browserOrigins: [origin] });

test("over-node/depth request text is rejected before JSON.parse or service allocation", async () => {
  let calls = 0;
  const handle = makeHandler({ query() { calls++; throw new Error("must not reach service"); } });
  for (const body of [
    `{"operation":"get_learning_overview","args":{"x":[${"0,".repeat(MAX_COMMAND_NODES)}0]}}`,
    `${"[".repeat(82)}0${"]".repeat(82)}`,
  ]) {
    const originalParse = JSON.parse;
    let parsedRequest = false;
    JSON.parse = (source, ...rest) => {
      if (source === body) parsedRequest = true;
      return originalParse(source, ...rest);
    };
    let response;
    try { response = await handle(request(body)); }
    finally { JSON.parse = originalParse; }
    assert.equal(parsedRequest, false);
    assert.equal(response.status, 413);
    const result = await response.json();
    assert.equal(result.error.code, "INPUT_TOO_LARGE");
    assert.equal(result.error.retryable, false);
  }
  assert.equal(calls, 0);
});

test("shared-core stale prerequisites remain a definite conflict, not retryable storage failure", async () => {
  const handle = makeHandler({ query() { throw Object.assign(new Error("private source must not be echoed"), { code: "PREREQUISITE_NOT_SATISFIED" }); } });
  const response = await handle(request('{"operation":"get_study_session","args":{}}'));
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.equal(result.error.code, "PREREQUISITE_NOT_SATISFIED");
  assert.equal(result.error.retryable, false);
  assert.equal(JSON.stringify(result).includes("private source"), false);
});

test("the isolate gate rejects overlapping work before body consumption and releases after failure", async () => {
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let count = 0;
  const handle = makeHandler({ async query() {
    if (++count === 1) { enter(); await blocked; throw new Error("synthetic storage failure"); }
    return { recovered: true };
  } });
  const first = handle(request('{"operation":"get_learning_overview","args":{}}'));
  await entered;
  let bodyRead = false;
  const unread = { get body() { bodyRead = true; throw new Error("must not read overlapping body"); } };
  let busy;
  try { busy = await handle(unread); }
  finally { release(); }
  assert.equal(busy.status, 503);
  assert.equal((await busy.json()).error.code, "SERVICE_BUSY");
  assert.equal(bodyRead, false);
  assert.equal((await first).status, 503);
  const next = await handle(request('{"operation":"get_learning_overview","args":{}}'));
  assert.equal(next.status, 200);
  assert.equal((await next.json()).data.recovered, true);
});
