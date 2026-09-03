import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { graphForCatalog } from "../public/study/js/library-view.js";
import { buildGraphIndex } from "../public/study/js/graph-scope.js";
import { layoutEntireGraphProjection } from "../public/study/js/graph-view.js";

const [app, graphView] = await Promise.all([
  readFile(new URL("../public/study/js/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/study/js/graph-view.js", import.meta.url), "utf8"),
]);

test("Library graph preview stays inside one course and keeps deck-local learning order", () => {
  const deck = {
    id: "academic-reviewed-v1:algorithms-i",
    title: "Algorithms I",
    subject: "Computer Science and Software",
    version: "2026-08-30.reviewed-72.v1",
    cards: [
      { id: "algorithms.root", term: "Algorithm" },
      { id: "algorithms.child", term: "Algorithm specification", prerequisite_ids: ["algorithms.root", "proofs.external"] },
    ],
  };
  const proofDeck = {
    id: "academic-reviewed-v1:proofs",
    title: "Introduction to Mathematical Proofs",
    subject: "Mathematics",
    version: deck.version,
    cards: [{ id: "proofs.external", term: "Proof" }],
  };
  const original = structuredClone(deck);
  const originalProof = structuredClone(proofDeck);

  const preview = graphForCatalog(deck, [deck, proofDeck]);
  const index = buildGraphIndex(preview);

  assert.deepEqual(deck, original, "previewing never rewrites catalog bytes");
  assert.deepEqual(proofDeck, originalProof, "ancestor catalog bytes also stay unchanged");
  assert.deepEqual(index.nodeIds, ["algorithms.child", "algorithms.root"]);
  assert.equal(index.edges.length, 1, "the deck-local prerequisite remains visible");
  assert.deepEqual(preview.rootCardIds, ["algorithms.root", "algorithms.child"]);
  assert.deepEqual(index.modules.map((item) => item.title), ["Concept"]);
  assert.equal(index.cardById.has("proofs.external"), false, "cross-course parents stay out of the learner graph");
  assert.ok([...index.cardById.values()].every((card) => card.external === false));
  assert.notEqual(preview.cards, deck.cards);
  assert.deepEqual(preview.missingPrerequisiteIds, []);
  const overview = layoutEntireGraphProjection({
    kind: "full",
    nodeIds: index.nodeIds,
    nodes: index.nodes,
    edges: index.edges,
  });
  assert.equal(overview.nodes.length, index.nodeIds.length, "the overview lays out every selected-course card");
  assert.equal(overview.edges.length, index.edges.length, "the overview keeps every deck-local edge");
  assert.ok(overview.edges.every((edge) => /^M .* C /.test(edge.path)), "the bounded overview emits renderable paths");
  assert.match(app, /showEntireGraph:\s*true/);
  assert.match(graphView, /nodeLimit = showEntireGraph \? index\.nodeIds\.length/);
  assert.match(graphView, /showEntireGraph\s*\? layoutEntireGraphProjection\(projection\)/);
  assert.match(graphView, /ENTIRE_GRAPH_MIN_SCALE = 0\.01/);
  assert.match(graphView, /minScale: showEntireGraph \? ENTIRE_GRAPH_MIN_SCALE/);
  assert.match(graphView, /if \(showEntireGraph\) \{[\s\S]*setSelected\(result\.match\.id, \{ center: true, preservePath: true \}\)/);
});
