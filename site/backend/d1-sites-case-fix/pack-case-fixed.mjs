import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCaseFixedPackage } from "./build-case-fixed-package.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function noSymlinkComponents(root, relative) {
  let current = root;
  for (const part of relative.split("/")) {
    assert.ok(part && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part),
      `Unsafe target path: ${relative}`);
    current = join(current, part);
    try {
      const status = await lstat(current);
      assert.ok(!status.isSymbolicLink(), `Target path must not use symlinks: ${relative}`);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function state(path, bytes) {
  try {
    const existing = await readFile(path);
    assert.equal(sha256(existing), sha256(bytes), `Refusing to replace a different artifact: ${path}`);
    return "identical";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return "absent";
  }
}

async function assertAllAndOnlyDrizzleTree(target, expectedFiles) {
  const drizzle = join(target, "drizzle");
  try {
    const rootStatus = await lstat(drizzle);
    assert.ok(rootStatus.isDirectory() && !rootStatus.isSymbolicLink(),
      "Existing drizzle path must be a non-symlink directory");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const allowedFiles = new Set(expectedFiles);
  const allowedDirectories = new Set(["drizzle", "drizzle/meta"]);
  async function walk(relative) {
    for (const entry of await readdir(join(target, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      const status = await lstat(join(target, path));
      assert.ok(!status.isSymbolicLink(), `Unexpected symlink in migration tree: ${path}`);
      if (status.isDirectory()) {
        assert.ok(allowedDirectories.has(path), `Unexpected directory in migration tree: ${path}`);
        await walk(path);
      } else if (status.isFile()) {
        assert.ok(allowedFiles.has(path), `Unexpected file in migration tree: ${path}`);
      } else {
        assert.fail(`Unexpected non-regular entry in migration tree: ${path}`);
      }
    }
  }
  await walk("drizzle");
}

export async function writeCaseFixedPackage(targetInput) {
  const requested = resolve(targetInput);
  const status = await lstat(requested);
  assert.ok(status.isDirectory() && !status.isSymbolicLink(), "Target must be an existing non-symlink directory");
  const target = await realpath(requested);
  const built = await buildCaseFixedPackage();
  const files = [
    ...built.migrations.map((item) => ({ path: item.site_path, bytes: item.bytes })),
    { path: built.contract.journal.path, bytes: built.journalBytes },
  ];
  await assertAllAndOnlyDrizzleTree(target, files.map((file) => file.path));
  const plan = [];
  for (const file of files) {
    await noSymlinkComponents(target, file.path);
    plan.push({ ...file, state: await state(join(target, file.path), file.bytes) });
  }
  for (const file of plan) {
    if (file.state === "identical") continue;
    const path = join(target, file.path);
    await mkdir(dirname(path), { recursive: true });
    await noSymlinkComponents(target, file.path);
    try { await writeFile(path, file.bytes, { flag: "wx" }); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      assert.equal(sha256(await readFile(path)), sha256(file.bytes),
        `Refusing a concurrently created different artifact: ${path}`);
    }
  }
  return Object.freeze({ schema: "meshful-sites-d1-case-fixed-package.v1", target,
    replacements: built.replacementCount,
    migrations: built.migrations.map((item) => ({ path: item.site_path,
      statements: item.statements.length, bytes: item.actual_bytes, sha256: item.actual_sha256 })),
    journal: { path: built.contract.journal.path, bytes: built.journalBytes.byteLength,
      sha256: built.journalSha256 }, hosted_changes: 0 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.deepEqual(args.slice(0, 1), ["--target"]);
  assert.equal(args.length, 2,
    "usage: node backend/d1-sites-case-fix/pack-case-fixed.mjs --target /absolute/site/root");
  process.stdout.write(`${JSON.stringify(await writeCaseFixedPackage(args[1]), null, 2)}\n`);
}
