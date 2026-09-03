import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createDurableClient } from "../src/durable-client.mjs";

const source = await readFile(new URL("../src/durable-client.mjs", import.meta.url), "utf8");
for (const forbidden of ["./canonical-engine.mjs", "capacity.mjs", "json-budget.mjs", "d1-repository.mjs"]) {
  assert.equal(source.includes(forbidden), false, `Browser client imports server-only dependency ${forbidden}`);
}
const client = createDurableClient({
  fetchImpl: async () => { throw new Error("No network call expected during import proof"); },
  outbox: { read: () => null, write: () => {} },
});
assert.equal(typeof client.setDeckArchived, "function");
assert.equal(typeof client.submitGrade, "function");
assert.equal(Object.hasOwn(client, "set_deck_archived"), false);
process.stdout.write("Browser-only client imports and Archive method verified without server v4 modules.\n");
