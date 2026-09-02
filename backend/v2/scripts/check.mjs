import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), "Delivery must not contain symlinks");
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
const all = (await files(root)).sort();
const environment = { ...process.env }; delete environment.NODE_COMPILE_CACHE;
let modules = 0;
for (const file of all) {
  const text = await readFile(file, "utf8");
  assert.ok(!/^(<{7}|={7}|>{7})/m.test(text), `Merge marker in ${file}`);
  assert.ok(!/[\t ]+$/m.test(text), `Trailing whitespace in ${file}`);
  if (!file.endsWith(".mjs")) continue;
  const checked = spawnSync(process.execPath, ["--check", file], { env: environment, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr); modules++;
}
const server = await import("../src/index.mjs");
const browser = await import("../src/durable-client.mjs");
for (const name of ["createD1Repository", "createCanonicalEngine", "createLearnerService", "createLearnerHandler"]) assert.equal(typeof server[name], "function");
assert.equal(typeof browser.createDurableClient, "function");
process.stdout.write(`Checked ${modules} JavaScript modules; server/browser factories import without providers or canonical data.\n`);
process.stdout.write("SQL behavior is tested separately in SQLite; typed Drizzle input still requires Website generation/type review.\n");
