// Sound effects (sound map v2, 2026-08-25): every game moment has its OWN
// sound id, and the id → file table lives in user-owned data/sounds.json —
// drop in a new file, point an id at it, refresh. An id with no file stays
// SILENT (never a wrong or reused sound; the designer's rule: one sound
// means one thing). Browsers block audio until the first user input, so
// early play() failures are silently ignored.

let SOUNDS = {};
const cache = {};
let muted = false;

// Called at boot with data/sounds.json's "sounds" table.
export function init(table) {
  SOUNDS = table ?? {};
}

export function play(name) {
  if (muted || typeof Audio === 'undefined') return;
  const src = SOUNDS[name];
  if (!src) return; // unmapped moments stay silent by design
  if (!cache[name]) {
    cache[name] = new Audio(src);
    cache[name].volume = 0.5;
  }
  const a = cache[name];
  a.currentTime = 0;
  a.play().catch(() => {});
}

export function toggleMute() {
  muted = !muted;
  return muted;
}
