import { BackendError, object } from "./contracts.mjs";

// Checks reference integrity and value shapes before a one-time local claim.
// It does not assess answer correctness or compute scheduling/eligibility.
export function validateLocalSnapshot(snapshot, store) {
  const ensure = (ok) => {
    if (!ok) throw new BackendError("INVALID_LOCAL_STATE",
      "Local state is incomplete or inconsistent; preserve it for recovery instead of claiming it");
  };
  const record = (value) => {
    try { object(value); } catch { ensure(false); }
  };
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  const date = (value) => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
  const stringList = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
  try {
    ensure(count(snapshot.revision) && date(snapshot.updatedAt));
    ensure(Array.isArray(snapshot.activity) && Array.isArray(snapshot.actionReceiptOrder));
    record(snapshot.streak); record(snapshot.view);
    ensure(count(snapshot.streak.current) && count(snapshot.streak.longest));
    ensure(snapshot.streak.lastActivityDate === null || typeof snapshot.streak.lastActivityDate === "string");
    ensure(["study", "decks", "library", "graph", "session"].includes(snapshot.view.route));
    ensure(snapshot.view.selectedDeckId === null || Object.hasOwn(snapshot.personalDecks, snapshot.view.selectedDeckId));
    for (const [deckId, deck] of Object.entries(snapshot.personalDecks)) {
      record(deck);
      ensure(deck.id === deckId && typeof deck.title === "string" && count(deck.revision) && deck.revision > 0);
      record(deck.cards);
      ensure(stringList(deck.cardOrder) && new Set(deck.cardOrder).size === deck.cardOrder.length);
      ensure(deck.cardOrder.every((id) => Object.hasOwn(deck.cards, id)));
      ensure(Object.keys(deck.cards).every((id) => deck.cardOrder.includes(id)));
      ensure(Array.isArray(deck.edges));
      for (const edge of deck.edges) {
        record(edge);
        ensure(Object.hasOwn(deck.cards, edge.prerequisiteCardId) && Object.hasOwn(deck.cards, edge.dependentCardId));
      }
      for (const [cardId, card] of Object.entries(deck.cards)) {
        record(card);
        ensure(card.id === cardId && typeof card.term === "string" && typeof card.definition === "string");
        ensure(card.contentRevision === undefined || (count(card.contentRevision) && card.contentRevision > 0));
        for (const field of ["aliases", "acceptedPoints", "acceptedVariants", "confusions", "tags", "sourceRefs", "prerequisiteIds", "moduleIds"]) {
          ensure(stringList(card[field]));
        }
        for (const field of ["requiredConcepts", "majorErrorConcepts", "misconceptions"]) ensure(Array.isArray(card[field]));
        ensure(card.reviewHistory === undefined || Array.isArray(card.reviewHistory));
        record(card.review);
        ensure(count(card.review.repetitions) && count(card.review.lapses));
        for (const field of ["stabilityDays", "difficulty", "intervalDays"]) {
          const newCardNull = card.review.repetitions === 0 && field !== "intervalDays" && card.review[field] === null;
          ensure(newCardNull || (typeof card.review[field] === "number" && Number.isFinite(card.review[field]) && card.review[field] >= 0));
        }
        ensure(date(card.review.dueAt) && date(card.review.lastReviewedAt));
      }
    }
    let activeCount = 0;
    for (const [sessionId, session] of Object.entries(snapshot.sessions)) {
      record(session);
      ensure(session.id === sessionId && Object.hasOwn(snapshot.personalDecks, session.deckId));
      const deck = snapshot.personalDecks[session.deckId];
      ensure(count(session.revision) && session.revision > 0 && count(session.reviewsApplied));
      ensure(stringList(session.queue) && session.queue.every((id) => Object.hasOwn(deck.cards, id)));
      ensure(count(session.cursor) && session.cursor <= session.queue.length && Array.isArray(session.history));
      ensure(session.currentCardId === null || Object.hasOwn(deck.cards, session.currentCardId));
      ensure(["active", "paused", "completed", "finished", "abandoned"].includes(session.status));
      if (session.status === "active") { activeCount++; ensure(snapshot.activeSessionId === sessionId); }
      if (["active", "paused"].includes(session.status) && session.phase === "awaiting_answer") {
        ensure(session.currentCardId === session.queue[session.cursor]);
      }
    }
    ensure(activeCount <= 1);
    ensure(snapshot.activeSessionId === null ||
      (Object.hasOwn(snapshot.sessions, snapshot.activeSessionId) && snapshot.sessions[snapshot.activeSessionId].status === "active"));
    ensure(snapshot.actionReceiptOrder.every((id) => typeof id === "string" && Object.hasOwn(snapshot.actionReceipts, id)));
    // Exercise canonical readers, including their progress/graph traversals.
    // Any importer success must at least leave usable canonical product views.
    store.getLearningOverview();
    store.searchMyDecks({ status: "all" });
    for (const deckId of Object.keys(snapshot.personalDecks)) store.getDeck({ scope: "personal", deck_id: deckId });
    for (const sessionId of Object.keys(snapshot.sessions)) store.getStudySession({ session_id: sessionId });
  } catch (error) {
    if (error?.code === "INVALID_LOCAL_STATE") throw error;
    throw new BackendError("INVALID_LOCAL_STATE",
      "Local state failed canonical consistency checks; preserve the original bytes for recovery");
  }
}
