export function showNeutralLoadingShell({ loading, view, clearView = false }) {
  if (clearView) view.replaceChildren();
  loading.hidden = false;
  view.hidden = true;
}

export function prepareAccountStartupShell({ accountMode, loading, view }) {
  if (!accountMode) return false;
  showNeutralLoadingShell({ loading, view });
  return true;
}
