import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DECK_BUILD_GUIDE,
  DECK_BUILD_GUIDE_VERSION,
} from "../public/study/js/deck-build-guide.js";
import {
  registerWebMCPTools,
  WEBMCP_TOOL_NAMES,
  WEBMCP_TOOL_SCHEMAS,
} from "../public/study/js/webmcp.js";

const EXPECTED_SOURCE_SHA = "aadd6c476bb54ff83fb7c121d7a3723b36c95b2b8357003652b2c4a08892ad08";
const EXPECTED_SCHEMA_SHA = "4ec18a230191e1ac86fce2a0dddada8ed8b234e2c537dfedc5ed7d1904dbf229";
const EXPECTED_CONSTRAINT_SHA = "785f469eabd147981e9c857a59b0353927d4b12a0fc067a0cb39741c22d4a074";
const EXPECTED_CONTEXT_SHA = "f572b85db872946adf7db7ba4ba01a300e0734a27570a7f5957197e8f6599ec4";

const sha = (value) => createHash("sha256").update(value).digest("hex");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function stripDescriptionAnnotations(value) {
  if (Array.isArray(value)) return value.map(stripDescriptionAnnotations);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !(key === "description" && typeof child === "string"))
      .map(([key, child]) => [key, stripDescriptionAnnotations(child)]),
  );
}

async function captureRegistrations() {
  const registrations = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      modelContext: {
        async registerTool(definition) {
          registrations.push(definition);
        },
      },
    },
  });
  const store = new Proxy({}, { get: () => () => ({}) });
  try {
    const receipt = await registerWebMCPTools({ store });
    assert.equal(receipt.supported, true);
    assert.equal(receipt.registered.length, 13);
    return registrations;
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else delete globalThis.document;
  }
}

test("WebMCP keeps the complete authoring guide available while shipping compact discovery metadata", async () => {
  assert.equal(DECK_BUILD_GUIDE_VERSION, "deck-generation-guide.v1.9");
  assert.match(DECK_BUILD_GUIDE, /legacy cross-course prerequisite IDs/);
  assert.match(DECK_BUILD_GUIDE, /do not gate Study|Study gating/);
  assert.match(DECK_BUILD_GUIDE, /three or more as a presumptive semantic defect/);
  assert.match(DECK_BUILD_GUIDE, /under the theorem hypotheses.*not a substitute/);
  assert.match(DECK_BUILD_GUIDE, /integral_a\^b/);
  assert.equal(WEBMCP_TOOL_NAMES.length, 13);
  assert.equal(Object.keys(WEBMCP_TOOL_SCHEMAS).length, 13);
  assert.equal(sha(JSON.stringify(stable(WEBMCP_TOOL_SCHEMAS))), EXPECTED_SCHEMA_SHA);
  assert.equal(
    sha(JSON.stringify(stable(stripDescriptionAnnotations(WEBMCP_TOOL_SCHEMAS)))),
    EXPECTED_CONSTRAINT_SHA,
  );

  for (const relative of [
    "../public/study/js/webmcp.js",
    "../integration/core/js/webmcp.js",
  ]) {
    const source = await readFile(new URL(relative, import.meta.url));
    assert.equal(sha(source), EXPECTED_SOURCE_SHA, relative);
  }
});

test("compact descriptions remove stale dependency claims and describe the explicit Study takeover boundary", async () => {
  const registrations = await captureRegistrations();
  const byName = new Map(registrations.map((definition) => [definition.name, definition]));
  const allDescriptions = registrations.map(({ description }) => description).join("\n");

  assert.doesNotMatch(allDescriptions, /cross[- ](?:course|deck)/i);
  assert.doesNotMatch(allDescriptions, /legacy .*prerequisite/i);
  assert.doesNotMatch(allDescriptions, /automatic(?:ally)? (?:install|add).*dependenc/i);
  assert.doesNotMatch(allDescriptions, /automatic(?:ally)?.*takeover/i);
  assert.doesNotMatch(allDescriptions, /dependency closure/i);
  assert.match(byName.get("validate_deck").description, /Candidate-v2 IDs and prerequisite edges are deck-local/);
  for (const name of ["start_study_session", "submit_grade", "finish_study_session"]) {
    const description = byName.get(name).description;
    assert.match(description, /never replaces an active grant/);
    assert.match(description, /superseded.*Continue here.*Study UI/);
  }
  assert.match(byName.get("get_study_session").description, /lock-free read remains available to a superseded client/);
  assert.match(byName.get("get_study_session").description, /neither acquires nor changes the Study-writer grant/);
});

test("actual 13-tool registration metadata retains its compact frozen receipt", async () => {
  const payload = (await captureRegistrations()).map(({ execute: _execute, ...metadata }) => metadata);
  const serialized = JSON.stringify(stable(payload));
  assert.equal(Buffer.byteLength(serialized), 44_587);
  assert.equal(sha(serialized), EXPECTED_CONTEXT_SHA);
});
