import {
  BackendError, assertJson, byteLength, catalogRef, clone, exactKeys, identity,
  requireThat, revision, sha256, stableJson, text,
} from "../../src/contracts.mjs";
import { encodeDocument } from "../../v2/src/fragment-codec.mjs";
import { requestIdentity } from "../../v2/src/request-identity.mjs";
import { assertJsonTextBudget } from "../../v2/src/json-budget.mjs";

const STUDY_WRITE_OPERATIONS = new Set([
  "start_study_session",
  "submit_grade",
  "submit_non_answer_grade",
  "submit_self_grade",
  "finish_study_session",
]);
const DELETION_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export function createLearnerService({ repository, engine, clock = () => new Date() }) {
  requireThat(repository && engine?.capacity, "SERVICE_UNAVAILABLE", "Repository and capacity-qualified canonical adapter are required", 503);
  const capacity = engine.capacity;
  function now() {
    const at = new Date(clock());
    requireThat(Number.isFinite(at.valueOf()), "CLOCK_UNAVAILABLE", "Server clock is invalid", 503);
    return at.toISOString();
  }
  async function authorize(context, scope) {
    requireThat(context && typeof context.principalId === "string", "UNAUTHENTICATED", "Sign in is required", 401);
    identity(context.identity);
    requireThat(["sites-browser", "remote-mcp"].includes(context.transport), "FORBIDDEN", "Unsupported authenticated transport", 403);
    requireThat(Array.isArray(context.scopes) && context.scopes.includes(scope), "FORBIDDEN", "The authenticated context lacks the required scope", 403);
    const binding = await repository.findPrincipalByIdentity(context.identity);
    requireThat(binding?.principalId === context.principalId, "FORBIDDEN", "The verified identity is not bound to this principal", 403);
    return context.principalId;
  }
  function boundedState(value) {
    requireThat(typeof value === "string" && byteLength(value) <= capacity.maxStateBytes,
      "STATE_TOO_LARGE", "The canonical working set exceeds this qualified profile. Preserve local drafts and use paged recovery; no partial write was made", 413);
    assertJsonTextBudget(value, { maxNodes: capacity.maxStateNodes });
  }
  async function stateFor(principalId) {
    const head = await repository.getRecoveryHead(principalId);
    requireThat(head, "PRINCIPAL_UNAVAILABLE", "The principal has no initialized storage", 403);
    if (head.document) requireThat(head.document.byteLength <= capacity.maxStateBytes,
      "STATE_TOO_LARGE", "Use paged recovery for this preserved state before selecting a larger qualified runtime", 413);
    else if (head.stateJson !== null && head.stateJson !== undefined) boundedState(head.stateJson);
    const record = await repository.getState(principalId);
    requireThat(record, "PRINCIPAL_UNAVAILABLE", "The principal has no initialized storage", 403);
    if (record.stateJson !== null) boundedState(record.stateJson);
    return record;
  }
  function boundedArgs(args) {
    assertJson(args, { maxNodes: capacity.maxCommandNodes });
    requireThat(byteLength(JSON.stringify(args)) <= capacity.maxCommandBytes,
      "INPUT_TOO_LARGE", "This command exceeds the native-authoring transport profile; preserve its original payload", 413);
  }
  async function replay(principalId, requestId, fingerprint) {
    const previous = await repository.getDestructiveReceipt?.(principalId, requestId)
      ?? await repository.getReceipt(principalId, requestId);
    if (!previous) return null;
    requireThat(previous.fingerprint === fingerprint, "IDEMPOTENCY_CONFLICT", "request_id was already committed with different input", 409);
    const response = JSON.parse(previous.responseJson);
    response.result.receipt.replayed = true;
    return response;
  }
  function confirmationToken() {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  function checkedConfirmationToken(value) {
    requireThat(typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
      "DELETION_CONFIRMATION_INVALID", "Review the current deletion impact and confirm it again", 409);
    return value;
  }
  async function deckDeletionBinding(principalId, expectedRevision, impact) {
    return sha256(stableJson({ contract: "meshful-deck-deletion-confirmation-v1",
      principal_id: principalId, expected_revision: expectedRevision, impact }));
  }
  async function deckDeletionImpact(principalId, record, deckId) {
    const impact = await engine.query(record, {
      operation: "get_deck_deletion_impact", args: { deck_id: deckId }, now: now(),
    });
    const stored = await repository.getDeletionStorageImpact(principalId);
    return {
      ...impact,
      saved_action_count: stored.savedActionCount,
      durable_review_event_count: stored.reviewEventCount,
      recovery_document_count: stored.recoveryDocumentCount,
      import_archive_count: stored.importArchiveCount,
      prior_account_recovery_copies_reset: true,
    };
  }
  async function accountDeletionImpact(principalId, record) {
    let personalDeckCount = 0;
    let sessionCount = 0;
    let retainedReviewCount = 0;
    if (record.stateJson !== null) {
      const state = assertJson(JSON.parse(record.stateJson), { maxNodes: capacity.maxStateNodes });
      const decks = state?.personalDecks && typeof state.personalDecks === "object"
        && !Array.isArray(state.personalDecks) ? Object.values(state.personalDecks) : [];
      personalDeckCount = decks.length;
      sessionCount = state?.sessions && typeof state.sessions === "object"
        && !Array.isArray(state.sessions) ? Object.keys(state.sessions).length : 0;
      retainedReviewCount = decks.reduce((total, deck) => total +
        Object.values(deck?.cards ?? {}).reduce((deckTotal, card) => deckTotal +
          (Array.isArray(card?.reviewHistory) ? card.reviewHistory.length : 0), 0), 0);
    }
    const stored = await repository.getDeletionStorageImpact(principalId);
    const reviewed = {
      account_binding: principalId,
      durable_revision: record.revision,
      personal_deck_count: personalDeckCount,
      session_count: sessionCount,
      retained_review_count: retainedReviewCount,
      durable_review_event_count: stored.reviewEventCount,
      recovery_document_count: stored.recoveryDocumentCount,
      import_archive_count: stored.importArchiveCount,
      saved_action_count: stored.savedActionCount,
      writer_receipt_count: stored.writerReceiptCount,
      prior_deletion_receipt_count: stored.deletionReceiptCount,
      browser_cleanup_required: true,
      immutable_library_preserved: true,
      sign_in_binding_retained: true,
    };
    return { ...reviewed, impact_digest: await sha256(stableJson(reviewed)) };
  }
  async function accountDeletionBinding(principalId, expectedRevision, impact) {
    return sha256(stableJson({ contract: "meshful-account-deletion-confirmation-v1",
      principal_id: principalId, expected_revision: expectedRevision, impact }));
  }
  async function createConfirmation(principalId, kind, expectedRevision, impact, bindingDigest) {
    const token = confirmationToken();
    const createdAt = now();
    const expiresAt = new Date(new Date(createdAt).valueOf() + DELETION_CONFIRMATION_TTL_MS).toISOString();
    await repository.createDestructiveConfirmation({
      principalId, tokenDigest: await sha256(token), kind, expectedRevision,
      bindingDigest, expiresAt, now: createdAt,
    });
    return { token, expires_at: expiresAt };
  }
  async function recoverDestructive(principalId, requestId, fingerprint, failureMessage) {
    const recovered = await replay(principalId, requestId, fingerprint);
    if (recovered) return recovered;
    throw new BackendError("DELETION_UNCONFIRMED", failureMessage, 503);
  }
  async function writerReplay(principalId, requestId, fingerprint) {
    const previous = await repository.getWriterReceipt(principalId, requestId);
    if (!previous) return null;
    requireThat(previous.fingerprint === fingerprint, "IDEMPOTENCY_CONFLICT",
      "request_id was already committed with different writer input", 409);
    const response = JSON.parse(previous.responseJson);
    response.receipt.replayed = true;
    return response;
  }
  async function checkedWriterGrant(principalId, value) {
    requireThat(value && typeof value === "object" && !Array.isArray(value),
      "WRITER_GRANT_REQUIRED", "Acquire the active study-writer grant before changing learner state", 409);
    exactKeys(value, ["writerEpoch", "token"], undefined, "writer_grant");
    revision(value.writerEpoch, "writer_epoch");
    requireThat(value.writerEpoch >= 1, "WRITER_GRANT_REQUIRED",
      "Acquire the active study-writer grant before changing learner state", 409);
    requireThat(typeof value.token === "string" && /^[a-f0-9]{64}$/.test(value.token),
      "WRITER_GRANT_REQUIRED", "A valid study-writer grant is required", 409);
    const grant = { writerEpoch: value.writerEpoch, tokenDigest: await sha256(value.token) };
    requireThat(await repository.isWriterGrantCurrent(principalId, grant), "WRITER_SUPERSEDED",
      "Another device owns study changes. Take over explicitly before continuing", 409);
    return grant;
  }
  async function commit(principalId, input, fingerprint, transition, baseRecord, importArchive,
    writerGrant) {
    boundedState(transition.stateJson);
    catalogRef(transition.catalogRef);
    const durableRevision = input.expected_revision + 1;
    const response = { schema_version: 1, durable_revision: durableRevision, catalog_ref: transition.catalogRef, result: transition.result };
    const responseJson = JSON.stringify(response);
    requireThat(byteLength(responseJson) <= capacity.maxResultBytes, "RESULT_TOO_LARGE", "The exact receipt exceeds the qualified response budget; no write was made", 413);
    requireThat((transition.events ?? []).length <= 1, "ENGINE_INVARIANT", "A command may append at most one immutable review", 503);
    const stateDocumentId = `state:${durableRevision}`;
    const responseDocumentId = `receipt:${input.request_id}`;
    // Preparation has no database effects. All fragments and their immutable
    // manifests enter the same conditional transaction as head and receipt.
    const documents = [await encodeDocument({ id: stateDocumentId, kind: "state", text: transition.stateJson })];
    documents.push(await encodeDocument({ id: responseDocumentId, kind: "receipt", text: responseJson }));
    const events = [];
    for (const event of transition.events ?? []) {
      boundedState(event.payloadJson);
      const documentId = `review:${event.eventId}`;
      documents.push(await encodeDocument({ id: documentId, kind: "review", text: event.payloadJson }));
      events.push({ eventId: event.eventId, deckId: event.deckId, cardId: event.cardId, documentId });
    }
    let archive;
    if (importArchive) {
      const documentId = `import:${importArchive.sourceId}`;
      documents.push(await encodeDocument({ id: documentId, kind: "import", text: importArchive.rawJson }));
      archive = { sourceId: importArchive.sourceId, digest: importArchive.digest, documentId };
    }
    let outcome;
    try {
      outcome = await repository.commit({ principalId, expectedRevision: input.expected_revision,
        requestId: input.request_id, fingerprint, catalogRef: transition.catalogRef,
        documents, stateDocumentId, responseDocumentId, baseRecord, events, importArchive: archive,
        writerGrant, now: now() });
    } catch (error) {
      if (error instanceof BackendError && error.code === "COMMIT_TOO_LARGE") throw error; // known pre-batch rejection
      if (writerGrant && !await repository.isWriterGrantCurrent(principalId, writerGrant)) {
        throw new BackendError("WRITER_SUPERSEDED",
          "Another device owns study changes. Preserve the draft and take over explicitly", 409);
      }
      const recovered = await replay(principalId, input.request_id, fingerprint);
      if (recovered) return recovered;
      if (error?.code === "LOCAL_SOURCE_ALREADY_CLAIMED") throw new BackendError("LOCAL_SOURCE_ALREADY_CLAIMED",
        "This source is already claimed; preserve its original account binding", 409);
      throw new BackendError("COMMIT_UNCONFIRMED", "No commit was confirmed. Preserve and retry the identical request_id and payload", 503);
    }
    if (!outcome.committed) {
      if (!outcome.writerAuthorized) throw new BackendError("WRITER_SUPERSEDED",
        "Another device owns study changes. Preserve the draft and take over explicitly", 409);
      const recovered = await replay(principalId, input.request_id, fingerprint);
      if (recovered) return recovered;
      throw new BackendError("STALE_DURABLE_REVISION", "Another write changed this learner's state; reload before a new action", 409);
    }
    return response;
  }

  return Object.freeze({
    capacity,
    async findPrincipalByIdentity(verifiedIdentity) {
      return repository.findPrincipalByIdentity(clone(identity(verifiedIdentity)));
    },
    async provisionPrincipalForVerifiedIdentity(verifiedIdentity) {
      return repository.provisionPrincipalForVerifiedIdentity(clone(identity(verifiedIdentity)));
    },
    async getState(context) {
      const principalId = await authorize(context, "learner:read");
      const record = await stateFor(principalId);
      return { schema_version: 2, snapshot_encoding: "canonical-json.v1", account_binding: principalId,
        durable_revision: record.revision, catalog_ref: record.catalogRef, state_json: record.stateJson };
    },
    async getWriterGrant(context) {
      const principalId = await authorize(context, "learner:read");
      const grant = await repository.getWriterGrant(principalId);
      return { schema_version: 1, account_binding: principalId,
        writer_epoch: grant.writerEpoch, active: grant.active };
    },
    async mutateWriterGrant(context, rawInput) {
      const principalId = await authorize(context, "learner:write");
      exactKeys(rawInput, ["request_id", "action", "expected_writer_epoch", "grant_token"]);
      requestIdentity(rawInput.request_id);
      requireThat(["acquire", "takeover", "release"].includes(rawInput.action),
        "INVALID_INPUT", "Writer action must be acquire, takeover, or release");
      revision(rawInput.expected_writer_epoch, "expected_writer_epoch");
      requireThat(typeof rawInput.grant_token === "string" && /^[a-f0-9]{64}$/.test(rawInput.grant_token),
        "INVALID_INPUT", "grant_token must contain 32 random bytes encoded as lowercase hex");
      const input = clone(rawInput);
      const fingerprint = await sha256(stableJson({ contract: "meshful-study-writer-grant-v1", ...input }));
      const replayed = await writerReplay(principalId, input.request_id, fingerprint);
      if (replayed) return replayed;
      const writerEpoch = input.expected_writer_epoch + 1;
      const response = { schema_version: 1, account_binding: principalId,
        writer_epoch: writerEpoch, active: input.action !== "release", action: input.action,
        receipt: { idempotency_key: input.request_id, replayed: false } };
      const outcome = await repository.mutateWriterGrant({
        principalId,
        requestId: input.request_id,
        action: input.action,
        expectedWriterEpoch: input.expected_writer_epoch,
        tokenDigest: await sha256(input.grant_token),
        fingerprint,
        responseJson: JSON.stringify(response),
        now: now(),
      });
      if (outcome.replay) return writerReplay(principalId, input.request_id, fingerprint);
      if (!outcome.committed) {
        if (outcome.writerEpoch !== input.expected_writer_epoch) {
          throw new BackendError("STALE_WRITER_EPOCH",
            "Another writer boundary changed. Reload writer status before continuing", 409);
        }
        throw new BackendError(input.action === "acquire" ? "WRITER_ALREADY_ACTIVE"
          : input.action === "takeover" ? "WRITER_NOT_ACTIVE" : "WRITER_SUPERSEDED",
        input.action === "acquire"
          ? "Another study writer is active. Take over explicitly to continue here"
          : input.action === "takeover"
            ? "No active writer remains. Acquire a new writer grant"
            : "This device no longer owns the active study-writer grant", 409);
      }
      return response;
    },
    async validateWriterGrant(context, rawWriterGrant) {
      const principalId = await authorize(context, "learner:write");
      let supplied;
      try { supplied = await checkedWriterGrant(principalId, rawWriterGrant); }
      catch (error) {
        if (error?.code !== "WRITER_SUPERSEDED") throw error;
        const current = await repository.getWriterGrant(principalId);
        return { schema_version: 1, account_binding: principalId, current: false,
          writer_epoch: current.writerEpoch, active: current.active };
      }
      return { schema_version: 1, account_binding: principalId, current: true,
        writer_epoch: supplied.writerEpoch, active: true };
    },
    async query(context, input) {
      const principalId = await authorize(context, "learner:read");
      exactKeys(input, ["operation", "args"]); text(input.operation, "operation", 64); boundedArgs(input.args);
      const record = await stateFor(principalId);
      const result = await engine.query(record, { ...input, now: now() });
      requireThat(byteLength(JSON.stringify(result)) <= capacity.maxResultBytes, "RESULT_TOO_LARGE",
        "The query exceeds the qualified response budget; preserved state is still available through recovery", 413);
      return { schema_version: 1, durable_revision: record.revision, result };
    },
    async previewDeckDeletion(context, rawInput) {
      const principalId = await authorize(context, "learner:write");
      exactKeys(rawInput, ["deck_id"]); text(rawInput.deck_id, "deck_id", 160);
      const record = await stateFor(principalId);
      const impact = await deckDeletionImpact(principalId, record, rawInput.deck_id);
      requireThat(impact.can_delete, impact.blocker ?? "DELETION_NOT_AVAILABLE",
        impact.blocker === "DECK_NOT_ARCHIVED"
          ? "Archive this deck before deleting it permanently"
          : "Pause or finish its active study session before deleting this deck", 409);
      const bindingDigest = await deckDeletionBinding(principalId, record.revision, impact);
      const confirmation = await createConfirmation(principalId, "deck", record.revision,
        impact, bindingDigest);
      return { schema_version: 1, account_binding: principalId,
        durable_revision: record.revision, impact, confirmation };
    },
    async deleteDeck(context, rawInput) {
      const principalId = await authorize(context, "learner:write");
      exactKeys(rawInput, ["request_id", "expected_revision", "args", "confirmation_token"]);
      requestIdentity(rawInput.request_id); revision(rawInput.expected_revision);
      checkedConfirmationToken(rawInput.confirmation_token); boundedArgs(rawInput.args);
      const args = clone(rawInput.args);
      engine.validateCommand("delete_deck", args, rawInput.request_id);
      const tokenDigest = await sha256(rawInput.confirmation_token);
      const fingerprint = await sha256(stableJson({
        contract: "meshful-deck-deletion-v1", request_id: rawInput.request_id,
        expected_revision: rawInput.expected_revision, args, token_digest: tokenDigest,
      }));
      const recovered = await replay(principalId, rawInput.request_id, fingerprint);
      if (recovered) return recovered;
      const record = await stateFor(principalId);
      requireThat(record.revision === rawInput.expected_revision, "STALE_DURABLE_REVISION",
        "Learner data changed after deletion was reviewed; review it again", 409);
      const impact = await deckDeletionImpact(principalId, record, args.deck_id);
      requireThat(impact.can_delete, impact.blocker ?? "DELETION_NOT_AVAILABLE",
        impact.blocker === "DECK_NOT_ARCHIVED"
          ? "Archive this deck before deleting it permanently"
          : "Pause or finish its active study session before deleting this deck", 409);
      requireThat(impact.deck_instance_id === args.deck_instance_id
        && impact.deck_revision === args.expected_revision
        && impact.app_revision === args.expected_app_revision
        && impact.impact_digest === args.expected_impact_digest,
      "DELETION_IMPACT_CHANGED", "The deck deletion impact changed; review it again", 409);
      const bindingDigest = await deckDeletionBinding(principalId, record.revision, impact);
      const transition = await engine.transition(record, {
        operation: "delete_deck", args, requestId: rawInput.request_id, now: now(),
      });
      boundedState(transition.stateJson); catalogRef(transition.catalogRef);
      requireThat(!transition.stateJson.includes(args.deck_instance_id), "ENGINE_INVARIANT",
        "The deleted deck instance remained in the replacement state", 503);
      const durableRevision = rawInput.expected_revision + 1;
      const response = { schema_version: 1, durable_revision: durableRevision,
        catalog_ref: transition.catalogRef, result: transition.result };
      const responseJson = JSON.stringify(response);
      requireThat(byteLength(responseJson) <= capacity.maxResultBytes, "RESULT_TOO_LARGE",
        "The deletion receipt exceeds the qualified response budget; no write was made", 413);
      const stateDocumentId = `state:${durableRevision}`;
      const responseDocumentId = `receipt:${rawInput.request_id}`;
      const documents = [
        await encodeDocument({ id: stateDocumentId, kind: "state", text: transition.stateJson }),
        await encodeDocument({ id: responseDocumentId, kind: "receipt", text: responseJson }),
      ];
      let outcome;
      try {
        outcome = await repository.destructiveDeckCommit({
          principalId, expectedRevision: rawInput.expected_revision,
          requestId: rawInput.request_id, fingerprint, tokenDigest, bindingDigest,
          instanceDigest: await sha256(stableJson({ principal_id: principalId,
            deck_instance_id: args.deck_instance_id })),
          catalogRef: transition.catalogRef, documents, stateDocumentId, responseDocumentId,
          responseJson, now: now(),
        });
      } catch (error) {
        if (error instanceof BackendError && error.code === "COMMIT_TOO_LARGE") throw error;
        return recoverDestructive(principalId, rawInput.request_id, fingerprint,
          "Deck deletion was not confirmed. Retry the exact request; do not create a new target");
      }
      if (!outcome.committed) {
        const replayed = await replay(principalId, rawInput.request_id, fingerprint);
        if (replayed) return replayed;
        const current = await repository.getState(principalId);
        requireThat(current?.revision === rawInput.expected_revision,
          "STALE_DURABLE_REVISION", "Learner data changed after deletion was reviewed; review it again", 409);
        throw new BackendError("DELETION_CONFIRMATION_INVALID",
          "The one-use deletion confirmation is invalid or expired; review it again", 409);
      }
      return response;
    },
    async previewAccountDeletion(context, rawInput) {
      const principalId = await authorize(context, "learner:write");
      exactKeys(rawInput, []);
      const record = await stateFor(principalId);
      const impact = await accountDeletionImpact(principalId, record);
      const bindingDigest = await accountDeletionBinding(principalId, record.revision, impact);
      const confirmation = await createConfirmation(principalId, "account", record.revision,
        impact, bindingDigest);
      return { schema_version: 1, account_binding: principalId,
        durable_revision: record.revision, impact, confirmation };
    },
    async deleteAccountData(context, rawInput) {
      const principalId = await authorize(context, "learner:write");
      exactKeys(rawInput, ["request_id", "expected_revision", "expected_impact_digest",
        "confirmation_token", "confirm_permanent_deletion", "idempotency_key"]);
      requestIdentity(rawInput.request_id); revision(rawInput.expected_revision);
      requireThat(rawInput.idempotency_key === rawInput.request_id, "REQUEST_ID_MISMATCH",
        "request_id must equal the account deletion idempotency key");
      checkedConfirmationToken(rawInput.confirmation_token);
      requireThat(rawInput.confirm_permanent_deletion === true, "DELETION_CONFIRMATION_REQUIRED",
        "Confirm permanent account-data deletion after reviewing its exact impact", 409);
      const tokenDigest = await sha256(rawInput.confirmation_token);
      const fingerprint = await sha256(stableJson({ contract: "meshful-account-deletion-v1",
        request_id: rawInput.request_id, expected_revision: rawInput.expected_revision,
        expected_impact_digest: rawInput.expected_impact_digest,
        confirm_permanent_deletion: true, token_digest: tokenDigest }));
      const recovered = await replay(principalId, rawInput.request_id, fingerprint);
      if (recovered) return recovered;
      const record = await stateFor(principalId);
      requireThat(record.revision === rawInput.expected_revision, "STALE_DURABLE_REVISION",
        "Learner data changed after deletion was reviewed; review it again", 409);
      const impact = await accountDeletionImpact(principalId, record);
      requireThat(impact.impact_digest === rawInput.expected_impact_digest,
        "DELETION_IMPACT_CHANGED", "The account deletion impact changed; review it again", 409);
      const bindingDigest = await accountDeletionBinding(principalId, record.revision, impact);
      const committedAt = now();
      const durableRevision = rawInput.expected_revision + 1;
      const response = {
        schema_version: 1,
        durable_revision: durableRevision,
        catalog_ref: null,
        result: {
          account_binding: principalId,
          deleted: {
            personal_deck_count: impact.personal_deck_count,
            session_count: impact.session_count,
            retained_review_count: impact.retained_review_count,
            durable_review_event_count: impact.durable_review_event_count,
            recovery_document_count: impact.recovery_document_count,
            import_archive_count: impact.import_archive_count,
            saved_action_count: impact.saved_action_count,
          },
          retained: { sign_in_binding: true, immutable_library_catalog: true,
            content_free_retry_receipt: true },
          browser_cleanup_required: true,
          receipt: { transaction_id: `durable-account-deletion:${rawInput.request_id}`,
            operation: "delete_my_data", idempotency_key: rawInput.request_id,
            replayed: false, committed_at: committedAt },
        },
      };
      const responseJson = JSON.stringify(response);
      let outcome;
      try {
        outcome = await repository.deleteAccountData({ principalId,
          expectedRevision: rawInput.expected_revision, requestId: rawInput.request_id,
          fingerprint, tokenDigest, bindingDigest, responseJson, now: committedAt });
      } catch {
        return recoverDestructive(principalId, rawInput.request_id, fingerprint,
          "Account-data deletion was not confirmed. Retry the exact request");
      }
      if (!outcome.committed) {
        const replayed = await replay(principalId, rawInput.request_id, fingerprint);
        if (replayed) return replayed;
        const current = await repository.getState(principalId);
        requireThat(current?.revision === rawInput.expected_revision,
          "STALE_DURABLE_REVISION", "Learner data changed after deletion was reviewed; review it again", 409);
        throw new BackendError("DELETION_CONFIRMATION_INVALID",
          "The one-use deletion confirmation is invalid or expired; review it again", 409);
      }
      return response;
    },
    async command(context, rawInput, rawWriterGrant) {
      const principalId = await authorize(context, "learner:write");
      exactKeys(rawInput, ["request_id", "expected_revision", "operation", "args"]);
      requestIdentity(rawInput.request_id); revision(rawInput.expected_revision); text(rawInput.operation, "operation", 64);
      boundedArgs(rawInput.args);
      const input = clone(rawInput);
      requireThat(input.operation !== "delete_deck", "OPERATION_NOT_ALLOWED",
        "Deck deletion requires its reviewed one-use confirmation endpoint", 409);
      // The grant fences only the long-lived Study state machine. Independent
      // account commands still use the global durable revision plus their exact
      // deck/action revisions, and never inspect or disturb the Study writer.
      const writerGrant = STUDY_WRITE_OPERATIONS.has(input.operation)
        ? await checkedWriterGrant(principalId, rawWriterGrant)
        : null;
      // Preserve v1's strong entire-envelope fingerprint across storage upgrade.
      const fingerprint = await sha256(stableJson({ contract: "meshful-command-v1", ...input }));
      // A committed exact envelope is authoritative even if a later shared-core
      // release tightens its input schema. Receipt recovery must not touch state,
      // the catalog resolver, or the current canonical validator.
      const recovered = await replay(principalId, input.request_id, fingerprint);
      if (recovered) return recovered;
      engine.validateCommand(input.operation, input.args, input.request_id);
      const record = await stateFor(principalId);
      requireThat(record.revision === input.expected_revision, "STALE_DURABLE_REVISION", "Reload this learner's state before a new action", 409);
      const transition = await engine.transition(record, { operation: input.operation, args: input.args, requestId: input.request_id, now: now() });
      return commit(principalId, input, fingerprint, transition, record, undefined, writerGrant);
    },
    async claimLocalState(context, rawInput, rawWriterGrant) {
      const principalId = await authorize(context, "learner:write");
      const writerGrant = await checkedWriterGrant(principalId, rawWriterGrant);
      exactKeys(rawInput, ["request_id", "expected_revision", "source_id", "catalog_ref", "raw_state_json"]);
      requestIdentity(rawInput.request_id); revision(rawInput.expected_revision); requestIdentity(rawInput.source_id, "source_id");
      catalogRef(rawInput.catalog_ref); boundedState(rawInput.raw_state_json);
      const input = clone(rawInput);
      const fingerprint = await sha256(stableJson({ contract: "meshful-local-claim-v1", ...input }));
      const recovered = await replay(principalId, input.request_id, fingerprint);
      if (recovered) return recovered;
      const record = await stateFor(principalId);
      requireThat(record.revision === input.expected_revision, "STALE_DURABLE_REVISION", "Reload before claiming local state", 409);
      requireThat(record.revision === 0 && record.stateJson === null, "LOCAL_STATE_CONFLICT",
        "Durable state already exists. Preserve both copies; automatic merging is disabled", 409);
      const digest = await sha256(input.raw_state_json);
      let transition;
      try { transition = await engine.importLocal(input.raw_state_json, input.catalog_ref, { now: now() }); }
      catch (error) {
        if (error instanceof SyntaxError) throw new BackendError("INVALID_LOCAL_STATE", "Local state is not valid JSON");
        throw error;
      }
      transition.result = { ...transition.result, source_id: input.source_id, source_digest: digest, receipt: {
        transaction_id: `local-claim:${input.request_id}`, operation: "claim_local_state", idempotency_key: input.request_id,
        replayed: false, committed_at: now(),
      } };
      return commit(principalId, input, fingerprint, transition, record,
        { sourceId: input.source_id, digest, rawJson: input.raw_state_json }, writerGrant);
    },
    async getReceipt(context, requestId) {
      const principalId = await authorize(context, "learner:read"); requestIdentity(requestId);
      const receipt = await repository.getDestructiveReceipt?.(principalId, requestId)
        ?? await repository.getReceipt(principalId, requestId);
      requireThat(receipt, "NOT_FOUND", "Receipt not found", 404);
      const response = JSON.parse(receipt.responseJson); response.result.receipt.replayed = true; return response;
    },
    async listReviews(context, { afterRevision = 0, limit = 100 } = {}) {
      const principalId = await authorize(context, "learner:read"); revision(afterRevision, "after_revision");
      requireThat(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "INVALID_INPUT", "limit must be 1..100");
      const events = await repository.listReviewEvents(principalId, { afterRevision, limit });
      return { events, next_after_revision: events.at(-1)?.revision ?? afterRevision,
        legacy_history: "Imported reviews remain in exact state and import backups; this stream contains durable grade sidecars." };
    },
    async getImportArchive(context, sourceId) {
      const principalId = await authorize(context, "learner:read"); requestIdentity(sourceId, "source_id");
      const archive = await repository.getImportArchive(principalId, sourceId);
      requireThat(archive, "NOT_FOUND", "Import archive not found", 404); return archive;
    },
    // Recovery never invokes the catalog or canonical scheduler. Each page is
    // pinned to the same immutable document and original authenticated owner.
    async getRecoveryHead(context) {
      const principalId = await authorize(context, "learner:read");
      const head = await repository.getRecoveryHead(principalId);
      requireThat(head, "NOT_FOUND", "Learner state not found", 404);
      return { account_binding: principalId, ...head, capacity };
    },
    async getDocumentParts(context, documentId, { afterPart = -1, limit = 16 } = {}) {
      const principalId = await authorize(context, "learner:read"); text(documentId, "document_id", 300);
      requireThat(Number.isSafeInteger(afterPart) && afterPart >= -1 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 16,
        "INVALID_INPUT", "Recovery page requires after_part >= -1 and limit 1..16");
      const page = await repository.getDocumentParts(principalId, documentId, { afterPart, limit });
      requireThat(page, "NOT_FOUND", "Recovery document not found", 404);
      return { account_binding: principalId, ...page };
    },
  });
}
