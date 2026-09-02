import { BackendError } from "../../src/contracts.mjs";

// Count a JSON text's value tokens before JSON.parse allocates an object tree.
// This is only a resource guard. JSON.parse/canonical validation still decide
// syntax and meaning; no learner fields are interpreted or transformed here.
export function assertJsonTextBudget(text, { maxNodes = 150_000, maxDepth = 80 } = {}) {
  let nodes = 0;
  let depth = 0;
  let deepest = 0;
  const whitespace = (code) => code === 32 || code === 9 || code === 10 || code === 13;
  const invalid = () => { throw new BackendError("INVALID_LOCAL_STATE", "The preserved state must contain valid JSON", 400); };
  const value = () => {
    if (++nodes > maxNodes) throw new BackendError("STATE_TOO_COMPLEX", "The canonical working set exceeds the qualified node budget; preserve it and use paged recovery", 413);
  };
  for (let i = 0; i < text.length;) {
    const code = text.charCodeAt(i);
    if (whitespace(code) || code === 44 || code === 58) { i++; continue; }
    if (code === 123 || code === 91) {
      value(); depth++; deepest = Math.max(deepest, depth); i++;
      if (depth > maxDepth) throw new BackendError("STATE_TOO_COMPLEX", "The preserved state exceeds the JSON nesting budget", 413);
      continue;
    }
    if (code === 125 || code === 93) { if (--depth < 0) invalid(); i++; continue; }
    if (code === 34) {
      i++;
      let closed = false;
      while (i < text.length) {
        const next = text.charCodeAt(i++);
        if (next === 92) { i++; continue; }
        if (next === 34) { closed = true; break; }
      }
      if (!closed) invalid();
      let after = i;
      while (whitespace(text.charCodeAt(after))) after++;
      if (text.charCodeAt(after) !== 58) value(); // object keys are not values
      continue;
    }
    value();
    if (code === 116 && text.slice(i, i + 4) === "true") i += 4;
    else if (code === 102 && text.slice(i, i + 5) === "false") i += 5;
    else if (code === 110 && text.slice(i, i + 4) === "null") i += 4;
    else if (code === 45 || (code >= 48 && code <= 57)) {
      i++;
      while (i < text.length) {
        const next = text.charCodeAt(i);
        if ((next >= 48 && next <= 57) || [43, 45, 46, 69, 101].includes(next)) i++;
        else break;
      }
    } else invalid();
  }
  if (depth !== 0 || nodes === 0) invalid();
  return { nodes, depth: deepest };
}
