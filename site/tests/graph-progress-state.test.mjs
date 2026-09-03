import test from "node:test";
import assert from "node:assert/strict";

import { cardStatesForDeck } from "../public/study/js/graph-progress-state.js";

test("Graph ignores demo examples and preserves retained learner progress", () => {
  const learnerHistory = [
    { rating: "hard", submittedAt: "2026-09-01T00:00:00.000Z" },
    { rating: "good", submittedAt: "2026-09-03T00:00:00.000Z" },
  ];
  const states = cardStatesForDeck({
    cards: {
      example: {
        review: {
          demoSeeded: true,
          repetitions: 8,
          dueAt: "2099-01-01T00:00:00.000Z",
          lastReviewedAt: "2098-12-01T00:00:00.000Z",
          lastRating: "easy",
        },
        reviewHistory: [{ rating: "easy", submittedAt: "2098-12-01T00:00:00.000Z" }],
      },
      learner: {
        review: {
          repetitions: 2,
          stabilityDays: 8,
          difficulty: 4.5,
          lapses: 0,
          dueAt: "2026-09-05T00:00:00.000Z",
          lastReviewedAt: "2026-09-03T00:00:00.000Z",
          lastRating: "good",
        },
        reviewHistory: learnerHistory,
      },
    },
  });

  assert.equal(states.example.reviewCount, 0);
  assert.equal(states.example.learnedness, 0);
  assert.equal(states.example.dueAt, null);
  assert.equal(states.example.lastReviewedAt, null);
  assert.equal(states.example.lastRating, null);
  assert.deepEqual(states.example.reviewHistory, []);
  assert.equal(states.learner.reviewCount, 2);
  assert.ok(states.learner.learnedness > 0);
  assert.equal(states.learner.dueAt, "2026-09-05T00:00:00.000Z");
  assert.equal(states.learner.lastReviewedAt, "2026-09-03T00:00:00.000Z");
  assert.equal(states.learner.lastRating, "good");
  assert.deepEqual(states.learner.reviewHistory, learnerHistory);
});

test("a real grade after a demo seed counts only the learner's retained review", () => {
  const states = cardStatesForDeck({
    cards: {
      seededThenStudied: {
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

  assert.equal(states.seededThenStudied.reviewCount, 1);
  assert.ok(states.seededThenStudied.learnedness > 0);
  assert.equal(states.seededThenStudied.lastRating, "good");
  assert.equal(states.seededThenStudied.dueAt, "2026-09-10T00:00:00.000Z");
  assert.equal(states.seededThenStudied.lastReviewedAt, "2026-09-03T15:00:00.000Z");
  assert.deepEqual(states.seededThenStudied.reviewHistory, [
    { rating: "good", submittedAt: "2026-09-03T15:00:00.000Z" },
  ]);
  assert.equal(JSON.stringify(states).includes("private learner answer"), false);
});
