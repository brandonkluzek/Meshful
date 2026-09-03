import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, `Symlink is not allowed: ${entry.name}`);
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
let modules = 0;
for (const path of await walk(root)) {
  const source = await readFile(path, "utf8");
  assert.ok(!/^(<{7}|={7}|>{7})/m.test(source), `Merge marker in ${path}`);
  assert.ok(!/[\t ]+$/m.test(source), `Trailing whitespace in ${path}`);
  assert.ok(!source.includes(["", "Users"].join("/") + "/"), `Private path in ${path}`);
  if (!path.endsWith(".mjs")) continue;
  const env = { ...process.env };
  delete env.NODE_COMPILE_CACHE;
  const result = spawnSync(process.execPath, ["--check", path], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  modules += 1;
}
const entry = await import("../src/index.mjs");
for (const name of ["createCanonicalEngine", "createDurableClient", "createD1Repository", "createLearnerService", "createLearnerHandler"]) {
  assert.equal(typeof entry[name], "function", `Missing ${name}`);
}
process.stdout.write(`Checked ${modules} v4 modules and five runtime factories.\n`);
