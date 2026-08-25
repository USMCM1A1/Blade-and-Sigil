// Canvas renderer: tile map, fog of war, sprites, camera.

import { abilityMod } from './rules.js';

const TILE = 56;
const PARTY_ICON = 'assets/heroes/party-icon.png';

const COLORS = {
  floor: '#232330',
  floorEdge: '#1c1c27',
  wall: '#4a4a5c',
  wallTop: '#5c5c72',
  wallDark: '#33333f',
  doorWood: '#7a5230',
  doorDark: '#5c3d22',
  stairs: '#d4a94e',
};

export class Renderer {
  constructor(canvas, game, images) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.images = images;
    this.cols = Math.floor(canvas.width / TILE);
    this.rows = Math.floor(canvas.height / TILE);
  }

  draw() {
    const { ctx, game } = this;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (game.battle) {
      this.drawBattle();
      return;
    }
    if (game.mode === 'town') {
      this.drawTown();
      return;
    }

    // Camera centered on party, clamped to map bounds.
    const camX = Math.max(0, Math.min(game.level.w - this.cols, game.partyPos.x - Math.floor(this.cols / 2)));
    const camY = Math.max(0, Math.min(game.level.h - this.rows, game.partyPos.y - Math.floor(this.rows / 2)));

    for (let sy = 0; sy < this.rows; sy++) {
      for (let sx = 0; sx < this.cols; sx++) {
        const x = camX + sx, y = camY + sy;
        if (x >= game.level.w || y >= game.level.h) continue;
        if (!game.seen[y][x]) continue;
        this.drawTile(game.grid[y][x], sx * TILE, sy * TILE, x, y);
        if (!game.isVisible(x, y)) {
          ctx.fillStyle = 'rgba(0,0,0,0.6)'; // remembered but not currently lit
          ctx.fillRect(sx * TILE, sy * TILE, TILE, TILE);
        }
      }
    }

    // Spotted traps: a warning sigil the party can now walk around.
    for (const t of game.traps || []) {
      if (!t.detected || !game.seen[t.y]?.[t.x]) continue;
      const tx = t.x - camX, ty = t.y - camY;
      if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) continue;
      ctx.fillStyle = '#e0912f';
      ctx.font = `bold ${Math.floor(TILE / 2)}px Georgia`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⚠', tx * TILE + TILE / 2, ty * TILE + TILE / 2);
    }

    // Monsters (only when currently visible).
    for (const m of game.monsters) {
      if (!game.isVisible(m.x, m.y)) continue;
      this.drawSprite(m.sprite, (m.x - camX) * TILE, (m.y - camY) * TILE);
      if (m.hp < m.maxHp) this.drawHpBar(m, (m.x - camX) * TILE, (m.y - camY) * TILE);
    }

    // The party token: one banner icon for the whole marching group.
    const px = (game.partyPos.x - camX) * TILE, py = (game.partyPos.y - camY) * TILE;
    const icon = this.images[PARTY_ICON];
    if (icon) {
      ctx.drawImage(icon, px + 1, py + 1, TILE - 2, TILE - 2);
    } else {
      ctx.fillStyle = COLORS.stairs;
      ctx.font = `bold ${TILE - 16}px Georgia`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⚔', px + TILE / 2, py + TILE / 2);
    }
    ctx.strokeStyle = 'rgba(212,169,78,0.8)';
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 1, py + 1, TILE - 2, TILE - 2);

    if (game.victory || game.over) this.drawBanner(game.victory ? 'VICTORY!' : 'THE PARTY HAS FALLEN', game.victory ? '#d4a94e' : '#b03535');
  }

  drawTile(c, px, py, x, y) {
    const { ctx, game } = this;
    // An undetected secret door wears a wall's face; a spotted one glows.
    if (c === 'S' && !game.revealed?.has(`${x},${y}`)) c = '#';
    if (c === '#') {
      ctx.fillStyle = COLORS.wall;
      ctx.fillRect(px, py, TILE, TILE);
      ctx.fillStyle = COLORS.wallTop;
      ctx.fillRect(px, py, TILE, 5);
      ctx.fillStyle = COLORS.wallDark;
      ctx.fillRect(px, py + TILE - 5, TILE, 5);
      return;
    }
    if (c === 'S') { // revealed secret door: a wall with a telltale seam
      ctx.fillStyle = COLORS.wall;
      ctx.fillRect(px, py, TILE, TILE);
      ctx.strokeStyle = '#7fd4c8';
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 6, py + 4, TILE - 12, TILE - 8);
      ctx.fillStyle = '#7fd4c8';
      ctx.font = `bold ${Math.floor(TILE / 3)}px Georgia`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', px + TILE / 2, py + TILE / 2);
      return;
    }
    // Everything else sits on a floor tile.
    ctx.fillStyle = COLORS.floor;
    ctx.fillRect(px, py, TILE, TILE);
    ctx.strokeStyle = COLORS.floorEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);

    if (c === '+') {
      const door = this.images['assets/misc/door_1.png'];
      if (door) this.drawSprite('assets/misc/door_1.png', px, py);
      else {
        ctx.fillStyle = COLORS.doorWood;
        ctx.fillRect(px + 4, py + 2, TILE - 8, TILE - 4);
        ctx.fillStyle = COLORS.doorDark;
        ctx.fillRect(px + 8, py + 6, TILE - 16, TILE - 12);
      }
    } else if (c === "'") {
      ctx.strokeStyle = COLORS.doorWood; // open door: just the frame
      ctx.lineWidth = 3;
      ctx.strokeRect(px + 3, py + 3, TILE - 6, TILE - 6);
    } else if (c === '$') {
      this.drawSprite('assets/misc/loot_drop.jpg', px, py);
    } else if (c === '>') {
      ctx.fillStyle = COLORS.stairs;
      ctx.font = `bold ${TILE - 10}px Georgia`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('▼', px + TILE / 2, py + TILE / 2 + 2);
    } else if (c === '<') {
      ctx.fillStyle = COLORS.stairs;
      ctx.font = `bold ${TILE - 10}px Georgia`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('▲', px + TILE / 2, py + TILE / 2 + 2);
    }
  }

  // ---- Novamagus (Phase 4) ----
  // The whole town fits on screen: cobblestones, hedges, and the buildings
  // with their signs. No fog, no turns — a safe place.
  drawTown() {
    const { ctx, game } = this;
    const w = game.level.w, h = game.level.h;
    const ox = Math.max(0, (this.canvas.width - w * TILE) / 2);
    const oy = Math.max(0, (this.canvas.height - h * TILE) / 2);
    const img = n => this.images[`assets/town/${n}`];
    const SPRITES = { v: 'vegetation.png', i: 'inn.png', s: 'shop.png', d: 'dungeon_entrance.png' };
    const LABELS = { i: 'Inn', s: 'Shop', t: 'Temple', d: 'Dungeon' };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = ox + x * TILE, py = oy + y * TILE;
        const cobble = img('cobblestones.png');
        if (cobble) ctx.drawImage(cobble, px, py, TILE, TILE);
        const c = game.grid[y][x];
        if (c === 't') {
          // Placeholder shrine tile until the designer paints a temple.
          ctx.fillStyle = 'rgba(16,14,26,0.88)';
          ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
          ctx.strokeStyle = COLORS.stairs;
          ctx.lineWidth = 2;
          ctx.strokeRect(px + 3, py + 3, TILE - 6, TILE - 6);
          ctx.fillStyle = COLORS.stairs;
          ctx.font = `bold ${TILE - 22}px Georgia`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('✝', px + TILE / 2, py + TILE / 2 + 2);
        } else if (SPRITES[c]) {
          const s = img(SPRITES[c]);
          if (s) ctx.drawImage(s, px, py, TILE, TILE);
        }
        if (LABELS[c]) {
          ctx.font = 'bold 11px Georgia';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'alphabetic';
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#000';
          ctx.strokeText(LABELS[c], px + TILE / 2, py + TILE - 4);
          ctx.fillStyle = COLORS.stairs;
          ctx.fillText(LABELS[c], px + TILE / 2, py + TILE - 4);
        }
      }
    }

    // The party token.
    const px = ox + game.partyPos.x * TILE, py = oy + game.partyPos.y * TILE;
    const icon = this.images[PARTY_ICON];
    if (icon) ctx.drawImage(icon, px + 1, py + 1, TILE - 2, TILE - 2);

    ctx.fillStyle = 'rgba(207,196,166,0.75)';
    ctx.font = '13px Georgia';
    ctx.textAlign = 'center';
    ctx.fillText('Walk into a building to enter it — the dungeon waits at its gate.',
      this.canvas.width / 2, oy + h * TILE + 22);
  }

  // ---- Tactical battlefield (Phase 3a) ----
  // A template-built grid: every combatant on their own square, the active
  // hero ringed in gold with their reachable squares lit.
  drawBattle() {
    const { ctx, game } = this;
    const b = game.battle;
    const W = this.canvas.width, H = this.canvas.height;
    const gw = b.grid[0].length, gh = b.grid.length;
    // Cells grow with the canvas: fill the space between the header and the
    // footer hints (44px floor keeps cramped windows playable).
    const CELL = Math.max(44, Math.min(Math.floor((W - 60) / gw), Math.floor((H - 180) / gh)));
    const ox = (W - gw * CELL) / 2;
    const oy = 64 + Math.max(0, (H - 64 - 84 - gh * CELL) / 2);

    ctx.fillStyle = '#101018';
    ctx.fillRect(0, 0, W, H);

    // Header: template name + round on the left…
    ctx.fillStyle = COLORS.stairs;
    ctx.font = 'bold 19px Georgia';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`⚔  ${b.templateName}`, 18, 10);
    ctx.font = '13px Georgia';
    ctx.fillStyle = '#8a8a99';
    ctx.fillText(`Round ${b.round}`, 20, 34);

    // …and the initiative tracker on the right: portrait chips in turn
    // order, HP slivers underneath, the active combatant ringed in gold.
    const order = b.combatants.filter(c => c.kind === 'hero' ? true : c.ref.hp > 0);
    const CHIP = 38, GAP = 9, chipY = 9;
    let tx = W - 18 - order.length * (CHIP + GAP) + GAP;
    for (const c of order) {
      const isActive = c === b.active();
      const dead = c.kind === 'hero' && !c.ref.alive;
      const icon = c.kind === 'hero'
        ? (this.images[c.ref.cls.portrait] || this.images[c.ref.cls.sprite])
        : this.images[c.ref.sprite];
      ctx.save();
      if (dead) ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(tx, chipY, CHIP, CHIP);
      if (icon) ctx.drawImage(icon, tx, chipY, CHIP, CHIP);
      const hpFrac = Math.max(0, c.ref.hp / c.ref.maxHp);
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(tx, chipY + CHIP + 2, CHIP, 4);
      ctx.fillStyle = c.kind === 'hero' ? '#5c88d8' : '#c04848';
      ctx.fillRect(tx, chipY + CHIP + 2, CHIP * hpFrac, 4);
      ctx.strokeStyle = isActive ? COLORS.stairs : (c.kind === 'hero' ? '#3d4d6d' : '#5d3535');
      ctx.lineWidth = isActive ? 3 : 1.5;
      ctx.strokeRect(tx + 0.5, chipY + 0.5, CHIP - 1, CHIP - 1);
      if (isActive) {
        ctx.fillStyle = COLORS.stairs;
        ctx.font = 'bold 12px Georgia';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('▾', tx + CHIP / 2, chipY + CHIP + 16);
      }
      ctx.restore();
      tx += CHIP + GAP;
    }
    ctx.textBaseline = 'top';

    // The battlefield grid. In targeting mode, squares in range glow cold;
    // in move mode the active hero's reachable squares glow warm.
    const a0 = b.active();
    const reach = (b.mode === 'move' && a0?.kind === 'hero') ? b.reachable() : new Set();
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const px = ox + x * CELL, py = oy + y * CELL;
        if (b.grid[y][x] === '#') {
          ctx.fillStyle = COLORS.wall;
          ctx.fillRect(px, py, CELL, CELL);
          ctx.fillStyle = COLORS.wallTop;
          ctx.fillRect(px, py, CELL, 5);
          ctx.fillStyle = COLORS.wallDark;
          ctx.fillRect(px, py + CELL - 5, CELL, 5);
        } else {
          let fill = COLORS.floor;
          if (reach.has(y * gw + x)) fill = '#2c2a1e';
          if (b.mode === 'target' && a0
              && b.dist(a0.x, a0.y, x, y) <= b.pending.range
              && b.losClear(a0.x, a0.y, x, y)) fill = '#1e2436';
          ctx.fillStyle = fill;
          ctx.fillRect(px, py, CELL, CELL);
          ctx.strokeStyle = COLORS.floorEdge;
          ctx.lineWidth = 1;
          ctx.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);
        }
      }
    }

    // Area-of-effect preview around the crosshair.
    if (b.mode === 'target' && b.pending?.spell?.area) {
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          if (b.dist(x, y, b.cursor.x, b.cursor.y) <= b.pending.spell.area && b.grid[y][x] !== '#') {
            ctx.fillStyle = 'rgba(200,80,40,0.28)';
            ctx.fillRect(ox + x * CELL, oy + y * CELL, CELL, CELL);
          }
        }
      }
    }

    // The Burglar's planted traps — the party knows where they are.
    for (const t of b.battleTraps ?? []) {
      ctx.fillStyle = '#e0912f';
      ctx.font = `bold ${Math.floor(CELL / 3)}px Georgia`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⚙', ox + t.x * CELL + CELL / 2, oy + t.y * CELL + CELL / 2);
    }

    // Combatants. Slain monsters fall and stay on the field as faded,
    // walkable corpses for the rest of the battle. Corpses draw first so
    // anyone stepping onto the square stands on top of the body.
    const nowD = performance.now();
    const drawOrder = [...b.combatants].sort((a, z) =>
      (a.kind === 'monster' && a.ref.hp <= 0 ? 0 : 1) - (z.kind === 'monster' && z.ref.hp <= 0 ? 0 : 1));
    for (const c of drawOrder) {
      const dying = c.kind === 'monster' && c.ref.hp <= 0;
      if (dying && !c.diedAt) continue;
      const px = ox + c.x * CELL, py = oy + c.y * CELL;
      const dead = c.kind === 'hero' && !c.ref.alive;
      const hidden = c.kind === 'hero' && c.ref.hidden;
      ctx.save();
      if (dead) ctx.globalAlpha = 0.5;
      if (hidden) ctx.globalAlpha = 0.4; // in the shadows: the player sees a ghost, monsters see nothing
      if (dying) ctx.globalAlpha = Math.max(0.35, 0.9 - (nowD - c.diedAt) / 1600);
      const sprite = c.kind === 'hero'
        ? (c.ref.alive ? c.ref.cls.sprite : c.ref.cls.sprite_dead)
        : (dying ? (c.ref.sprite_dead || c.ref.sprite) : c.ref.sprite);
      const img = this.images[sprite];
      if (img) ctx.drawImage(img, px + 4, py + 3, CELL - 8, CELL - 14);
      if (c === b.active() && !dead) {
        // Gold ring = your hero's turn; red ring = this monster is acting.
        ctx.strokeStyle = c.kind === 'hero' ? COLORS.stairs : '#c04040';
        ctx.lineWidth = 3;
        ctx.strokeRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3);
      }
      // Stealth badges: 💤 on a monster that hasn't noticed the party yet
      // (an Assassinate mark), a wisp on a hidden hero.
      if (c.kind === 'monster' && !dying && !c.aware) {
        ctx.font = `bold ${Math.max(12, Math.round(CELL / 4))}px Georgia`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#000';
        ctx.strokeText('💤', px + CELL - 3, py + 1);
        ctx.fillStyle = '#b03a8e';
        ctx.fillText('💤', px + CELL - 3, py + 1);
      }
      if (hidden) {
        ctx.globalAlpha = 0.9;
        ctx.font = `bold ${Math.max(10, Math.round(CELL / 5.5))}px Georgia`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#8a7ab8';
        ctx.fillText('hidden', px + CELL - 4, py + 2);
        ctx.globalAlpha = 0.4;
      }
      // Condition pips along the square's top edge (not on corpses).
      (dying ? [] : c.ref.conditions ?? []).forEach((cond, ci) => {
        const cdef = this.game.conditionDef(cond.id);
        if (!cdef) return;
        ctx.fillStyle = cdef.color;
        ctx.fillRect(px + 4 + ci * 10, py + 3, 7, 7);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 4.5 + ci * 10, py + 3.5, 7, 7);
      });

      // Name + HP bar in the square's footer.
      ctx.fillStyle = c.kind === 'hero' ? '#a8c0e8' : '#e8a8a8';
      if (dead) ctx.fillStyle = '#777';
      ctx.font = `${Math.max(10, Math.round(CELL / 6.5))}px Verdana`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(c.ref.name.slice(0, 9), px + CELL / 2, py + CELL - 12);
      if (!dying) { // corpses keep a faint name but lose the drained HP bar
        ctx.fillStyle = '#0a0a0f';
        ctx.fillRect(px + 5, py + CELL - 9, CELL - 10, 5);
        ctx.fillStyle = c.kind === 'hero' ? '#5c88d8' : '#c04848';
        ctx.fillRect(px + 5, py + CELL - 9, (CELL - 10) * Math.max(0, c.ref.hp / c.ref.maxHp), 5);
      }
      ctx.restore();
    }

    // Animated spell visuals: bolts crossing the field, beams and lightning
    // connecting caster to target, bursts washing the squares they caught,
    // sparkles rising from the mended. Drawn UNDER the floating numbers.
    this.drawSpellFx(ctx, b, ox, oy, CELL);

    // Floating combat text: rises and fades over a second, so hits, heals,
    // and misses read right on the battlefield instead of only in the log.
    const now = performance.now();
    b.fx = b.fx.filter(f => now - f.born < 1100);
    for (const f of b.fx) {
      if (now < f.born) continue; // holding for impact (the bolt is mid-air)
      const age = (now - f.born) / 1100;
      ctx.save();
      ctx.globalAlpha = 1 - age * age;
      ctx.font = 'bold 17px Verdana';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const fx = ox + f.x * CELL + CELL / 2;
      const fy = oy + f.y * CELL + 8 - age * 34;
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#000';
      ctx.strokeText(f.text, fx, fy);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, fx, fy);
      ctx.restore();
    }

    // Targeting crosshair.
    if (b.mode === 'target' && b.cursor) {
      const px = ox + b.cursor.x * CELL, py = oy + b.cursor.y * CELL;
      ctx.strokeStyle = b.cursorValid() ? COLORS.stairs : '#b03535';
      ctx.lineWidth = 3;
      ctx.strokeRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3);
      ctx.font = 'bold 14px Georgia';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('✛', px + CELL / 2, py - 2);
    }

    // Footer: whose turn + hints.
    const a = b.active();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    if (a?.kind === 'monster') {
      ctx.fillStyle = '#e08080';
      ctx.font = 'bold 15px Georgia';
      ctx.fillText(`The ${a.ref.name} acts…`, W / 2, H - 42);
    } else if (a?.kind === 'hero' && b.mode === 'move') {
      ctx.fillStyle = COLORS.stairs;
      ctx.font = 'bold 15px Georgia';
      // Bump preview: a foe in reach shows the odds — and why (stealth tags).
      let bump = '';
      const foe = b.monsters()
        .filter(mc => Math.abs(mc.x - a.x) + Math.abs(mc.y - a.y) === 1)
        .sort((p, q) => (b.assassinateTriggers(a, q) ? 2 : b.isUnaware(q, a.ref) ? 1 : 0)
          - (b.assassinateTriggers(a, p) ? 2 : b.isUnaware(p, a.ref) ? 1 : 0))[0];
      if (foe) {
        const tags = [];
        if (b.assassinateTriggers(a, foe)) tags.push('ASSASSINATE ready!');
        else if (b.assassinateGuarded(a, foe)) tags.push('💤 unaware but GUARDED — no Assassinate');
        else if (b.isUnaware(foe, a.ref)) tags.push('💤 unaware');
        if (b.isFlanked(foe)) tags.push('flanked');
        const pct = Math.round(Math.max(5, Math.min(95, (21 + b.attackBonus(a.ref) - (10 + foe.ref.ac)) / 20 * 100)));
        bump = ` · bump the ${foe.ref.name}: ${tags.some(t => t.startsWith('ASSASSINATE')) ? 'auto-crit' : `${pct}% to hit`}${tags.length ? ` (${tags.join(', ')})` : ''}`;
      }
      ctx.fillText(`${a.ref.name}'s turn — ${b.movesLeft} move${b.movesLeft === 1 ? '' : 's'} left${bump}`, W / 2, H - 42);
    } else if (b.mode === 'target') {
      ctx.fillStyle = COLORS.stairs;
      ctx.font = 'bold 15px Georgia';
      const p = b.pending;
      const what = p.kind === 'shoot' ? `${a.ref.weapon.name}`
        : p.kind === 'trap' ? `${p.entry.name} (pick an empty square)`
        : p.kind === 'shadowstep' ? `${p.entry.name} (pick where to reappear)`
        : p.kind === 'deathblow' ? p.entry.name
        : p.spell.name;
      // Odds preview for the monster under the crosshair: to-hit % for
      // shots, save DC (and odds of full damage) for spells.
      let odds = '';
      const tgt = b.cursor && b.cursorValid() && b.monsterAt(b.cursor.x, b.cursor.y);
      if (tgt) {
        const pct = pr => `${Math.round(Math.max(5, Math.min(95, pr * 100)))}%`;
        if (p.kind === 'shoot') {
          odds = ` · ${pct((21 + b.attackBonus(a.ref) - (10 + tgt.ref.ac)) / 20)} to hit`;
        } else if (p.kind === 'deathblow') {
          odds = ' · an automatic critical — it cannot miss';
        } else if (p.spell) {
          const s = p.spell;
          if (s.auto) odds = ' · never misses';
          else if (s.save || s.type === 'afflict') {
            // Insight and Overcast raise the bar — the preview shows the real DC.
            const dc = 10 + s.level + abilityMod(a.ref.abilities[s.stat])
              + (a.ref.insight?.dc ?? 0) + (s.dc_bonus ?? 0);
            const failSave = (dc - (tgt.ref.save || 0) - 1) / 20;
            odds = ` · save DC ${dc} — ${pct(failSave)} for full ${s.type === 'afflict' ? 'effect' : 'damage'}`;
          }
        }
      }
      ctx.fillText(`Aiming ${what} — range ${b.pending.range}${odds}`, W / 2, H - 42);
    }
    ctx.fillStyle = 'rgba(207,196,166,0.7)';
    ctx.font = '13px Georgia';
    // The C hint NAMES the hero's battle arts — a power nobody sees is a
    // power nobody uses (Rage, Vanish, and every named Rite verb).
    let cHint = '';
    if (a?.kind === 'hero') {
      const acts = b.classActives(a);
      const hasSpells = b.castables(a).length > 0;
      if (acts.length) {
        const names = acts.slice(0, 2).map(s => s.hint ?? s.name).join(', ');
        cHint = `C — ${names}${acts.length > 2 ? ' +more' : ''}${hasSpells ? ' & spells' : ''} · `;
      } else if (hasSpells) {
        cHint = 'C — spells · ';
      }
    }
    const hints = b.mode === 'target'
      ? 'arrows — aim · Enter — unleash! · Esc — cancel'
      : `arrows — move & bump to attack · ${cHint}${a?.kind === 'hero' && b.canShoot(a) ? 'F — shoot · ' : ''}${a?.kind === 'hero' && this.game.heldItems().length ? 'I — item · ' : ''}Space — end turn · Esc — flee`;
    ctx.fillText(hints, W / 2, H - 20);

    // Abilities menu overlay (spells + class battle arts). A high-level
    // caster's list outgrows nine digits, so the menu scrolls: arrows walk a
    // highlight, Enter casts it, digits still snap to the first nine.
    if (b.mode === 'menu' && a?.kind === 'hero') {
      const full = b.abilities(a);
      const sel = Math.min(b.menuSel ?? 0, full.length - 1);
      const maxRows = Math.max(3, Math.min(full.length, Math.floor((H - 150) / 44)));
      const start = Math.max(0, Math.min(sel - Math.floor(maxRows / 2), full.length - maxRows));
      const list = full.slice(start, start + maxRows);
      const mw = 460, mh = 70 + list.length * 44;
      const mx = (W - mw) / 2, my = (H - mh) / 2;
      ctx.fillStyle = 'rgba(10,10,16,0.92)';
      ctx.fillRect(mx, my, mw, mh);
      ctx.strokeStyle = COLORS.stairs;
      ctx.lineWidth = 2;
      ctx.strokeRect(mx, my, mw, mh);
      ctx.fillStyle = COLORS.stairs;
      ctx.font = 'bold 17px Georgia';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`${a.ref.name}'s abilities${a.ref.maxSp ? ` — ${a.ref.sp} SP` : ''}${start > 0 ? ' ▲' : ''}${start + maxRows < full.length ? ' ▼' : ''}`, mx + mw / 2, my + 12);
      list.forEach((s, i) => {
        const idx = start + i;
        const ly = my + 48 + i * 44;
        if (idx === sel) {
          ctx.fillStyle = 'rgba(212,169,78,0.16)';
          ctx.fillRect(mx + 8, ly - 6, mw - 16, 42);
        }
        ctx.textAlign = 'left';
        ctx.fillStyle = s.affordable ? (idx === sel ? '#ffe9b8' : '#cfc4a6') : '#66605a';
        ctx.font = 'bold 14px Georgia';
        const key = idx < 9 ? `${idx + 1}.` : ' ·';
        const lvlTag = s.level ? `L${s.level} · ` : '';
        ctx.fillText(`${key}  ${s.name}  —  ${lvlTag}${s.cost ? `${s.cost} SP` : 'free'}${s.range ? ` · range ${s.range}` : ''}${s.area ? ` · burst ${s.area}` : ''}`, mx + 20, ly);
        ctx.font = 'italic 11.5px Georgia';
        ctx.fillStyle = s.affordable ? '#8a8a99' : '#55504c';
        ctx.fillText(s.description.length > 76 ? s.description.slice(0, 74) + '…' : s.description, mx + 38, ly + 17);
      });
      ctx.textAlign = 'center';
      ctx.fillStyle = '#8a8a99';
      ctx.font = '12px Georgia';
      ctx.fillText('↑↓ choose · Enter or number — cast · Esc — close', mx + mw / 2, my + mh - 22);
    }

    // Item menu overlay — same skin as the spell menu.
    if (b.mode === 'items' && a?.kind === 'hero') {
      const list = b.usableItems(a);
      const mw = 380, mh = 70 + list.length * 44;
      const mx = (W - mw) / 2, my = (H - mh) / 2;
      ctx.fillStyle = 'rgba(10,10,16,0.92)';
      ctx.fillRect(mx, my, mw, mh);
      ctx.strokeStyle = COLORS.stairs;
      ctx.lineWidth = 2;
      ctx.strokeRect(mx, my, mw, mh);
      ctx.fillStyle = COLORS.stairs;
      ctx.font = 'bold 17px Georgia';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`The party pouch — ${a.ref.name} drinks`, mx + mw / 2, my + 12);
      list.forEach((it, i) => {
        const ly = my + 48 + i * 44;
        ctx.textAlign = 'left';
        ctx.fillStyle = it.usable ? '#cfc4a6' : '#66605a';
        ctx.font = 'bold 14px Georgia';
        ctx.fillText(`${i + 1}.  ${it.def.name}  ×${it.count}`, mx + 20, ly);
        ctx.font = 'italic 11.5px Georgia';
        ctx.fillStyle = it.usable ? '#8a8a99' : '#55504c';
        ctx.fillText(it.def.description, mx + 38, ly + 17);
      });
      ctx.textAlign = 'center';
      ctx.fillStyle = '#8a8a99';
      ctx.font = '12px Georgia';
      ctx.fillText('press a number to drink (ends the turn) · Esc to close', mx + mw / 2, my + mh - 22);
    }

    // Guardian's Stand: the blow hangs in the air while the player decides.
    if (b.pendingReaction) {
      const r = b.pendingReaction;
      const mw = 480, mh = 110;
      const mx = (W - mw) / 2, my = (H - mh) / 2;
      ctx.fillStyle = 'rgba(10,10,16,0.94)';
      ctx.fillRect(mx, my, mw, mh);
      ctx.strokeStyle = '#7fd4c8';
      ctx.lineWidth = 2;
      ctx.strokeRect(mx, my, mw, mh);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#7fd4c8';
      ctx.font = 'bold 18px Georgia';
      ctx.fillText(`Guardian's Stand!`, mx + mw / 2, my + 14);
      ctx.fillStyle = '#cfc4a6';
      ctx.font = '14px Georgia';
      ctx.fillText(`The ${r.m.name}'s blow (${r.dmg} damage) is falling on ${r.target.name}.`, mx + mw / 2, my + 44);
      ctx.fillStyle = COLORS.stairs;
      ctx.font = 'bold 14px Georgia';
      ctx.fillText(`Y — ${r.guardian.name} takes the blow · N — let it land`, mx + mw / 2, my + 74);
    }

    // Ending beat: let the killing blow's numbers land first, then banner.
    if (b.ending && performance.now() - b.endedAt > 700) {
      this.drawBanner(b.ending === 'victory' ? 'VICTORY!' : 'THE PARTY HAS FALLEN',
        b.ending === 'victory' ? COLORS.stairs : '#b03535');
    }
  }

  // ---- Spell visuals ----
  // Sprites are white-on-transparent (the art pipeline's tintable layers);
  // each (sprite, color) pair is tinted once and cached. A sprite that
  // hasn't loaded yet (or is missing) falls back to a plain glow.
  fxSprite(key, color) {
    const paths = {
      dart: 'assets/fx/fx_dart.png', fire: 'assets/fx/fx_burst_fire.png',
      frost: 'assets/fx/fx_burst_frost.png', holy: 'assets/fx/fx_burst_holy.png',
      sparkle: 'assets/fx/fx_spark.png', wisp: 'assets/fx/fx_wisp.png',
    };
    const src = paths[key];
    if (!src) return null;
    this.fxImages ??= {};
    this.fxTinted ??= new Map();
    if (!(src in this.fxImages)) {
      this.fxImages[src] = null;
      const img = new Image();
      img.onload = () => { this.fxImages[src] = img; };
      img.src = src;
    }
    const img = this.fxImages[src];
    if (!img) return null;
    const ck = `${key}|${color}`;
    if (!this.fxTinted.has(ck)) {
      const off = document.createElement('canvas');
      off.width = img.width; off.height = img.height;
      const c2 = off.getContext('2d');
      c2.drawImage(img, 0, 0);
      c2.globalCompositeOperation = 'source-in';
      c2.fillStyle = color;
      c2.fillRect(0, 0, off.width, off.height);
      this.fxTinted.set(ck, off);
    }
    return this.fxTinted.get(ck);
  }

  drawSpellFx(ctx, b, ox, oy, CELL) {
    const now = performance.now();
    b.spellFx = (b.spellFx ?? []).filter(f => now < f.born + f.dur);
    const center = p => [ox + p.x * CELL + CELL / 2, oy + p.y * CELL + CELL / 2];
    for (const f of b.spellFx) {
      if (now < f.born) continue; // chained bursts wait for their bolt
      const t = (now - f.born) / f.dur;
      ctx.save();
      if (f.kind === 'bolt') {
        const [x0, y0] = center(f.from), [x1, y1] = center(f.to);
        const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
        const ang = Math.atan2(y1 - y0, x1 - x0);
        ctx.translate(px, py);
        ctx.rotate(ang);
        ctx.shadowColor = f.color;
        ctx.shadowBlur = 14;
        const spr = this.fxSprite('dart', f.color);
        const s = CELL * 0.62;
        if (spr) ctx.drawImage(spr, -s / 2, -s / 2, s, s);
        else { ctx.fillStyle = f.color; ctx.beginPath(); ctx.arc(0, 0, CELL * 0.14, 0, Math.PI * 2); ctx.fill(); }
      } else if (f.kind === 'beam' || f.kind === 'lightning') {
        const alpha = (1 - t) * (f.kind === 'lightning' ? 0.65 + 0.35 * Math.sin(now / 22) : 1);
        ctx.globalAlpha = Math.max(0, alpha);
        const pts = f.kind === 'lightning' ? f.points : [f.from, f.to];
        ctx.shadowColor = f.color;
        ctx.shadowBlur = 12;
        for (const [width, style] of [[CELL * 0.13, f.color], [CELL * 0.045, '#ffffff']]) {
          ctx.strokeStyle = style;
          ctx.lineWidth = width;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.beginPath();
          pts.forEach((p, i) => {
            const [px, py] = center(p);
            i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
          });
          ctx.stroke();
        }
      } else if (f.kind === 'burst') {
        // Wash exactly the squares the spell caught, then bloom the sprite.
        const fade = 1 - t;
        ctx.globalAlpha = 0.3 * fade;
        ctx.fillStyle = f.color;
        for (let y = 0; y < b.grid.length; y++) {
          for (let x = 0; x < b.grid[0].length; x++) {
            if (Math.max(Math.abs(x - f.to.x), Math.abs(y - f.to.y)) <= f.area && b.grid[y][x] !== '#') {
              ctx.fillRect(ox + x * CELL, oy + y * CELL, CELL, CELL);
            }
          }
        }
        const [cx, cy] = center(f.to);
        const r = (f.area + 0.65) * CELL * Math.min(1, t * 1.6);
        ctx.globalAlpha = Math.min(1, fade * 1.4);
        ctx.shadowColor = f.color;
        ctx.shadowBlur = 18;
        const spr = this.fxSprite(f.sprite, f.color);
        if (spr) ctx.drawImage(spr, cx - r, cy - r, r * 2, r * 2);
        else { ctx.fillStyle = f.color; ctx.beginPath(); ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2); ctx.fill(); }
      } else if (f.kind === 'sparkle' || f.kind === 'wisp') {
        const [cx, cy] = center(f.to);
        const spr = this.fxSprite(f.kind, f.color);
        for (const p of f.parts) {
          const pt = Math.min(1, Math.max(0, t - p.phase) / (1 - p.phase));
          if (pt <= 0 || pt >= 1) continue;
          ctx.globalAlpha = (1 - pt) * 0.95;
          const px = cx + p.dx * CELL;
          const py = cy + CELL * 0.2 - p.rise * CELL * pt;
          const s = CELL * 0.34 * p.scale;
          if (spr) ctx.drawImage(spr, px - s / 2, py - s / 2, s, s);
          else { ctx.fillStyle = f.color; ctx.beginPath(); ctx.arc(px, py, s * 0.25, 0, Math.PI * 2); ctx.fill(); }
        }
      }
      ctx.restore();
    }
  }

  drawSprite(src, px, py) {
    const img = this.images[src];
    if (!img) return;
    this.ctx.drawImage(img, px + 2, py + 2, TILE - 4, TILE - 4);
  }

  drawHpBar(m, px, py) {
    const { ctx } = this;
    ctx.fillStyle = '#000';
    ctx.fillRect(px + 4, py - 1, TILE - 8, 4);
    ctx.fillStyle = '#c04848';
    ctx.fillRect(px + 4, py - 1, (TILE - 8) * Math.max(0, m.hp / m.maxHp), 4);
  }

  drawBanner(text, color) {
    const { ctx, canvas } = this;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, canvas.height / 2 - 50, canvas.width, 100);
    ctx.fillStyle = color;
    ctx.font = 'bold 44px Georgia';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  }
}

// Preload every image the game references; missing files just skip (colored fallbacks draw instead).
export function preloadImages(paths) {
  return Promise.all(paths.map(src => new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve([src, img]);
    img.onerror = () => resolve([src, null]);
    img.src = src;
  }))).then(pairs => Object.fromEntries(pairs.filter(([, img]) => img)));
}
