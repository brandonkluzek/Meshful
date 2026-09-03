import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { SqliteD1 } from "../../test-support/sqlite-d1.mjs";
import { contextFor, FIXED_NOW } from "../../test-support/fixtures.mjs";
import { RESOLUTION_BUDGET } from "../../v3/test-support/pinned-resolver.mjs";
import {
  createCanonicalEngine, createD1Repository, createLearnerService,
} from "../src/index.mjs";
import { loadTwoReleaseResolver } from "../test-support/two-release-resolver.mjs";

assert.ok(process.env.MESHFUL_CANONICAL_ROOT,
  "Supply the authorized canonical source root");
const canonicalRoot = resolve(process.env.MESHFUL_CANONICAL_ROOT);
const canonical = await import(pathToFileURL(join(canonicalRoot, "web/js/store.js")));
const webmcp = await import(pathToFileURL(join(canonicalRoot, "web/js/webmcp.js")));
const migration = new URL("../../v2/migrations/0002_fragmented_storage.sql", import.meta.url);
const code = (expected) => (error) => error?.code === expected;

function command(operation, args, expectedRevision) {
  return {
    request_id: args.client_action_id ?? args.idempotency_key,
    expected_revision: expectedRevision,
    operation,
    args,
  };
}

async function engineFor(resolver, expectedCatalogPins) {
  return createCanonicalEngine({
    ...canonical,
    toolSchemas: webmcp.WEBMCP_TOOL_SCHEMAS,
    catalogResolver: resolver,
    expectedCatalogPins,
    expectedResolutionBudget: RESOLUTION_BUDGET,
  });
}

test("a compatible current Library install atomically promotes an old account while retaining exact v1 bases", {
  timeout: 120_000,
}, async (t) => {
  const releases = await loadTwoReleaseResolver();
  const retained = await releases.createRetainedResolver();
  const db = new SqliteD1().applyMigration().applyMigration(migration);
  t.after(() => db.close());
  const repository = createD1Repository(db);
  const v1Service = createLearnerService({
    repository,
    engine: await engineFor(retained.resolver, retained.expectedCatalogPins),
    clock: () => FIXED_NOW,
  });
  const learner = await contextFor(v1Service, "catalog-promotion-a");
  const v1InstallArgs = {
    library_deck_id: "academic-reviewed-v1:linear-algebra-i",
    expected_catalog_version: retained.expectedCatalogPins[0].sourcePins.rawCatalogRef.version,
    client_action_id: "promotion:install-v1-linear-algebra",
  };
  const v1Install = await v1Service.command(learner, command("add_library_deck", v1InstallArgs, 0));
  assert.equal(v1Install.durable_revision, 1);
  const oldDeckId = v1Install.result.deck.id;
  const oldDeckBefore = await v1Service.query(learner, {
    operation: "get_deck",
    args: { scope: "personal", deck_id: oldDeckId },
  });
  const stateBefore = await v1Service.getState(learner);
  assert.deepEqual(stateBefore.catalog_ref, retained.expectedCatalogPins[0].constructorCatalogRef);

  const currentService = createLearnerService({
    repository,
    engine: await engineFor(releases.resolver, releases.expectedCatalogPins),
    clock: () => FIXED_NOW,
  });

  const search = await currentService.query(learner, {
    operation: "search_library",
    args: { query: "Linear Algebra I", limit: 10 },
  });
  const currentSummary = search.result.items.find((item) =>
    item.deck_id === releases.retained.linearAlgebraId);
  assert.equal(currentSummary.version, releases.current.version);
  const currentPreview = await currentService.query(learner, {
    operation: "get_deck",
    args: { scope: "library", deck_id: releases.current.physiologyId },
  });
  assert.equal(currentPreview.result.deck.version, releases.current.version);
  const oldDeckThroughCurrent = await currentService.query(learner, {
    operation: "get_deck",
    args: { scope: "personal", deck_id: oldDeckId },
  });
  assert.deepEqual(oldDeckThroughCurrent.result, oldDeckBefore.result);
  assert.deepEqual(await currentService.getState(learner), stateBefore);

  const conflictingArgs = {
    library_deck_id: releases.retained.linearAlgebraId,
    expected_catalog_version: releases.current.version,
    client_action_id: "promotion:conflicting-current-linear-algebra",
  };
  await assert.rejects(currentService.command(learner,
    command("add_library_deck", conflictingArgs, 1)), code("LIBRARY_DEPENDENCY_CONFLICT"));
  assert.deepEqual(await currentService.getState(learner), stateBefore);

  const promoteArgs = {
    library_deck_id: releases.current.physiologyId,
    expected_catalog_version: releases.current.version,
    client_action_id: "promotion:install-current-physiology",
  };
  const promoted = await currentService.command(learner,
    command("add_library_deck", promoteArgs, 1));
  assert.equal(promoted.durable_revision, 2);
  assert.deepEqual(promoted.catalog_ref, releases.current.constructorRef);
  assert.equal(promoted.result.installation.decks.length, 14);
  assert.equal(promoted.result.receipt.replayed, false);
  const stateAfterPromotion = await currentService.getState(learner);
  assert.deepEqual(stateAfterPromotion.catalog_ref, releases.current.constructorRef);
  assert.notEqual(stateAfterPromotion.state_json, stateBefore.state_json);
  const oldDeckAfter = await currentService.query(learner, {
    operation: "get_deck",
    args: { scope: "personal", deck_id: oldDeckId },
  });
  assert.deepEqual(oldDeckAfter.result, oldDeckBefore.result);

  const replay = await currentService.command(learner,
    command("add_library_deck", promoteArgs, 1));
  assert.equal(replay.durable_revision, 2);
  assert.equal(replay.result.receipt.replayed, true);
  assert.deepEqual((await currentService.getState(learner)).catalog_ref,
    releases.current.constructorRef);

  const staleReleaseArgs = {
    library_deck_id: "academic-reviewed-v1:algorithms-i",
    expected_catalog_version: releases.retained.version,
    client_action_id: "promotion:stale-page-install",
  };
  const beforeStaleRelease = await currentService.getState(learner);
  await assert.rejects(currentService.command(learner,
    command("add_library_deck", staleReleaseArgs, 2)), code("STALE_CATALOG_VERSION"));
  assert.deepEqual(await currentService.getState(learner), beforeStaleRelease);

  const started = await currentService.command(learner, command("start_study_session", {
    deck_id: oldDeckId,
    limit: 1,
    idempotency_key: "promotion:start-old-v1-deck",
  }, 2));
  const session = started.result.session;
  const personal = await currentService.query(learner, {
    operation: "get_deck",
    args: { scope: "personal", deck_id: oldDeckId },
  });
  const card = personal.result.deck.cards.find((item) => item.card_id === session.current_card_id);
  assert.ok(card);
  const gradeArgs = {
    session_id: session.session_id,
    card_id: card.card_id,
    expected_card_revision: card.card_revision,
    expected_session_revision: session.session_revision,
    answer_text: "I do not remember the definition.",
    answer_origin: "chat",
    rating: "again",
    rubric_evidence: card.required_concepts.map((item) => ({
      rubric_item_id: item.rubric_item_id,
      status: "missed",
      note: "The learner supplied no definition content for this required item.",
    })),
    feedback: "Review the revealed definition, then recall its essential meaning on the next pass.",
    misconceptions: [],
    confidence: 1,
    idempotency_key: "promotion:grade-old-v1-deck",
  };
  const graded = await currentService.command(learner, command("submit_grade", gradeArgs, 3));
  assert.equal(graded.durable_revision, 4);
  const reviews = await currentService.listReviews(learner);
  assert.equal(reviews.events.length, 1);
  assert.deepEqual(reviews.events[0].payload.constructor_catalog_ref,
    releases.current.constructorRef);
  assert.deepEqual(reviews.events[0].payload.reviewed_constructor_catalog_ref,
    releases.retained.constructorRef);
  assert.deepEqual(reviews.events[0].payload.catalog_ref,
    releases.retained.catalogRef);
});
