import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { loadWebsiteLibrary } from "../js/library-loader.js";

const WEB_ROOT = path.resolve(import.meta.dirname, "..");
const DATA_ROOT = path.resolve(WEB_ROOT, "data");
const INDEX_URL = "https://meshful.test/study/data/library-releases.json";

async function publicDataFetcher(url) {
  const pathname = new URL(url).pathname;
  const prefix = "/study/data/";
  if (!pathname.startsWith(prefix)) return new Response("not found", { status: 404 });
  const absolute = path.resolve(DATA_ROOT, pathname.slice(prefix.length));
  if (!absolute.startsWith(`${DATA_ROOT}${path.sep}`)) return new Response("not found", { status: 404 });
  try {
    const bytes = await readFile(absolute);
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

test("the shipped public index loads the exact sanitized 72-course browser catalog", async () => {
  const loaded = await loadWebsiteLibrary({ indexUrl: INDEX_URL, fetcher: publicDataFetcher });
  assert.equal(loaded.release, "2026-09-02.public-sanitized-72.v2");
  assert.equal(loaded.seedExamples, false);
  assert.equal(loaded.catalog.library.catalogRef.digest,
    "sha256:a7ef2efa1d6133879ab8daf6068ff88a17abc23be1590d39932cea82b0ec8642");
  assert.equal(loaded.catalog.library.dependencyGraphDigest,
    "sha256:82025162442152929780e8bcf42066361b8ebc1602c899b1f706f621b2257ce0");
  assert.equal(loaded.catalog.catalog.length, 72);
  assert.equal(loaded.catalog.catalog.reduce((sum, deck) => sum + deck.cards.length, 0), 9988);
});
