#!/usr/bin/env node

// Opt-in observation of the trusted current web source, not an Accounts unit
// test or a browser/hosted acceptance test. Only synthetic in-memory data is
// created. No source, browser profile, learner database, or artifact is written.
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const usage = "Usage: node accounts/checks/current-runtime-privacy.mjs /absolute/path/to/canonical/web";
const argumentsList = process.argv.slice(2);

if (argumentsList.length !== 1 || !isAbsolute(argumentsList[0])) {
  console.error(usage);
  console.error("No runtime modules were loaded. An explicit absolute web source path is required.");
  process.exitCode = 2;
} else {
  try {
    await checkCurrentRuntime(argumentsList[0]);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

async function checkCurrentRuntime(webSourcePath) {
  // This process has no need for network access. Keep the guards installed for
  // its entire lifetime, including target-module evaluation. This is a guard
  // for the audited browser modules, not a sandbox for arbitrary Node code.
  let networkAttempts = 0;
  function denyNetwork() {
    networkAttempts += 1;
    throw new Error("Network access is forbidden in the current-runtime privacy check");
  }
  for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) {
    Object.defineProperty(globalThis, name, {
      value: denyNetwork,
      writable: false,
      configurable: false,
    });
  }

  const sourcePath = await realpath(webSourcePath);
  if (basename(sourcePath) !== "web") {
    throw new Error("The source argument must identify the canonical web directory");
  }
  const moduleDirectory = join(sourcePath, "js");
  const modulePaths = await Promise.all(
    ["store.js", "webmcp.js"].map(async (name) => {
      const target = await realpath(join(moduleDirectory, name));
      if (!target.startsWith(`${moduleDirectory}${sep}`)) {
        throw new Error(`Refusing a source module outside canonical web/js: ${name}`);
      }
      return target;
    }),
  );

  // Direct target imports are limited to the audited store/tool modules.
  // webmcp.js also imports its own adjacent grading/authoring guide modules.
  const { createMemoryStorage, createStudyStore } = await import(pathToFileURL(modulePaths[0]).href);
  const { WEBMCP_TOOL_NAMES } = await import(pathToFileURL(modulePaths[1]).href);
  const storage = createMemoryStorage();
  const store = createStudyStore({
    catalog: [],
    storage,
    clock: () => new Date("2026-08-30T12:00:00.000Z"),
  });
  const created = store.ingestDeck({
    operation: "create",
    deck: {
      schema_version: "normalized-definition-deck.v2",
      deck_id: "privacy-synthetic",
      title: "Synthetic privacy audit",
      cards: [{
        id: "alpha",
        term: "Alpha",
        definition: "The synthetic first symbol.",
        criteria: ["States the first symbol."],
        tags: [],
      }],
      edges: [],
    },
    idempotency_key: "audit-create",
  });
  const started = store.startStudySession({
    deck_id: created.deck_id,
    limit: 1,
    idempotency_key: "audit-start",
  });
  const syntheticAnswer = "SYNTHETIC-ANSWER-ONLY";
  store.submitGrade({
    session_id: started.session.session_id,
    card_id: started.current_card.card_id,
    expected_card_revision: started.current_card.card_revision,
    expected_session_revision: started.session.session_revision,
    answer_text: syntheticAnswer,
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: [{
      rubric_item_id: started.current_card.required_concepts[0].rubric_item_id,
      status: "met",
      note: "Synthetic test evidence.",
    }],
    feedback: "SYNTHETIC-FEEDBACK-ONLY",
    misconceptions: [],
    confidence: 0.75,
    idempotency_key: "audit-grade",
  });

  const checks = [];
  function equal(name, actual, expected) {
    assert.equal(actual, expected, name);
    checks.push(name);
  }
  const stateKey = "adaptive-study-lab:web-state:v1";
  const state = JSON.parse(storage.getItem(stateKey));
  const card = Object.values(state.personalDecks[created.deck_id].cards)[0];
  equal("card history retains the submitted answer", card.reviewHistory[0].answer_text, syntheticAnswer);
  equal("session history retains the submitted answer", state.sessions[started.session.session_id].history[0].answer_text, syntheticAnswer);
  equal("idempotency receipt retains the submitted answer", state.actionReceipts["webmcp:audit-grade"].result.answer_text, syntheticAnswer);
  equal("deck read excludes historical answer text", JSON.stringify(store.getDeck({ scope: "personal", deck_id: created.deck_id })).includes(syntheticAnswer), false);
  equal("overview excludes historical answer text", JSON.stringify(store.getLearningOverview()).includes(syntheticAnswer), false);
  equal("the current tool surface has 13 tools", WEBMCP_TOOL_NAMES.length, 13);
  equal("the current surface has no export/delete tool", WEBMCP_TOOL_NAMES.some((name) => /export|delete/.test(name)), false);

  store.setDeckArchived({
    deck_id: created.deck_id,
    archived: true,
    expected_revision: store.getSnapshot().personalDecks[created.deck_id].revision,
    client_action_id: "audit-archive",
  });
  equal("archiving retains review history", store.getSnapshot().personalDecks[created.deck_id].cards[card.id].reviewHistory[0].answer_text, syntheticAnswer);

  // Model the current handler's single-key removal in memory. This deliberately
  // does not import app.js, execute a UI handler, or access real localStorage.
  const graphKey = "adaptive-study.graph-pins.v2.privacy-synthetic.1.full";
  storage.setItem(graphKey, JSON.stringify({ alpha: { x: 1, y: 2 } }));
  storage.removeItem(stateKey);
  equal("main-key removal clears study state", storage.getItem(stateKey), null);
  equal("main-key removal leaves a graph-pin key", storage.getItem(graphKey) !== null, true);

  if (networkAttempts !== 0) {
    throw new Error(`The runtime attempted ${networkAttempts} forbidden network operation(s)`);
  }
  console.log(JSON.stringify({
    ok: true,
    assertions: checks.length,
    network_attempts: networkAttempts,
    source_path: sourcePath,
    checks,
    boundary: "Synthetic in-memory source check only; no browser, hosted account, or deletion acceptance.",
  }, null, 2));
}
