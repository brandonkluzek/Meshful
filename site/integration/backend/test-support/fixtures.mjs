export const FIXED_NOW = "2026-08-30T18:00:00.000Z";
export function fixtureIdentity(subject = "learner-a") {
  return { provider: "sites-chatgpt", issuer: "urn:meshful:sites:local-test", subject };
}
export async function contextFor(service, subject = "learner-a", scopes = ["learner:read", "learner:write"]) {
  const identity = fixtureIdentity(subject);
  const { principalId } = await service.provisionPrincipalForVerifiedIdentity(identity);
  return { principalId, identity, transport: "sites-browser", scopes };
}

// Original synthetic definitions only. This is not an admitted curriculum or
// grading gold set; the canonical engine supplies all scheduling semantics.
export function definitionCatalog() {
  return [{
    id: "backend-fixture", version: "1", title: "Persistence fixture", subject: "mathematics",
    level: "introductory", provenance: "backend_synthetic_fixture",
    cards: [{
      id: "set", term: "set", definition: "A collection of distinct objects, called elements.",
      required_concepts: ["a collection of distinct objects"],
      accepted_variants: ["a collection of elements"], major_error_concepts: ["an ordered list with repeated members"],
    }, {
      id: "subset", term: "subset", definition: "A set whose elements all belong to another specified set.",
      prerequisite_ids: ["set"], required_concepts: ["every element belongs to the other set"],
    }],
    edges: [{ prerequisite_card_id: "set", dependent_card_id: "subset" }],
  }];
}

export function gradeFor(started, requestId = "grade-1") {
  return {
    session_id: started.session.session_id, card_id: started.current_card.card_id,
    expected_card_revision: started.current_card.card_revision,
    expected_session_revision: started.session.session_revision,
    answer_text: "  A collection of distinct objects.\r\nElements can be α or β.  ",
    answer_origin: "chat", rating: "good",
    rubric_evidence: [{ rubric_item_id: started.current_card.required_concepts[0].rubric_item_id, status: "met", note: "Identifies a collection of distinct objects." }],
    feedback: "Correct: distinct objects are the elements.\nKeep the definition concise.",
    misconceptions: [], confidence: 0.9, idempotency_key: requestId,
  };
}

// For storage/auth tests only; deliberately contains NO scheduler or grader.
export function persistenceFixtureEngine() {
  const ref = { version: "fixture-only", digest: `sha256:${"0".repeat(64)}` };
  return {
    defaultCatalogRef: ref,
    validateCommand(operation, args, requestId) {
      if (operation !== "fixture_write" || args.idempotency_key !== requestId) {
        throw Object.assign(new Error("Bad test command"), { code: "INVALID_TOOL_INPUT" });
      }
    },
    async transition(record, { args, requestId, now }) {
      const state = record.stateJson ? JSON.parse(record.stateJson) : { entries: [] };
      state.entries.push(args.value);
      return {
        stateJson: JSON.stringify(state), catalogRef: ref,
        result: { value: args.value, receipt: { idempotency_key: requestId, replayed: false, committed_at: now } },
        events: [{ eventId: requestId, deckId: "fixture", cardId: "fixture", payloadJson: JSON.stringify({ value: args.value }) }],
      };
    },
    async query(record) { return record.stateJson ? JSON.parse(record.stateJson) : { entries: [] }; },
    async importLocal(rawJson) {
      JSON.parse(rawJson);
      return { stateJson: rawJson, catalogRef: ref, events: [], result: { imported: true } };
    },
  };
}
