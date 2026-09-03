import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { catalogRelease } from "../public/study/integration/catalog-release.mjs";

const EXPECTED_DECKS = 72;
const EXPECTED_CARDS = 9_988;
const EXPECTED_INTERNAL_EDGES = 16_942;
const DETERMINISTIC_DECK_IDS = Object.freeze([
  "academic-reviewed-v1:algorithms-i",
  "academic-reviewed-v1:biology-i",
  "academic-reviewed-v1:linear-algebra-i",
  "academic-reviewed-v1:programming-i",
]);
const WORKER_URL = new URL("./helpers/graph-catalog-validation-worker.mjs", import.meta.url);

async function activeRelease() {
  const releaseRootUrl = new URL(
    `../public/study/data/library-runtime/${catalogRelease.version}/`,
    import.meta.url,
  );
  const index = JSON.parse(await readFile(new URL("index.json", releaseRootUrl), "utf8"));
  assert.equal(index.audience, "public");
  assert.equal(index.current_runtime_compatible, true);
  assert.equal(index.catalog_ref?.version, catalogRelease.version);
  assert.equal(index.constructor_ref?.version, catalogRelease.version);
  assert.equal(index.constructor_ref?.digest, catalogRelease.digest);
  return { index, releaseRoot: fileURLToPath(releaseRootUrl) };
}

function workWeight(entry) {
  const nodes = entry.card_count;
  const edges = entry.summary?.prerequisite_edge_count ?? entry.prerequisite_edge_count ?? 0;
  const repeatFactor = DETERMINISTIC_DECK_IDS.includes(entry.catalog_deck_id) ? 2 : 1;
  return repeatFactor * (nodes * nodes * 120 + edges * edges * 900);
}

function balancedBatches(entries, count) {
  const batches = Array.from({ length: count }, () => ({ weight: 0, entries: [] }));
  const ordered = [...entries].sort((left, right) =>
    workWeight(right) - workWeight(left) ||
    left.catalog_deck_id.localeCompare(right.catalog_deck_id),
  );
  for (const entry of ordered) {
    batches.sort((left, right) => left.weight - right.weight);
    batches[0].entries.push({
      catalog_deck_id: entry.catalog_deck_id,
      card_count: entry.card_count,
      chunk: entry.chunk,
      summary: entry.summary,
    });
    batches[0].weight += workWeight(entry);
  }
  return batches.filter((batch) => batch.entries.length > 0).map((batch) => batch.entries);
}

function runWorker(entries, releaseRoot) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      workerData: {
        deterministicDeckIds: DETERMINISTIC_DECK_IDS,
        entries,
        releaseRoot,
      },
    });
    let settled = false;
    worker.once("message", (message) => {
      settled = true;
      if (message.error) {
        const error = new Error(message.error.message);
        error.stack = message.error.stack ?? error.stack;
        reject(error);
      } else {
        resolve(message.results);
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`Graph catalog worker exited with code ${code}.`));
    });
  });
}

test("active 72-deck catalog preserves complete deterministic graph geometry", async () => {
  const gateStartedAt = performance.now();
  const { index, releaseRoot } = await activeRelease();
  assert.equal(index.decks.length, EXPECTED_DECKS, "the active release must contain all 72 decks");
  const catalogDeckIds = index.decks.map((entry) => entry.catalog_deck_id);
  assert.equal(new Set(catalogDeckIds).size, EXPECTED_DECKS, "installed deck IDs must be unique");
  for (const deckId of catalogDeckIds) {
    assert.match(
      deckId,
      /^academic-reviewed-v1:[a-z0-9]+(?:-[a-z0-9]+)*$/,
      `installed deck ID ${deckId} must use the active catalog namespace`,
    );
  }

  const workerCount = Math.max(1, Math.min(6, availableParallelism(), index.decks.length));
  const batches = balancedBatches(index.decks, workerCount);
  const results = (await Promise.all(
    batches.map((entries) => runWorker(entries, releaseRoot)),
  )).flat().sort((left, right) => left.deckId.localeCompare(right.deckId));

  assert.equal(results.length, EXPECTED_DECKS);
  assert.equal(results.reduce((total, result) => total + result.nodes, 0), EXPECTED_CARDS);
  assert.equal(results.reduce((total, result) => total + result.edges, 0), EXPECTED_INTERNAL_EDGES);
  assert.deepEqual(
    results.filter((result) => result.determinismChecked).map((result) => result.deckId),
    [...DETERMINISTIC_DECK_IDS].sort(),
  );

  for (const result of results) {
    console.log(
      `GRAPH_CATALOG deck=${result.deckId} nodes=${result.nodes} edges=${result.edges} ` +
      `crossings=${result.crossings} edge_card_penetrations=${result.edgeCardPenetrations} ` +
      `layout_ms=${result.layoutDurationMs.toFixed(1)} diagnostics_ms=${result.diagnosticsDurationMs.toFixed(1)}`,
    );
  }
  const aggregateLayoutMs = results.reduce((total, result) => total + result.layoutDurationMs, 0);
  const aggregateDiagnosticsMs = results.reduce((total, result) => total + result.diagnosticsDurationMs, 0);
  console.log(
    `GRAPH_CATALOG_TOTAL release=${catalogRelease.version} decks=${results.length} ` +
    `nodes=${results.reduce((total, result) => total + result.nodes, 0)} ` +
    `edges=${results.reduce((total, result) => total + result.edges, 0)} ` +
    `crossings=${results.reduce((total, result) => total + result.crossings, 0)} ` +
    `edge_card_penetrations=${results.reduce((total, result) => total + result.edgeCardPenetrations, 0)} ` +
    `layout_worker_ms=${aggregateLayoutMs.toFixed(1)} ` +
    `diagnostics_worker_ms=${aggregateDiagnosticsMs.toFixed(1)} ` +
    `wall_ms=${(performance.now() - gateStartedAt).toFixed(1)} ` +
    "quality_policy=diagnostic_only",
  );
});
