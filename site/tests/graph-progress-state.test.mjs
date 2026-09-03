import test from "node:test";
import assert from "node:assert/strict";

import { cardStatesForDeck } from "../public/study/js/graph-progress-state.js";

test("graph progress ignores demo examples and preserves learner reviews", () => {
  const states = cardStatesForDeck({
    cards: {
      example: {
        review: {
          demoSeeded: true,
          repetitions: 8,
          dueAt: "2099-01-01T00:00:00.000Z",
          lastReviewedAt: "2098-12-01T00:00:00.000Z",
        },
      },
      learner: {
        review: {
          repetitions: 2,
          dueAt: "2026-09-05T00:00:00.000Z",
          lastReviewedAt: "2026-09-03T00:00:00.000Z",
        },
      },
    },
  });

  assert.deepEqual(states.example, {
    reviewCount: 0,
    learnedness: 0,
    dueAt: null,
    lastReviewedAt: null,
    lastRating: null,
    reviewHistory: [],
  });
  assert.deepEqual(states.learner, {
    reviewCount: 2,
    learnedness: 0,
    dueAt: "2026-09-05T00:00:00.000Z",
    lastReviewedAt: "2026-09-03T00:00:00.000Z",
    lastRating: null,
    reviewHistory: [],
  });
});

test("one real grade after a demo seed counts as one learner review", () => {
  const states = cardStatesForDeck({
    cards: {
      seeded_then_studied: {
        review: {
          repetitions: 7,
          dueAt: "2026-09-10T00:00:00.000Z",
          lastReviewedAt: "2026-09-03T15:00:00.000Z",
          lastRating: "good",
        },
        reviewHistory: [{
          rating: "good",
          submittedAt: "2026-09-03T15:00:00.000Z",
          answer_text: "private learner answer",
          scheduleBefore: { demoSeeded: true, repetitions: 6 },
        }],
      },
    },
  });

  assert.deepEqual(states.seeded_then_studied, {
    reviewCount: 1,
    learnedness: states.seeded_then_studied.learnedness,
    dueAt: "2026-09-10T00:00:00.000Z",
    lastReviewedAt: "2026-09-03T15:00:00.000Z",
    lastRating: "good",
    reviewHistory: [{ rating: "good", submittedAt: "2026-09-03T15:00:00.000Z" }],
  });
  assert.ok(states.seeded_then_studied.learnedness < 0.6);
  assert.equal(JSON.stringify(states).includes("private learner answer"), false);
});
