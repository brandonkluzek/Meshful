import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function filesAt(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? filesAt(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat();
}
const files = await filesAt(root);
for (const file of files) {
  const content = await readFile(file, "utf8");
  if (/[\t ]+$/m.test(content) || !content.endsWith("\n")) {
    throw new Error(`Whitespace/newline check failed: ${relative(root, file)}`);
  }
}
let checked = 0;
for (const file of files.filter((path) => path.endsWith(".mjs"))) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${relative(root, file)}: ${result.stderr}`);
  if (relative(root, file).startsWith("src/")) {
    const source = await readFile(file, "utf8");
    if (/from\s+["']node:/.test(source)) throw new Error(`Node dependency in Worker runtime: ${file}`);
  }
  checked++;
}
console.log(`${checked} JavaScript modules passed syntax checks; runtime has no node: imports.`);
console.log("Drizzle generation, Worker build, migration application and hosted ingress are separate Website gates.");
