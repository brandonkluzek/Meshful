import { BackendError, requireThat } from "../../src/contracts.mjs";

// This codec knows nothing about learner schemas or schedules. Concatenation
// recovers the original UTF-8 text, including whitespace and escape spelling.
// Content-defined boundaries let an append reuse unaffected history fragments.
export const FRAGMENT_MIN_BYTES = 8_192;
export const FRAGMENT_TARGET_BYTES = 32_768;
export const FRAGMENT_MAX_BYTES = 65_536;
export const DOCUMENT_DECODE_MAX_BYTES = 16 * 1_024 * 1_024;
const encoder = new TextEncoder();
// A fragment may begin inside a JSON string. U+FEFF there is learner content,
// not a file BOM; TextDecoder must never strip it at a fragment boundary.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const DIGEST = /^sha256:[a-f0-9]{64}$/;

// Deterministic rolling boundary markers, NOT integrity hashes. A 32-bit
// shift/add forgets bytes more than 32 positions back and can resynchronize
// after an insertion. SHA-256 below supplies content identity and integrity.
const gear = Uint32Array.from({ length: 256 }, (_, index) => {
  let x = index + 1;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
});

export async function digestBytes(bytes) {
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(result, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function encodeDocument({ id, kind, text }) {
  requireThat(typeof id === "string" && id.length > 0 && id.length <= 300,
    "INVALID_DOCUMENT", "A bounded document identity is required", 503);
  requireThat(["state", "receipt", "review", "import"].includes(kind),
    "INVALID_DOCUMENT", "Unknown durable document kind", 503);
  requireThat(typeof text === "string" && text.length > 0,
    "INVALID_DOCUMENT", "A durable document must contain text", 503);
  const bytes = encoder.encode(text);
  // JSON.stringify escapes lone UTF-16 surrogates. Raw import archives can
  // contain them only as escaped JSON, never as literal invalid UTF-8 text.
  requireThat(decoder.decode(bytes) === text, "INVALID_DOCUMENT",
    "The original text must be losslessly representable as UTF-8", 400);
  const parts = [];
  let start = 0;
  while (start < bytes.length) {
    let end = start;
    let marker = 0;
    const maximum = Math.min(start + FRAGMENT_MAX_BYTES, bytes.length);
    while (end < maximum) {
      marker = ((marker << 1) + gear[bytes[end]]) >>> 0;
      end += 1;
      if (end - start >= FRAGMENT_MIN_BYTES && (marker & (FRAGMENT_TARGET_BYTES - 1)) === 0) break;
    }
    // Each TEXT fragment is valid UTF-8 on its own. Move a proposed boundary
    // before a multi-byte code point, never between its continuation bytes.
    while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end -= 1;
    const fragment = bytes.subarray(start, end);
    parts.push({ digest: await digestBytes(fragment), byteLength: fragment.byteLength, text: decoder.decode(fragment) });
    start = end;
  }
  return { id, kind, byteLength: bytes.byteLength, digest: await digestBytes(bytes), parts };
}

export async function decodeDocument(document, { maxBytes = DOCUMENT_DECODE_MAX_BYTES } = {}) {
  const corrupt = () => { throw new BackendError("STORAGE_CORRUPT", "Durable document integrity could not be verified; preserve its stored parts", 503); };
  if (!document || !Number.isSafeInteger(document.byteLength) || document.byteLength <= 0 ||
      document.byteLength > maxBytes || !DIGEST.test(document.digest) || !Array.isArray(document.parts) ||
      document.parts.length === 0 || document.parts.length > Math.ceil(maxBytes / (FRAGMENT_MIN_BYTES - 3)) + 1) corrupt();
  let total = 0;
  for (const part of document.parts) {
    if (typeof part?.text !== "string" || !DIGEST.test(part.digest) ||
        !Number.isSafeInteger(part.byteLength) || part.byteLength < 1 || part.byteLength > FRAGMENT_MAX_BYTES) corrupt();
    total += part.byteLength;
    if (total > document.byteLength) corrupt();
    const bytes = encoder.encode(part.text);
    if (bytes.byteLength !== part.byteLength || decoder.decode(bytes) !== part.text ||
        await digestBytes(bytes) !== part.digest) corrupt();
  }
  if (total !== document.byteLength) corrupt();
  const text = document.parts.map((part) => part.text).join("");
  if (await digestBytes(encoder.encode(text)) !== document.digest) corrupt();
  return text;
}
