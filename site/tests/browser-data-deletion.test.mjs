import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  GRAPH_PIN_STORAGE_KEY,
  LEARNER_STORAGE_KEY,
  createBrowserWorkspace,
} from "../public/study/js/browser-workspace.js";
import { createMemoryStorage } from "../public/study/js/store.js";

const GRAPH_KEY = `${GRAPH_PIN_STORAGE_KEY}.deck.rev.full`;

test("guest Reset study data opens confirmation before clearing the browser workspace", async () => {
  const [page, app] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/study/js/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(page, /data-request-delete-local>Reset study data<\/button>/);
  assert.match(page, /data-delete-local-confirmation/);
  assert.doesNotMatch(page, /data-reset-local/);
  assert.match(app, /data-request-delete-local/);
  assert.match(app, /<strong>Reset study data\?<\/strong>/);
  assert.match(app, /data-cancel-delete-local>Cancel<\/button>/);
  assert.match(app, /data-confirm-delete-local>Reset<\/button>/);
  assert.match(app, /workspace\.deleteData\(\);[\s\S]*location\.assign/);
});

test("Delete my data clears learner state and graph pins only in the selected browser workspace", () => {
  const storage = createMemoryStorage({
    [LEARNER_STORAGE_KEY]: "learner-default",
    [GRAPH_KEY]: "pins-default",
    [`${LEARNER_STORAGE_KEY}:recording:demo`]: "learner-recording",
    [`${GRAPH_KEY}:recording:demo`]: "pins-recording",
    "unrelated:key": "keep",
  });
  const workspace = createBrowserWorkspace("", () => storage);
  assert.deepEqual(workspace.deleteData(), {
    deleted_keys: [LEARNER_STORAGE_KEY, GRAPH_KEY],
    scope: "browser-local",
  });
  assert.equal(storage.getItem(LEARNER_STORAGE_KEY), null);
  assert.equal(storage.getItem(GRAPH_KEY), null);
  assert.equal(storage.getItem(`${LEARNER_STORAGE_KEY}:recording:demo`), "learner-recording");
  assert.equal(storage.getItem(`${GRAPH_KEY}:recording:demo`), "pins-recording");
  assert.equal(storage.getItem("unrelated:key"), "keep");
});

test("recording deletion cannot erase the normal learner workspace", () => {
  const storage = createMemoryStorage({
    [LEARNER_STORAGE_KEY]: "learner-default",
    [`${LEARNER_STORAGE_KEY}:recording:capture`]: "learner-recording",
    [`${GRAPH_KEY}:recording:capture`]: "pins-recording",
  });
  const workspace = createBrowserWorkspace("?recording=capture", () => storage);
  const result = workspace.deleteData();
  assert.equal(result.scope, "recording");
  assert.equal(storage.getItem(`${LEARNER_STORAGE_KEY}:recording:capture`), null);
  assert.equal(storage.getItem(`${GRAPH_KEY}:recording:capture`), null);
  assert.equal(storage.getItem(LEARNER_STORAGE_KEY), "learner-default");
});

test("a partial browser-storage failure restores every deleted key", () => {
  const backing = createMemoryStorage({
    [LEARNER_STORAGE_KEY]: "learner",
    [GRAPH_KEY]: "pins",
  });
  let removes = 0;
  const storage = {
    get length() { return backing.length; },
    key: (index) => backing.key(index),
    getItem: (key) => backing.getItem(key),
    setItem: (key, value) => backing.setItem(key, value),
    removeItem(key) {
      removes += 1;
      if (removes === 2) throw new Error("storage blocked");
      backing.removeItem(key);
    },
  };
  const workspace = createBrowserWorkspace("", () => storage);
  assert.throws(() => workspace.deleteData(), /storage blocked/);
  assert.equal(backing.getItem(LEARNER_STORAGE_KEY), "learner");
  assert.equal(backing.getItem(GRAPH_KEY), "pins");
});
