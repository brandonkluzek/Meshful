import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WEBMCP_TOOL_SCHEMAS } from "../integration/core/js/webmcp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bytes = (relative) => readFile(path.join(root, relative));
const text = async (relative) => (await bytes(relative)).toString("utf8");
const digest = async (relative) => createHash("sha256").update(await bytes(relative)).digest("hex");
const selection = JSON.parse(await text("integration/SELECTED_INPUTS.json"));
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function applyOverrides(base, overrides) {
  const baseByPath = new Map(base.map((item) => [item.path, item]));
  assert.equal(baseByPath.size, base.length, "predecessor selection contains duplicate paths");
  const overrideByPath = new Map();
  for (const item of overrides) {
    assert.equal(overrideByPath.has(item.path), false, `duplicate successor override: ${item.path}`);
    const predecessor = baseByPath.get(item.path);
    assert.ok(predecessor, `successor path is absent from predecessor: ${item.path}`);
    assert.equal(item.predecessor_sha256, predecessor.sha256, `${item.path}: predecessor hash`);
    overrideByPath.set(item.path, item);
  }
  return base.map((item) => {
    const override = overrideByPath.get(item.path);
    return override ? { path: item.path, sha256: override.sha256 } : item;
  });
}

function effectiveV7RuntimeFiles() {
  const recovered = applyOverrides(
    selection.backend_v7_writer_successor.runtime_selected_files,
    selection.post_v35_successors.backend_v7_account_command_recovery.runtime_file_overrides,
  );
  const selfGrading = applyOverrides(
    recovered,
    selection.post_v35_successors.manual_self_grading_v1.runtime_file_overrides,
  );
  return applyOverrides(
    selfGrading,
    selection.post_v35_successors.release_v42_non_answer_grade_v1.runtime_file_overrides,
  );
}

function effectiveV7BrowserFiles() {
  const recovered = applyOverrides(
    selection.backend_v7_writer_successor.browser_files,
    selection.post_v35_successors.backend_v7_account_command_recovery.browser_file_overrides,
  );
  const selfGrading = applyOverrides(
    recovered,
    selection.post_v35_successors.manual_self_grading_v1.backend_browser_file_overrides,
  );
  return applyOverrides(
    selfGrading,
    selection.post_v35_successors.release_v42_non_answer_grade_v1.backend_browser_file_overrides,
  );
}

function effectiveRecoveredBrowserFiles() {
  return applyOverrides(
    selection.post_v35_successors.browser_account_recovery.files,
    selection.post_v35_successors.browser_account_command_queue.file_overrides,
  );
}

function effectiveStartupBrowserFiles() {
  const startup = applyOverrides(
    effectiveRecoveredBrowserFiles(),
    selection.post_v35_successors.empty_account_snapshot.file_overrides,
  );
  const selfGrading = applyOverrides(
    startup,
    selection.post_v35_successors.manual_self_grading_v1.startup_file_overrides,
  );
  return applyOverrides(
    selfGrading,
    selection.post_v35_successors.release_v42_non_answer_grade_v1.startup_file_overrides,
  );
}

function effectiveAccountFocusedTests() {
  return applyOverrides(
    selection.post_v35_successors.browser_account_command_queue.focused_tests,
    selection.post_v35_successors.empty_account_snapshot.focused_tests,
  );
}

function effectiveReleaseBrowserFiles() {
  const v40 = applyOverrides(
    selection.post_v35_successors.manual_self_grading_v1.browser_files,
    selection.post_v35_successors.release_v40_candidate.browser_file_overrides,
  );
  const visualPolish = applyOverrides(
    v40,
    selection.post_v35_successors.release_v42_visual_polish.browser_file_overrides,
  );
  return applyOverrides(
    visualPolish,
    selection.post_v35_successors.release_v42_non_answer_grade_v1.browser_file_overrides,
  );
}

function effectiveReleaseFocusedTests() {
  const v40 = applyOverrides(
    selection.post_v35_successors.manual_self_grading_v1.focused_tests,
    selection.post_v35_successors.release_v40_candidate.focused_test_overrides,
  );
  return applyOverrides(
    v40,
    selection.post_v35_successors.release_v42_non_answer_grade_v1.focused_test_overrides,
  );
}

function effectiveGraphBrowserFiles() {
  return applyOverrides(
    effectiveReleaseBrowserFiles(),
    selection.post_v35_successors.release_v43_graph_candidate.release_browser_file_overrides,
  );
}

function effectiveMasteryMotionBrowserFiles() {
  return applyOverrides(
    effectiveGraphBrowserFiles(),
    selection.post_v35_successors.release_v45_mastery_motion.browser_file_overrides,
  );
}

function effectiveAccountClarityBrowserFiles() {
  const responsive = applyOverrides(
    effectiveMasteryMotionBrowserFiles(),
    selection.post_v35_successors.release_v46_responsive_shell.browser_file_overrides,
  );
  const graphDefault = applyOverrides(
    responsive,
    selection.post_v35_successors.release_v47_graph_default_overview.browser_file_overrides,
  );
  const sessionControls = applyOverrides(
    graphDefault,
    selection.post_v35_successors.release_v48_session_controls.browser_file_overrides,
  );
  return applyOverrides(
    sessionControls,
    selection.post_v35_successors.release_v49_account_clarity.browser_file_overrides,
  );
}

function effectiveGraphReleaseSelectedFiles() {
  return applyOverrides(
    selection.post_v35_successors.release_v40_candidate.selected_files,
    selection.post_v35_successors.release_v43_graph_candidate.release_selected_file_overrides,
  );
}

function effectiveGraphRuntimeFiles() {
  const candidate = selection.post_v35_successors.release_v43_graph_candidate;
  return [
    ...applyOverrides(
      selection.post_v35_successors.graph_learner_progress_v1.runtime_files,
      candidate.runtime_file_overrides,
    ),
    ...candidate.runtime_file_additions,
  ];
}

function effectiveMasteryMotionRuntimeFiles() {
  return applyOverrides(
    effectiveGraphRuntimeFiles(),
    selection.post_v35_successors.release_v45_mastery_motion.runtime_file_overrides,
  );
}

function effectiveAccountClarityRuntimeFiles() {
  const responsive = applyOverrides(
    effectiveMasteryMotionRuntimeFiles(),
    selection.post_v35_successors.release_v46_responsive_shell.runtime_file_overrides,
  );
  const graphDefault = applyOverrides(
    responsive,
    selection.post_v35_successors.release_v47_graph_default_overview.runtime_file_overrides,
  );
  const sessionControls = applyOverrides(
    graphDefault,
    selection.post_v35_successors.release_v48_session_controls.runtime_file_overrides,
  );
  return applyOverrides(
    sessionControls,
    selection.post_v35_successors.release_v49_account_clarity.runtime_file_overrides,
  );
}

function effectiveAccountClaritySelectedFiles() {
  const graphDefault = applyOverrides(
    effectiveGraphReleaseSelectedFiles(),
    selection.post_v35_successors.release_v47_graph_default_overview.selected_file_overrides,
  );
  const sessionControls = applyOverrides(
    graphDefault,
    selection.post_v35_successors.release_v48_session_controls.selected_file_overrides,
  );
  return applyOverrides(
    sessionControls,
    selection.post_v35_successors.release_v49_account_clarity.selected_file_overrides,
  );
}

function effectiveGraphFocusedTests() {
  const candidate = selection.post_v35_successors.release_v43_graph_candidate;
  return [
    ...applyOverrides(
      selection.post_v35_successors.graph_learner_progress_v1.focused_tests,
      candidate.graph_focused_test_overrides,
    ),
    ...candidate.graph_focused_test_additions,
  ];
}

function effectiveGraphDefaultFocusedTests() {
  return applyOverrides(
    effectiveGraphFocusedTests(),
    selection.post_v35_successors.release_v47_graph_default_overview.graph_focused_test_overrides,
  );
}

function effectiveGraphReleaseFocusedTests() {
  return applyOverrides(
    effectiveReleaseFocusedTests(),
    selection.post_v35_successors.release_v43_graph_candidate.release_focused_test_overrides,
  );
}

function effectiveSessionControlReleaseFocusedTests() {
  return applyOverrides(
    effectiveGraphReleaseFocusedTests(),
    selection.post_v35_successors.release_v48_session_controls.release_focused_test_overrides,
  );
}

function effectiveGraphVisualPolishFocusedTests() {
  return applyOverrides(
    selection.post_v35_successors.release_v42_visual_polish.focused_tests,
    selection.post_v35_successors.release_v43_graph_candidate.visual_focused_test_overrides,
  );
}

function effectiveMasteryMotionVisualFocusedTests() {
  return applyOverrides(
    effectiveGraphVisualPolishFocusedTests(),
    selection.post_v35_successors.release_v45_mastery_motion.visual_focused_test_overrides,
  );
}

function effectiveAccountClarityVisualFocusedTests() {
  const responsive = applyOverrides(
    effectiveMasteryMotionVisualFocusedTests(),
    selection.post_v35_successors.release_v46_responsive_shell.visual_focused_test_overrides,
  );
  const graphDefault = applyOverrides(
    responsive,
    selection.post_v35_successors.release_v47_graph_default_overview.visual_focused_test_overrides,
  );
  const sessionControls = applyOverrides(
    graphDefault,
    selection.post_v35_successors.release_v48_session_controls.visual_focused_test_overrides,
  );
  return applyOverrides(
    sessionControls,
    selection.post_v35_successors.release_v49_account_clarity.visual_focused_test_overrides,
  );
}

function effectiveAccountClarityStartupBrowserFiles() {
  return applyOverrides(
    effectiveStartupBrowserFiles(),
    selection.post_v35_successors.release_v49_account_clarity.startup_file_overrides,
  );
}

function effectiveAccountClarityFocusedTests() {
  return applyOverrides(
    selection.post_v35_successors.release_v45_mastery_motion.focused_test_additions,
    selection.post_v35_successors.release_v49_account_clarity.focused_test_overrides,
  );
}

async function filesBelow(relative) {
  const base = path.join(root, relative);
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else output.push(path.relative(root, absolute));
    }
  }
  await visit(base);
  return output.sort(compareText);
}

test("the source allowlist retains exact Accounts and Backend successor bytes", async () => {
  assert.equal(selection.schema, "meshful-sites-selected-inputs.v1");
  assert.equal(selection.accounts_v4.source_manifest_sha256,
    "bd05466bcff38498bc7e297f89e67ae8909c54b23842d3ac950fdb8cd2c4de39");
  assert.equal(selection.backend_v3.source_manifest_sha256,
    "8ea8096550a100c78177160858bc43f4b7e15ad26a656173e1fb61c967f374cb");
  assert.equal(selection.backend_v3.source_payload_sha256,
    "f238f6fc8a66d6a24164730a2c8987356187799624e6196fce499ba94123f39a");
  assert.equal(selection.backend_v4_archive_successor.source_manifest_sha256,
    "a8c48bb05652665da99c58e29b3530049d59902287676999c3190d4a98ffce00");
  assert.equal(selection.backend_v4_archive_successor.source_payload_sha256,
    "2b06191616208dceefb0fab4ac66f16f52bc914c950e09d4662814fc94b824b0");
  assert.equal(selection.backend_v4_archive_successor.upstream_manifest_sha256,
    "2b48efedfd92c66f1ae75fc85ca1ab0f9960a6d4b3ebd5f1b26c465a2509bd51");
  assert.equal(selection.backend_v4_archive_successor.upstream_payload_sha256,
    "99add73b49e97000da6ad762147b787035e7f91d2df0deeada0710f6ac828f56");
  assert.equal(selection.backend_v5_catalog_successor.source_manifest_sha256,
    "f9d4a86ffb5cabc3e80f88b2f6958d33cd0dbe0dd3cd15419081addc36527243");
  assert.equal(selection.backend_v5_catalog_successor.source_payload_sha256,
    "68029d33c49116d9b90edafd6905bfbe5f9bd2fad4c606fee91b1f3c4c5ee732");
  assert.equal(selection.backend_v5_catalog_successor.upstream_manifest_sha256,
    "ddbb4ed04aca6990fd9543255ce64af39ff913f6595000bc2e07419ee7a2a7ce");
  assert.equal(selection.backend_v5_catalog_successor.upstream_payload_sha256,
    "e40fc3762592c6f0c7d44087bc034a480a8a6e34470f5d4adc972d76521ccc65");
  assert.equal(selection.backend_v7_writer_successor.source_manifest_sha256,
    "f2eddbc8c577c214513bb341f10849ef65e2d39aaf56ccee37f42a8515ff0a6d");
  assert.equal(selection.backend_v7_writer_successor.source_payload_sha256,
    "7f1978ce77ca218fe7467477fc4911ca7220e26d1ea656fd09cb65f695315522");
  const recoverySuccessor = selection.post_v35_successors.backend_v7_account_command_recovery;
  assert.equal(recoverySuccessor.predecessor_selection, "backend_v7_writer_successor");
  assert.equal(recoverySuccessor.predecessor_source_manifest_sha256,
    selection.backend_v7_writer_successor.source_manifest_sha256);
  assert.equal(recoverySuccessor.predecessor_source_payload_sha256,
    selection.backend_v7_writer_successor.source_payload_sha256);
  assert.equal(recoverySuccessor.d1_migration_change, false);
  assert.equal(recoverySuccessor.public_webmcp_tool_change, false);
  assert.deepEqual(selection.post_v35_successors.browser_account_recovery.files.map((item) => ({
    path: item.path,
    predecessor_sha256: item.predecessor_sha256,
  })), [
    {
      path: "public/study/js/account-runtime.js",
      predecessor_sha256: "e7945a35f5afa32afac364e29edf7588bf280579492e69c19b01c6b86e5b694e",
    },
    {
      path: "public/study/accounts/browser-study-session.mjs",
      predecessor_sha256: "ed3d75a1220c6d36d580564865daf77a7c6efcb0984d410e6262f9cc8aa28741",
    },
  ]);
  const queueSuccessor = selection.post_v35_successors.browser_account_command_queue;
  assert.equal(queueSuccessor.predecessor_selection, "browser_account_recovery");
  assert.equal(queueSuccessor.source_commit, "f2a08f3c865667352e498fd2d7363969b3706637");
  assert.equal(queueSuccessor.source_handoff_sha256,
    "c8be36d1ff22e50a009cf2d041c27f61932d112a174b122584368592b17a1ad3");
  assert.deepEqual(queueSuccessor.file_overrides, [{
    path: "public/study/accounts/browser-study-session.mjs",
    predecessor_sha256: "c02435cefa9b6aaa7a8d2c724f725f9743eab026bd26476ed9b06d6283f5ebad",
    sha256: "d243f28cb899320e744d1469b5b17cdcab866974713a880e6f0883f12d58894a",
  }]);
  assert.deepEqual(queueSuccessor.focused_tests, [{
    path: "tests/account-runtime-v6.test.mjs",
    predecessor_sha256: "85f1ac6d3c0c468d7f3d44c1e4b4826c9cba57a335739499a31284d954fd2b97",
    source_sha256: "0c92e6ef4fd4fd07e4bd6aa3e338e5de4616af1f236d98fb0f9ae24d48876196",
    sha256: "0c92e6ef4fd4fd07e4bd6aa3e338e5de4616af1f236d98fb0f9ae24d48876196",
    integration: "byte-exact",
  }]);
  assert.equal(queueSuccessor.d1_migration_change, false);
  assert.equal(queueSuccessor.public_webmcp_tool_change, false);
  const emptyAccountSuccessor = selection.post_v35_successors.empty_account_snapshot;
  assert.equal(emptyAccountSuccessor.predecessor_selection, "browser_account_command_queue");
  assert.equal(emptyAccountSuccessor.source_commit, "37a801c48f1edcd1aa5c51afb199ad0fd5957486");
  assert.deepEqual(emptyAccountSuccessor.file_overrides, [{
    path: "public/study/js/account-runtime.js",
    predecessor_sha256: "b80bb0627ab1b32986959e86aa837a0b57d8cffd83c1ad664f0eb1682a1fc468",
    sha256: "dbb62775f3830bf099f1e1de0116f663de6e1aca7d6dd6b5c3bf2ede5cb6054f",
  }]);
  assert.deepEqual(emptyAccountSuccessor.focused_tests, [{
    path: "tests/account-runtime-v6.test.mjs",
    predecessor_sha256: "0c92e6ef4fd4fd07e4bd6aa3e338e5de4616af1f236d98fb0f9ae24d48876196",
    source_sha256: "9efef58d5c75b47230fabdf5a4129279638fdeccf7c4de48046d3e59eaedf3b9",
    sha256: "9efef58d5c75b47230fabdf5a4129279638fdeccf7c4de48046d3e59eaedf3b9",
    integration: "byte-exact",
  }]);
  assert.deepEqual(emptyAccountSuccessor.contract, {
    null_catalog_ref_requires_revision_zero: true,
    null_catalog_ref_requires_null_state: true,
  });
  assert.equal(emptyAccountSuccessor.d1_migration_change, false);
  assert.equal(emptyAccountSuccessor.public_webmcp_tool_change, false);
  const selfGradingSuccessor = selection.post_v35_successors.manual_self_grading_v1;
  assert.deepEqual(selfGradingSuccessor.contract, {
    rating_buckets: ["again", "hard", "good", "easy"],
    answer_revealed: true,
    agent_evidence_fields_absent: true,
    exactly_once_receipt: "submit_self_grade",
    cancel_is_presentation_only: true,
  });
  assert.equal(selfGradingSuccessor.d1_migration_change, false);
  assert.equal(selfGradingSuccessor.public_webmcp_tool_change, false);
  const graphSuccessor = selection.post_v35_successors.graph_learner_progress_v1;
  assert.equal(graphSuccessor.predecessor_selection, "graph_revision_16");
  assert.equal(graphSuccessor.source_commit, "6a18f658f832f8beea9e9afa55b4f11e689712ad");
  assert.equal(graphSuccessor.source_patch_sha256,
    "a74615fb887adfba95790c17e6b9d2ccd5accc686fcf70f0a7e2c0c44c4a0bc0");
  assert.equal(graphSuccessor.asset_query_token, "v40-learner-graph");
  assert.equal(graphSuccessor.graph_query_revision, "graph-revision-17");
  assert.deepEqual(graphSuccessor.contract, {
    personal_progress_source: "learner",
    library_progress_source: "structure",
    example_progress_excluded: true,
    library_can_study: false,
    personal_can_study: true,
  });
  assert.equal(graphSuccessor.d1_migration_change, false);
  assert.equal(graphSuccessor.public_webmcp_tool_change, false);
  const releaseCandidate = selection.post_v35_successors.release_v40_candidate;
  assert.equal(releaseCandidate.predecessor_commit, "48cbd6d24754173d889fe4fbdea103e95e72562e");
  assert.deepEqual(releaseCandidate.contract, {
    public_heading: "Deck Library",
    committed_reveal_survives_reload: true,
    advance_is_presentation_only: true,
    canonical_session_queue_unchanged: true,
    pending_marker_contains_no_definition_or_answer: true,
  });
  assert.equal(releaseCandidate.d1_migration_change, false);
  assert.equal(releaseCandidate.public_webmcp_tool_change, false);
  const visualPolish = selection.post_v35_successors.release_v42_visual_polish;
  assert.equal(visualPolish.predecessor_commit, "7e1e443d4a3e92b156c591443b36f3ad35dd325c");
  assert.deepEqual(visualPolish.contract, {
    inactive_filter_surface: "surface-1",
    active_filter_surface: "surface-2",
    brand_wordmark_px: 20,
    deck_metadata_bottom_aligned: true,
    graph_archive_secondary_surface_equal: true,
  });
  assert.equal(visualPolish.d1_migration_change, false);
  assert.equal(visualPolish.public_webmcp_tool_change, false);
  const nonAnswerGrade = selection.post_v35_successors.release_v42_non_answer_grade_v1;
  assert.equal(nonAnswerGrade.predecessor_commit, "7e1e443d4a3e92b156c591443b36f3ad35dd325c");
  assert.deepEqual(nonAnswerGrade.contract, {
    attempt_kinds: ["reveal", "skip"],
    fixed_rating: "again",
    reveal_answer_revealed: true,
    skip_answer_revealed: false,
    fabricated_evidence_fields_absent: true,
    exactly_once_receipt: "submit_non_answer_grade",
    skip_omits_reviewed_card: true,
  });
  assert.equal(nonAnswerGrade.d1_migration_change, false);
  assert.equal(nonAnswerGrade.public_webmcp_tool_change, false);
  const graphCandidate = selection.post_v35_successors.release_v43_graph_candidate;
  assert.equal(graphCandidate.predecessor_commit, "dd578874933241eb8d679f10e3d5726c2ad6b855");
  assert.deepEqual(graphCandidate.predecessor_selections, [
    "graph_learner_progress_v1",
    "release_v40_candidate",
    "release_v42_visual_polish",
    "release_v42_non_answer_grade_v1",
  ]);
  assert.equal(graphCandidate.asset_query_token, "v43-real-progress-graph");
  assert.equal(graphCandidate.graph_query_revision, "graph-revision-18");
  assert.deepEqual(graphCandidate.contract, {
    all_active_cards_and_internal_edges_visible: true,
    personal_progress_source: "retained_learner_records_only",
    library_progress_source: "neutral_structure",
    selected_direct_neighborhood_opacity: 1,
    unrelated_node_opacity: 0.6,
    single_cubic_s_curve_per_edge: true,
    labels_hidden_at_overview_zoom: true,
  });
  assert.equal(graphCandidate.d1_migration_change, false);
  assert.equal(graphCandidate.public_webmcp_tool_change, false);
  const masteryMotion = selection.post_v35_successors.release_v45_mastery_motion;
  assert.equal(masteryMotion.predecessor_commit, "23f73b3e39839a36296e8bd3f254ff79612e7a40");
  assert.equal(masteryMotion.predecessor_selection, "release_v43_graph_candidate");
  assert.equal(masteryMotion.asset_query_token, "v45-mastery-motion");
  assert.deepEqual(masteryMotion.contract, {
    loop_duration_ms: 5800,
    slow_lead_percent: 60,
    burst_end_percent: 72,
    slow_finish_percent: 28,
    reduced_motion_static: true,
  });
  assert.equal(masteryMotion.d1_migration_change, false);
  assert.equal(masteryMotion.public_webmcp_tool_change, false);
  const responsiveShell = selection.post_v35_successors.release_v46_responsive_shell;
  assert.equal(responsiveShell.source_commit, "c82c5da050c5cb6a06eb29509cc347e5405b62d9");
  assert.equal(responsiveShell.predecessor_selection, "release_v45_mastery_motion");
  assert.deepEqual(responsiveShell.contract, {
    desktop_shell_uses_full_viewport: true,
    desktop_navigation_cannot_clip: true,
    compact_navigation_breakpoint_px: 920,
  });
  assert.equal(responsiveShell.d1_migration_change, false);
  assert.equal(responsiveShell.public_webmcp_tool_change, false);
  const graphDefault = selection.post_v35_successors.release_v47_graph_default_overview;
  assert.equal(graphDefault.source_commit, "5d7d7803c23a1c5bac8495daf0aac4f2b92d1fe7");
  assert.equal(graphDefault.predecessor_selection, "release_v46_responsive_shell");
  assert.equal(graphDefault.asset_query_token, "v47-graph-default-overview");
  assert.deepEqual(graphDefault.contract, {
    personal_graph_default: "full_deck_overview",
    library_graph_default: "full_deck_overview",
    explicit_card_focus_preserved: true,
  });
  assert.equal(graphDefault.d1_migration_change, false);
  assert.equal(graphDefault.public_webmcp_tool_change, false);
  const sessionControls = selection.post_v35_successors.release_v48_session_controls;
  assert.equal(sessionControls.source_commit, "4a2b9730566c434ef8091613eb7f6e2eef4edb9d");
  assert.equal(sessionControls.predecessor_selection, "release_v47_graph_default_overview");
  assert.equal(sessionControls.asset_query_token, "v48-session-controls");
  assert.deepEqual(sessionControls.contract, {
    agent_host_uses_agent_led_controls: true,
    standalone_browser_keeps_manual_controls: true,
    skip_action_uses_compact_icon: true,
    desktop_study_stage_is_vertically_centered: true,
  });
  assert.equal(sessionControls.d1_migration_change, false);
  assert.equal(sessionControls.public_webmcp_tool_change, false);
  const accountClarity = selection.post_v35_successors.release_v49_account_clarity;
  assert.equal(accountClarity.predecessor_commit, "4a2b9730566c434ef8091613eb7f6e2eef4edb9d");
  assert.equal(accountClarity.predecessor_selection, "release_v48_session_controls");
  assert.equal(accountClarity.asset_query_token, "v49-account-clarity");
  assert.deepEqual(accountClarity.contract, {
    account_state_copy: "saved_not_continuously_synced",
    guest_data_prompt_requires_empty_account: true,
    claim_replay_requires_confirmation: true,
    pending_recovery_remains_visible: true,
    generic_recovery_controls_removed: true,
  });
  assert.equal(accountClarity.d1_migration_change, false);
  assert.equal(accountClarity.public_webmcp_tool_change, false);
  const combined = selection.post_v35_successors.release_v50_combined;
  assert.equal(combined.base_source_commit, "514a779b1c823422bafbca32519c9b4a26490928");
  assert.equal(combined.asset_query_token, "v50-demo-mode");
  assert.deepEqual(combined.contract, {
    demo_state_is_memory_only: true,
    artificial_history_is_labeled: true,
    production_graph_uses_learner_records: true,
    session_takeover_controls_retained: true,
    initial_service_busy_retry_is_bounded: true,
    active_session_start_conflict_does_not_block_grade: true,
  });
  assert.equal(combined.d1_migration_change, false);
  assert.equal(combined.public_webmcp_tool_change, false);
  const recoveryCopy = selection.post_v35_successors.release_v51_recovery_copy;
  assert.equal(recoveryCopy.predecessor_commit, "5ed3a0468d9d73935952ccb6ffd8aa249746474b");
  assert.equal(recoveryCopy.predecessor_selection, "release_v50_combined");
  assert.equal(recoveryCopy.asset_query_token, "v51-recovery-copy");
  assert.deepEqual(recoveryCopy.contract, {
    guest_data_copy_is_distinct: true,
    pending_command_copy_is_distinct: true,
    dismissed_recovery_remains_in_privacy: true,
    nonempty_account_merge_is_not_implied: true,
  });
  assert.equal(recoveryCopy.d1_migration_change, false);
  assert.equal(recoveryCopy.public_webmcp_tool_change, false);
  const combinedV53 = selection.post_v35_successors.release_v53_combined;
  assert.equal(combinedV53.predecessor_commit, "6e4cfdd0d7d29b0b7f2ea2ffca44ff334b515449");
  assert.equal(combinedV53.predecessor_selection, "release_v51_recovery_copy");
  assert.equal(combinedV53.asset_query_token, "v53-neutral-attention");
  assert.deepEqual(combinedV53.contract, {
    stale_session_routes_return_to_study: true,
    deck_switch_requires_explicit_interrupt: true,
    attention_treatment_is_neutral_grey: true,
    attention_copy_remains_explicit: true,
  });
  assert.equal(combinedV53.d1_migration_change, false);
  assert.equal(combinedV53.public_webmcp_tool_change, false);
  const demoMetrics = selection.post_v35_successors.release_v55_demo_metrics;
  assert.equal(demoMetrics.base_source_commit, "b6cc4720672eb7364a561fd81ebf3a5093a865dc");
  assert.equal(demoMetrics.predecessor_selection, "release_v53_combined");
  assert.equal(demoMetrics.asset_query_token, "v55-demo-metrics");
  assert.deepEqual(demoMetrics.contract, {
    normal_mode_header_unchanged: true,
    active_demo_status_is_in_header: true,
    full_width_demo_banner_removed: true,
    demo_state_is_memory_only: true,
    artificial_history_is_labeled: true,
    active_due_count: 19,
    weekly_review_count: 118,
    current_streak_days: 24,
    active_deck_mastery_percentages: [17, 36, 66, 100],
    account_recovery_copy_retained: true,
    stale_session_handoff_fix_retained: true,
    account_difference_prompt_retained: true,
  });
  assert.equal(demoMetrics.d1_migration_change, false);
  assert.equal(demoMetrics.public_webmcp_tool_change, false);
  const guestAccountData = selection.post_v35_successors.release_v56_guest_account_data;
  assert.equal(guestAccountData.base_source_commit, "f30f4e27b549d256326264fff65779a03ddb63c6");
  assert.equal(guestAccountData.predecessor_selection, "release_v55_demo_metrics");
  assert.equal(guestAccountData.asset_query_token, "v56-guest-account-data");
  assert.deepEqual(guestAccountData.contract, {
    prompt_requires_meaningful_browser_data: true,
    destination_account_must_be_empty: true,
    guest_to_account_reason_is_explicit: true,
    prompt_copy_is_one_two_sentence_paragraph: true,
    uncertain_retries_remain_in_data_privacy: true,
    demo_metrics_release_retained: true,
  });
  assert.equal(guestAccountData.d1_migration_change, false);
  assert.equal(guestAccountData.public_webmcp_tool_change, false);
  const demoErrorPolish = selection.post_v35_successors.release_v57_demo_error_polish;
  assert.equal(demoErrorPolish.base_source_commit, "82c7787cfdc7dcc6fbba41459ca0a1aa980858df");
  assert.equal(demoErrorPolish.predecessor_selection, "release_v56_guest_account_data");
  assert.equal(demoErrorPolish.asset_query_token, "v57-demo-error-polish");
  assert.deepEqual(demoErrorPolish.contract, {
    demo_control_is_white: true,
    realistic_demo_metrics_retained: true,
    guest_data_prompt_gate_retained: true,
    demo_state_remains_memory_only: true,
    startup_error_has_one_plain_sentence: true,
    account_reconnect_button_removed: true,
    retry_action_preserved: true,
  });
  assert.equal(demoErrorPolish.d1_migration_change, false);
  assert.equal(demoErrorPolish.public_webmcp_tool_change, false);
  const accountErrorDialog = selection.post_v35_successors.release_v58_account_error_dialog;
  assert.equal(accountErrorDialog.base_source_commit, "961ce70a7aadb3857984a7a8c07510cfa3ab8d42");
  assert.equal(accountErrorDialog.predecessor_selection, "release_v57_demo_error_polish");
  assert.equal(accountErrorDialog.asset_query_token, "v58-account-error-dialog");
  assert.deepEqual(accountErrorDialog.contract, {
    account_button_works_during_fatal_state: true,
    failed_account_dialog_is_identity_safe: true,
    retry_action_available_in_account_dialog: true,
    v57_demo_and_error_polish_retained: true,
  });
  assert.equal(accountErrorDialog.d1_migration_change, false);
  assert.equal(accountErrorDialog.public_webmcp_tool_change, false);
  const studySession = selection.post_v35_successors.release_v59_study_session;
  assert.equal(studySession.base_source_commit, "867a633f6018987ebce1c4bf92dababbd4bb814d");
  assert.equal(studySession.predecessor_selection, "release_v58_account_error_dialog");
  assert.equal(studySession.asset_query_token, "v59-study-session");
  assert.deepEqual(studySession.contract, {
    due_progress_is_plain_text: true,
    progress_bar_is_determinate: true,
    continuous_progress_has_no_looping_animation: true,
    continuous_progress_uses_neutral_to_warm_color: true,
    grade_controls_are_opt_in_below_card: true,
    agent_grade_tools_remain_available: true,
    mobile_exit_target_minimum_px: 48,
    guest_data_prompt_gate_retained: true,
    demo_error_polish_retained: true,
    account_error_dialog_retained: true,
  });
  assert.equal(studySession.d1_migration_change, false);
  assert.equal(studySession.public_webmcp_tool_change, false);
  const demoExit = selection.post_v35_successors.release_v60_demo_exit;
  assert.equal(demoExit.base_source_commit, "2ea65d9990faf284add48fbef190b1e1dabb98eb");
  assert.equal(demoExit.predecessor_selection, "release_v59_study_session");
  assert.equal(demoExit.asset_query_token, "v60-demo-exit");
  assert.deepEqual(demoExit.contract, {
    demo_entry_control_is_neutral: true,
    active_demo_exit_is_light_grey: true,
    active_demo_exit_copy: "Exit Demo?",
    active_demo_status_remains_in_header: true,
    full_width_demo_banner_remains_removed: true,
    demo_state_remains_memory_only: true,
    v59_study_session_retained: true,
  });
  assert.equal(demoExit.d1_migration_change, false);
  assert.equal(demoExit.public_webmcp_tool_change, false);
  const studyTakeover = selection.post_v35_successors.release_v61_study_takeover;
  assert.equal(studyTakeover.base_source_commit, "1eb49f5f10b229a751d3ea5e6425a44b8f87210b");
  assert.equal(studyTakeover.predecessor_selection, "release_v60_demo_exit");
  assert.equal(studyTakeover.asset_query_token, "v61-study-takeover");
  assert.deepEqual(studyTakeover.contract, {
    active_session_hero_eyebrow_removed: true,
    active_session_yellow_state_removed: true,
    takeover_modal_eyebrow_removed: true,
    takeover_copy_is_concise: true,
    takeover_revokes_other_device_writer: true,
    takeover_modal_max_width_px: 520,
    takeover_close_target_minimum_px: 44,
    v60_demo_exit_retained: true,
  });
  assert.equal(studyTakeover.d1_migration_change, false);
  assert.equal(studyTakeover.public_webmcp_tool_change, false);
  const archiveResponse = selection.post_v35_successors.release_v62_archive_response;
  assert.equal(archiveResponse.base_source_commit, "f02bfcfc3b314769107d88095edad08696ad96a9");
  assert.equal(archiveResponse.predecessor_selection, "release_v61_study_takeover");
  assert.equal(archiveResponse.asset_query_token, "v62-archive-response");
  assert.deepEqual(archiveResponse.contract, {
    archive_shows_immediate_pending_state: true,
    confirmed_archive_updates_visible_decks_before_refresh: true,
    full_account_refresh_runs_in_background: true,
    archive_server_confirmation_remains_required: true,
    v61_study_takeover_retained: true,
  });
  assert.equal(archiveResponse.d1_migration_change, false);
  assert.equal(archiveResponse.public_webmcp_tool_change, false);
  const demoExitLabel = selection.post_v35_successors.release_v63_demo_exit_label;
  assert.equal(demoExitLabel.base_source_commit, "d0035b7a4820ecb08afeb95b62d9d15236df5810");
  assert.equal(demoExitLabel.predecessor_selection, "release_v62_archive_response");
  assert.equal(demoExitLabel.asset_query_token, "v63-demo-exit-label");
  assert.deepEqual(demoExitLabel.contract, {
    active_demo_exit_copy: "Exit Demo",
    inactive_demo_entry_copy: "Demo",
    demo_exit_behavior_retained: true,
    v62_archive_response_retained: true,
  });
  assert.equal(demoExitLabel.d1_migration_change, false);
  assert.equal(demoExitLabel.public_webmcp_tool_change, false);
  const demoMasteryMotion = selection.post_v35_successors.release_v64_demo_mastery_motion;
  assert.equal(demoMasteryMotion.base_source_commit, "caf7c668bff35a4a0676a2c9e14f46e50172bee5");
  assert.equal(demoMasteryMotion.predecessor_selection, "release_v63_demo_exit_label");
  assert.equal(demoMasteryMotion.asset_query_token, "v64-demo-mastered-motion");
  assert.deepEqual(demoMasteryMotion.contract, {
    active_demo_status_visible_copy_is_exit_only: true,
    inactive_demo_entry_copy: "Demo",
    mastered_queue_motion_avoids_mid_edge_stall: true,
    mastered_corner_transitions_are_brief: true,
    v63_demo_exit_behavior_retained: true,
  });
  assert.equal(demoMasteryMotion.d1_migration_change, false);
  assert.equal(demoMasteryMotion.public_webmcp_tool_change, false);
  const masteredCornerTiming = selection.post_v35_successors.release_v65_mastered_corner_timing;
  assert.equal(masteredCornerTiming.base_source_commit, "bffffa539c0be741250e6d3505c0410f532b9818");
  assert.equal(masteredCornerTiming.predecessor_selection, "release_v64_demo_mastery_motion");
  assert.equal(masteredCornerTiming.asset_query_token, "v65-mastered-corner-timing");
  assert.deepEqual(masteredCornerTiming.contract, {
    mastered_queue_reaches_side_before_turn: true,
    mastered_queue_corner_sweep_percent: 2,
    mastered_queue_edge_pacing_remains_even: true,
    v64_compact_demo_exit_retained: true,
  });
  assert.equal(masteredCornerTiming.d1_migration_change, false);
  assert.equal(masteredCornerTiming.public_webmcp_tool_change, false);
  const flatAccountAttention = selection.post_v35_successors.release_v66_flat_account_attention;
  assert.equal(flatAccountAttention.base_source_commit, "20675317c7369ee09dd193febaca16e0284fa1cf");
  assert.equal(flatAccountAttention.predecessor_selection, "release_v65_mastered_corner_timing");
  assert.equal(flatAccountAttention.asset_query_token, "v66-flat-account-attention");
  assert.deepEqual(flatAccountAttention.contract, {
    needs_attention_card_uses_flat_surface: true,
    saved_account_card_gradient_retained: true,
    v65_mastered_corner_timing_retained: true,
  });
  assert.equal(flatAccountAttention.d1_migration_change, false);
  assert.equal(flatAccountAttention.public_webmcp_tool_change, false);
  const weeklyActivityIntensity = selection.post_v35_successors.release_v68_weekly_activity_intensity;
  assert.equal(weeklyActivityIntensity.base_source_commit, "d57d6e54c327ea24e06ba009ceffd4302b15252c");
  assert.equal(weeklyActivityIntensity.predecessor_selection, "release_v66_flat_account_attention");
  assert.equal(weeklyActivityIntensity.asset_query_token, "v68-weekly-activity-intensity");
  assert.deepEqual(weeklyActivityIntensity.contract, {
    activity_dot_brightness_tracks_weekly_share: true,
    zero_review_days_remain_visibly_distinct: true,
    activity_tooltips_and_labels_retained: true,
    v67_logo_identity_retained: true,
  });
  assert.equal(weeklyActivityIntensity.d1_migration_change, false);
  assert.equal(weeklyActivityIntensity.public_webmcp_tool_change, false);
  const manualGradePalette = selection.post_v35_successors.release_v69_manual_grade_palette;
  assert.equal(manualGradePalette.base_source_commit, "019c59f1420a406cba82f810ed808b35596a0648");
  assert.equal(manualGradePalette.predecessor_selection, "release_v68_weekly_activity_intensity");
  assert.equal(manualGradePalette.asset_query_token, "v69-manual-grade-palette");
  assert.deepEqual(manualGradePalette.contract, {
    manual_grade_actions_use_distinct_full_contrast_colors: true,
    manual_grade_back_control_removed: true,
    four_rating_actions_and_behavior_retained: true,
    v68_weekly_activity_intensity_retained: true,
  });
  assert.equal(manualGradePalette.d1_migration_change, false);
  assert.equal(manualGradePalette.public_webmcp_tool_change, false);
  const deckDeletion = selection.post_v35_successors.release_v70_deck_deletion;
  assert.equal(deckDeletion.base_source_commit, "0063cfddcd75a5067b7895dd0ac09a8c6f68a9d6");
  assert.equal(deckDeletion.predecessor_selection, "release_v69_manual_grade_palette");
  assert.equal(deckDeletion.asset_query_token, "v70-deck-deletion");
  assert.deepEqual(deckDeletion.contract, {
    archived_deck_permanent_deletion: true,
    exact_instance_and_revision_confirmation: true,
    principal_scoped_and_idempotent: true,
    compact_immediate_confirmation: true,
    immutable_library_preserved: true,
    public_webmcp_tool_count_retained: 13,
  });
  assert.equal(deckDeletion.d1_migration_change, true);
  assert.equal(deckDeletion.public_webmcp_tool_change, false);
  const accountDemoNoDeckDelete = selection.post_v35_successors.release_v71_account_demo_no_deck_delete;
  assert.equal(accountDemoNoDeckDelete.base_source_commit, "75dfec2bdfc34f26f2f773e8f0729e85a2a1578d");
  assert.equal(accountDemoNoDeckDelete.predecessor_selection, "release_v70_deck_deletion");
  assert.equal(accountDemoNoDeckDelete.asset_query_token, "v71-account-demo-no-deck-delete");
  assert.deepEqual(accountDemoNoDeckDelete.contract, {
    demo_entry_is_inside_account_panel: true,
    archived_deck_delete_control_hidden: true,
    archive_and_restore_retained: true,
    deletion_backend_retained_but_not_exposed_on_deck_cards: true,
  });
  assert.equal(accountDemoNoDeckDelete.d1_migration_change, false);
  assert.equal(accountDemoNoDeckDelete.public_webmcp_tool_change, false);
  const guestStudyReset = selection.post_v35_successors.release_v72_guest_study_reset;
  assert.equal(guestStudyReset.base_source_commit, "8744f6e582da81ded3803df2490fd8ee68f56102");
  assert.equal(guestStudyReset.predecessor_selection, "release_v71_account_demo_no_deck_delete");
  assert.equal(guestStudyReset.asset_query_token, "v72-guest-study-reset");
  assert.deepEqual(guestStudyReset.contract, {
    guest_reset_control_reaches_confirmation: true,
    reset_requires_explicit_confirmation: true,
    confirmed_reset_returns_to_empty_browser_baseline: true,
    account_deletion_flow_unchanged: true,
  });
  assert.equal(guestStudyReset.d1_migration_change, false);
  assert.equal(guestStudyReset.public_webmcp_tool_change, false);
  const effectiveRuntime = effectiveV7RuntimeFiles();
  const effectiveBrowser = effectiveV7BrowserFiles();
  const priorSelected = [
    ...selection.accounts_v4.selected_files,
    ...selection.backend_v3.selected_files,
    ...selection.backend_v4_archive_successor.selected_files,
    ...selection.backend_v4_archive_successor.selected_verification_files,
    selection.backend_v4_archive_successor.browser_file,
    ...selection.backend_v4_archive_successor.selected_verification_dependencies,
    ...selection.backend_v5_catalog_successor.selected_files,
    ...selection.backend_v5_catalog_successor.selected_verification_files,
    selection.backend_v5_catalog_successor.browser_file,
    ...selection.backend_v5_catalog_successor.selected_verification_dependencies,
    ...effectiveRuntime,
    ...effectiveBrowser,
    selection.backend_v7_writer_successor.packaged_migration,
    ...effectiveAccountClarityStartupBrowserFiles(),
    ...effectiveAccountFocusedTests(),
    ...effectiveAccountClarityBrowserFiles(),
    ...effectiveSessionControlReleaseFocusedTests(),
    ...effectiveAccountClarityRuntimeFiles(),
    ...effectiveGraphDefaultFocusedTests(),
    ...effectiveAccountClaritySelectedFiles(),
    ...effectiveAccountClarityVisualFocusedTests(),
    ...effectiveAccountClarityFocusedTests(),
    ...responsiveShell.focused_test_additions,
    ...accountClarity.focused_test_additions,
    ...nonAnswerGrade.focused_tests,
  ];
  const recoverySelected = [
    recoveryCopy.browser_file_overrides,
    recoveryCopy.runtime_file_overrides,
    recoveryCopy.selected_file_overrides,
    recoveryCopy.visual_focused_test_overrides,
  ].reduce((files, overrides) => applyOverrides(files, overrides), combined.selected_files);
  const v53Selected = [
    combinedV53.browser_file_overrides,
    combinedV53.runtime_file_overrides,
    combinedV53.selected_file_overrides,
    combinedV53.visual_focused_test_overrides,
  ].reduce((files, overrides) => applyOverrides(files, overrides), recoverySelected);
  const demoMetricPaths = new Set(demoMetrics.selected_files.map(({ path: selectedPath }) => selectedPath));
  const guestAccountDataPaths = new Set(guestAccountData.selected_files.map(({ path: selectedPath }) => selectedPath));
  const demoErrorPolishPaths = new Set(demoErrorPolish.selected_files.map(({ path: selectedPath }) => selectedPath));
  const accountErrorDialogPaths = new Set(accountErrorDialog.selected_files.map(({ path: selectedPath }) => selectedPath));
  const studySessionPaths = new Set(studySession.selected_files.map(({ path: selectedPath }) => selectedPath));
  const demoExitPaths = new Set(demoExit.selected_files.map(({ path: selectedPath }) => selectedPath));
  const studyTakeoverPaths = new Set(studyTakeover.selected_files.map(({ path: selectedPath }) => selectedPath));
  const archiveResponsePaths = new Set(archiveResponse.selected_files.map(({ path: selectedPath }) => selectedPath));
  const demoExitLabelPaths = new Set(demoExitLabel.selected_files.map(({ path: selectedPath }) => selectedPath));
  const demoMasteryMotionPaths = new Set(demoMasteryMotion.selected_files.map(({ path: selectedPath }) => selectedPath));
  const masteredCornerTimingPaths = new Set(masteredCornerTiming.selected_files.map(({ path: selectedPath }) => selectedPath));
  const flatAccountAttentionPaths = new Set(flatAccountAttention.selected_files.map(({ path: selectedPath }) => selectedPath));
  const weeklyActivityIntensityPaths = new Set(weeklyActivityIntensity.selected_files.map(({ path: selectedPath }) => selectedPath));
  const manualGradePalettePaths = new Set(manualGradePalette.selected_files.map(({ path: selectedPath }) => selectedPath));
  const v53Paths = new Set(v53Selected.map(({ path: selectedPath }) => selectedPath));
  const deckDeletionPaths = new Set(deckDeletion.selected_files.map(({ path: selectedPath }) => selectedPath));
  const accountDemoNoDeckDeletePaths = new Set(accountDemoNoDeckDelete.selected_files.map(({ path: selectedPath }) => selectedPath));
  const guestStudyResetPaths = new Set(guestStudyReset.selected_files.map(({ path: selectedPath }) => selectedPath));
  const releaseFiles = [
    ...priorSelected.filter(({ path: selectedPath }) => !v53Paths.has(selectedPath) && !demoMetricPaths.has(selectedPath)
      && !guestAccountDataPaths.has(selectedPath) && !demoErrorPolishPaths.has(selectedPath)
      && !accountErrorDialogPaths.has(selectedPath) && !studySessionPaths.has(selectedPath)
      && !demoExitPaths.has(selectedPath) && !studyTakeoverPaths.has(selectedPath)
      && !archiveResponsePaths.has(selectedPath) && !demoExitLabelPaths.has(selectedPath)
      && !demoMasteryMotionPaths.has(selectedPath) && !masteredCornerTimingPaths.has(selectedPath)),
    ...v53Selected.filter(({ path: selectedPath }) => !demoMetricPaths.has(selectedPath)
      && !guestAccountDataPaths.has(selectedPath) && !demoErrorPolishPaths.has(selectedPath)
      && !accountErrorDialogPaths.has(selectedPath) && !studySessionPaths.has(selectedPath)
      && !demoExitPaths.has(selectedPath) && !studyTakeoverPaths.has(selectedPath)
      && !archiveResponsePaths.has(selectedPath) && !demoExitLabelPaths.has(selectedPath)
      && !demoMasteryMotionPaths.has(selectedPath) && !masteredCornerTimingPaths.has(selectedPath)),
    ...demoMetrics.selected_files.filter(({ path: selectedPath }) => !guestAccountDataPaths.has(selectedPath)
      && !demoErrorPolishPaths.has(selectedPath) && !accountErrorDialogPaths.has(selectedPath)
      && !studySessionPaths.has(selectedPath) && !demoExitPaths.has(selectedPath)
      && !studyTakeoverPaths.has(selectedPath) && !archiveResponsePaths.has(selectedPath)
      && !demoExitLabelPaths.has(selectedPath) && !demoMasteryMotionPaths.has(selectedPath)
      && !masteredCornerTimingPaths.has(selectedPath)),
    ...guestAccountData.selected_files.filter(({ path: selectedPath }) => !demoErrorPolishPaths.has(selectedPath)
      && !accountErrorDialogPaths.has(selectedPath) && !studySessionPaths.has(selectedPath)
      && !demoExitPaths.has(selectedPath) && !studyTakeoverPaths.has(selectedPath)
      && !archiveResponsePaths.has(selectedPath) && !demoExitLabelPaths.has(selectedPath)
      && !demoMasteryMotionPaths.has(selectedPath) && !masteredCornerTimingPaths.has(selectedPath)),
    ...demoErrorPolish.selected_files.filter(({ path: selectedPath }) => !accountErrorDialogPaths.has(selectedPath)
      && !studySessionPaths.has(selectedPath) && !demoExitPaths.has(selectedPath)
      && !studyTakeoverPaths.has(selectedPath) && !archiveResponsePaths.has(selectedPath)
      && !demoExitLabelPaths.has(selectedPath) && !demoMasteryMotionPaths.has(selectedPath)
      && !masteredCornerTimingPaths.has(selectedPath)),
    ...accountErrorDialog.selected_files.filter(({ path: selectedPath }) => !studySessionPaths.has(selectedPath)
      && !demoExitPaths.has(selectedPath) && !studyTakeoverPaths.has(selectedPath)
      && !archiveResponsePaths.has(selectedPath) && !demoExitLabelPaths.has(selectedPath)
      && !demoMasteryMotionPaths.has(selectedPath) && !masteredCornerTimingPaths.has(selectedPath)),
    ...studySession.selected_files.filter(({ path: selectedPath }) => !demoExitPaths.has(selectedPath)
      && !studyTakeoverPaths.has(selectedPath) && !archiveResponsePaths.has(selectedPath)
      && !demoExitLabelPaths.has(selectedPath) && !demoMasteryMotionPaths.has(selectedPath)
      && !masteredCornerTimingPaths.has(selectedPath)),
    ...demoExit.selected_files.filter(({ path: selectedPath }) => !studyTakeoverPaths.has(selectedPath)
      && !archiveResponsePaths.has(selectedPath) && !demoExitLabelPaths.has(selectedPath)
      && !demoMasteryMotionPaths.has(selectedPath) && !masteredCornerTimingPaths.has(selectedPath)),
    ...studyTakeover.selected_files.filter(({ path: selectedPath }) => !archiveResponsePaths.has(selectedPath)
      && !demoExitLabelPaths.has(selectedPath) && !demoMasteryMotionPaths.has(selectedPath)
      && !masteredCornerTimingPaths.has(selectedPath)),
    ...archiveResponse.selected_files.filter(({ path: selectedPath }) => !demoExitLabelPaths.has(selectedPath)
      && !demoMasteryMotionPaths.has(selectedPath) && !masteredCornerTimingPaths.has(selectedPath)),
    ...demoExitLabel.selected_files.filter(({ path: selectedPath }) => !demoMasteryMotionPaths.has(selectedPath)
      && !masteredCornerTimingPaths.has(selectedPath)),
    ...demoMasteryMotion.selected_files.filter(({ path: selectedPath }) => !masteredCornerTimingPaths.has(selectedPath)
      && !weeklyActivityIntensityPaths.has(selectedPath)),
    ...masteredCornerTiming.selected_files.filter(({ path: selectedPath }) => !flatAccountAttentionPaths.has(selectedPath)
      && !weeklyActivityIntensityPaths.has(selectedPath)),
    ...flatAccountAttention.selected_files.filter(({ path: selectedPath }) => !weeklyActivityIntensityPaths.has(selectedPath)),
    ...weeklyActivityIntensity.selected_files.filter(({ path: selectedPath }) => !manualGradePalettePaths.has(selectedPath)),
    ...manualGradePalette.selected_files.filter(({ path: selectedPath }) => !deckDeletionPaths.has(selectedPath)),
    ...deckDeletion.selected_files.filter(({ path: selectedPath }) => !accountDemoNoDeckDeletePaths.has(selectedPath)),
    ...accountDemoNoDeckDelete.selected_files.filter(({ path: selectedPath }) => !guestStudyResetPaths.has(selectedPath)),
    ...guestStudyReset.selected_files,
  ];
  for (const item of new Map(releaseFiles.map((entry) => [entry.path, entry])).values()) {
    assert.equal(await digest(item.path), item.sha256, item.path);
  }
  const selectedV3Verification = selection.backend_v4_archive_successor.selected_verification_dependencies
    .filter(({ path: selectedPath }) => selectedPath.startsWith("integration/backend/v3/"));
  assert.deepEqual(await filesBelow("integration/backend/v3"), [
    ...selection.backend_v3.selected_files,
    ...selectedV3Verification,
  ].map(({ path: selectedPath }) => selectedPath).sort(compareText));
  assert.deepEqual(await filesBelow("integration/backend/v4"), [
    ...selection.backend_v4_archive_successor.selected_files,
    ...selection.backend_v4_archive_successor.selected_verification_files,
  ].map(({ path: selectedPath }) => selectedPath).sort(compareText));
  assert.deepEqual(await filesBelow("integration/backend/v5"), [
    ...selection.backend_v5_catalog_successor.selected_files,
    ...selection.backend_v5_catalog_successor.selected_verification_files,
  ].map(({ path: selectedPath }) => selectedPath).sort(compareText));
  assert.deepEqual(await filesBelow("integration/backend/v7"),
    effectiveRuntime
      .map(({ path: selectedPath }) => selectedPath).sort(compareText));
  assert.equal(await digest("integration/backend/v7/src/durable-client.mjs"),
    await digest("public/study/backend/v7/src/durable-client.mjs"));
  const predecessorManifest = JSON.parse(await text("integration/backend/v3/FILE_MANIFEST.json"));
  assert.equal(predecessorManifest.payload_sha256, selection.backend_v3.source_payload_sha256);
  const selectedV4Manifest = JSON.parse(await text("integration/backend/v4/FILE_MANIFEST.json"));
  assert.equal(selectedV4Manifest.payload_sha256,
    selection.backend_v4_archive_successor.source_payload_sha256);
  assert.deepEqual(selectedV4Manifest.migrations.required_existing, [
    "backend/migrations/0001_learner_data.sql",
    "backend/v2/migrations/0002_fragmented_storage.sql",
  ]);
  const selectedV5Manifest = JSON.parse(await text("integration/backend/v5/FILE_MANIFEST.json"));
  assert.equal(selectedV5Manifest.payload_sha256,
    selection.backend_v5_catalog_successor.source_payload_sha256);
  assert.equal(selectedV5Manifest.predecessor.manifest_sha256,
    selection.backend_v4_archive_successor.source_manifest_sha256);
  assert.equal(selectedV5Manifest.predecessor.payload_sha256,
    selection.backend_v4_archive_successor.source_payload_sha256);
  assert.deepEqual(selectedV5Manifest.migrations.required_existing, [
    "backend/migrations/0001_learner_data.sql",
    "backend/v2/migrations/0002_fragmented_storage.sql",
  ]);
  assert.equal(selectedV4Manifest.read_only_dependencies.canonical.files
    .find(({ path: dependencyPath }) => dependencyPath === "web/js/webmcp.js")?.sha256,
  selection.canonical_runtime.webmcp_predecessor_sha256);
});

test("every selected Backend runtime and browser import resolves inside the candidate", async () => {
  for (const item of [
    ...selection.backend_v3.selected_files,
    ...selection.backend_v4_archive_successor.selected_files,
    ...selection.backend_v4_archive_successor.selected_verification_files
      .filter(({ path: selectedPath }) => selectedPath.endsWith(".mjs")),
    selection.backend_v4_archive_successor.browser_file,
    ...selection.backend_v4_archive_successor.selected_verification_dependencies
      .filter(({ path: selectedPath }) => selectedPath.endsWith(".mjs")),
    ...selection.backend_v5_catalog_successor.selected_files,
    ...selection.backend_v5_catalog_successor.selected_verification_files
      .filter(({ path: selectedPath }) => selectedPath.endsWith(".mjs")),
    selection.backend_v5_catalog_successor.browser_file,
    ...selection.backend_v5_catalog_successor.selected_verification_dependencies
      .filter(({ path: selectedPath }) => selectedPath.endsWith(".mjs")),
    ...effectiveV7RuntimeFiles(),
    ...effectiveV7BrowserFiles(),
    ...effectiveStartupBrowserFiles(),
    ...effectiveAccountFocusedTests()
      .filter(({ path: selectedPath }) => selectedPath.endsWith(".mjs")),
    ...effectiveReleaseBrowserFiles()
      .filter(({ path: selectedPath }) => selectedPath.endsWith(".mjs")),
    ...effectiveReleaseFocusedTests()
      .filter(({ path: selectedPath }) => selectedPath.endsWith(".mjs")),
    ...selection.post_v35_successors.graph_learner_progress_v1.runtime_files
      .filter(({ path: selectedPath }) => selectedPath.endsWith(".mjs")),
    ...selection.post_v35_successors.graph_learner_progress_v1.focused_tests
      .filter(({ path: selectedPath }) => selectedPath.endsWith(".mjs")),
    ...selection.post_v35_successors.release_v42_non_answer_grade_v1.focused_tests
      .filter(({ path: selectedPath }) => selectedPath.endsWith(".mjs")),
  ]) {
    const source = await text(item.path);
    for (const match of source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
      const dependency = path.resolve(path.dirname(path.join(root, item.path)), match[1]);
      assert.equal(dependency.startsWith(`${root}${path.sep}`), true, match[1]);
      await access(dependency);
    }
  }
});

test("canonical mirrors, asset identity, budget, and 13 WebMCP schemas are frozen", async () => {
  const pins = selection.canonical_runtime;
  const webmcpSuccessor = selection.post_v35_successors.canonical_webmcp_copy;
  const selfGradingStore = selection.post_v35_successors.manual_self_grading_v1.canonical_store;
  const nonAnswerStore = selection.post_v35_successors.release_v42_non_answer_grade_v1.canonical_store;
  for (const relative of ["integration/core/js/library-catalog.js", "public/study/js/library-catalog.js"])
    assert.equal(await digest(relative), pins.library_catalog_sha256, relative);
  assert.equal(selfGradingStore.predecessor_sha256, pins.store_sha256);
  assert.equal(nonAnswerStore.predecessor_sha256, selfGradingStore.sha256);
  assert.deepEqual(nonAnswerStore.mirror_paths, selfGradingStore.mirror_paths);
  const currentStore = selection.post_v35_successors.release_v70_deck_deletion.selected_files
    .find(({ path: selectedPath }) => selectedPath === "integration/core/js/store.js")?.sha256;
  assert.equal(typeof currentStore, "string");
  for (const relative of nonAnswerStore.mirror_paths)
    assert.equal(await digest(relative), currentStore, relative);
  for (const relative of ["integration/core/js/streak.js", "public/study/js/streak.js"])
    assert.equal(await digest(relative), pins.streak_sha256, relative);
  assert.equal(pins.webmcp_sha256,
    "27f5cee39858f07846dd63a1b7deb6929fa486c93da5e1cd918603f98a545f30");
  assert.equal(webmcpSuccessor.predecessor_sha256, pins.webmcp_sha256);
  for (const relative of webmcpSuccessor.mirror_paths)
    assert.equal(await digest(relative), webmcpSuccessor.sha256, relative);
  for (const relative of ["integration/core/js/deck-build-guide.js", "public/study/js/deck-build-guide.js"])
    assert.equal(await digest(relative), pins.deck_build_guide_sha256, relative);
  assert.equal(pins.deck_build_guide_version, "deck-generation-guide.v1.9");
  assert.deepEqual(selection.post_v35_successors.deck_generation_guide_v1_9, {
    source_handoff_sha256: "f047274e7b22ab494d40708b69bba4465e856e23c5746a14f92abf9744e305f0",
    source_validation_sha256: "c91d99d2b567c10b18259002e5e9227f50ec4995b32a7c9cd36cf5482cf291a5",
    guide_freeze_sha256: "aaeb78829e92313616da381e065b6d995ba2930579217a08b9f7db5fdd96bc3b",
    metadata_stripped_constraints_sha256: "785f469eabd147981e9c857a59b0353927d4b12a0fc067a0cb39741c22d4a074",
    registration_metadata_sha256: "f572b85db872946adf7db7ba4ba01a300e0734a27570a7f5957197e8f6599ec4",
    registration_metadata_bytes: 44_587,
    public_webmcp_tool_change: false,
  });
  assert.equal(Object.keys(WEBMCP_TOOL_SCHEMAS).length, 13);
  assert.equal(webmcpSuccessor.webmcp_tool_count, 13);
  assert.equal(webmcpSuccessor.public_webmcp_tool_change, false);
  assert.equal(await digest(selection.library_assets.manifest_path),
    selection.library_assets.manifest_sha256);
  assert.equal(await digest(selection.library_assets.public_metadata_path),
    selection.library_assets.public_metadata_sha256);
  assert.equal(await digest(selection.library_assets.verification_receipt_path),
    selection.library_assets.verification_receipt_sha256);
  assert.equal(await digest(selection.library_assets.description_successor.overlay_path),
    selection.library_assets.description_successor.overlay_sha256);
  for (const retained of selection.library_assets.retained_releases) {
    assert.equal(await digest(retained.manifest_path), retained.manifest_sha256);
  }
  assert.equal(await digest(selection.library_assets.retained_release.manifest_path),
    selection.library_assets.retained_release.manifest_sha256);
  assert.equal(selection.library_assets.release, "2026-09-03.public-sanitized.v4");
  assert.deepEqual(selection.library_assets.retained_releases.map(({ release }) => release), [
    "2026-09-02.public-sanitized.v3",
    "2026-08-30.reviewed-72.v1",
  ]);
  assert.equal(selection.library_assets.retained_release.release, "2026-08-30.reviewed-72.v1");
  assert.equal(selection.library_assets.browser_catalog_artifact_sha256,
    "sha256:ffcd11b6409fcc7c5fb500e097e41c829d94601614b6fe5ae37ebf23dafb28a1");
  assert.deepEqual(selection.library_assets.description_successor, {
    overlay_path: "integration/library-assets/COURSE_DESCRIPTION_OVERLAY_V1.json",
    overlay_sha256: "221a8ce11bcc52cbb81814baf27599b7081b6b7d79460c70006971f914f140ee",
    base_public_metadata_sha256: "b73810e51aedffbe0062e3d4bb0e0c982e4b6f792eb236ea13d4fe6982b7f8be",
    base_browser_catalog_artifact_sha256: "fd26b03178e8ffa0db631814cc7771aae1966f9b087499378ddfa1c78b98a332",
    description_changes: 72,
    non_description_changes: 0,
  });
  assert.deepEqual(selection.library_assets.resolution_budget,
    { max_decks: 42, max_cards: 5500, max_raw_chunk_bytes: 7000000 });
});

test("tracked source contains no owner path or symlink escape", async () => {
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root })
    .toString("utf8").split("\0").filter(Boolean);
  const index = execFileSync("git", ["ls-files", "-s"], { cwd: root }).toString("utf8");
  assert.doesNotMatch(index, /^120000\s/m);
  assert.equal(tracked.some((entry) => entry === "node_modules" || entry.startsWith("node_modules/")), false);
  const home = homedir();
  const forbidden = [
    `${home}${path.sep}`,
    path.basename(home),
    path.join("Documents", "GitHub"),
    [".", "tmp", path.sep].join(""),
  ].map((value) => value.toLowerCase());
  for (const relative of tracked) {
    let status;
    try { status = await lstat(path.join(root, relative)); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    assert.equal(status.isSymbolicLink(), false, relative);
    const content = await bytes(relative);
    const source = content.toString("utf8").toLowerCase();
    for (const needle of forbidden) {
      const selectedOverlayProvenance = relative === selection.library_assets.description_successor.overlay_path
        && needle === [".", "tmp/"].join("");
      if (!selectedOverlayProvenance) assert.equal(source.includes(needle), false, `${relative}: ${needle}`);
    }
  }
  assert.deepEqual(selection.source_boundary, {
    selected_files_only: true,
    local_verification_harness_in_source: true,
    raw_library_construction_inputs_in_source: false,
    absolute_owner_paths_in_source: false,
    tracked_symlinks: false,
  });
});
