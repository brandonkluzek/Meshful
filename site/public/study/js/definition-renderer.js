import katex from "../vendor/katex/katex.js";

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const MARKDOWN_ESCAPES = new Set(["\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "+", "-", ".", "!", "$", ">"]);
const MAX_INLINE_DEPTH = 12;

function textToken(value) {
  return { type: "text", value };
}

function appendText(tokens, value) {
  if (!value) return;
  const previous = tokens.at(-1);
  if (previous?.type === "text") previous.value += value;
  else tokens.push(textToken(value));
}

function isEscaped(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function closingDelimiter(source, delimiter, start) {
  let cursor = start;
  while (cursor < source.length) {
    const found = source.indexOf(delimiter, cursor);
    if (found < 0) return -1;
    if (!isEscaped(source, found)) return found;
    cursor = found + delimiter.length;
  }
  return -1;
}

function closingLinkParen(source, start) {
  let depth = 1;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (isEscaped(source, cursor)) continue;
    if (source[cursor] === "(") depth += 1;
    if (source[cursor] === ")") depth -= 1;
    if (depth === 0) return cursor;
  }
  return -1;
}

function normalizedSchemeProbe(value) {
  const entitiesDecoded = value.slice(0, 128).replace(
    /&#(?:x([\da-f]+)|(\d+));?/gi,
    (match, hexadecimal, decimal) => {
      const codePoint = Number.parseInt(hexadecimal ?? decimal, hexadecimal ? 16 : 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    },
  );
  let decoded = entitiesDecoded;
  try {
    decoded = decodeURIComponent(entitiesDecoded);
  } catch {
    // Malformed escapes remain literal and cannot become a decoded scheme.
  }
  return decoded.replace(/[\s\u0000-\u001f\u007f]/g, "").toLowerCase();
}

export function safeLinkHref(value) {
  const href = String(value ?? "").trim();
  if (!href || /\s|[\u0000-\u001f\u007f\\]/.test(href) || href.startsWith("//")) return null;
  if (/^(?:javascript|data|vbscript|file|blob):/.test(normalizedSchemeProbe(href))) return null;
  if (/^(?:#|\?|\/(?!\/)|\.\.?\/)/.test(href)) return href;
  if (!href.includes(":")) return href;
  if (!/^(?:https?:\/\/|mailto:)/i.test(href)) return null;
  try {
    const url = new URL(href);
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? href : null;
  } catch {
    return null;
  }
}

function inlineTokens(source, depth = 0) {
  const input = String(source ?? "");
  if (depth >= MAX_INLINE_DEPTH) return [textToken(input)];
  const tokens = [];
  let cursor = 0;

  while (cursor < input.length) {
    if (input.startsWith("![", cursor)) {
      const labelEnd = input.indexOf("](", cursor + 2);
      const targetEnd = labelEnd < 0 ? -1 : closingLinkParen(input, labelEnd + 2);
      if (labelEnd >= 0 && targetEnd >= 0) {
        appendText(tokens, input.slice(cursor, targetEnd + 1));
        cursor = targetEnd + 1;
        continue;
      }
    }

    if (input.startsWith("\\(", cursor)) {
      const end = closingDelimiter(input, "\\)", cursor + 2);
      if (end >= 0 && end > cursor + 2) {
        tokens.push({
          type: "math",
          value: input.slice(cursor + 2, end),
          raw: input.slice(cursor, end + 2),
          display: false,
          closed: true,
        });
        cursor = end + 2;
        continue;
      }
    }

    if (input[cursor] === "`" && !isEscaped(input, cursor)) {
      const end = closingDelimiter(input, "`", cursor + 1);
      if (end > cursor + 1) {
        tokens.push({ type: "code", value: input.slice(cursor + 1, end) });
        cursor = end + 1;
        continue;
      }
    }

    const strongDelimiter = input.startsWith("**", cursor)
      ? "**"
      : input.startsWith("__", cursor)
        ? "__"
        : null;
    if (strongDelimiter && !isEscaped(input, cursor)) {
      const end = closingDelimiter(input, strongDelimiter, cursor + 2);
      if (end > cursor + 2) {
        tokens.push({
          type: "strong",
          children: inlineTokens(input.slice(cursor + 2, end), depth + 1),
        });
        cursor = end + 2;
        continue;
      }
    }

    if ((input[cursor] === "*" || input[cursor] === "_") && !isEscaped(input, cursor)) {
      const delimiter = input[cursor];
      const end = closingDelimiter(input, delimiter, cursor + 1);
      if (end > cursor + 1) {
        tokens.push({
          type: "emphasis",
          children: inlineTokens(input.slice(cursor + 1, end), depth + 1),
        });
        cursor = end + 1;
        continue;
      }
    }

    if (input[cursor] === "[" && !isEscaped(input, cursor)) {
      const labelEnd = input.indexOf("](", cursor + 1);
      const targetEnd = labelEnd < 0 ? -1 : closingLinkParen(input, labelEnd + 2);
      if (labelEnd >= 0 && targetEnd >= 0) {
        const label = input.slice(cursor + 1, labelEnd);
        const href = safeLinkHref(input.slice(labelEnd + 2, targetEnd));
        if (href) {
          tokens.push({
            type: "link",
            href,
            children: inlineTokens(label, depth + 1),
          });
        } else {
          tokens.push(...inlineTokens(label, depth + 1));
        }
        cursor = targetEnd + 1;
        continue;
      }
    }

    if (input[cursor] === "$" && input[cursor + 1] !== "$" && !isEscaped(input, cursor)) {
      const end = closingDelimiter(input, "$", cursor + 1);
      if (end > cursor + 1 && input[end + 1] !== "$") {
        tokens.push({
          type: "math",
          value: input.slice(cursor + 1, end),
          raw: input.slice(cursor, end + 1),
          display: false,
          closed: true,
        });
        cursor = end + 1;
        continue;
      }
    }

    if (input[cursor] === "\\" && MARKDOWN_ESCAPES.has(input[cursor + 1])) {
      appendText(tokens, input[cursor + 1]);
      cursor += 2;
      continue;
    }

    appendText(tokens, input[cursor]);
    cursor += 1;
  }

  return tokens;
}

function listItem(line) {
  const match = /^(?: {0,3})([-+*]|\d+[.)])\s+(.+)$/.exec(line);
  if (!match) return null;
  return {
    ordered: /^\d/.test(match[1]),
    value: match[2],
  };
}

function displayMathStart(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith("$$")) return { open: "$$", close: "$$" };
  if (trimmed.startsWith("\\[")) return { open: "\\[", close: "\\]" };
  return null;
}

function isBlockStart(line) {
  const trimmed = line.trim();
  return Boolean(
    !trimmed ||
    trimmed.startsWith("```") ||
    displayMathStart(line) ||
    listItem(line),
  );
}

export function parseDefinitionMarkdown(definitionSource) {
  const source = String(definitionSource ?? "");
  const lines = source.split(/\r\n?|\n/);
  const blocks = [];
  let cursor = 0;

  while (cursor < lines.length) {
    if (!lines[cursor].trim()) {
      cursor += 1;
      continue;
    }

    const trimmed = lines[cursor].trim();
    if (trimmed.startsWith("```")) {
      const opening = lines[cursor];
      const language = trimmed.slice(3).trim();
      const content = [];
      cursor += 1;
      let closed = false;
      while (cursor < lines.length) {
        if (lines[cursor].trim().startsWith("```")) {
          closed = true;
          cursor += 1;
          break;
        }
        content.push(lines[cursor]);
        cursor += 1;
      }
      blocks.push({
        type: "code_block",
        value: content.join("\n"),
        language,
        closed,
        raw: [opening, ...content, ...(closed ? ["```"] : [])].join("\n"),
      });
      continue;
    }

    const mathDelimiter = displayMathStart(lines[cursor]);
    if (mathDelimiter) {
      const first = trimmed.slice(mathDelimiter.open.length);
      const sameLineCloseAt = closingDelimiter(first, mathDelimiter.close, 0);
      if (sameLineCloseAt >= 0) {
        const value = first.slice(0, sameLineCloseAt);
        blocks.push({
          type: "math",
          value,
          raw: `${mathDelimiter.open}${value}${mathDelimiter.close}`,
          display: true,
          closed: true,
        });
        lines[cursor] = first.slice(sameLineCloseAt + mathDelimiter.close.length);
        continue;
      }

      const content = first ? [first] : [];
      cursor += 1;
      let closed = false;
      while (cursor < lines.length) {
        const candidate = lines[cursor];
        const closeAt = closingDelimiter(candidate, mathDelimiter.close, 0);
        if (closeAt >= 0) {
          if (candidate.slice(0, closeAt)) content.push(candidate.slice(0, closeAt));
          closed = true;
          lines[cursor] = candidate.slice(closeAt + mathDelimiter.close.length);
          break;
        }
        content.push(candidate);
        cursor += 1;
      }
      const value = content.join("\n");
      blocks.push({
        type: "math",
        value,
        raw: `${mathDelimiter.open}${value}${closed ? mathDelimiter.close : ""}`,
        display: true,
        closed,
      });
      continue;
    }

    const firstListItem = listItem(lines[cursor]);
    if (firstListItem) {
      const ordered = firstListItem.ordered;
      const items = [];
      while (cursor < lines.length) {
        const item = listItem(lines[cursor]);
        if (!item || item.ordered !== ordered) break;
        items.push(inlineTokens(item.value));
        cursor += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraphLines = [trimmed];
    cursor += 1;
    while (cursor < lines.length && !isBlockStart(lines[cursor])) {
      paragraphLines.push(lines[cursor].trim());
      cursor += 1;
    }
    blocks.push({
      type: "paragraph",
      children: inlineTokens(paragraphLines.join(" ")),
    });
  }

  return blocks;
}

function mathNode(documentRef, token) {
  const node = documentRef.createElement(token.display ? "div" : "span");
  node.className = token.display
    ? "definition-math definition-math-display"
    : "definition-math definition-math-inline";
  if (!token.closed) return mathFallback(documentRef, node, token.raw);
  try {
    katex.render(token.value, node, {
      displayMode: token.display,
      output: "htmlAndMathml",
      throwOnError: true,
      trust: false,
      strict: "error",
      maxExpand: 1_000,
      maxSize: 20,
      macros: {},
    });
  } catch {
    return mathFallback(documentRef, node, token.raw);
  }
  return node;
}

function mathFallback(documentRef, node, source) {
  node.classList.add("definition-math-fallback");
  const code = documentRef.createElement("code");
  code.textContent = source;
  node.replaceChildren(code);
  return node;
}

function appendInline(documentRef, parent, tokens) {
  for (const token of tokens) {
    if (token.type === "text") {
      parent.append(documentRef.createTextNode(token.value));
      continue;
    }
    if (token.type === "math") {
      parent.append(mathNode(documentRef, token));
      continue;
    }
    if (token.type === "code") {
      const code = documentRef.createElement("code");
      code.textContent = token.value;
      parent.append(code);
      continue;
    }
    if (token.type === "link") {
      const anchor = documentRef.createElement("a");
      anchor.setAttribute("href", token.href);
      if (/^https?:/i.test(token.href)) {
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer nofollow");
        anchor.setAttribute("referrerpolicy", "no-referrer");
      }
      appendInline(documentRef, anchor, token.children);
      parent.append(anchor);
      continue;
    }
    if (token.type === "strong" || token.type === "emphasis") {
      const element = documentRef.createElement(token.type === "strong" ? "strong" : "em");
      appendInline(documentRef, element, token.children);
      parent.append(element);
    }
  }
}

export function renderDefinition(element, definitionSource) {
  if (!element) return;
  const documentRef = element.ownerDocument ?? globalThis.document;
  if (!documentRef) throw new TypeError("A document is required to render a definition");
  const fragment = documentRef.createDocumentFragment();

  for (const block of parseDefinitionMarkdown(definitionSource)) {
    if (block.type === "paragraph") {
      const paragraph = documentRef.createElement("p");
      appendInline(documentRef, paragraph, block.children);
      fragment.append(paragraph);
      continue;
    }
    if (block.type === "list") {
      const list = documentRef.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const listItemElement = documentRef.createElement("li");
        appendInline(documentRef, listItemElement, item);
        list.append(listItemElement);
      }
      fragment.append(list);
      continue;
    }
    if (block.type === "code_block") {
      const pre = documentRef.createElement("pre");
      const code = documentRef.createElement("code");
      code.textContent = block.closed ? block.value : block.raw;
      pre.append(code);
      fragment.append(pre);
      continue;
    }
    if (block.type === "math") fragment.append(mathNode(documentRef, block));
  }

  element.replaceChildren(fragment);
}
