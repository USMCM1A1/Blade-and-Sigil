// Sound effects. Browsers block audio until the first user input,
// so play() failures before that are silently ignored.

const SOUNDS = {
  melee: 'assets/sfx/basic_melee_strike.mp3',
  gold: 'assets/sfx/store_bell.mp3',
  victory: 'assets/sfx/level_up_ding.mp3',
  spell: 'assets/sfx/lvl1_spell_woosh.mp3',
  arrow: 'assets/sfx/arrow_shot.mp3',
};

const cache = {};
let muted = false;

export function play(name) {
  if (muted || typeof Audio === 'undefined') return;
  const src = SOUNDS[name];
  if (!src) return;
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
