import test from "node:test";
import assert from "node:assert/strict";
import { encodeDocument, decodeDocument, FRAGMENT_MAX_BYTES } from "../src/fragment-codec.mjs";

test("lossless fragments preserve JSON escapes, whitespace and multibyte boundaries", async () => {
  const raw = ` {\n  "unicode": ${JSON.stringify("α🪐漢字\\\"".repeat(30_000))},\n  "escaped": "\\u0061"\n} `;
  const encoded = await encodeDocument({ id: "import:original", kind: "import", text: raw });
  assert.ok(encoded.parts.length > 1);
  for (const part of encoded.parts) {
    assert.ok(part.byteLength <= FRAGMENT_MAX_BYTES);
    assert.equal(new TextEncoder().encode(part.text).byteLength, part.byteLength);
  }
  assert.equal(await decodeDocument(encoded), raw);
  assert.deepEqual(await encodeDocument({ id: encoded.id, kind: encoded.kind, text: raw }), encoded);
});

test("missing, reordered, substituted or falsified fragments fail without returning partial data", async () => {
  const raw = JSON.stringify(Array.from({ length: 8_000 }, (_, i) => ({ id: i, answer: `Recall ${i} ${i * 7919}` })));
  const encoded = await encodeDocument({ id: "state:1", kind: "state", text: raw });
  const corrupt = (error) => error.code === "STORAGE_CORRUPT";
  await assert.rejects(decodeDocument({ ...encoded, parts: encoded.parts.slice(1) }), corrupt);
  await assert.rejects(decodeDocument({ ...encoded, parts: [...encoded.parts].reverse() }), corrupt);
  const altered = structuredClone(encoded);
  altered.parts[0].text = `X${altered.parts[0].text.slice(1)}`;
  await assert.rejects(decodeDocument(altered), corrupt);
  await assert.rejects(decodeDocument({ ...encoded, byteLength: encoded.byteLength + 1 }), corrupt);
});

test("literal U+FEFF at a fragment boundary remains exact learner content", async () => {
  const raw = JSON.stringify({ x: "x".repeat(65_530) + "\uFEFFtail" });
  const encoded = await encodeDocument({ id: "state:bom", kind: "state", text: raw });
  assert.equal(encoded.parts[1].text.codePointAt(0), 0xFEFF);
  assert.equal(await decodeDocument(encoded), raw);
});

test("content-defined boundaries reuse existing exact history after an append and an early revision edit", async (t) => {
  const records = Array.from({ length: 12_000 }, (_, i) => ({
    id: `review-${i}`, answer: `Definition ${i * 3571}`, feedback: `Missing condition ${i * 7927}`,
    schedule: { interval: i % 101, stability: (i % 37) / 3 },
  }));
  const before = await encodeDocument({ id: "state:1", kind: "state", text: JSON.stringify({ revision: 1, records }) });
  records.push({ id: "review-new", answer: "Exact new answer", feedback: "One correction" });
  const after = await encodeDocument({ id: "state:2", kind: "state", text: JSON.stringify({ revision: 2, records }) });
  const oldDigests = new Set(before.parts.map((part) => part.digest));
  const newBytes = after.parts.filter((part) => !oldDigests.has(part.digest)).reduce((sum, part) => sum + part.byteLength, 0);
  assert.ok(before.byteLength > 1_000_000);
  assert.ok(newBytes < before.byteLength / 4, `append wrote ${newBytes} of ${before.byteLength} original bytes`);
  assert.equal(await decodeDocument(after), JSON.stringify({ revision: 2, records }));
  t.diagnostic(`snapshot=${after.byteLength}B reused=${after.byteLength - newBytes}B new-fragments=${newBytes}B`);
});
