import test from "node:test";
import assert from "node:assert/strict";
import { assertJsonTextBudget } from "../src/json-budget.mjs";

test("text budget counts values before parsing without confusing escaped content or keys", () => {
  const data = { "key:[]{}\"": [true, false, null, -123.04e24, { nested: "\\\"[,]🪐\ud800" }], empty: {} };
  const count = (value) => 1 + (value && typeof value === "object" ? Object.values(value).reduce((n, item) => n + count(item), 0) : 0);
  for (const encoded of [JSON.stringify(data), JSON.stringify(data, null, 2)]) {
    assert.equal(assertJsonTextBudget(encoded).nodes, count(data));
    assert.deepEqual(JSON.parse(encoded), data);
  }
});

test("dense state and excessive nesting reject on text scan", () => {
  assert.throws(() => assertJsonTextBudget(`[${"0,".repeat(150_000)}0]`), (error) => error.code === "STATE_TOO_COMPLEX");
  assert.throws(() => assertJsonTextBudget(`${"[".repeat(81)}0${"]".repeat(81)}`), (error) => error.code === "STATE_TOO_COMPLEX");
  assert.throws(() => assertJsonTextBudget('{"unfinished":"'), (error) => error.code === "INVALID_LOCAL_STATE");
});
