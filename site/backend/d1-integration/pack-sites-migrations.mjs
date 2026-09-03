// Deterministically converts the reviewed Backend SQL into the statement-
// breakpoint format consumed by the Sites/Drizzle D1 migration runner. It does
// not create a database, call a provider, build a Site, or enable an endpoint.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const integrationRoot = fileURLToPath(new URL("./", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function hasSql(value) {
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (lineComment) {
      if (char === "\r" || char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (!/\s/.test(char)) return true;
  }
  return false;
}

// This is a small SQL lexical splitter, not a general SQL parser. It recognizes
// SQLite quoting/comments plus CREATE TRIGGER BEGIN...END and nested CASE...END,
// which are the constructs present in the two pinned migrations. Every output
// statement is subsequently prepared and run independently in the rehearsal.
export function splitTopLevelSql(sql) {
  assert.equal(typeof sql, "string");
  assert.ok(!sql.includes(STATEMENT_BREAKPOINT), "Authored SQL must not already contain Drizzle breakpoints");
  const statements = [];
  let start = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let createSeen = false;
  let trigger = false;
  let triggerBlockDepth = 0;
  let caseDepth = 0;

  const finish = (end) => {
    const statement = sql.slice(start, end).trim();
    if (hasSql(statement)) statements.push(statement);
    start = end;
    createSeen = false;
    trigger = false;
    triggerBlockDepth = 0;
    caseDepth = 0;
  };

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (char === "\r" || char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (quote === "[" && char === "]") quote = null;
      else if (quote !== "[" && char === quote) {
        if (next === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === "`" || char === "[") { quote = char; continue; }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) end += 1;
      const word = sql.slice(index, end).toUpperCase();
      if (word === "CREATE") createSeen = true;
      else if (createSeen && word === "TRIGGER") trigger = true;
      if (trigger) {
        if (word === "CASE" && triggerBlockDepth > 0) caseDepth += 1;
        else if (word === "BEGIN") triggerBlockDepth += 1;
        else if (word === "END") {
          if (caseDepth > 0) caseDepth -= 1;
          else if (triggerBlockDepth > 0) triggerBlockDepth -= 1;
        }
      }
      index = end - 1;
      continue;
    }
    if (char === ";" && (!trigger || triggerBlockDepth === 0)) finish(index + 1);
  }
  const tail = sql.slice(start);
  assert.ok(!hasSql(tail), "Authored SQL has an unterminated top-level statement");
  assert.equal(quote, null, "Authored SQL has an unterminated quote");
  assert.equal(blockComment, false, "Authored SQL has an unterminated block comment");
  assert.equal(triggerBlockDepth, 0, "Authored SQL has an unterminated trigger body");
  assert.ok(statements.length > 0, "Authored SQL has no statements");
  return statements;
}

export function parseBreakpointSql(sql) {
  const parts = sql.split(STATEMENT_BREAKPOINT).map((part) => part.trim()).filter(hasSql);
  assert.ok(parts.length > 0, "Packaged migration has no statements");
  assert.ok(parts.every((part) => part.endsWith(";")), "Every packaged statement must end in a semicolon");
  return parts;
}

export async function buildSitesMigrationPackage() {
  const contract = JSON.parse(await readFile(join(integrationRoot, "SITES_D1_CONTRACT.json"), "utf8"));
  const files = [];
  for (const migration of contract.migrations) {
    const sourceBytes = await readFile(join(repositoryRoot, migration.source));
    assert.equal(sourceBytes.byteLength, migration.source_bytes);
    assert.equal(digest(sourceBytes), migration.source_sha256);
    const statements = splitTopLevelSql(sourceBytes.toString("utf8"));
    const body = `${statements.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`;
    const bytes = Buffer.from(body);
    assert.equal(statements.length, migration.statement_count);
    assert.equal(statements.length - 1, migration.breakpoint_count);
    assert.equal(bytes.byteLength, migration.packaged_bytes);
    assert.equal(digest(bytes), migration.packaged_sha256);
    files.push({ ...migration, bytes, statements });
  }
  const journalBytes = Buffer.from(`${JSON.stringify(contract.migration_journal, null, 2)}\n`);
  assert.equal(journalBytes.byteLength, contract.migration_journal_bytes);
  assert.equal(digest(journalBytes), contract.migration_journal_sha256);
  return { contract, files, journalBytes };
}

async function inspectAbsentOrIdentical(path, bytes) {
  try {
    const existing = await readFile(path);
    assert.equal(digest(existing), digest(bytes),
      `Refusing to replace a different migration artifact: ${path}`);
    return "identical";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return "absent";
}

async function assertNoSymlinkComponents(root, relative) {
  let current = root;
  for (const part of relative.split("/")) {
    assert.ok(part && part !== "." && part !== "..", `Unsafe migration target path: ${relative}`);
    current = join(current, part);
    try {
      const status = await lstat(current);
      assert.ok(!status.isSymbolicLink(), `Migration target must not use symlinks: ${relative}`);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function createAbsentOrAcceptConcurrentIdentical(path, bytes) {
  try {
    await writeFile(path, bytes, { flag: "wx" });
    return "created";
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(path);
    assert.equal(digest(existing), digest(bytes),
      `Refusing to replace a concurrently created migration artifact: ${path}`);
    return "identical";
  }
}

export async function writeSitesMigrationPackage(targetRootInput) {
  const requestedRoot = resolve(targetRootInput);
  const requestedStatus = await lstat(requestedRoot);
  assert.ok(requestedStatus.isDirectory() && !requestedStatus.isSymbolicLink(),
    "Migration target root must be an existing non-symlink directory");
  const targetRoot = await realpath(requestedRoot);
  const built = await buildSitesMigrationPackage();
  const targets = [
    ...built.files.map((migration) => ({ relative: migration.site_path, path: join(targetRoot, migration.site_path), bytes: migration.bytes })),
    { relative: "drizzle/meta/_journal.json", path: join(targetRoot, "drizzle/meta/_journal.json"), bytes: built.journalBytes },
  ];

  // Detect every pre-existing conflict before creating any file. This keeps a
  // stale or previously applied target tree byte-for-byte unchanged on refusal.
  const plan = [];
  for (const target of targets) {
    await assertNoSymlinkComponents(targetRoot, target.relative);
    plan.push({ ...target, status: await inspectAbsentOrIdentical(target.path, target.bytes) });
  }
  for (const target of plan) {
    if (target.status === "identical") continue;
    await mkdir(dirname(target.path), { recursive: true });
    await assertNoSymlinkComponents(targetRoot, target.relative);
    await createAbsentOrAcceptConcurrentIdentical(target.path, target.bytes);
  }
  return Object.freeze({
    schema: "meshful-sites-migration-package.v1",
    target_root: targetRoot,
    migrations: built.files.map((item) => ({
      tag: item.tag,
      path: item.site_path,
      statements: item.statements.length,
      breakpoints: item.statements.length - 1,
      bytes: item.bytes.byteLength,
      sha256: digest(item.bytes),
    })),
    journal: { path: "drizzle/meta/_journal.json", bytes: built.journalBytes.byteLength,
      sha256: digest(built.journalBytes) },
    hosted_changes: 0,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 2,
    "usage: node backend/d1-integration/pack-sites-migrations.mjs --target /absolute/site/root");
  assert.equal(args[0], "--target",
    "usage: node backend/d1-integration/pack-sites-migrations.mjs --target /absolute/site/root");
  process.stdout.write(`${JSON.stringify(await writeSitesMigrationPackage(args[1]), null, 2)}\n`);
}
