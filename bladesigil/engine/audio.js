// Sound effects (sound map v2, 2026-08-25): every game moment has its OWN
// sound id, and the id → file table lives in user-owned data/sounds.json —
// drop in a new file, point an id at it, refresh. An id with no file stays
// SILENT (never a wrong or reused sound; the designer's rule: one sound
// means one thing). Browsers block audio until the first user input, so
// early play() failures are silently ignored.
//
// v3 (2026-09-05, from the hosted playtest: "the swing sound is sometimes
// clipped or garbled"): every play is its OWN voice. The old player kept one
// <audio> element per id and rewound it on every call, so a second swing
// close behind the first (two attacks a round, an off-hand blade, a Rampage)
// cut the first note off mid-way. Now each file is fetched and decoded ONCE
// into an AudioBuffer and every play starts a fresh buffer source, so
// overlapping sounds layer instead of interrupting each other. Where Web
// Audio is unavailable the old <audio> path remains as the fallback.

let SOUNDS = {};
let muted = false;
const VOLUME = 0.5;

let ctx = null;          // the one AudioContext (created lazily)
const buffers = {};      // id → decoded AudioBuffer
const decoding = {};     // id → in-flight decode promise
const fallback = {};     // id → <audio> element (no Web Audio)

function context() {
  if (ctx) return ctx;
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

// Fetch + decode one sound; resolves to the buffer (or null on any failure).
function load(name) {
  if (buffers[name]) return Promise.resolve(buffers[name]);
  if (decoding[name]) return decoding[name];
  const c = context();
  const src = SOUNDS[name];
  if (!c || !src || typeof fetch === 'undefined') return Promise.resolve(null);
  decoding[name] = fetch(src)
    .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
    .then(bytes => c.decodeAudioData(bytes))
    .then(buf => { buffers[name] = buf; return buf; })
    .catch(() => null)
    .finally(() => { delete decoding[name]; });
  return decoding[name];
}

// Called at boot with data/sounds.json's "sounds" table. Every mapped file
// is decoded in the background so the first swing is not late.
export function init(table) {
  SOUNDS = table ?? {};
  if (context()) for (const name of Object.keys(SOUNDS)) load(name);
}

function voice(name) {
  const c = context();
  const buf = buffers[name];
  if (!c || !buf) return false;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const source = c.createBufferSource();
  source.buffer = buf;
  const gain = c.createGain();
  gain.gain.value = VOLUME;
  source.connect(gain).connect(c.destination);
  try { source.start(); } catch { return false; }
  return true;
}

export function play(name) {
  if (muted) return;
  const src = SOUNDS[name];
  if (!src) return; // unmapped moments stay silent by design
  if (context()) {
    if (voice(name)) return;
    // Not decoded yet (first play, or still loading): play when it lands.
    load(name).then(buf => { if (buf && !muted) voice(name); });
    return;
  }
  // Fallback without Web Audio: one element per id, as before.
  if (typeof Audio === 'undefined') return;
  if (!fallback[name]) {
    fallback[name] = new Audio(src);
    fallback[name].volume = VOLUME;
  }
  const a = fallback[name];
  a.currentTime = 0;
  a.play().catch(() => {});
}

export function toggleMute() {
  muted = !muted;
  return muted;
}
