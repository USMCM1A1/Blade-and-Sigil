// Engine constants (refactor step 2, 2026-09-03). Numbers that used to sit
// inline in game.js / battle.js / render.js, gathered so an outside reader
// can find every tuning knob in one place. Anything marked DESIGN LEVER is
// a candidate for data/ (designer-editable) — moving it there is a design
// question, not a refactor, so it stays here until the designer asks.

// ---- Map (game.js) ----
export const VISION_RADIUS = 6.5;        // tiles the party can see
export const MONSTER_AGGRO_RANGE = 7;    // a visible monster this close starts hunting
export const BATTLE_RADIUS = 3;          // monsters this close (and visible) join a battle
export const CAMP_AMBUSH_TURNS = 25;     // DESIGN LEVER: half a watch passes before the ambush
export const CAMP_TURNS = 50;            // DESIGN LEVER: a full night's rest
export const AMBUSH_PACK = { min: 1, extra: 3, radius: 3 }; // 1 + rand(extra) wanderers spawn within radius
export const VAULT_BAND_FLOORS = 4;      // vault gear tier band = ceil(depth / 4), capped at 5
export const SCOUT_CAP = 95;             // the scout's warning can never be a certainty
export const LOG_CAP = 200;              // lines the message log keeps

// ---- Battle (battle.js) ----
export const HERO_MOVE = 4;              // squares a hero may move per turn
export const MONSTER_MOVE = { normal: 4, slow: 2 }; // map-slow (speed > 1) monsters are battle-slow too
export const CHAIN_CAP = 12;             // Rampage / Volley links — a generous cap against pathology
export const TIMING = {                  // milliseconds; the player must SEE each consequence
  monsterTurn: 600,   // pause before a monster acts
  skipTurn: 800,      // a paralysed/asleep hero's turn drags past
  swing: 300,         // between a multi-attacker's blows
  stagger: 160,       // between staggered bolt/breath/spell targets and volley arrows
  staggerSlow: 150,   // between afflict / summon placements
  staggerTail: 200,   // grace after the last staggered target before the hand-back (also the summon's lead)
  blink: 350,         // the Overlord's Elsewhere
  partingLead: 400,   // before the first parting blow on a fleeing party
  partingBlow: 600,   // between parting blows
  fleeExit: 900,      // after the last parting blow, the party is away
  endBeat: 2000,      // victory ending beat before the map returns
  campBeat: 3200,     // the campfire picture lingers this long (any key hurries it)
  wipeBeat: 2400,     // the fallen party's beat
};

// ---- Presentation (render.js) ----
export const RENDER = {
  panel: 220,         // battle left panel width
  cellMin: 44,        // smallest battle cell
  chip: 40,           // initiative ladder portrait
  row: 50,            // initiative ladder row height
  menuRow: 44,        // canvas overlay menu row height
  fxLife: 1100,       // floating combat text lifetime (ms)
  corpseFade: 1600,   // a slain combatant fades over this long
};

// Colours the battle log/fx speak in. Names describe the MEANING so a new
// message picks the right one without guessing a hex.
export const COLOR = {
  dim: '#9a94a8',     // misses, fades, quiet notes
  gold: '#ffd24a',    // crits, big moments
  amber: '#d4a94e',   // the Guardian's cost, warnings
  shadow: '#8a7ab8',  // vanish, hiding
  green: '#6ad46a',   // heals, good news
  teal: '#7fd4c8',    // shields, absorbs, wards
  red: '#e0483a',     // wounds
  violet: '#b48cff',  // arcane, blink
  sun: '#e0c060',     // buffs
  ember: '#e0a060',   // fire, rage
};
