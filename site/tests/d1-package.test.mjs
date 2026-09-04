import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root));
const text = async (path) => (await read(path)).toString("utf8");
const digest = async (path) => createHash("sha256").update(await read(path)).digest("hex");

test("the Sites package declares the reviewed logical D1 binding", async () => {
  const hosting = JSON.parse(await text(".openai/hosting.json"));
  assert.deepEqual(hosting, {
    project_id: "appgprj_6a9334b99f20819195ece80ebe97016b",
    d1: "DB",
    r2: null,
  });
});

test("the exact Backend v1, v2, writer-grant, and privacy migrations are journaled in order", async () => {
  const migrations = [
    ["drizzle/0000_meshful_learner_data.sql", "d340074b78317d6cbb95d8b02a2b623a3614dacb6b87ee71dc41f44da5f32eb3", 9],
    ["drizzle/0001_meshful_fragmented_storage.sql", "6644a87087193b85df28964637600d5b2ee3e5562881bc31c46969741ecc7e78", 31],
    ["drizzle/0002_meshful_study_writer_grants.sql", "1f0d0faa172abc03e9d1bed83b779cb52ad612bbe0f9b80ad9de75a5afd78d11", 5],
    ["drizzle/0003_meshful_privacy_deletion.sql", "f18026e861bc96ce45ad81827845b276e6a75ca1b9cf412481ccc89b9c026d51", 23],
  ];
  for (const [path, expected, breakpoints] of migrations) {
    assert.equal(await digest(path), expected);
    assert.equal((await text(path)).match(/^--> statement-breakpoint$/gm)?.length ?? 0, breakpoints);
  }
  assert.equal(await digest("drizzle/meta/_journal.json"), "b5d720c49b033bee6cda8a09cd0ecc8eff889f2414c0c5174ca8bf225668aa18");
  const journal = JSON.parse(await text("drizzle/meta/_journal.json"));
  assert.equal(journal.dialect, "sqlite");
  assert.deepEqual(journal.entries.map(({ idx, tag }) => ({ idx, tag })), [
    { idx: 0, tag: "0000_meshful_learner_data" },
    { idx: 1, tag: "0001_meshful_fragmented_storage" },
    { idx: 2, tag: "0002_meshful_study_writer_grants" },
    { idx: 3, tag: "0003_meshful_privacy_deletion" },
  ]);
});

test("the packaged schema retains every table, guard replacement, and deferred receipt FK", async () => {
  const sql = `${await text("drizzle/0000_meshful_learner_data.sql")}\n${await text("drizzle/0001_meshful_fragmented_storage.sql")}\n${await text("drizzle/0002_meshful_study_writer_grants.sql")}\n${await text("drizzle/0003_meshful_privacy_deletion.sql")}`;
  assert.equal([...sql.matchAll(/^CREATE TABLE\s+(\w+)/gm)].length, 19);
  assert.equal([...sql.matchAll(/^CREATE TRIGGER\s+(\w+)/gm)].length, 34);
  assert.match(sql, /FOREIGN KEY\s*\(principal_id,\s*response_document_id\)[\s\S]*?REFERENCES\s+meshful_v2_documents\s*\(principal_id,\s*document_id\)[\s\S]*?DEFERRABLE\s+INITIALLY\s+DEFERRED/i);
  const deletion = await text("drizzle/0003_meshful_privacy_deletion.sql");
  assert.equal((deletion.match(/^DROP TRIGGER\s+/gm) ?? []).length, 9);
  assert.equal((deletion.match(/^CREATE TRIGGER\s+/gm) ?? []).length, 9);
  assert.match(deletion, /meshful_data_deletion_authorizations/);
  assert.match(deletion, /meshful_retired_deck_instances/);
});

test("the Sites migration avoids remote D1 trigger-splitter hazards", async () => {
  const sql = await text("drizzle/0001_meshful_fragmented_storage.sql");
  assert.equal((sql.match(/SELECT\s+\(CASE\b/g) ?? []).length, 3);
  assert.equal((sql.match(/SELECT\s+CASE\b/g) ?? []).length, 0);
  assert.equal((sql.match(/^CREATE TRIGGER\b/gm) ?? []).length, 23);
  assert.equal((sql.match(/\bBEGIN\b/g) ?? []).length, 23);
  assert.equal((sql.match(/\bbegin\b/gi) ?? []).length, 23);
  assert.equal((sql.match(/\r/g) ?? []).length, 0);
});

test("the generated Worker route activates only the same-request Sites resolver", async () => {
  const route = await text("app/api/learner/[...path]/route.ts");
  const runtime = await text("integration/site-runtime.mjs");
  const vite = await text("vite.config.ts");
  assert.match(route, /import \{ env \} from 'cloudflare:workers'/);
  assert.match(route, /getChatGPTUser/);
  assert.match(route, /const user = await getChatGPTUser\(\)/);
  assert.match(route, /subject:\s*user\.userId/);
  assert.match(route, /const assets = runtime\.ASSETS/);
  assert.match(route, /MESHFUL_ACCOUNT_PERSISTENCE_MODE/);
  assert.match(route, /MESHFUL_ACCOUNT_ACCEPTANCE_SUBJECTS/);
  assert.match(route, /accountPersistenceAllowsSubject/);
  assert.match(route, /activation:\s*accountPolicy\.enabled[\s\S]*allowProvisioning:\s*accountPolicy\.allowProvisioning[\s\S]*resolveTrustedSitesRequest[\s\S]*: null/);
  assert.match(vite, /assets:\s*\{ binding: 'ASSETS' \}/);
  assert.match(runtime, /allowProvisioning:\s*false/);
  assert.match(runtime, /allowedOrigins:\s*Object\.freeze\(\["https:\/\/meshful\.ai"\]\)/);
  assert.match(runtime, /createPreparedSiteEndpoint\(\{ database = null, assets = null, activation = null \}/);
});

test("the visible and account-backed Deck Library use the sanitized public release and retain prior-release readback", async () => {
  const releases = JSON.parse(await text("public/study/data/library-releases.json"));
  const active = releases.releases.find((release) => release.version === releases.active);
  assert.equal(active.version, "2026-09-03.public-sanitized.v4");
  assert.equal(active.delivery, "artifact");
  assert.equal(active.sha256, "ffcd11b6409fcc7c5fb500e097e41c829d94601614b6fe5ae37ebf23dafb28a1");
  assert.deepEqual(active.counts, {
    cards: 9988,
    decks: 72,
    external_prerequisite_edges: 770,
    internal_prerequisite_edges: 16942,
    prerequisite_edges: 17712,
  });
  const previous = releases.releases.find((release) => release.version === "2026-09-02.public-sanitized.v3");
  assert.equal(previous.delivery, "artifact");
  assert.equal(previous.sha256, "fd26b03178e8ffa0db631814cc7771aae1966f9b087499378ddfa1c78b98a332");
  const retained = releases.releases.find((release) => release.version === "2026-08-30.reviewed-72.v1");
  assert.equal(retained.delivery, "feed");
  assert.equal(retained.sha256, "612d5c79dbe924ba00db2c08833ac79922d3de3e71a7a857bac3b1204bdca783");
  const accountRelease = await text("integration/catalog-release.mjs");
  assert.match(accountRelease, /2026-09-03\.public-sanitized\.v4/);
  assert.match(accountRelease, /ce0589f4055dd2cf45a07601eaec0ec71107c62683289e1b0a54417d9480e859/);
  assert.doesNotMatch(accountRelease, /demo-fixtures/);
});
