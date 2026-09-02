// Original synthetic capacity fixtures; no private Library content or scheduler.
// The maximum create witness was first ingested/reloaded with canonical store
// cbfc6e0e9fedd8f021446bdc4e4c568cacd1122f3bc2e7fc24c18695c5e80ca9
// and WebMCP d051c349dafc304ec34e86616505c29b14d14cf1f1a15e0fb3f131e98377e846.
// Earlier history-growth measurements used store f51d9822a0097a74f7c41551e502b8157de6c494d5e0d206e19e01884e958f42.
// These are measurement provenance, not imports or qualification of an evolving
// successor engine. Record the actual source hashes when running new receipts.

export const MAX_NATIVE_V2_CREATE_ARGS_UTF8_BYTES = 4_523_091;
export const MAX_NATIVE_V2_CREATE_ARGS_NODES = 1_909;
export const MAX_NATIVE_V2_CREATE_ARGS_SHA256 = "9cc8ca276cafb44307eaa1d2720fe8e2c90f95481bd3f7a85d337c79221482ef";
export const NATIVE_V2_REGRESSION_ARGS_UTF8_BYTES = 205_026;

// This exact default reproduces the original witness digest. NUL is permitted
// by the canonical idempotency-key schema, but SQLite length(TEXT) stops at NUL.
// A storage qualification must handle that difference explicitly. Supplying
// String.fromCharCode(1).repeat(128) retains the byte maximum without NUL.
export const MAX_NATIVE_V2_DEFAULT_IDEMPOTENCY_KEY = String.fromCharCode(0).repeat(128);

const CONTROL_CODES = [0, 1, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];

// Every selected code unit has a six-byte JSON escape and survives trim().
// The first two code units distinguish terms, criteria, and tags without
// sacrificing maximum encoded length or the schema's uniqueness requirements.
function escapedText(length, index = 0) {
  return String.fromCharCode(
    CONTROL_CODES[Math.floor(index / CONTROL_CODES.length) % CONTROL_CODES.length],
    CONTROL_CODES[index % CONTROL_CODES.length],
  ) + String.fromCharCode(0).repeat(length - 2);
}

function localCardId(index) {
  return `c${String(index).padStart(3, "0")}${"x".repeat(124)}`;
}

export function makeMaxNativeV2Args({
  operation = "create",
  idempotencyKey = MAX_NATIVE_V2_DEFAULT_IDEMPOTENCY_KEY,
  deckId = "d".repeat(128),
  targetDeckId = deckId,
  expectedDeckRevision = 1,
} = {}) {
  if (!["create", "replace"].includes(operation)) throw new TypeError("Unsupported fixture operation");
  const deck = {
    schema_version: "normalized-definition-deck.v2",
    deck_id: deckId,
    title: escapedText(200),
    cards: Array.from({ length: 50 }, (_, index) => ({
      id: localCardId(index),
      term: escapedText(300, index),
      definition: escapedText(8_000),
      criteria: Array.from({ length: 12 }, (_, criterion) => escapedText(500, criterion)),
      tags: Array.from({ length: 5 }, (_, tag) => escapedText(100, tag)),
    })),
    edges: [],
  };
  for (let from = 0; from < 50 && deck.edges.length < 250; from++) {
    for (let to = from + 1; to < 50 && deck.edges.length < 250; to++) {
      deck.edges.push({ from: localCardId(from), to: localCardId(to) });
    }
  }
  return operation === "create"
    ? { operation, deck, idempotency_key: idempotencyKey }
    : { operation, target_deck_id: targetDeckId, expected_deck_revision: expectedDeckRevision, deck, idempotency_key: idempotencyKey };
}

// Reproduces the just-over-200KB regression without control characters. The
// definition padding is deliberately content-free: this is not grading gold.
export function makeNativeV2RegressionArgs({ idempotencyKey = "native-v2-205026-regression" } = {}) {
  const args = {
    operation: "create",
    deck: {
      schema_version: "normalized-definition-deck.v2",
      deck_id: "native-capacity-regression",
      title: "Synthetic capacity regression",
      cards: Array.from({ length: 50 }, (_, index) => ({
        id: `card-${String(index).padStart(2, "0")}`,
        term: `Capacity term ${String(index).padStart(2, "0")}`,
        definition: "x".repeat(3_800),
        criteria: ["One original synthetic required fact."],
        tags: [],
      })),
      edges: [],
    },
    idempotency_key: idempotencyKey,
  };
  let remaining = NATIVE_V2_REGRESSION_ARGS_UTF8_BYTES - new TextEncoder().encode(JSON.stringify(args)).byteLength;
  if (remaining < 0) throw new RangeError("Fixture options exceed the regression byte target");
  for (let index = args.deck.cards.length - 1; index >= 0 && remaining > 0; index--) {
    const card = args.deck.cards[index];
    const padding = Math.min(remaining, 8_000 - card.definition.length);
    card.definition += "x".repeat(padding);
    remaining -= padding;
  }
  if (remaining !== 0) throw new RangeError("Cannot reach the regression byte target within canonical limits");
  return args;
}
