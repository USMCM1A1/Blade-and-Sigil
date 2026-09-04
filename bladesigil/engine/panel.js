// DOM panels (refactor step 6a, 2026-09-04). Every modal — the character
// sheet, the spellbook, a building, the bench, marching order, the choice
// and level-up cards, help and the guide — used to be its own trio of
// open/close/isOpen functions with the element's display string as state.
// This is the one place that knows how a panel shows and hides; a panel
// registers once with what to do when it opens (render) and closes (clear).

const PANELS = new Map();
const elOf = id => document.getElementById(id);

export function registerPanel(id, { display = 'block', onOpen = null, onClose = null } = {}) {
  PANELS.set(id, { display, onOpen, onClose });
}

export function isOpen(id) {
  return elOf(id).style.display === (PANELS.get(id)?.display ?? 'block');
}

export function openPanel(id, ...args) {
  const p = PANELS.get(id);
  elOf(id).style.display = p?.display ?? 'block';
  p?.onOpen?.(...args);
}

export function closePanel(id) {
  const p = PANELS.get(id);
  const el = elOf(id);
  el.style.display = 'none';
  p?.onClose?.(el);
}

// show: true/false to force, undefined to flip. Returns whether it is open now.
export function togglePanel(id, show, ...args) {
  const opening = show ?? !isOpen(id);
  if (opening) openPanel(id, ...args); else closePanel(id);
  return opening;
}
