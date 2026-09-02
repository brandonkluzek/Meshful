import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

const files = await walk(root);
const sourceFiles = files.filter((path) => [".js", ".mjs"].includes(extname(path)));
const failures = [];

for (const path of sourceFiles) {
  const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${path}:\n${result.stderr.trim()}`);
}

const htmlPath = resolve(root, "index.html");
const html = await readFile(htmlPath, "utf8");
for (const match of html.matchAll(/(?:src|href)="(\.\/[^"#?]+)"/g)) {
  const asset = resolve(root, match[1]);
  if (!files.includes(asset)) failures.push(`${htmlPath}: missing local asset ${match[1]}`);
}

if (/https?:\/\//.test(html)) {
  failures.push(`${htmlPath}: the application shell must not require third-party runtime assets`);
}

for (const path of sourceFiles.filter((candidate) => !candidate.includes("/scripts/") && !candidate.includes("/tests/"))) {
  const source = await readFile(path, "utf8");
  if (/from\s+["']https?:\/\//.test(source) || /import\s*\(\s*["']https?:\/\//.test(source)) {
    failures.push(`${path}: remote runtime imports are not allowed`);
  }
}

if (failures.length) {
  console.error(failures.join("\n\n"));
  process.exitCode = 1;
} else {
  console.log(`check: ${sourceFiles.length} JavaScript modules parse; local assets and offline runtime boundary verified`);
}
