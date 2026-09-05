// Boot: load data files, build the game, wire input, run the render loop.

import { loadJSON, showFatal } from './loader.js';
import { Game, validateItems, validateMonsters, validateSummons } from './game.js';
import { Renderer, preloadImages } from './render.js';
import { buildPartyPanel, updateUI, toggleEquipment, equipmentOpen, openBuilding, buildingOpen, closeBuilding, maybeOpenChoice, choiceOpen, choicePick, togglePlaytest, playtestOpen, levelupOpen, dismissLevelup, toggleSpellbook, spellbookOpen, flipToSheet, flipToBook, toggleMarching, marchingOpen, campOpen, openCamp, closeCamp } from './ui.js';
import { validateProgression } from './progression.js';
import { validateDungeon } from './dungeon.js';
import { validateMagic, deriveScrollItems } from './magic.js';
import { choosePartyDef } from './creation.js';
import { loadRun } from './save.js';
import * as audio from './audio.js';
import { registerPanel, togglePanel, closePanel, isOpen } from './panel.js';

async function boot() {
  const [classes, races, monsters, party, level, spells, conditions, items, town, dungeon, progression, sounds, summons] = await Promise.all([
    loadJSON('data/classes.json'),
    loadJSON('data/races.json'),
    loadJSON('data/monsters.json'),
    loadJSON('data/party.json'),
    loadJSON('data/levels/level1.json'),
    loadJSON('data/spells.json'),
    loadJSON('data/conditions.json'),
    loadJSON('data/items.json'),
    loadJSON('data/town.json'),
    loadJSON('data/dungeon.json'),
    loadJSON('data/progression.json'),
    loadJSON('data/sounds.json'),
    loadJSON('data/summons.json'),
  ]);
  audio.init(sounds.sounds); // the moment → file table is the designer's

  // Tactical battle templates: the level says which ones its battles use.
  const tacticsNames = level.tactics ?? ['room'];
  const tactics = {};
  for (const n of tacticsNames) tactics[n] = await loadJSON(`data/tactics/${n}.json`);

  const data = { classes, races, monsters, party, level, tactics, spells, conditions, items, town, dungeon, progression, summons };
  deriveScrollItems(data);   // magic v3: spells flagged "scroll" become scroll_<id> items
  validateProgression(data); // friendly errors for progression.json typos
  validateMagic(data);       // …and for spells.json / scroll items
  validateItems(data);       // …and for items.json (tiers, immunities, potion effects)
  validateMonsters(data);    // …and for monsters.json (families, abilities, danger fields)
  validateSummons(data);     // …and for summons.json + the Summoner's calling ladders
  validateDungeon(data);     // …and for every dungeon tier's roster/loot/traps
  const { def: partyDef, run } = await choosePartyDef(data);
  const game = new Game({ ...data, party: { ...party, party: partyDef } });
  game.partyDef = partyDef; // the marching-order panel (O) edits and re-saves this

  // Collect every sprite the data mentions and preload it.
  const sprites = new Set(['assets/misc/loot_drop.jpg', 'assets/misc/door_1.png', 'assets/heroes/party-icon.png']);
  for (const t of ['cobblestones.png', 'vegetation.png', 'inn.png', 'shop.png', 'dungeon_entrance.png']) {
    sprites.add(`assets/town/${t}`);
  }
  for (const c of Object.values(classes.classes)) { sprites.add(c.sprite); sprites.add(c.sprite_dead); if (c.portrait) sprites.add(c.portrait); }
  for (const m of Object.values(monsters.monsters)) { sprites.add(m.sprite); if (m.sprite_dead) sprites.add(m.sprite_dead); }
  for (const m of Object.values(summons.summons)) { if (m.sprite) sprites.add(m.sprite); if (m.sprite_dead) sprites.add(m.sprite_dead); }
  const images = await preloadImages([...sprites]);

  const canvas = document.getElementById('viewport');
  const renderer = new Renderer(canvas, game, images);
  window.game = game; // console access for debugging/playtesting
  game.onBuilding = kind => openBuilding(game, kind);
  game.onCamp = (caption, then) => openCamp(game, caption, then);
  // Continue (Phase 6): overlay the saved run onto the freshly built party.
  // A save that names retired things steps aside with a message, not a crash.
  if (run) {
    try { loadRun(game, run); }
    catch (e) { game.log(`The old save could not be read (${e.message}) — the run starts fresh.`, 'info'); }
  }
  buildPartyPanel(game);

  // Fill the window: the canvas takes all the room the sidebar, log, and
  // bars leave, and the renderer's camera sees as many tiles as fit.
  const TILE = 56;
  const fitCanvas = () => {
    // Battle claims the whole stage (designer's call 2026-08-26): the sidebar
    // hides, the log shrinks, and the canvas keeps every pixel — no tile
    // snapping, since the battle grid scales its own cells.
    const inBattle = document.body.classList.contains('in-battle');
    const layout = document.getElementById('layout');
    const w = Math.max(840, layout.clientWidth - (inBattle ? 0 : 330)); // sidebar + gap
    const otherH = document.getElementById('titlebar').offsetHeight
      + document.getElementById('log').offsetHeight
      + document.getElementById('controls').offsetHeight + 44; // paddings/margins
    const h = Math.max(600, window.innerHeight - otherH);
    canvas.width = inBattle ? w : Math.floor(w / TILE) * TILE;
    canvas.height = inBattle ? h : Math.floor(h / TILE) * TILE;
    renderer.cols = Math.floor(canvas.width / TILE);
    renderer.rows = Math.floor(canvas.height / TILE);
  };
  window.addEventListener('resize', fitCanvas);
  // A refresh mid-step keeps the last moment: flush the debounced autosave.
  window.addEventListener('beforeunload', () => game.autosave(true));
  fitCanvas();

  const MOVES = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
    W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0],
  };

  // Help (H) and the guide (G) are panels too — mutually exclusive.
  registerPanel('help', { onOpen: () => closePanel('guide') });
  registerPanel('guide', { onOpen: () => closePanel('help') });
  const toggleHelp = show => togglePanel('help', show);
  const toggleGuide = show => togglePanel('guide', show);
  if (!localStorage.getItem('bs_seen_help')) {
    toggleHelp(true); // first visit: open with the controls on screen
    localStorage.setItem('bs_seen_help', '1');
  }

  // ---- The keymap (refactor step 6a, 2026-09-04) ----
  // Each context is a table: the battle's modes, the map's modal panels
  // (in priority order — the first open one takes the key), and the map
  // itself. A handler returns nothing; keys nobody claims fall through.
  const digit = e => (/^[1-9]$/.test(e.key) ? Number(e.key) : 0);
  const is = (e, chars) => chars.includes(e.key);
  const isEsc = e => e.key === 'Escape';
  const isGo = e => e.key === ' ' || e.key === 'Enter';
  const stop = e => e.preventDefault();
  const mute = () => { const muted = audio.toggleMute(); game.log(muted ? 'Sound muted.' : 'Sound on.', 'info'); };
  const reload = () => location.reload();
  const playing = () => !game.over && !game.victory;

  // Battle: one table per mode. Arrows move the active hero (walk into a
  // monster to attack), C casts, F shoots, Space/Enter ends the turn, Esc flees.
  const BATTLE_MODES = {
    menu: (e, b) => {
      if (digit(e)) b.chooseSpell(digit(e));
      else if (MOVES[e.key] && MOVES[e.key][1]) { stop(e); b.menuMove(MOVES[e.key][1]); }
      else if (isGo(e)) { stop(e); b.chooseSpell((b.menuSel ?? 0) + 1); }
      else if (isEsc(e) || is(e, 'cC')) b.mode = 'move';
    },
    items: (e, b) => {
      if (digit(e)) b.chooseItem(digit(e));
      else if (isEsc(e) || is(e, 'iI')) b.mode = 'move';
    },
    swap: (e, b) => {
      if (digit(e)) b.chooseSwap(digit(e));
      else if (isEsc(e) || is(e, 'wW')) b.mode = 'move';
    },
    target: (e, b) => {
      if (MOVES[e.key]) { stop(e); b.moveCursor(...MOVES[e.key]); }
      else if (isGo(e)) { stop(e); b.confirm(); }
      else if (isEsc(e)) b.cancelTargeting();
    },
    move: (e, b) => {
      if (MOVES[e.key]) { stop(e); b.heroMove(...MOVES[e.key]); }
      else if (isGo(e)) { stop(e); b.endHeroTurn(); }
      else if (is(e, 'cC')) b.openMenu();
      else if (is(e, 'fF')) b.beginShoot();
      else if (is(e, 'iI')) b.openItems();
      else if (is(e, 'wW')) b.openSwap();
      else if (isEsc(e)) b.flee();
      else if (is(e, 'mM')) mute();
      else if (is(e, 'rR')) reload();
    },
  };

  // Map-side modals, highest priority first: the first one open owns the key.
  const MODALS = [
    // A fork in the road: number keys (or clicks) decide. No backing out.
    [campOpen, e => { stop(e); closeCamp(); }], // the campfire picture: any key hurries the night along
    [choiceOpen, e => { if (digit(e)) choicePick(digit(e)); }],
    [buildingOpen, e => { if (isEsc(e)) closeBuilding(); }],
    // The level-up summary (or a milestone card) sits on top of the
    // character sheet — dismissing it advances the level-up chain.
    [levelupOpen, e => { if (isGo(e) || isEsc(e)) { stop(e); dismissLevelup(game); } }],
    // The character sheet is modal on the map: I, E, C, or Esc puts it away;
    // B flips straight to the Spellbook screen.
    [equipmentOpen, e => { if (is(e, 'iIeEcC') || isEsc(e)) toggleEquipment(game, false); else if (is(e, 'bB')) flipToBook(game); }],
    // The Spellbook screen: B or Esc closes; C flips to the character sheet.
    [spellbookOpen, e => { if (is(e, 'bB') || isEsc(e)) toggleSpellbook(game, false); else if (is(e, 'iIeEcC')) flipToSheet(game); }],
    [playtestOpen, e => { if (is(e, 'pP') || isEsc(e)) togglePlaytest(game, false); }],
    [marchingOpen, e => { if (is(e, 'oO') || isEsc(e)) toggleMarching(game, false); }],
  ];

  // The map itself.
  const MAP_KEYS = {
    ' ': e => { stop(e); game.wait(); },
    t: () => game.rest(), T: () => game.rest(),
    i: () => playing() && toggleEquipment(game), I: () => playing() && toggleEquipment(game),
    e: () => playing() && toggleEquipment(game), E: () => playing() && toggleEquipment(game),
    c: () => playing() && toggleEquipment(game), C: () => playing() && toggleEquipment(game),
    b: () => playing() && toggleSpellbook(game), B: () => playing() && toggleSpellbook(game),
    o: () => playing() && toggleMarching(game), O: () => playing() && toggleMarching(game),
    p: () => playing() && togglePlaytest(game), P: () => playing() && togglePlaytest(game),
    m: mute, M: mute,
    r: reload, R: reload,
  };

  document.addEventListener('keydown', e => {
    // Typing is typing: while a text field has focus (the Rite's naming and
    // title steps, any future input), NO game shortcut fires — an "h" in
    // "the" must never summon the help screen. The fields' own Enter
    // handlers still work; they listen on the input itself.
    if (e.target.matches?.('input, textarea, select')) return;
    if (is(e, 'hH?')) { stop(e); toggleHelp(); return; }
    if (is(e, 'gG')) { stop(e); toggleGuide(); return; }
    if ((isOpen('help') || isOpen('guide')) && (isEsc(e) || MOVES[e.key])) {
      toggleHelp(false); // any move or Esc dismisses them, then the move happens
      toggleGuide(false);
    }
    if (game.battle) {
      const b = game.battle;
      // Guardian's Stand: the world waits on a single question.
      if (b.pendingReaction) {
        if (is(e, 'yY')) b.resolveReaction(true);
        else if (is(e, 'nN') || isEsc(e)) b.resolveReaction(false);
        return;
      }
      if (b.busy) return; // a monster is taking its turn — watch it play out
      (BATTLE_MODES[b.mode] ?? BATTLE_MODES.move)(e, b);
      return;
    }
    for (const [open, handle] of MODALS) {
      if (open()) { handle(e); return; }
    }
    if (MOVES[e.key]) { stop(e); game.tryMove(...MOVES[e.key]); return; }
    MAP_KEYS[e.key]?.(e);
  });

  let wasBattle = false;
  function frame() {
    // Entering/leaving battle re-stages the whole screen (sidebar, log, canvas).
    const inBattle = !!game.battle;
    if (inBattle !== wasBattle) {
      wasBattle = inBattle;
      document.body.classList.toggle('in-battle', inBattle);
      fitCanvas();
    }
    renderer.draw();
    updateUI(game);
    maybeOpenChoice(game); // owed lane forks pop up once the party is on the map
    requestAnimationFrame(frame);
  }
  frame();
}

boot().catch(showFatal);
