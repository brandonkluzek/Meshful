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

const v2Migration = new URL(
  "../integration/backend/v2/migrations/0002_fragmented_storage.sql",
  import.meta.url,
);
const writerMigration = new URL("../drizzle/0002_meshful_study_writer_grants.sql", import.meta.url);
const releaseRoots = new Map([
  [LIBRARY_RELEASE, new URL(`../public/study/data/library-runtime/${LIBRARY_RELEASE}/`, import.meta.url)],
  [PREVIOUS_LIBRARY_RELEASE,
    new URL(`../public/study/data/library-runtime/${PREVIOUS_LIBRARY_RELEASE}/`, import.meta.url)],
  [RETAINED_LIBRARY_RELEASE,
    new URL(`../public/study/data/library-runtime/${RETAINED_LIBRARY_RELEASE}/`, import.meta.url)],
]);

function libraryAssets() {
  return {
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      for (const [release, root] of releaseRoots) {
        const marker = `/library-runtime/${release}/`;
        if (!pathname.includes(marker)) continue;
        const key = pathname.slice(pathname.indexOf(marker) + marker.length);
        try {
          const bytes = await readFile(new URL(key, root));
          return new Response(bytes, {
            headers: { "content-length": String(bytes.length) },
          });
        } catch {
          return new Response("", { status: 404 });
        }
      }
      return new Response("", { status: 404 });
    },
  };
}

test("Website composes trusted Accounts, Backend v7 and SQLite without provisioning unknown identities", async (t) => {
  const database = new SqliteD1().applyMigration().applyMigration(v2Migration).applyMigration(writerMigration);
  t.after(() => database.close());

  const issuer = `urn:meshful:sites:${accountSiteConfig.siteId}`;
  const repository = createD1Repository(database);
  const knownIdentity = {
    provider: "sites-chatgpt",
    issuer,
    subject: "site-composition-a",
  };
  const { principalId } = await repository.provisionPrincipalForVerifiedIdentity(knownIdentity);
  assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM meshful_principals").get().count, 1);
  const writesAfterSetup = database.database.prepare("SELECT total_changes() AS total").get().total;

  let trustedSubject = knownIdentity.subject;
  const endpoint = createPreparedSiteEndpoint({
    database,
    assets: libraryAssets(),
    activation: {
      ...accountSiteConfig,
      allowProvisioning: false,
      resolveTrustedSitesRequest: async () => ({
        trusted: true,
        authenticated: true,
        subject: trustedSubject,
      }),
    },
  });

  const response = await endpoint.handle(new Request("https://meshful.ai/api/learner/v2/state", {
    headers: { "oai-authenticated-user-id": "forged-user" },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    data: {
      schema_version: 2,
      snapshot_encoding: "canonical-json.v1",
      account_binding: principalId,
      durable_revision: 0,
      catalog_ref: null,
      state_json: null,
    },
  });
  assert.equal(database.database.prepare("SELECT total_changes() AS total").get().total, writesAfterSetup);

  trustedSubject = "site-composition-unbound";
  const unbound = await endpoint.handle(new Request("https://meshful.ai/api/learner/v2/state"));
  assert.equal(unbound.status, 403);
  assert.deepEqual(await unbound.json(), {
    error: {
      code: "identity_not_bound",
      message: "Account access is not available for this identity.",
    },
  });
  assert.equal(database.database.prepare("SELECT total_changes() AS total").get().total, writesAfterSetup);
  assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM meshful_principals").get().count, 1);
  assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM meshful_identity_bindings").get().count, 1);
  assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM meshful_learner_state").get().count, 1);
  assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM meshful_v2_heads").get().count, 0);
});
