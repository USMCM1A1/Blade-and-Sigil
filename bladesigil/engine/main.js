// Boot: load data files, build the game, wire input, run the render loop.

import { loadJSON, showFatal } from './loader.js';
import { Game, validateItems } from './game.js';
import { Renderer, preloadImages } from './render.js';
import { buildPartyPanel, updateUI, toggleEquipment, equipmentOpen, openBuilding, buildingOpen, closeBuilding, maybeOpenChoice, choiceOpen, choicePick, togglePlaytest, playtestOpen, levelupOpen, dismissLevelup, toggleSpellbook, spellbookOpen, flipToSheet, flipToBook, toggleMarching, marchingOpen } from './ui.js';
import { validateProgression } from './progression.js';
import { validateDungeon } from './dungeon.js';
import { validateMagic, deriveScrollItems } from './magic.js';
import { choosePartyDef } from './creation.js';
import { loadRun } from './save.js';
import * as audio from './audio.js';

async function boot() {
  const [classes, races, monsters, party, level, spells, conditions, items, town, dungeon, progression, sounds] = await Promise.all([
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
  ]);
  audio.init(sounds.sounds); // the moment → file table is the designer's

  // Tactical battle templates: the level says which ones its battles use.
  const tacticsNames = level.tactics ?? ['room'];
  const tactics = {};
  for (const n of tacticsNames) tactics[n] = await loadJSON(`data/tactics/${n}.json`);
  const arenaTemplate = await loadJSON('data/tactics/arena.json');

  const data = { classes, races, monsters, party, level, tactics, spells, conditions, items, town, dungeon, progression, arenaTemplate };
  deriveScrollItems(data);   // magic v3: spells flagged "scroll" become scroll_<id> items
  validateProgression(data); // friendly errors for progression.json typos
  validateMagic(data);       // …and for spells.json / scroll items
  validateItems(data);       // …and for items.json (tiers, immunities, potion effects)
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
  const images = await preloadImages([...sprites]);

  const canvas = document.getElementById('viewport');
  const renderer = new Renderer(canvas, game, images);
  window.game = game; // console access for debugging/playtesting
  game.onBuilding = kind => openBuilding(game, kind);
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

  const help = document.getElementById('help');
  const guide = document.getElementById('guide');
  const toggleHelp = show => {
    help.style.display = (show ?? help.style.display !== 'block') ? 'block' : 'none';
    if (help.style.display === 'block') guide.style.display = 'none';
  };
  const toggleGuide = show => {
    guide.style.display = (show ?? guide.style.display !== 'block') ? 'block' : 'none';
    if (guide.style.display === 'block') help.style.display = 'none';
  };
  if (!localStorage.getItem('bs_seen_help')) {
    toggleHelp(true); // first visit: open with the controls on screen
    localStorage.setItem('bs_seen_help', '1');
  }

  document.addEventListener('keydown', e => {
    // Typing is typing: while a text field has focus (the Rite's naming and
    // title steps, any future input), NO game shortcut fires — an "h" in
    // "the" must never summon the help screen. The fields' own Enter
    // handlers still work; they listen on the input itself.
    if (e.target.matches?.('input, textarea, select')) return;
    if (e.key === 'h' || e.key === 'H' || e.key === '?') {
      e.preventDefault();
      toggleHelp();
      return;
    }
    if (e.key === 'g' || e.key === 'G') {
      e.preventDefault();
      toggleGuide();
      return;
    }
    if ((help.style.display === 'block' || guide.style.display === 'block')
        && (e.key === 'Escape' || MOVES[e.key])) {
      toggleHelp(false); // any move or Esc dismisses them, then the move happens
      toggleGuide(false);
    }
    if (game.battle) {
      const b = game.battle;
      // Guardian's Stand: the world waits on a single question.
      if (b.pendingReaction) {
        if (e.key === 'y' || e.key === 'Y') b.resolveReaction(true);
        else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') b.resolveReaction(false);
        return;
      }
      if (b.busy) return; // a monster is taking its turn — watch it play out
      // Battle mode: arrows move the active hero (walk into a monster to
      // attack), C casts, F shoots, Space/Enter ends the turn, Esc flees.
      if (b.mode === 'menu') {
        if (/^[1-9]$/.test(e.key)) b.chooseSpell(Number(e.key));
        else if (MOVES[e.key] && MOVES[e.key][1]) { e.preventDefault(); b.menuMove(MOVES[e.key][1]); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.chooseSpell((b.menuSel ?? 0) + 1); }
        else if (e.key === 'Escape' || e.key === 'c' || e.key === 'C') b.mode = 'move';
        return;
      }
      if (b.mode === 'items') {
        if (/^[1-9]$/.test(e.key)) b.chooseItem(Number(e.key));
        else if (e.key === 'Escape' || e.key === 'i' || e.key === 'I') b.mode = 'move';
        return;
      }
      if (b.mode === 'swap') {
        if (/^[1-9]$/.test(e.key)) b.chooseSwap(Number(e.key));
        else if (e.key === 'Escape' || e.key === 'w' || e.key === 'W') b.mode = 'move';
        return;
      }
      if (b.mode === 'target') {
        if (MOVES[e.key]) { e.preventDefault(); b.moveCursor(...MOVES[e.key]); }
        else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); b.confirm(); }
        else if (e.key === 'Escape') b.cancelTargeting();
        return;
      }
      if (MOVES[e.key]) {
        e.preventDefault();
        b.heroMove(...MOVES[e.key]);
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        b.endHeroTurn();
      } else if (e.key === 'c' || e.key === 'C') {
        b.openMenu();
      } else if (e.key === 'f' || e.key === 'F') {
        b.beginShoot();
      } else if (e.key === 'i' || e.key === 'I') {
        b.openItems();
      } else if (e.key === 'w' || e.key === 'W') {
        b.openSwap();
      } else if (e.key === 'Escape') {
        b.flee();
      } else if (e.key === 'm' || e.key === 'M') {
        const muted = audio.toggleMute();
        game.log(muted ? 'Sound muted.' : 'Sound on.', 'info');
      } else if (e.key === 'r' || e.key === 'R') {
        location.reload();
      }
      return;
    }
    if (choiceOpen()) {
      // A fork in the road: number keys (or clicks) decide. No backing out.
      if (/^[1-9]$/.test(e.key)) choicePick(Number(e.key));
      return;
    }
    if (buildingOpen()) {
      if (e.key === 'Escape') closeBuilding();
      return;
    }
    if (levelupOpen()) {
      // The level-up summary (or a milestone card) sits on top of the
      // character sheet — dismissing it advances the level-up chain.
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
        e.preventDefault();
        dismissLevelup(game);
      }
      return;
    }
    if (equipmentOpen()) {
      // The character sheet is modal on the map: I, E, C, or Esc puts it away;
      // B flips straight to the Spellbook screen.
      if ('iIeEcC'.includes(e.key) || e.key === 'Escape') toggleEquipment(game, false);
      else if (e.key === 'b' || e.key === 'B') flipToBook(game);
      return;
    }
    if (spellbookOpen()) {
      // The Spellbook screen: B or Esc closes; C flips to the character sheet.
      if (e.key === 'b' || e.key === 'B' || e.key === 'Escape') toggleSpellbook(game, false);
      else if ('iIeEcC'.includes(e.key)) flipToSheet(game);
      return;
    }
    if (playtestOpen()) {
      if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') togglePlaytest(game, false);
      return;
    }
    if (marchingOpen()) {
      if (e.key === 'o' || e.key === 'O' || e.key === 'Escape') toggleMarching(game, false);
      return;
    }
    if (MOVES[e.key]) {
      e.preventDefault();
      game.tryMove(...MOVES[e.key]);
    } else if (e.key === ' ') {
      e.preventDefault();
      game.wait();
    } else if (e.key === 't' || e.key === 'T') {
      game.rest();
    } else if ('iIeEcC'.includes(e.key)) {
      if (!game.over && !game.victory) toggleEquipment(game);
    } else if (e.key === 'b' || e.key === 'B') {
      if (!game.over && !game.victory) toggleSpellbook(game);
    } else if (e.key === '`' || e.key === '~') {
      game.startArena();
    } else if (e.key === 'o' || e.key === 'O') {
      if (!game.over && !game.victory) toggleMarching(game);
    } else if (e.key === 'p' || e.key === 'P') {
      if (!game.over && !game.victory) togglePlaytest(game);
    } else if (e.key === 'm' || e.key === 'M') {
      const muted = audio.toggleMute();
      game.log(muted ? 'Sound muted.' : 'Sound on.', 'info');
    } else if (e.key === 'r' || e.key === 'R') {
      location.reload();
    }
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
