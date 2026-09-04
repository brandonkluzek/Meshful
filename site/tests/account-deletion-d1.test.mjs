import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createStudyStore, createMemoryStorage } from "../integration/core/js/store.js";
import { WEBMCP_TOOL_SCHEMAS } from "../integration/core/js/webmcp.js";
import {
  createCanonicalEngine, createD1Repository, createLearnerService,
} from "../integration/backend/v7/src/index.mjs";
import { SqliteD1 } from "../integration/backend/test-support/sqlite-d1.mjs";
import { contextFor, FIXED_NOW } from "../integration/backend/test-support/fixtures.mjs";
import {
  BACKEND_EXPECTED_CATALOG_PINS, LIBRARY_RELEASE, LIBRARY_RESOLUTION_BUDGET,
  PREVIOUS_LIBRARY_RELEASE, RETAINED_LIBRARY_RELEASE, createReviewedLibraryResolver,
} from "../integration/library-runtime.mjs";

const fragmentedMigration = new URL(
  "../integration/backend/v2/migrations/0002_fragmented_storage.sql",
  import.meta.url,
);
const writerMigration = new URL("../drizzle/0002_meshful_study_writer_grants.sql", import.meta.url);
const deletionMigration = new URL("../drizzle/0003_meshful_privacy_deletion.sql", import.meta.url);
const code = (expected) => (error) => error?.code === expected;
const releaseRoots = new Map([
  [LIBRARY_RELEASE, new URL(`../public/study/data/library-runtime/${LIBRARY_RELEASE}/`, import.meta.url)],
  [PREVIOUS_LIBRARY_RELEASE,
    new URL(`../public/study/data/library-runtime/${PREVIOUS_LIBRARY_RELEASE}/`, import.meta.url)],
  [RETAINED_LIBRARY_RELEASE,
    new URL(`../public/study/data/library-runtime/${RETAINED_LIBRARY_RELEASE}/`, import.meta.url)],
]);

function libraryAssets() {
  return { async fetch(request) {
    const pathname = new URL(request.url).pathname;
    for (const [release, root] of releaseRoots) {
      const marker = `/library-runtime/${release}/`;
      if (!pathname.includes(marker)) continue;
      const key = pathname.slice(pathname.indexOf(marker) + marker.length);
      try {
        const bytes = await readFile(new URL(key, root));
        return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
      } catch { return new Response("", { status: 404 }); }
    }
    return new Response("", { status: 404 });
  } };
}

function command(operation, args, expectedRevision) {
  return {
    request_id: args.client_action_id ?? args.idempotency_key,
    expected_revision: expectedRevision,
    operation,
    args,
  };
}

async function fixture({ beforeStatement } = {}) {
  const resolver = await createReviewedLibraryResolver(libraryAssets());
  const library = {
    resolver,
    expectedCatalogPins: BACKEND_EXPECTED_CATALOG_PINS,
    root: { catalogDeckId: "academic-reviewed-v1:algorithms-i", catalogVersion: LIBRARY_RELEASE },
  };
  const engine = await createCanonicalEngine({
    createStudyStore,
    createMemoryStorage,
    toolSchemas: WEBMCP_TOOL_SCHEMAS,
    catalogResolver: library.resolver,
    expectedCatalogPins: library.expectedCatalogPins,
    expectedResolutionBudget: LIBRARY_RESOLUTION_BUDGET,
  });
  const db = new SqliteD1(":memory:", { beforeStatement })
    .applyMigration()
    .applyMigration(fragmentedMigration)
    .applyMigration(writerMigration)
    .applyMigration(deletionMigration);
  return {
    library,
    db,
    service: createLearnerService({
      repository: createD1Repository(db), engine, clock: () => FIXED_NOW,
    }),
  };
}

async function installAndArchive(service, context, library, prefix = "delete") {
  const installed = await service.command(context, command("add_library_deck", {
    library_deck_id: library.root.catalogDeckId,
    expected_catalog_version: library.root.catalogVersion,
    client_action_id: `${prefix}:install`,
  }, 0));
  const archived = await service.command(context, command("set_deck_archived", {
    deck_id: installed.result.deck.id,
    archived: true,
    expected_revision: installed.result.deck.revision,
    client_action_id: `${prefix}:archive`,
  }, 1));
  return { installed, archived, deck: archived.result.deck };
}

function deckDeleteRequest(preview, requestId) {
  const impact = preview.impact;
  return {
    request_id: requestId,
    expected_revision: preview.durable_revision,
    confirmation_token: preview.confirmation.token,
    args: {
      deck_id: impact.deck_id,
      deck_instance_id: impact.deck_instance_id,
      expected_revision: impact.deck_revision,
      expected_app_revision: impact.app_revision,
      expected_impact_digest: impact.impact_digest,
      confirm_permanent_deletion: true,
      idempotency_key: requestId,
    },
  };
}

test("D1 deck deletion is exact-instance, principal-scoped, replay-safe, and purges prior recovery copies", {
  timeout: 120_000,
}, async (t) => {
  const { library, db, service } = await fixture();
  t.after(() => db.close());
  const owner = await contextFor(service, "deck-delete-owner");
  const other = await contextFor(service, "deck-delete-other");
  const { deck } = await installAndArchive(service, owner, library);

  const supersededPreview = await service.previewDeckDeletion(owner, { deck_id: deck.id });
  const preview = await service.previewDeckDeletion(owner, { deck_id: deck.id });
  assert.equal(preview.impact.can_delete, true);
  assert.equal(preview.impact.deck_instance_id, deck.deck_instance_id);
  assert.equal(preview.impact.saved_action_count, 2);
  assert.equal(preview.impact.recovery_document_count, 4);
  assert.equal(preview.impact.prior_account_recovery_copies_reset, true);
  assert.match(preview.confirmation.token, /^[a-f0-9]{64}$/);
  const request = deckDeleteRequest(preview, "delete:commit");
  await assert.rejects(service.deleteDeck(owner,
    deckDeleteRequest(supersededPreview, "delete:superseded-preview")),
  code("DELETION_CONFIRMATION_INVALID"));

  await assert.rejects(service.deleteDeck(other, request), code("STALE_DURABLE_REVISION"));
  assert.ok(JSON.parse((await service.getState(owner)).state_json).personalDecks[deck.id]);

  const deleted = await service.deleteDeck(owner, request);
  assert.equal(deleted.durable_revision, 3);
  assert.equal(deleted.result.deleted_deck_id, deck.id);
  assert.equal(deleted.result.deleted_deck_instance_id, deck.deck_instance_id);
  assert.equal(deleted.result.receipt.transaction_id, "durable-deletion:delete:commit");
  const after = await service.getState(owner);
  assert.equal(after.durable_revision, 3);
  assert.equal(JSON.parse(after.state_json).personalDecks[deck.id], undefined);

  const contentTables = [
    "meshful_learner_state", "meshful_request_receipts", "meshful_review_events",
    "meshful_import_archives",
  ];
  for (const table of contentTables) {
    assert.equal(db.database.prepare(`SELECT count(*) AS count FROM ${table} WHERE principal_id = ?`)
      .get(owner.principalId).count, 0, table);
  }
  assert.equal(db.database.prepare(
    "SELECT count(*) AS count FROM meshful_v2_receipts WHERE principal_id = ?",
  ).get(owner.principalId).count, 1);
  assert.equal(db.database.prepare(
    "SELECT count(*) AS count FROM meshful_v2_documents WHERE principal_id = ? AND kind = 'state'",
  ).get(owner.principalId).count, 1, "only the replacement state remains recoverable");

  const replay = await service.deleteDeck(owner, request);
  assert.equal(replay.result.receipt.replayed, true);
  assert.equal((await service.getState(owner)).durable_revision, 3);

  const reinstalled = await service.command(owner, command("add_library_deck", {
    library_deck_id: library.root.catalogDeckId,
    expected_catalog_version: library.root.catalogVersion,
    client_action_id: "delete:reinstall",
  }, 3));
  assert.notEqual(reinstalled.result.deck.deck_instance_id, deck.deck_instance_id);
  const staleReplay = await service.deleteDeck(owner, request);
  assert.equal(staleReplay.result.receipt.replayed, true);
  assert.ok(JSON.parse((await service.getState(owner)).state_json).personalDecks[deck.id],
    "a stale exact replay cannot delete a same-ID reinstall");
});

test("Delete my data removes learner content but preserves sign-in identity and immutable Library access", {
  timeout: 120_000,
}, async (t) => {
  const { library, db, service } = await fixture();
  t.after(() => db.close());
  const owner = await contextFor(service, "account-delete-owner");
  const other = await contextFor(service, "account-delete-other");
  const ownerDeck = await installAndArchive(service, owner, library, "account-delete");
  const restored = await service.command(owner, command("set_deck_archived", {
    deck_id: ownerDeck.deck.id,
    archived: false,
    expected_revision: ownerDeck.deck.revision,
    client_action_id: "account-delete:restore",
  }, 2));
  const writerToken = "a".repeat(64);
  await service.mutateWriterGrant(owner, {
    request_id: "account-delete:writer", action: "acquire",
    expected_writer_epoch: 0, grant_token: writerToken,
  });
  await service.command(owner, command("start_study_session", {
    deck_id: restored.result.deck.id,
    idempotency_key: "account-delete:start",
  }, 3), { writerEpoch: 1, token: writerToken });
  await installAndArchive(service, other, library, "account-other");
  const otherBefore = await service.getState(other);

  const preview = await service.previewAccountDeletion(owner, {});
  assert.equal(preview.impact.personal_deck_count, 1);
  assert.equal(preview.impact.session_count, 1, "the confirmation names the active session being ended");
  assert.equal(preview.impact.immutable_library_preserved, true);
  assert.equal(preview.impact.sign_in_binding_retained, true);
  const input = {
    request_id: "delete-my-data:commit",
    idempotency_key: "delete-my-data:commit",
    expected_revision: preview.durable_revision,
    expected_impact_digest: preview.impact.impact_digest,
    confirmation_token: preview.confirmation.token,
    confirm_permanent_deletion: true,
  };
  const deleted = await service.deleteAccountData(owner, input);
  assert.equal(deleted.result.retained.sign_in_binding, true);
  assert.equal(deleted.result.retained.immutable_library_catalog, true);
  assert.equal(deleted.result.browser_cleanup_required, true);

  const after = await service.getState(owner);
  assert.equal(after.durable_revision, 5);
  assert.equal(after.state_json, null);
  assert.equal(after.catalog_ref, null);
  assert.equal(db.database.prepare(
    "SELECT count(*) AS count FROM meshful_identity_bindings WHERE principal_id = ?",
  ).get(owner.principalId).count, 1);
  assert.equal(db.database.prepare(
    "SELECT count(*) AS count FROM meshful_principals WHERE principal_id = ?",
  ).get(owner.principalId).count, 1);
  for (const table of [
    "meshful_request_receipts", "meshful_review_events", "meshful_import_archives",
    "meshful_v2_heads", "meshful_v2_receipts", "meshful_v2_documents", "meshful_v2_parts",
    "meshful_v2_objects", "meshful_v2_review_events", "meshful_v2_import_archives",
    "meshful_study_writer_grants", "meshful_study_writer_receipts",
    "meshful_retired_deck_instances",
  ]) {
    assert.equal(db.database.prepare(`SELECT count(*) AS count FROM ${table} WHERE principal_id = ?`)
      .get(owner.principalId).count, 0, table);
  }
  assert.equal(db.database.prepare(
    "SELECT count(*) AS count FROM meshful_destructive_deletion_receipts WHERE principal_id = ?",
  ).get(owner.principalId).count, 1);
  assert.deepEqual(await service.getState(other), otherBefore, "another account is unchanged");

  const replay = await service.deleteAccountData(owner, input);
  assert.equal(replay.result.receipt.replayed, true);
  await assert.rejects(service.deleteAccountData(owner, {
    ...input,
    request_id: "delete-my-data:token-replay",
    idempotency_key: "delete-my-data:token-replay",
  }), code("STALE_DURABLE_REVISION"));

  const libraryResult = await service.query(owner, {
    operation: "get_deck", args: { scope: "library", deck_id: library.root.catalogDeckId },
  });
  assert.equal(libraryResult.result.deck.deck_id, library.root.catalogDeckId);
});

test("a failed destructive D1 batch rolls back completely and the identical confirmation can retry", {
  timeout: 120_000,
}, async (t) => {
  let injectFailure = false;
  let failedOnce = false;
  const { library, db, service } = await fixture({ beforeStatement({ sql }) {
    if (injectFailure && !failedOnce && /DELETE FROM meshful_v2_documents/.test(sql)) {
      failedOnce = true;
      throw new Error("injected deletion failure");
    }
  } });
  t.after(() => db.close());
  const owner = await contextFor(service, "delete-rollback");
  const { deck } = await installAndArchive(service, owner, library, "rollback");
  const preview = await service.previewDeckDeletion(owner, { deck_id: deck.id });
  const request = deckDeleteRequest(preview, "rollback:delete");
  const before = await service.getState(owner);
  injectFailure = true;
  await assert.rejects(service.deleteDeck(owner, request), code("DELETION_UNCONFIRMED"));
  assert.deepEqual(await service.getState(owner), before);
  assert.equal(db.database.prepare(
    "SELECT consumed_at FROM meshful_destructive_confirmations WHERE principal_id = ?",
  ).get(owner.principalId).consumed_at, null);

  injectFailure = false;
  const retried = await service.deleteDeck(owner, request);
  assert.equal(retried.result.deleted_deck_instance_id, deck.deck_instance_id);
  assert.equal(JSON.parse((await service.getState(owner)).state_json).personalDecks[deck.id], undefined);
});
