export function captureSearchFieldState(activeElement, field) {
  if (!field || activeElement !== field) return null;
  return {
    start: Number.isInteger(field.selectionStart) ? field.selectionStart : field.value.length,
    end: Number.isInteger(field.selectionEnd) ? field.selectionEnd : field.value.length,
    direction: field.selectionDirection ?? "none",
  };
}

export function restoreSearchFieldState(field, state) {
  if (!field || !state) return false;
  const length = field.value.length;
  const start = Math.min(Math.max(state.start, 0), length);
  const end = Math.min(Math.max(state.end, start), length);
  field.focus({ preventScroll: true });
  field.setSelectionRange(start, end, state.direction);
  return true;
}
