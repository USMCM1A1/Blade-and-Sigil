// Procedural floor generation (Phase 5). Every floor below the hand-made
// first one is built here from the designer's tier tables in
// data/dungeon.json: 'rooms' floors are halls joined by corridors (with
// doors, some secret); 'caves' floors are smoothed caverns (no doors).
// The output is a levelData object in exactly the shape of a hand-written
// level file, so game.loadLevel treats generated floors like real ones.

import { roll } from './rules.js';
import { DataError } from './loader.js';
import { isDiceOrInt } from './validate.js';

const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const rollMin0 = dice => Math.max(0, roll(dice));

export function tierFor(dungeon, depth) {
  const t = dungeon.tiers.find(t => depth >= t.floors[0] && depth <= t.floors[1]);
  return t || dungeon.tiers[dungeon.tiers.length - 1]; // deeper than the last tier: it goes on forever
}

// ---- Validation (friendly, designer-facing) ----
// Every tier is checked at BOOT (main.js), not just when a floor generates —
// a typo in floor 7's loot must fail at launch, not five floors into a run
// (it once made the stairs silently "skip" from depth 4 to 9).
export function validateDungeon(data) {
  for (const tier of data.dungeon.tiers) validateTier(tier, data);
  // Magic v3: scroll drop bands.
  const bands = data.dungeon.scroll_drops?.bands;
  if (bands !== undefined) {
    if (!Array.isArray(bands)) throw new DataError('data/dungeon.json', `"scroll_drops" needs a "bands" list.`);
    const check = (knobs, where) => {
      for (const k of ['chance', 'rare_chance']) {
        if (knobs[k] !== undefined && (typeof knobs[k] !== 'number' || knobs[k] < 0 || knobs[k] > 1)) throw new DataError('data/dungeon.json', `${where} "${k}" must be a number between 0 and 1.`);
      }
      if (!Array.isArray(knobs.levels) || knobs.levels.some(l => ![1, 2, 3, 4, 5].includes(l))) throw new DataError('data/dungeon.json', `${where} "levels" must list spell levels 1-5 (e.g. [1, 2]).`);
    };
    bands.forEach((b, i) => {
      const where = `scroll_drops band ${i + 1}`;
      if (!Array.isArray(b.floors) || b.floors.length !== 2 || b.floors[0] > b.floors[1]) throw new DataError('data/dungeon.json', `${where} needs "floors": [first, last].`);
      check(b, where);
      if (b.vault) check(b.vault, `${where} vault`);
    });
  }
  const boss = data.dungeon.boss || {};
  for (const entry of boss.chest_items || []) {
    if (!data.items.items[entry.id]) {
      throw new DataError('data/dungeon.json', `The boss floor's chest_items lists "${entry.id}" but items.json has no such item.`);
    }
  }
  for (const id of Object.values(boss.legend || {})) {
    if (!data.monsters.monsters[id]) {
      throw new DataError('data/dungeon.json', `The boss floor's legend names monster "${id}" but monsters.json has no such monster.`);
    }
  }
}

function validateTier(tier, data) {
  for (const id of Object.keys(tier.monsters || {})) {
    if (!data.monsters.monsters[id]) {
      throw new DataError('data/dungeon.json', `Tier "${tier.name}" lists monster "${id}" but monsters.json has no such monster. Valid: ${Object.keys(data.monsters.monsters).join(', ')}`);
    }
  }
  (tier.encounters ?? []).forEach((e, i) => {
    const where = `Tier "${tier.name}" encounter ${i + 1}`;
    if (!Array.isArray(e.group) || !e.group.length) throw new DataError('data/dungeon.json', `${where} needs a "group" list of monster ids (a group of one is the lone terror).`);
    for (const entry of e.group) {
      const id = typeof entry === 'string' ? entry : entry?.id;
      if (!id || !data.monsters.monsters[id]) throw new DataError('data/dungeon.json', `${where} names monster "${id ?? JSON.stringify(entry)}" but monsters.json has no such monster.`);
      if (typeof entry === 'object' && entry.count !== undefined && !isDiceOrInt(entry.count)) {
        throw new DataError('data/dungeon.json', `${where}: "count" must be a number or dice (e.g. "1d2" or "1d2-1").`);
      }
    }
    if (e.weight !== undefined && (typeof e.weight !== 'number' || e.weight < 1)) throw new DataError('data/dungeon.json', `${where}: "weight" must be 1 or more.`);
  });
  if (tier.encounters?.length && tier.encounter_count !== undefined && typeof tier.encounter_count !== 'string' && typeof tier.encounter_count !== 'number') {
    throw new DataError('data/dungeon.json', `Tier "${tier.name}": "encounter_count" is dice (e.g. "1d2+2") — how many groups spawn per floor.`);
  }
  for (const entry of tier.chest_items || []) {
    if (!data.items.items[entry.id]) {
      throw new DataError('data/dungeon.json', `Tier "${tier.name}" chest_items lists "${entry.id}" but items.json has no such item.`);
    }
  }
  for (const id of tier.traps || []) {
    if (!data.dungeon.traps[id]) {
      throw new DataError('data/dungeon.json', `Tier "${tier.name}" uses trap "${id}" but the "traps" section doesn't define it. Valid: ${Object.keys(data.dungeon.traps).join(', ')}`);
    }
  }
}

// ---- Style: rooms & corridors ----
function carveRooms(w, h) {
  const g = Array.from({ length: h }, () => new Array(w).fill('#'));
  const rooms = [];
  for (let tries = 0; tries < 80 && rooms.length < 9; tries++) {
    const rw = rint(4, 9), rh = rint(3, 6);
    const x = rint(1, w - rw - 1), y = rint(1, h - rh - 1);
    const clash = rooms.some(r => x < r.x + r.w + 1 && x + rw + 1 > r.x && y < r.y + r.h + 1 && y + rh + 1 > r.y);
    if (clash) continue;
    rooms.push({ x, y, w: rw, h: rh, cx: x + Math.floor(rw / 2), cy: y + Math.floor(rh / 2) });
  }
  for (const r of rooms) {
    for (let yy = r.y; yy < r.y + r.h; yy++) for (let xx = r.x; xx < r.x + r.w; xx++) g[yy][xx] = '.';
  }
  // Spine: connect each room to the previous with an L-corridor, then a
  // couple of extra links so floors loop instead of being a straight line.
  rooms.sort((a, b) => a.cx - b.cx);
  const corridor = (a, b) => {
    let { cx: x, cy: y } = a;
    const bendFirst = Math.random() < 0.5;
    const walk = (tx, ty) => {
      while (x !== tx) { x += Math.sign(tx - x); g[y][x] = g[y][x] === '#' ? ',' : g[y][x]; }
      while (y !== ty) { y += Math.sign(ty - y); g[y][x] = g[y][x] === '#' ? ',' : g[y][x]; }
    };
    if (bendFirst) { walk(b.cx, a.cy); walk(b.cx, b.cy); } else { walk(a.cx, b.cy); walk(b.cx, b.cy); }
  };
  for (let i = 1; i < rooms.length; i++) corridor(rooms[i - 1], rooms[i]);
  for (let i = 0; i < 2 && rooms.length > 3; i++) corridor(pick(rooms), pick(rooms));
  // Corridor carving can leave dead-end stubs where paths overlapped —
  // unwind them wall-ward so no doorway ever opens onto nothing.
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (g[y][x] !== ',') continue;
        const solid = [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .filter(([dx, dy]) => g[y + dy][x + dx] === '#').length;
        if (solid >= 3) { g[y][x] = '#'; pruned = true; }
      }
    }
  }
  // ',' marks carved corridor. A doorway must actually DO something: walls
  // on both flanks, open floor on BOTH opposite sides (it separates two
  // places), and a room at its shoulder.
  const open = c => c === '.' || c === ',';
  const doors = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (g[y][x] !== ',') continue;
      const passesVert = g[y - 1][x] === '#' && g[y + 1][x] === '#' && open(g[y][x - 1]) && open(g[y][x + 1]);
      const passesHoriz = g[y][x - 1] === '#' && g[y][x + 1] === '#' && open(g[y - 1][x]) && open(g[y + 1][x]);
      const touchesRoom = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => g[y + dy]?.[x + dx] === '.');
      if ((passesVert || passesHoriz) && touchesRoom) doors.push({ x, y });
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y][x] === ',') g[y][x] = '.';
  for (const d of doors) if (Math.random() < 0.45 && !doors.some(o => o.placed && Math.abs(o.x - d.x) + Math.abs(o.y - d.y) === 1)) {
    g[d.y][d.x] = '+';
    d.placed = true;
  }
  return g;
}

// ---- Style: caves (cellular automata) ----
function carveCaves(w, h) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let g = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) =>
      (x === 0 || y === 0 || x === w - 1 || y === h - 1 || Math.random() < 0.46) ? '#' : '.'));
    // Two-phase smoothing (the classic cellular-automata recipe): the first
    // rounds also GROW rock in wide-open areas (few walls within 2 tiles),
    // seeding the pillars and pinch-points that keep a cavern from becoming
    // one giant room; the last rounds only smooth.
    const wallsWithin = (x, y, r) => {
      let n = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if ((dx || dy) && g[y + dy]?.[x + dx] !== '.') n++;
      }
      return n;
    };
    for (let it = 0; it < 7; it++) {
      const next = g.map(row => [...row]);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const near = wallsWithin(x, y, 1);
          next[y][x] = (near >= 5 || (it < 4 && wallsWithin(x, y, 2) <= 2)) ? '#' : '.';
        }
      }
      g = next;
    }
    // Keep only the biggest cavern; wall off disconnected pockets.
    const seen = new Set();
    let best = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const k0 = y * w + x;
        if (g[y][x] !== '.' || seen.has(k0)) continue;
        const region = [], q = [k0];
        seen.add(k0);
        while (q.length) {
          const k = q.pop();
          region.push(k);
          const kx = k % w, ky = Math.floor(k / w);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nk = (ky + dy) * w + (kx + dx);
            if (g[ky + dy]?.[kx + dx] === '.' && !seen.has(nk)) { seen.add(nk); q.push(nk); }
          }
        }
        if (region.length > best.length) best = region;
      }
    }
    if (best.length < w * h * 0.22) continue; // too cramped — reroll
    const keep = new Set(best);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (g[y][x] === '.' && !keep.has(y * w + x)) g[y][x] = '#';
    }
    // The automata alone leaves one airy hall. Drop clusters of rock into
    // the excess space — stalagmites, rubble, old collapses — until the
    // cavern is closer to two-fifths open, then keep the biggest connected
    // cave that survives. This is what makes tunnels, pinches, and corners.
    const target = w * h * 0.4;
    let openCount = best.length;
    for (let tries = 0; openCount > target && tries < 250; tries++) {
      const fx = rint(2, w - 3), fy = rint(2, h - 3);
      if (g[fy][fx] !== '.') continue;
      const r = rint(1, 2);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > r) continue; // diamond blob
        if (g[fy + dy]?.[fx + dx] === '.') { g[fy + dy][fx + dx] = '#'; openCount--; }
      }
    }
    // Blobs may have pinched bits off — keep only the largest cave again.
    const seen2 = new Set();
    let best2 = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const k0 = y * w + x;
        if (g[y][x] !== '.' || seen2.has(k0)) continue;
        const region = [], q = [k0];
        seen2.add(k0);
        while (q.length) {
          const k = q.pop();
          region.push(k);
          const kx = k % w, ky = Math.floor(k / w);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nk = (ky + dy) * w + (kx + dx);
            if (g[ky + dy]?.[kx + dx] === '.' && !seen2.has(nk)) { seen2.add(nk); q.push(nk); }
          }
        }
        if (region.length > best2.length) best2 = region;
      }
    }
    if (best2.length < w * h * 0.2) continue; // the rockfall buried too much — reroll
    const keep2 = new Set(best2);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (g[y][x] === '.' && !keep2.has(y * w + x)) g[y][x] = '#';
    }
    return g;
  }
  return carveRooms(rint(38, 46), rint(22, 26)); // caves refused to open up — fall back
}

// ---- Feature placement helpers ----
const floorCells = g => {
  const out = [];
  for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0].length; x++) if (g[y][x] === '.') out.push({ x, y });
  return out;
};

// BFS distances over walkable cells: anything the party could eventually
// cross (doors open, monsters die, chests pop) — only walls and secret
// doors block.
function bfs(g, from) {
  const w = g[0].length, dist = new Map([[from.y * w + from.x, 0]]);
  const q = [from];
  while (q.length) {
    const { x, y } = q.shift();
    const d = dist.get(y * w + x);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = ny * w + nx;
      const c = g[ny]?.[nx];
      if (c && c !== '#' && c !== 'S' && !dist.has(k)) { dist.set(k, d + 1); q.push({ x: nx, y: ny }); }
    }
  }
  return dist;
}

function farthestFrom(g, from) {
  const w = g[0].length;
  const dist = bfs(g, from);
  let best = from, bd = -1;
  for (const [k, d] of dist) {
    if (d > bd && g[Math.floor(k / w)][k % w] === '.') { bd = d; best = { x: k % w, y: Math.floor(k / w) }; }
  }
  return best;
}

// A secret vault: a wall-enclosed chamber behind an 'S' door, chest inside.
// Every candidate wall on the floor is considered (in random order), and if
// no rock is thick enough for a grand chamber, smaller ones are tried —
// secret rooms are a promise, not a coin flip.
function carveVault(g, W, H) {
  const spots = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (g[y][x] !== '.') continue;           // must open off walked floor
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (g[y + dy]?.[x + dx] === '#') spots.push({ x, y, dx, dy });
      }
    }
  }
  for (let i = spots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [spots[i], spots[j]] = [spots[j], spots[i]];
  }
  const sizes = [[rint(3, 5), rint(3, 4)], [3, 3], [3, 2], [2, 2]]; // grand first, then humbler
  for (const [vw, vh] of sizes) {
    for (const s of spots) {
      const doorX = s.x + s.dx, doorY = s.y + s.dy;
      const rx0 = s.dx === 1 ? doorX + 1 : s.dx === -1 ? doorX - vw : doorX - Math.floor(vw / 2);
      const ry0 = s.dy === 1 ? doorY + 1 : s.dy === -1 ? doorY - vh : doorY - Math.floor(vh / 2);
      let solid = true;
      for (let y = ry0 - 1; y <= ry0 + vh && solid; y++) {
        for (let x = rx0 - 1; x <= rx0 + vw && solid; x++) {
          if (x === doorX && y === doorY) continue;
          if (g[y]?.[x] !== '#') solid = false; // into untouched rock, fully sealed
        }
      }
      if (!solid) continue;
      for (let y = ry0; y < ry0 + vh; y++) for (let x = rx0; x < rx0 + vw; x++) g[y][x] = '.';
      g[doorY][doorX] = 'S';
      g[ry0 + Math.floor(vh / 2)][rx0 + Math.floor(vw / 2)] = '*'; // a vault chest — rich loot (dungeon.json vault_loot)
      return true;
    }
  }
  return false; // truly no rock anywhere — this floor keeps its walls honest
}

// ---- The generator ----
export function generateFloor(data, depth) {
  const dungeon = data.dungeon;
  const tier = tierFor(dungeon, depth);
  validateTier(tier, data);
  const w = rint(dungeon.floor_size.w[0], dungeon.floor_size.w[1]);
  const h = rint(dungeon.floor_size.h[0], dungeon.floor_size.h[1]);
  const style = pick(tier.styles?.length ? tier.styles : ['rooms']);
  const g = style === 'caves' ? carveCaves(w, h) : carveRooms(w, h);
  const H = g.length, W = g[0].length;

  // Stairs at two far-apart points: pick any floor cell, walk to the cell
  // farthest from it (up-stairs), then farthest from THAT (down-stairs).
  const a = farthestFrom(g, pick(floorCells(g)));
  const b = farthestFrom(g, a);
  g[a.y][a.x] = '<';
  g[b.y][b.x] = '>';
  // The party arrives beside the up-stairs.
  const start = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: a.x + dx, y: a.y + dy }))
    .find(p => g[p.y]?.[p.x] === '.') || pick(floorCells(g));
  g[start.y][start.x] = '@';

  const upDist = bfs(g, a); // distance-from-entrance, for spacing monsters
  const openFar = floorCells(g).filter(p => (upDist.get(p.y * W + p.x) ?? 99) > 7);
  const takeSpot = pool => {
    while (pool.length) {
      const i = Math.floor(Math.random() * pool.length);
      const p = pool.splice(i, 1)[0];
      if (g[p.y][p.x] === '.') return p;
    }
    return null;
  };

  // Monsters. ENCOUNTERS (designer ruling 2026-08-31): a tier with an
  // 'encounters' list spawns named GROUPS — a vampire with wight and shadow
  // in its thrall — clustered within two tiles of an anchor so the battle
  // radius pulls the whole court in. A group of one is the deliberate lone
  // terror. Tiers without the list keep the old scattered weighted singles.
  const legend = {}, letters = {};
  let nextLetter = 'a'.charCodeAt(0);
  const monsterPool = [...openFar];
  const placeAs = (id, x, y) => {
    if (!letters[id]) {
      letters[id] = String.fromCharCode(nextLetter++);
      legend[letters[id]] = id;
    }
    g[y][x] = letters[id];
  };
  const packs = [];
  if (tier.encounters?.length) {
    const ebag = [];
    for (const e of tier.encounters) for (let i = 0; i < (e.weight ?? 1); i++) ebag.push(e);
    for (let i = 0, n = rollMin0(tier.encounter_count || '1d2+2'); i < n; i++) {
      const enc = pick(ebag);
      const anchor = takeSpot(monsterPool);
      if (!anchor) break;
      const members = [];
      for (const entry of enc.group) {
        const id = typeof entry === 'string' ? entry : entry.id;
        const ct = typeof entry === 'string' ? 1
          : typeof entry.count === 'number' ? entry.count : rollMin0(entry.count ?? '1');
        for (let k = 0; k < ct; k++) members.push(id);
      }
      if (!members.length) continue;
      const spots = [anchor];
      outer: for (let r = 1; r <= 2 && spots.length < members.length; r++) {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = anchor.x + dx, y = anchor.y + dy;
          if (g[y]?.[x] === '.') { spots.push({ x, y }); if (spots.length >= members.length) break outer; }
        }
      }
      const placed = [];
      members.slice(0, spots.length).forEach((id, k) => {
        placeAs(id, spots[k].x, spots[k].y);
        placed.push([spots[k].x, spots[k].y]);
      });
      if (enc.name && placed.length > 1) packs.push({ name: enc.name, spots: placed });
    }
  } else {
    const bag = [];
    for (const [id, weight] of Object.entries(tier.monsters)) {
      for (let i = 0; i < weight; i++) bag.push(id);
    }
    for (let i = 0, n = rollMin0(tier.monster_count || '2d3+2'); i < n; i++) {
      const spot = takeSpot(monsterPool);
      if (!spot) break;
      placeAs(pick(bag), spot.x, spot.y);
    }
  }

  // Chests anywhere, traps only past the doorstep.
  const anyPool = floorCells(g);
  for (let i = 0, n = rollMin0(tier.chest_count || '1d3'); i < n; i++) {
    const spot = takeSpot(anyPool);
    if (spot) g[spot.y][spot.x] = '$';
  }
  // Traps go where feet must fall: doorway thresholds, corridor squeezes,
  // cavern pinch-points, and the tile in front of a chest — never sprinkled
  // across open floor where no one would think to dig one.
  const traps = [];
  const solid = (x, y) => g[y]?.[x] === '#' || g[y]?.[x] === undefined;
  const chokepoint = p =>
    (solid(p.x, p.y - 1) && solid(p.x, p.y + 1)) ||   // squeezed top & bottom
    (solid(p.x - 1, p.y) && solid(p.x + 1, p.y)) ||   // squeezed left & right
    [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) =>
      "+$".includes(g[p.y + dy]?.[p.x + dx]));        // a threshold or a chest's doorstep
  const farEnough = p => (upDist.get(p.y * W + p.x) ?? 0) > 3;
  const trapPool = floorCells(g).filter(p => farEnough(p) && chokepoint(p));
  const sparePool = floorCells(g).filter(p => farEnough(p) && !chokepoint(p));
  for (let i = 0, n = (tier.traps?.length ? rollMin0(tier.trap_count || '1d2-1') : 0); i < n; i++) {
    const spot = takeSpot(trapPool) || takeSpot(sparePool);
    if (spot) traps.push({ x: spot.x, y: spot.y, id: pick(tier.traps) });
  }

  // Secret doors guard hidden treasure vaults: a small chamber carved out
  // of solid wall, reachable ONLY through the 'S' door, with a chest
  // inside. Optional riches — a missed one can never block the way down.
  for (let i = 0, n = rollMin0(tier.secret_doors || '0d1'); i < n; i++) carveVault(g, W, H);

  return {
    packs,
    name: `Depth ${depth} — ${tier.name}`,
    map: g.map(row => row.join('')),
    legend,
    chest_gold: tier.chest_gold,
    chest_items: tier.chest_items || [],
    chest_trap_chance: tier.chest_trap_chance, // undefined falls back to dungeon.json's top-level chance
    chest_traps: tier.traps || [],             // a rigged chest carries one of this floor's trap flavors

    rest_ambush: tier.rest_ambush ?? 0,
    tactics: style === 'caves' ? ['cave'] : ['room'],
    traps,
    file: 'data/dungeon.json',
  };
}
