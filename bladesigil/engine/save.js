// The run save (Phase 6, designer session 2026-08-30): one autosave slot in
// the browser's localStorage ('bs_run'), written quietly at map moments —
// never mid-battle, never in the arena. Death or victory ends the run and
// deletes the save (the crawl keeps its teeth); refreshing or pressing R
// lands on the title screen, where a valid save offers "Continue".
// The party DEFINITION ('bs_party') is separate and untouched by any of this.

const RUN_KEY = 'bs_run';
const SAVE_VERSION = 1;

// Everything about a hero that is played, not derived. Derived fields
// (abilities-with-gear, ac, weapon, maxSp, hitBase…) are recomputed by
// refreshDerived on load; battle-scoped fields are rebuilt by every fight.
const HERO_FIELDS = ['name', 'level', 'row', 'xp', 'hp', 'maxHp', 'sp', 'alive',
  'look', 'lane', 'focusType', 'gift', 'bonusAbility', 'favored', 'favoredPicks',
  'timedBuffs', 'counters', 'rite', 'spellbook', 'prepared', 'knownSpells',
  'formerBook', 'studyOwed', 'bonusPicksTaken', 'spentRest', 'prepFresh',
  'equipment', 'quiver', 'conditions'];

function classIdOf(data, ch) {
  return Object.keys(data.classes.classes).find(k => data.classes.classes[k] === ch.cls);
}
function raceIdOf(data, ch) {
  return Object.keys(data.races.races).find(k => data.races.races[k] === ch.race);
}

function serializeHero(data, ch) {
  const out = { classId: classIdOf(data, ch), raceId: raceIdOf(data, ch),
    baseAbilities: { ...(ch.baseAbilities ?? ch.abilities) } };
  for (const k of HERO_FIELDS) out[k] = ch[k];
  return out;
}

function serializeFloor(f) {
  return { level: f.level, grid: f.grid, monsters: f.monsters, seen: f.seen,
    traps: f.traps, chestTraps: f.chestTraps ?? [], revealed: [...f.revealed] };
}

function buildPayload(game) {
  game.saveFloor(); // the live floor joins the cache (no-op in town)
  const floors = {};
  for (const [d, f] of Object.entries(game.floors)) floors[d] = serializeFloor(f);
  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    partyDef: game.partyDef,
    party: game.party.map(ch => serializeHero(game.data, ch)),
    gold: game.gold,
    inventory: game.inventory,
    turn: game.turn,
    mode: game.mode,
    depth: game.depth,
    preBossDepth: game.preBossDepth ?? null,
    partyPos: game.partyPos,
    floors,
  };
}

// ---- The autosave: debounced, guarded, silent ----
let timer = null;
export function autosave(game, flush = false) {
  if (game.arena || game.battle) return; // battle state is never serialized
  if (game.over || game.victory) {       // the run is finished — death is death
    clearTimeout(timer); timer = null;
    clearRun();
    return;
  }
  if (flush) {
    clearTimeout(timer); timer = null;
    writeRun(game);
    return;
  }
  if (timer) return;
  timer = setTimeout(() => { timer = null;
    if (!game.battle && !game.arena && !game.over && !game.victory) writeRun(game);
  }, 400);
}

function writeRun(game) {
  try { localStorage.setItem(RUN_KEY, JSON.stringify(buildPayload(game))); }
  catch { /* private mode or full storage: play on without saving */ }
}

export function clearRun() {
  try { localStorage.removeItem(RUN_KEY); } catch { /* fine */ }
}

// ---- The title screen's look at the save (cheap checks only) ----
export function peekRun(data) {
  let p;
  try { p = JSON.parse(localStorage.getItem(RUN_KEY)); } catch { return null; }
  if (!p || p.version !== SAVE_VERSION) return null;
  if (!Array.isArray(p.partyDef) || !Array.isArray(p.party) || !p.party.length) return null;
  // A save from before a class/race was retired steps aside quietly,
  // the same way an outdated bs_party does.
  if (p.partyDef.some(h => !data.classes.classes[h.class] || !data.races.races[h.race])) return null;
  return p;
}

// ---- Loading: validate EVERYTHING first, then overlay ----
// Throws with a friendly message if the save names things the data no
// longer has (a retired item, a renamed spell) — the caller starts fresh.
export function loadRun(game, p) {
  const data = game.data;
  const bad = (what) => { throw new Error(`the save names ${what} that no longer exists`); };
  if (p.party.length !== game.party.length) bad('a different party size');
  p.party.forEach((s, i) => {
    const ch = game.party[i];
    if (classIdOf(data, ch) !== s.classId || raceIdOf(data, ch) !== s.raceId) bad(`a changed hero (${s.name})`);
    for (const id of Object.values(s.equipment ?? {})) if (id && !data.items.items[id]) bad(`item "${id}"`);
    for (const id of [...(s.spellbook ?? []), ...(s.prepared ?? []), ...(s.knownSpells ?? []), ...(s.formerBook ?? [])]) {
      if (!data.spells.spells[id]) bad(`spell "${id}"`);
    }
    for (const c of s.conditions ?? []) if (!data.conditions.conditions[c.id]) bad(`condition "${c.id}"`);
  });
  for (const id of Object.keys(p.inventory ?? {})) if (!data.items.items[id]) bad(`item "${id}"`);
  for (const f of Object.values(p.floors ?? {})) {
    for (const m of f.monsters ?? []) if (!data.monsters.monsters[m.id]) bad(`monster "${m.id}"`);
    for (const t of [...(f.traps ?? []), ...(f.chestTraps ?? [])]) if (!data.dungeon.traps[t.id]) bad(`trap "${t.id}"`);
  }
  if (p.mode === 'dungeon' && !p.floors?.[p.depth]) bad('the floor the party stood on');

  // Overlay the heroes onto the freshly built party.
  p.party.forEach((s, i) => {
    const ch = game.party[i];
    for (const k of HERO_FIELDS) if (s[k] !== undefined) ch[k] = s[k];
    ch.baseAbilities = { ...s.baseAbilities };
    ch.abilities = { ...s.baseAbilities }; // refreshDerived layers gear back on
    game.refreshDerived(ch);
    ch.hp = Math.min(ch.hp, ch.maxHp);
    ch.sp = Math.min(ch.sp, ch.maxSp);
  });
  game.gold = p.gold;
  game.inventory = p.inventory ?? {};
  game.turn = p.turn ?? 0;
  game.preBossDepth = p.preBossDepth ?? null;
  game.floors = {};
  for (const [d, f] of Object.entries(p.floors ?? {})) {
    game.floors[d] = { ...f, chestTraps: f.chestTraps ?? [], revealed: new Set(f.revealed ?? []) };
  }
  if (p.mode === 'dungeon') {
    const cached = game.floors[p.depth];
    game.mode = 'dungeon';
    game.depth = p.depth;
    game.level = cached.level;
    game.grid = cached.grid;
    game.monsters = cached.monsters;
    game.seen = cached.seen;
    game.traps = cached.traps;
    game.chestTraps = cached.chestTraps;
    game.revealed = cached.revealed;
    game.partyPos = p.partyPos;
    game.updateVision();
  } else {
    game.partyPos = p.partyPos; // enterTown already ran in the constructor
  }
  game.refreshChoices();
  const where = p.mode === 'town' ? game.data.town.name : (p.depth === 'boss' ? game.level.name : `floor ${p.depth}`);
  game.log(`The tale resumes where it left off — ${where}, turn ${game.turn}.`, 'good');
}
