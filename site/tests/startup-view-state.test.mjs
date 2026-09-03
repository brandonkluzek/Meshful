import assert from "node:assert/strict";
import test from "node:test";

import { prepareAccountStartupShell, showNeutralLoadingShell } from "../public/study/js/startup-view-state.js";

test("signed-in refresh clears an intermediate paused view and keeps the neutral shell visible", () => {
  const loading = { hidden: true };
  const view = {
    hidden: false,
    content: ["Account access paused"],
    replaceChildren() { this.content = []; },
  };
  showNeutralLoadingShell({ loading, view, clearView: true });
  assert.equal(loading.hidden, false);
  assert.equal(view.hidden, true);
  assert.deepEqual(view.content, []);
});

test("guest startup is unchanged unless the account path explicitly requests the shell", () => {
  const loading = { hidden: true };
  const view = { hidden: false, content: ["guest startup"] };
  assert.equal(prepareAccountStartupShell({ accountMode: false, loading, view }), false);
  assert.deepEqual({ loading: loading.hidden, view: view.hidden, content: view.content },
    { loading: true, view: false, content: ["guest startup"] });
});
