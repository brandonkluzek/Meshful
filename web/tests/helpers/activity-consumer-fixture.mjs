import { createMemoryStorage, createStudyStore } from "../../js/store.js";
import { createBrowserWorkspace } from "../../js/browser-workspace.js";

// Small disposable source fixtures only, never a user profile or model judgment.
export const KEY = "adaptive-study-lab:web-state:v1";
export const SEARCH = "?recording=activity-consumer-test";
export const CATALOG_OPTIONS = { catalog: [], seedExamples: false };
const NativeDate = Date;
export async function withClock(callback, at = "2026-08-31T16:00:00.000Z") {
  let wall = NativeDate.parse(at);
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [wall])); }
    static now() { return wall; }
  };
  try {
    await callback({ now: () => wall, set: (value) => { wall = NativeDate.parse(value); }, advance: (ms) => { wall += ms; } });
  } finally { globalThis.Date = NativeDate; }
}
export function fixture() {
  const storage = createMemoryStorage({ [KEY]: "normal-learner-state-untouched" });
  const scoped = createBrowserWorkspace(SEARCH, () => storage).storage;
  return { storage, scoped, store: createStudyStore({ catalog: [], storage: scoped }) };
}
export function seed(store, id = "activity", count = 2) {
  return store.ingestDeck({ operation: "create", idempotency_key: `seed:${id}`, deck: {
    schema_version: "normalized-definition-deck.v2", deck_id: id, title: `Activity ${id}`,
    cards: Array.from({ length: count }, (_, index) => ({ id: `term${index}`, term: `Activity term ${index}`,
      definition: `PRIVATE_DEFINITION ${index}`, criteria: [`PRIVATE_CRITERION ${index}`] })), edges: [],
  } });
}
export function start(store, id = "activity", limit = 1, key = id) {
  return store.startStudySession({ deck_id: id, limit, idempotency_key: `start:${key}` });
}
export function gradeInput(current, key = "activity") {
  return { session_id: current.session.session_id, expected_session_revision: current.session.session_revision,
    card_id: current.current_card.card_id, expected_card_revision: current.current_card.card_revision,
    answer_origin: "chat", answer_text: "PRIVATE_ANSWER injected mechanics fixture, not learner evidence.", rating: "good",
    rubric_evidence: current.current_card.required_concepts.map((item) => ({ rubric_item_id: item.rubric_item_id,
      status: "met", note: "PRIVATE_RUBRIC injected judgment." })),
    feedback: "PRIVATE_FEEDBACK injected mechanics fixture.", misconceptions: [], confidence: 1, idempotency_key: `grade:${key}` };
}
export function review(store, id = "activity", key = id) {
  const input = gradeInput(start(store, id, 1, key), key);
  return { input, receipt: store.submitGrade(input) };
}
export function rewrite(scoped, change) {
  const raw = JSON.parse(scoped.getItem(KEY));
  change(raw); raw.revision++;
  scoped.setItem(KEY, JSON.stringify(raw));
}
export async function wake(window, flush) {
  for (const fn of window.listeners.get("focus") ?? []) fn();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await flush();
}
