import { learnednessForReview, previewFsrsSchedule } from "./store.js";

const RATING_NAMES = Object.freeze({
  1: "again",
  2: "hard",
  3: "good",
  4: "easy",
  again: "again",
  hard: "hard",
  good: "good",
  easy: "easy",
});

function ratingName(value) {
  return RATING_NAMES[String(value ?? "").toLowerCase()] ?? null;
}

function replayLearnerSchedule(history) {
  let review = null;
  for (const record of history) {
    const rating = ratingName(record.rating);
    const submittedAt = new Date(record.submittedAt ?? "");
    if (!rating || !Number.isFinite(submittedAt.valueOf())) continue;
    review = previewFsrsSchedule(review, rating, submittedAt);
  }
  return review;
}

export function cardStatesForDeck(deck) {
  return Object.fromEntries(Object.entries(deck?.cards ?? {}).map(([id, card]) => {
    const review = card.review ?? {};
    const history = Array.isArray(card.reviewHistory) ? card.reviewHistory : [];
    const retainedLearnerReviews = history
      .filter((record) => record && ratingName(record.rating))
      .map((record) => ({
        rating: ratingName(record.rating),
        submittedAt: record.submittedAt ?? null,
      }));
    const hasDemoSeedProvenance = review.demoSeeded === true
      || history.some((record) => record?.scheduleBefore?.demoSeeded === true);
    const reviewCount = review.demoSeeded === true
      ? 0
      : hasDemoSeedProvenance
        ? retainedLearnerReviews.length
        : Math.max(0, Number(review.repetitions) || 0);
    const learnerSchedule = hasDemoSeedProvenance
      ? replayLearnerSchedule(retainedLearnerReviews)
      : review;
    return [id, {
      reviewCount,
      learnedness: reviewCount > 0 ? learnednessForReview(learnerSchedule) : 0,
      dueAt: reviewCount > 0 ? review.dueAt ?? null : null,
      lastReviewedAt: reviewCount > 0 ? review.lastReviewedAt ?? null : null,
      lastRating: reviewCount > 0
        ? review.lastRating ?? retainedLearnerReviews.at(-1)?.rating ?? null
        : null,
      // The inspector needs score and date, never private learner answers.
      reviewHistory: review.demoSeeded === true ? [] : retainedLearnerReviews,
    }];
  }));
}
