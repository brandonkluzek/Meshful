import assert from "node:assert/strict";
import test from "node:test";

import { matchesLibraryQuery } from "../public/study/js/library-view.js";
import { captureSearchFieldState, restoreSearchFieldState } from "../public/study/js/search-field-state.js";

test("Library matching covers titles, subjects, descriptions, and supported term metadata", () => {
  const deck = {
    title: "Linear Algebra I",
    subject: "Mathematics",
    level: "Undergraduate",
    description: "Vectors, systems, and geometric transformations.",
    coverageSummary: "Matrix methods and vector spaces.",
    crossListedSubjects: ["Computer Science and Software"],
    tags: ["foundations"],
    searchText: "linear algebra mathematics undergraduate vectors systems geometric transformations matrix methods vector spaces computer science software foundations linear map eigenvalue least squares objective",
  };
  for (const query of ["linear algebra", "mathematics", "geometric transformations", "computer science", "eigenvalue", "least squares"]) {
    assert.equal(matchesLibraryQuery(deck, query), true, query);
  }
  assert.equal(matchesLibraryQuery(deck, "organic chemistry"), false);
});

test("a rerender restores the focused search caret for continued typing and backspace", () => {
  const original = { value: "eigenvalu", selectionStart: 9, selectionEnd: 9, selectionDirection: "none" };
  const state = captureSearchFieldState(original, original);
  const calls = [];
  const replacement = {
    value: "eigenvalu",
    focus(options) { calls.push(["focus", options]); },
    setSelectionRange(...args) { calls.push(["selection", ...args]); },
  };
  assert.equal(restoreSearchFieldState(replacement, state), true);
  assert.deepEqual(calls, [["focus", { preventScroll: true }], ["selection", 9, 9, "none"]]);

  replacement.value = "eigenval";
  assert.equal(restoreSearchFieldState(replacement, state), true);
  assert.deepEqual(calls.at(-1), ["selection", 8, 8, "none"]);
});

test("an unfocused Library search is not focused by a general rerender", () => {
  const field = { value: "math", selectionStart: 4, selectionEnd: 4 };
  assert.equal(captureSearchFieldState({}, field), null);
  assert.equal(restoreSearchFieldState(field, null), false);
});
