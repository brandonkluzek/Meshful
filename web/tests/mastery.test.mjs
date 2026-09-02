import test from "node:test";
import assert from "node:assert/strict";

import { isDeckFullyMastered } from "../js/mastery.js";

test("fully mastered requires a nonempty deck, no unseen cards, and 100% mastery", () => {
  assert.equal(isDeckFullyMastered({ total: 0, newCount: 0, mastery: 100 }), false);
  assert.equal(isDeckFullyMastered({ total: 12, newCount: 0, mastery: 99 }), false);
  assert.equal(isDeckFullyMastered({ total: 12, newCount: 1, mastery: 100 }), false);
  assert.equal(isDeckFullyMastered({ total: 12, newCount: 0, mastery: 100 }), true);
});

test("due reviews do not revoke mastery", () => {
  assert.equal(
    isDeckFullyMastered({ total: 12, newCount: 0, mastery: 100, dueCount: 7 }),
    true,
  );
});
