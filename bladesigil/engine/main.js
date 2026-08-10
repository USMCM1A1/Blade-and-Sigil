// Boot: load data files, build the game, wire input, run the render loop.

import { loadJSON, showFatal } from './loader.js';
import { Game } from './game.js';
import { Renderer, preloadImages } from './render.js';
import { buildPartyPanel, updateUI, toggleEquipment, equipmentOpen, openBuilding, buildingOpen, closeBuilding } from './ui.js';
import { choosePartyDef } from './creation.js';
import * as audio from './audio.js';

async function boot() {
  const [classes, races, monsters, party, level, spells, conditions, items, town] = await Promise.all([
    loadJSON('data/classes.json'),
    loadJSON('data/races.json'),
    loadJSON('data/monsters.json'),
    loadJSON('data/party.json'),
    loadJSON('data/levels/level1.json'),
    loadJSON('data/spells.json'),
    loadJSON('data/conditions.json'),
    loadJSON('data/items.json'),
    loadJSON('data/town.json'),
  ]);

  // Tactical battle templates: the level says which ones its battles use.
  const tacticsNames = level.tactics ?? ['room'];
  const tactics = {};
  for (const n of tacticsNames) tactics[n] = await loadJSON(`data/tactics/${n}.json`);
  const arenaTemplate = await loadJSON('data/tactics/arena.json');

  const data = { classes, races, monsters, party, level, tactics, spells, conditions, items, town, arenaTemplate };
  const partyDef = await choosePartyDef(data);
  const game = new Game({ ...data, party: { ...party, party: partyDef } });

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
  buildPartyPanel(game);

  // Fill the window: the canvas takes all the room the sidebar, log, and
  // bars leave, and the renderer's camera sees as many tiles as fit.
  const TILE = 56;
  const fitCanvas = () => {
    const layout = document.getElementById('layout');
    const w = Math.max(840, layout.clientWidth - 330); // sidebar + gap
    const otherH = document.getElementById('titlebar').offsetHeight
      + document.getElementById('log').offsetHeight
      + document.getElementById('controls').offsetHeight + 44; // paddings/margins
    const h = Math.max(600, window.innerHeight - otherH);
    canvas.width = Math.floor(w / TILE) * TILE;
    canvas.height = Math.floor(h / TILE) * TILE;
    renderer.cols = Math.floor(canvas.width / TILE);
    renderer.rows = Math.floor(canvas.height / TILE);
  };
  window.addEventListener('resize', fitCanvas);
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
      if (b.busy) return; // a monster is taking its turn — watch it play out
      // Battle mode: arrows move the active hero (walk into a monster to
      // attack), C casts, F shoots, Space/Enter ends the turn, Esc flees.
      if (b.mode === 'menu') {
        if (/^[1-9]$/.test(e.key)) b.chooseSpell(Number(e.key));
        else if (e.key === 'Escape' || e.key === 'c' || e.key === 'C') b.mode = 'move';
        return;
      }
      if (b.mode === 'items') {
        if (/^[1-9]$/.test(e.key)) b.chooseItem(Number(e.key));
        else if (e.key === 'Escape' || e.key === 'i' || e.key === 'I') b.mode = 'move';
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
    if (buildingOpen()) {
      if (e.key === 'Escape') closeBuilding();
      return;
    }
    if (equipmentOpen()) {
      // The inventory screen is modal on the map: I, E, or Esc puts it away.
      if ('iIeE'.includes(e.key) || e.key === 'Escape') toggleEquipment(game, false);
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
    } else if ('iIeE'.includes(e.key)) {
      if (!game.over && !game.victory) toggleEquipment(game);
    } else if (e.key === '`' || e.key === '~') {
      game.startArena();
    } else if (e.key === 'm' || e.key === 'M') {
      const muted = audio.toggleMute();
      game.log(muted ? 'Sound muted.' : 'Sound on.', 'info');
    } else if (e.key === 'r' || e.key === 'R') {
      location.reload();
    }
  });

  function frame() {
    renderer.draw();
    updateUI(game);
    requestAnimationFrame(frame);
  }
  frame();
}

boot().catch(showFatal);
