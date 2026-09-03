import {
  BackendError, assertJson, byteLength, catalogRef, clone, exactKeys, identity,
  requireThat, revision, sha256, stableJson, text,
} from "./contracts.mjs";

// Below D1's per-row limit, including metadata. This bounded aggregate is the
// first adapter, not a claim of unbounded per-learner storage.
export const MAX_STATE_BYTES = 1_000_000;
export const MAX_COMMAND_BYTES = 200_000;

export function createLearnerService({ repository, engine, clock = () => new Date() }) {
  requireThat(repository && engine, "SERVICE_UNAVAILABLE", "Repository and canonical engine are required", 503);

  function now() {
    const at = new Date(clock());
    requireThat(Number.isFinite(at.valueOf()), "CLOCK_UNAVAILABLE", "Server clock is invalid", 503);
    return at.toISOString();
  }

  async function authorize(context, scope) {
    requireThat(context && typeof context.principalId === "string", "UNAUTHENTICATED", "Sign in is required", 401);
    identity(context.identity);
    requireThat(["sites-browser", "remote-mcp"].includes(context.transport),
      "FORBIDDEN", "Unsupported authenticated transport", 403);
    requireThat(Array.isArray(context.scopes) && context.scopes.includes(scope),
      "FORBIDDEN", "The authenticated context lacks the required scope", 403);
    const binding = await repository.findPrincipalByIdentity(context.identity);
    requireThat(binding?.principalId === context.principalId,
      "FORBIDDEN", "The authenticated identity is not bound to this principal", 403);
    return context.principalId;
  }

  async function stateFor(principalId) {
    const record = await repository.getState(principalId);
    requireThat(record, "PRINCIPAL_UNAVAILABLE", "The principal has no initialized storage", 403);
    return record;
  }

  function boundedState(value) {
    requireThat(typeof value === "string" && byteLength(value) <= MAX_STATE_BYTES,
      "STATE_TOO_LARGE", "State exceeds this rollout's limit; export and preserve it before continuing", 413);
  }

  function responseFor(transition, durableRevision) {
    return {
      schema_version: 1, durable_revision: durableRevision,
      catalog_ref: transition.catalogRef, result: transition.result,
    };
  }

  async function replay(principalId, requestId, fingerprint) {
    const previous = await repository.getReceipt(principalId, requestId);
    if (!previous) return null;
    requireThat(previous.fingerprint === fingerprint, "IDEMPOTENCY_CONFLICT",
      "request_id was already committed with different input", 409);
    const response = JSON.parse(previous.responseJson);
    // Everything else, including exact learner text and schedules, is original.
    response.result.receipt.replayed = true;
    return response;
  }

  async function commit(principalId, input, fingerprint, transition, importArchive) {
    boundedState(transition.stateJson);
    catalogRef(transition.catalogRef);
    const response = responseFor(transition, input.expected_revision + 1);
    const responseJson = JSON.stringify(response);
    requireThat(byteLength(responseJson) <= MAX_STATE_BYTES,
      "RESULT_TOO_LARGE", "The commit receipt exceeds this rollout's limit", 413);
    requireThat((transition.events ?? []).length <= 1, "ENGINE_INVARIANT",
      "This slice permits at most one immutable review event per commit", 503);
    for (const event of transition.events ?? []) boundedState(event.payloadJson);
    let outcome;
    try {
      outcome = await repository.commit({
        principalId, expectedRevision: input.expected_revision,
        requestId: input.request_id, fingerprint,
        stateJson: transition.stateJson, catalogRef: transition.catalogRef,
        responseJson, events: transition.events ?? [], importArchive, now: now(),
      });
    } catch (error) {
      // Handles both racing identical requests and a committed batch whose
      // acknowledgement was lost. A DB error itself is never exposed to clients.
      const recovered = await replay(principalId, input.request_id, fingerprint);
      if (recovered) return recovered;
      if (error?.code === "LOCAL_SOURCE_ALREADY_CLAIMED") {
        throw new BackendError("LOCAL_SOURCE_ALREADY_CLAIMED", "This local source is already claimed; preserve the original account binding", 409);
      }
      if (importArchive && await repository.getImportArchive(principalId, importArchive.sourceId)) {
        throw new BackendError("LOCAL_SOURCE_ALREADY_CLAIMED", "This local source is already preserved; use its receipt", 409);
      }
      throw new BackendError("COMMIT_UNCONFIRMED",
        "No commit was confirmed. Preserve and retry the identical request_id and payload.", 503);
    }
    if (!outcome.committed) {
      const recovered = await replay(principalId, input.request_id, fingerprint);
      if (recovered) return recovered;
      throw new BackendError("STALE_DURABLE_REVISION",
        "Another write changed this learner's state; reload before making a new action", 409);
    }
    return response;
  }

  function commandInput(input) {
    exactKeys(input, ["request_id", "expected_revision", "operation", "args"]);
    text(input.request_id, "request_id");
    revision(input.expected_revision);
    text(input.operation, "operation", 64);
    assertJson(input.args);
    requireThat(byteLength(JSON.stringify(input.args)) <= MAX_COMMAND_BYTES,
      "INPUT_TOO_LARGE", "Command exceeds this rollout's input limit", 413);
    engine.validateCommand(input.operation, input.args, input.request_id);
  }

  return Object.freeze({
    // Server-only hooks for Accounts. They are intentionally absent from HTTP.
    async findPrincipalByIdentity(verifiedIdentity) {
      return repository.findPrincipalByIdentity(clone(identity(verifiedIdentity)));
    },
    async provisionPrincipalForVerifiedIdentity(verifiedIdentity) {
      return repository.provisionPrincipalForVerifiedIdentity(clone(identity(verifiedIdentity)));
    },
    async getState(context) {
      const principalId = await authorize(context, "learner:read");
      const record = await stateFor(principalId);
      return {
        schema_version: 1, account_binding: principalId,
        durable_revision: record.revision, catalog_ref: record.catalogRef,
        state: record.stateJson ? JSON.parse(record.stateJson) : null,
        // Exact bytes remain available for recovery even if a catalog is absent.
        state_json: record.stateJson,
      };
    },
    async query(context, input) {
      const principalId = await authorize(context, "learner:read");
      exactKeys(input, ["operation", "args"]);
      text(input.operation, "operation", 64);
      assertJson(input.args);
      requireThat(byteLength(JSON.stringify(input.args)) <= MAX_COMMAND_BYTES,
        "INPUT_TOO_LARGE", "Query exceeds this rollout's input limit", 413);
      const record = await stateFor(principalId);
      return {
        schema_version: 1, durable_revision: record.revision,
        result: await engine.query(record, { ...input, now: now() }),
      };
    },
    async command(context, rawInput) {
      const principalId = await authorize(context, "learner:write");
      commandInput(rawInput);
      const input = clone(rawInput);
      const fingerprint = await sha256(stableJson({ contract: "meshful-command-v1", ...input }));
      const recovered = await replay(principalId, input.request_id, fingerprint);
      if (recovered) return recovered; // Before revision/session/card checks.
      const record = await stateFor(principalId);
      requireThat(record.revision === input.expected_revision, "STALE_DURABLE_REVISION",
        "Reload this learner's state before making a new action", 409);
      const transition = await engine.transition(record, {
        operation: input.operation, args: input.args, requestId: input.request_id, now: now(),
      });
      return commit(principalId, input, fingerprint, transition);
    },
    async claimLocalState(context, rawInput) {
      const principalId = await authorize(context, "learner:write");
      exactKeys(rawInput, ["request_id", "expected_revision", "source_id", "catalog_ref", "raw_state_json"]);
      text(rawInput.request_id, "request_id");
      revision(rawInput.expected_revision);
      text(rawInput.source_id, "source_id", 128);
      catalogRef(rawInput.catalog_ref);
      boundedState(rawInput.raw_state_json);
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
      transition.result = {
        ...transition.result, source_id: input.source_id, source_digest: digest,
        receipt: {
          transaction_id: `local-claim:${input.request_id}`, operation: "claim_local_state",
          idempotency_key: input.request_id, replayed: false, committed_at: now(),
        },
      };
      return commit(principalId, input, fingerprint, transition, {
        sourceId: input.source_id, digest, rawJson: input.raw_state_json,
      });
    },
    async getReceipt(context, requestId) {
      const principalId = await authorize(context, "learner:read");
      text(requestId, "request_id");
      const receipt = await repository.getReceipt(principalId, requestId);
      requireThat(receipt, "NOT_FOUND", "Receipt not found", 404);
      const response = JSON.parse(receipt.responseJson);
      response.result.receipt.replayed = true;
      return response;
    },
    async listReviews(context, { afterRevision = 0, limit = 100 } = {}) {
      const principalId = await authorize(context, "learner:read");
      revision(afterRevision, "after_revision");
      requireThat(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "INVALID_INPUT", "limit must be 1..100");
      const events = await repository.listReviewEvents(principalId, { afterRevision, limit });
      return {
        events, next_after_revision: events.at(-1)?.revision ?? afterRevision,
        legacy_history: "Imported prior reviews remain in state and the exact import archive; this stream records new durable grades.",
      };
    },
    async getImportArchive(context, sourceId) {
      const principalId = await authorize(context, "learner:read");
      text(sourceId, "source_id");
      const archive = await repository.getImportArchive(principalId, sourceId);
      requireThat(archive, "NOT_FOUND", "Import archive not found", 404);
      return archive;
    },
  });
}
