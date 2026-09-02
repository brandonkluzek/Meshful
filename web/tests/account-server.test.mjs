import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateLearnerEndpoint } from "../integration/learner-endpoint.mjs";

test("unconfigured learner wrapper denies every route without touching accounts, backend or storage", async () => {
  const forbidden = new Proxy({}, { get() { throw new Error("disabled dependency was touched"); } });
  const endpoint = createPrivateLearnerEndpoint({ backend: forbidden, accounts: forbidden, database: forbidden });
  for (const path of ["state", "commands", "claims", "receipts/request", "reviews", "imports/local"]) {
    const request = new Request(`https://meshful.ai/api/learner/v1/${path}`, { headers: {
      "oai-authenticated-user-id": "forged", "oai-authenticated-user-email": "forged@example.invalid", "X-Meshful-Account": "arbitrary", Host: "meshful.ai",
    } });
    const response = await endpoint.handle(request);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "ACCOUNT_SYNC_DISABLED");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await endpoint.canSelectAccountEntry(request), false);
  }
});

test("a false or throwing server ingress predicate is closed before composition", async () => {
  for (const isTrustedIngress of [() => false, () => { throw new Error("no provenance"); }]) {
    const endpoint = createPrivateLearnerEndpoint({ database: {}, activation: { isTrustedIngress },
      backend: new Proxy({}, { get() { throw new Error("must not compose"); } }) });
    assert.equal((await endpoint.handle(new Request("https://meshful.ai/api/learner/v1/state"))).status, 503);
  }
});
