import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  parseDefinitionMarkdown,
  safeLinkHref,
} from "../js/definition-renderer.js";

const webRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(webRoot, "..");
const fixturePath = resolve(repositoryRoot, "tests/fixtures/deck_generation/order-relations.normalized.json");
const fixtureBytes = await readFile(fixturePath);
const fixture = JSON.parse(fixtureBytes);

function allNodes(value) {
  if (Array.isArray(value)) return value.flatMap(allNodes);
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(allNodes)];
}

function nodesOfType(blocks, type) {
  return allNodes(blocks).filter((node) => node.type === type);
}

function textContent(value) {
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (!value || typeof value !== "object") return "";
  if (value.type === "text" || value.type === "code" || value.type === "code_block") return value.value;
  return Object.values(value).map(textContent).join("");
}

test("the retained v2 definitions parse as Markdown with inline and display math", () => {
  const rendered = new Map(
    fixture.cards.map((card) => [card.id, parseDefinitionMarkdown(card.definition)]),
  );
  assert.equal(rendered.size, 8);

  const set = rendered.get("set");
  assert.equal(nodesOfType(set, "strong").length, 1);
  assert.equal(nodesOfType(set, "math").filter((node) => !node.display).length, 3);

  const cartesian = rendered.get("cartesian-product");
  assert.equal(nodesOfType(cartesian, "math").filter((node) => node.display).length, 1);

  const partialOrder = rendered.get("partial-order");
  const lists = nodesOfType(partialOrder, "list");
  assert.equal(lists.length, 1);
  assert.equal(lists[0].ordered, false);
  assert.equal(lists[0].items.length, 3);
  assert.equal(nodesOfType(partialOrder, "strong").length, 4);
});

test("the renderer model supports emphasis, code, paragraphs, lists, and safe links", () => {
  const blocks = parseDefinitionMarkdown([
    "A *compact* definition with `source code` and [a reference](https://example.org/reference).",
    "",
    "1. First condition",
    "2. Second condition",
  ].join("\n"));

  assert.equal(blocks.length, 2);
  assert.equal(nodesOfType(blocks, "emphasis").length, 1);
  assert.equal(nodesOfType(blocks, "code").length, 1);
  assert.deepEqual(nodesOfType(blocks, "link").map((node) => node.href), ["https://example.org/reference"]);
  assert.equal(nodesOfType(blocks, "list")[0].ordered, true);
});

test("raw HTML, media syntax, and executable attributes stay inert text", () => {
  const hostile = [
    '<script>globalThis.__termMeshPwned = true</script>',
    '<iframe src="https://attacker.invalid/frame"></iframe>',
    '<img src="https://attacker.invalid/pixel" onerror="alert(1)">',
    '<svg onload="alert(1)"><use href="https://attacker.invalid/x"></use></svg>',
    '<object data="https://attacker.invalid/o"></object>',
    '<embed src="https://attacker.invalid/e">',
    '<a href="javascript:alert(1)" onclick="alert(1)">raw link</a>',
    '![remote image](https://attacker.invalid/image.png)',
  ].join("\n\n");
  const blocks = parseDefinitionMarkdown(hostile);
  const types = new Set(allNodes(blocks).map((node) => node.type).filter(Boolean));

  assert.deepEqual([...types], ["paragraph", "text"]);
  assert.match(textContent(blocks), /<script>/);
  assert.match(textContent(blocks), /onerror=/);
  assert.match(textContent(blocks), /!\[remote image\]/);
  assert.equal(nodesOfType(blocks, "link").length, 0);
});

test("only explicit navigation protocols and local references become links", () => {
  for (const href of [
    "https://example.org/reference",
    "http://example.org/reference",
    "mailto:teacher@example.org",
    "#definition",
    "/library/reference",
    "./reference",
    "../reference",
    "?view=reference",
    "reference/section",
  ]) {
    assert.equal(safeLinkHref(href), href, `${href} should remain navigable`);
  }

  for (const href of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\nscript:alert(1)",
    "javascript%3Aalert(1)",
    "java&#x0a;script:alert(1)",
    "jav&#97;script:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://example.org/id",
    "//attacker.invalid/path",
  ]) {
    assert.equal(safeLinkHref(href), null, `${href} must be inert`);
    const blocks = parseDefinitionMarkdown(`[readable label](${href})`);
    assert.equal(nodesOfType(blocks, "link").length, 0);
    assert.match(textContent(blocks), /readable label/);
  }
});

test("invalid and unclosed TeX retains a readable delimited fallback source", () => {
  const invalidInline = parseDefinitionMarkdown("Invalid but closed: $x^{$.");
  const inlineMath = nodesOfType(invalidInline, "math")[0];
  assert.equal(inlineMath.raw, "$x^{$");
  assert.equal(inlineMath.closed, true);

  const unclosedDisplay = parseDefinitionMarkdown("$$\n\\begin{matrix} 1 & 2");
  const displayMath = nodesOfType(unclosedDisplay, "math")[0];
  assert.equal(displayMath.display, true);
  assert.equal(displayMath.closed, false);
  assert.match(displayMath.raw, /^\$\$/);
  assert.match(displayMath.raw, /\\begin\{matrix\}/);
});

test("display math preserves closing-line and same-line trailing prose", () => {
  const source = [
    "$$",
    "x=1",
    "$$, therefore **the first conclusion remains**.",
    "Its continuation stays in the same paragraph.",
    "",
    "\\[",
    "y=2",
    "\\] Second conclusion.",
    "",
    "$$z=3$$; Third conclusion.",
  ].join("\n");
  const sourceBytes = Buffer.from(source, "utf8");
  const blocks = parseDefinitionMarkdown(source);
  const displayMath = nodesOfType(blocks, "math").filter((node) => node.display);
  const paragraphs = blocks.filter((block) => block.type === "paragraph");

  assert.deepEqual(blocks.map((block) => block.type), [
    "math",
    "paragraph",
    "math",
    "paragraph",
    "math",
    "paragraph",
  ]);
  assert.deepEqual(displayMath.map((node) => node.value), ["x=1", "y=2", "z=3"]);
  assert.deepEqual(displayMath.map((node) => node.raw), ["$$x=1$$", "\\[y=2\\]", "$$z=3$$"]);
  assert.ok(displayMath.every((node) => node.closed));
  assert.deepEqual(paragraphs.map(textContent), [
    ", therefore the first conclusion remains. Its continuation stays in the same paragraph.",
    "Second conclusion.",
    "; Third conclusion.",
  ]);
  assert.equal(nodesOfType(paragraphs[0], "strong").length, 1);
  assert.deepEqual(Buffer.from(source, "utf8"), sourceBytes);

  const windowsSource = "$$\r\nx=1\r\n$$ Trailing prose survives CRLF.";
  const windowsBytes = Buffer.from(windowsSource, "utf8");
  const windowsBlocks = parseDefinitionMarkdown(windowsSource);
  assert.deepEqual(windowsBlocks.map((block) => block.type), ["math", "paragraph"]);
  assert.equal(textContent(windowsBlocks[1]), "Trailing prose survives CRLF.");
  assert.deepEqual(Buffer.from(windowsSource, "utf8"), windowsBytes);
});

test("rendering analysis does not rewrite canonical definition bytes", async () => {
  const before = fixture.cards.map((card) => Buffer.from(card.definition, "utf8"));
  for (const card of fixture.cards) parseDefinitionMarkdown(card.definition);
  const afterFixtureBytes = await readFile(fixturePath);

  assert.deepEqual(afterFixtureBytes, fixtureBytes);
  fixture.cards.forEach((card, index) => {
    assert.deepEqual(Buffer.from(card.definition, "utf8"), before[index]);
  });
});

test("runtime rendering is structural, offline, and locks down TeX capabilities", async () => {
  const [renderer, html, katexCss] = await Promise.all([
    readFile(resolve(webRoot, "js/definition-renderer.js"), "utf8"),
    readFile(resolve(webRoot, "index.html"), "utf8"),
    readFile(resolve(webRoot, "vendor/katex/katex.min.css"), "utf8"),
  ]);

  assert.doesNotMatch(renderer, /innerHTML|insertAdjacentHTML|document\.write|fetch\s*\(|XMLHttpRequest|WebSocket|EventSource/);
  assert.match(renderer, /trust:\s*false/);
  assert.match(renderer, /throwOnError:\s*true/);
  assert.match(renderer, /maxExpand:\s*1_000/);
  assert.match(renderer, /macros:\s*\{\}/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.doesNotMatch(katexCss, /https?:\/\/|@import/i);
});
