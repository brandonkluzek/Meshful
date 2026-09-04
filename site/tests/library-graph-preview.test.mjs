import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { graphForCatalog } from "../public/study/js/library-view.js";
import { buildGraphIndex } from "../public/study/js/graph-scope.js";
import { layoutEntireGraphProjection } from "../public/study/js/graph-view.js";

const [app, graphView, graphProgressState] = await Promise.all([
  readFile(new URL("../public/study/js/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/study/js/graph-view.js", import.meta.url), "utf8"),
  readFile(new URL("../public/study/js/graph-progress-state.js", import.meta.url), "utf8"),
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
  assert.match(app, /canStudy:\s*false/);
  assert.match(app, /progressSource:\s*['"]structure['"]/);
  assert.match(app, /backAriaLabel:\s*['"]Close graph and return to Library['"]/);
  assert.match(graphView, /nodeLimit = showEntireGraph \? index\.nodeIds\.length/);
  assert.match(graphView, /showEntireGraph\s*\? layoutEntireGraphProjection\(projection\)/);
  assert.match(graphView, /ENTIRE_GRAPH_MIN_SCALE = 0\.01/);
  assert.match(graphView, /minScale: showEntireGraph \? ENTIRE_GRAPH_MIN_SCALE/);
  assert.match(graphView, /if \(showEntireGraph\) \{[\s\S]*setSelected\(result\.match\.id, \{ center: true, preservePath: true \}\)/);
});

test("production graphs use retained learner records and never synthetic state scenarios", () => {
  const graphRoute = app.match(/function graphRouteForDeck\(deckId, snapshot\) \{([\s\S]*?)\n\}/)?.[1];
  const preview = app.match(/async function showDeckPreview\(deckId\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(graphRoute && preview);
  assert.match(app, /import \{ cardStatesForDeck \} from ['"]\.\/graph-progress-state\.js\?release=v47-graph-default-overview['"]/);
  assert.match(graphProgressState, /review\.demoSeeded === true/);
  assert.match(graphProgressState, /scheduleBefore\?\.demoSeeded === true/);
  assert.match(graphProgressState, /learnednessForReview\(learnerSchedule\)/);
  assert.match(graphProgressState, /review\.lastRating \?\? retainedLearnerReviews\.at\(-1\)\?\.rating/);
  assert.match(graphProgressState, /Array\.isArray\(card\.reviewHistory\)/);
  assert.match(graphRoute, /installedPersonalDeck\(deckId, snapshot\)/);
  assert.match(graphRoute, /graph\/\$\{personal\.id\}/);
  assert.match(preview, /graphHref = graphRouteForDeck\(deck\.id, snapshot\)/);
  assert.match(preview, /View my graph/);
  assert.match(app, /if \(installed && !installed\.archived\) \{\s*location\.hash = `graph\/\$\{installed\.id\}`;\s*return;/);
  assert.match(app, /progressSource:\s*['"]learner['"]/);
  assert.doesNotMatch(app, /focusCardId:\s*deck\.rootCardIds\[0\]/, "personal graphs open on the full-deck overview");

  assert.doesNotMatch(graphView, /GRAPH_STATE_SCENARIOS|stateForScenario|data-graph-scenario|Compare learner states|Visual preview/);
  assert.doesNotMatch(graphView, /graph-comparison-bar|data-graph-deck|deckOptions|onDeckChange/);
  assert.doesNotMatch(graphView, /graph-layout-flag|Review \$\{longLinks\.length\} long links|longPrerequisiteLinks/);
  assert.doesNotMatch(app, /graphDeckOptions|deckOptions:\s*|onDeckChange:\s*/);
  assert.match(graphView, /const activeStateFor = \(cardId\) => stateFor\(cardId, cardStates\)/);
  assert.match(graphView, /again:\s*1,\s*hard:\s*2,\s*good:\s*3,\s*easy:\s*4/);
});
