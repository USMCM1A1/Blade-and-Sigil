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
        this.drawTile(game.grid[y][x], sx * TILE, sy * TILE);
        if (!game.isVisible(x, y)) {
          ctx.fillStyle = 'rgba(0,0,0,0.6)'; // remembered but not currently lit
          ctx.fillRect(sx * TILE, sy * TILE, TILE, TILE);
        }
      }
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

  drawTile(c, px, py) {
    const { ctx } = this;
    if (c === '#') {
      ctx.fillStyle = COLORS.wall;
      ctx.fillRect(px, py, TILE, TILE);
      ctx.fillStyle = COLORS.wallTop;
      ctx.fillRect(px, py, TILE, 5);
      ctx.fillStyle = COLORS.wallDark;
      ctx.fillRect(px, py + TILE - 5, TILE, 5);
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
      ctx.save();
      if (dead) ctx.globalAlpha = 0.5;
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

    // Floating combat text: rises and fades over a second, so hits, heals,
    // and misses read right on the battlefield instead of only in the log.
    const now = performance.now();
    b.fx = b.fx.filter(f => now - f.born < 1100);
    for (const f of b.fx) {
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
      ctx.fillText(`${a.ref.name}'s turn — ${b.movesLeft} move${b.movesLeft === 1 ? '' : 's'} left`, W / 2, H - 42);
    } else if (b.mode === 'target') {
      ctx.fillStyle = COLORS.stairs;
      ctx.font = 'bold 15px Georgia';
      const what = b.pending.kind === 'shoot' ? `${a.ref.weapon.name}` : b.pending.spell.name;
      // Odds preview for the monster under the crosshair: to-hit % for
      // shots, save DC (and odds of full damage) for spells.
      let odds = '';
      const tgt = b.cursor && b.cursorValid() && b.monsterAt(b.cursor.x, b.cursor.y);
      if (tgt) {
        const pct = p => `${Math.round(Math.max(5, Math.min(95, p * 100)))}%`;
        if (b.pending.kind === 'shoot') {
          odds = ` · ${pct((21 + b.attackBonus(a.ref) - (10 + tgt.ref.ac)) / 20)} to hit`;
        } else {
          const s = b.pending.spell;
          if (s.auto) odds = ' · never misses';
          else if (s.save) {
            const dc = 10 + s.level + abilityMod(a.ref.abilities[s.stat]);
            const failSave = (dc - (tgt.ref.save || 0) - 1) / 20;
            odds = ` · save DC ${dc} — ${pct(failSave)} for full ${s.type === 'afflict' ? 'effect' : 'damage'}`;
          }
        }
      }
      ctx.fillText(`Aiming ${what} — range ${b.pending.range}${odds}`, W / 2, H - 42);
    }
    ctx.fillStyle = 'rgba(207,196,166,0.7)';
    ctx.font = '13px Georgia';
    const hints = b.mode === 'target'
      ? 'arrows — aim · Enter — unleash! · Esc — cancel'
      : `arrows — move & bump to attack · ${a?.kind === 'hero' && b.castables(a).length ? 'C — cast · ' : ''}${a?.kind === 'hero' && b.canShoot(a) ? 'F — shoot · ' : ''}${a?.kind === 'hero' && this.game.heldItems().length ? 'I — item · ' : ''}Space — end turn · Esc — flee`;
    ctx.fillText(hints, W / 2, H - 20);

    // Spell menu overlay.
    if (b.mode === 'menu' && a?.kind === 'hero') {
      const list = b.castables(a);
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
      ctx.fillText(`${a.ref.name}'s spells — ${a.ref.sp} SP`, mx + mw / 2, my + 12);
      list.forEach((s, i) => {
        const ly = my + 48 + i * 44;
        ctx.textAlign = 'left';
        ctx.fillStyle = s.affordable ? '#cfc4a6' : '#66605a';
        ctx.font = 'bold 14px Georgia';
        ctx.fillText(`${i + 1}.  ${s.name}  —  ${s.cost} SP${s.range ? ` · range ${s.range}` : ''}${s.area ? ` · burst ${s.area}` : ''}`, mx + 20, ly);
        ctx.font = 'italic 11.5px Georgia';
        ctx.fillStyle = s.affordable ? '#8a8a99' : '#55504c';
        ctx.fillText(s.description, mx + 38, ly + 17);
      });
      ctx.textAlign = 'center';
      ctx.fillStyle = '#8a8a99';
      ctx.font = '12px Georgia';
      ctx.fillText('press a number to cast · Esc to close', mx + mw / 2, my + mh - 22);
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

    // Ending beat: let the killing blow's numbers land first, then banner.
    if (b.ending && performance.now() - b.endedAt > 700) {
      this.drawBanner(b.ending === 'victory' ? 'VICTORY!' : 'THE PARTY HAS FALLEN',
        b.ending === 'victory' ? COLORS.stairs : '#b03535');
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
