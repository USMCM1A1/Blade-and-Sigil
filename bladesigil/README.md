# Blade & Sigil

An old-school party-based dungeon crawler. Phase 1: walking skeleton.

## How to play

**Double-click `Play.command`.** The game opens in your browser. Keep the terminal
window it spawns open while you play.

The title screen offers **Create New Party** (roll your own four heroes: 3d6
with 1s re-rolled, arrange the scores as you like, pick race/class/row),
**Play Your Party** (your last created party, saved in the browser), and
**Continue the Descent** when a run is saved. The game is also hosted at
https://usmcm1a1.github.io/Blade-and-Sigil/ — see the README at the repo root.

- **Arrow keys / WASD** — move the party. Walk into things to interact:
  - Walk into a **monster** to start a battle (see below)
  - Walk into a **door** to open it
  - Walk into a **chest** to loot it
  - Walk onto the **stairs (▼)** to win the level
- **Space** — wait a turn
- **T** — make camp: restores everyone's HP and spell points. Only allowed
  with no enemies in sight, and the fallen stay fallen. (Camp advances the
  dungeon clock — once conditions arrive, poison will tick while you sleep.)
- **` (backtick)** — the **training arena**: every monster type as a tough
  5×-HP dummy, spells cost nothing, and nothing carries back — your party is
  snapshotted on entry and restored on exit (Esc to leave, no XP awarded).
  The floor is yours to edit in `data/tactics/arena.json`.
- **H or ?** — help & controls overlay
- **M** — mute · **R** — restart

### Battle screen

Walking into a monster — or getting caught by one — moves the fight to a
tactical battlefield built from a template in `data/tactics/`. Every visible
monster nearby joins. **Initiative** (d20 + DEX modifier; monsters roll a
flat d20) sets the turn order shown at the top of the screen.

On a hero's turn:

- **Arrow keys / WASD** — move, up to 4 squares (lit squares show your reach)
- **Walk into a monster** — attack it (this ends the hero's turn)
- **C** — open the spell menu (casters); pick a spell by number, then aim
  with the arrows and press Enter. Blue squares are in range; a red
  crosshair means out of range or no line of sight (walls block spells and
  arrows!). Fireballs burn friend and foe alike — aim carefully.
- **F** — draw a ranged weapon (the archer's longbow, range 6) and aim the
  same way. Ranged attacks aim with DEX, melee swings with STR.
- **Space / Enter** — end the turn without attacking
- **Esc** — the whole party flees (you get one free step before the hunt resumes)

Monsters walk toward the nearest hero and attack whoever is adjacent — keep
your wizard behind the fighters! Slow monsters (`"speed": 2`) only act on
even-numbered rounds.

### Tactical templates (`data/tactics/`)

Each battle picks a random template from the level's `"tactics"` list
(see `data/levels/level1.json`). A template is a 13×8 ASCII grid:
`#` obstacle · `.` open floor · `f` front-row hero spawn · `b` back-row spawn ·
`m` monster spawn. Add your own file (say `data/tactics/crypt.json`), list it
in the level's `"tactics"`, and it's in the rotation.

## You are the designer — edit these files

Everything in `data/` is yours. Edit a file, save, refresh the browser (Cmd+R).
If you make a typo, the game shows you which file and line to fix.

| File | What it controls |
|---|---|
| `data/party.json` | The party: names, races, classes, ability scores, marching rows |
| `data/monsters.json` | Monster stats: HP, armor, damage dice, speed, XP |
| `data/classes.json` | The 7 classes: level tables, hit dice, weapons |
| `data/races.json` | The 5 races and their bonuses |
| `data/spells.json` | Battlefield spells: dice, range, burst size, cost, who casts them |
| `data/conditions.json` | Afflictions: burning, poison, paralysis — ticks, durations, colors |
| `data/tactics/*.json` | Tactical battle maps — 13×8 ASCII grids |
| `data/levels/level1.json` | The dungeon map — drawn in ASCII, edit freely! |

### Map symbols (`data/levels/level1.json`)

`#` wall · `.` floor · `+` closed door · `$` treasure chest · `>` stairs down ·
`@` party start · letters = monsters (defined in the `legend` section)

Every map row must be the same length.

### Combat rules (from the design doc)

- Attack: d20 + hit bonus + STR modifier vs. 10 + defender's AC (ranged: DEX)
- Damage: weapon dice + hit bonus + STR modifier
- **Damage spells never miss** — each target rolls a saving throw instead:
  d20 + save bonus vs. DC 10 + spell level + caster's stat modifier.
  Success = half damage. The spell's `"save"` says what resists it
  (`dex` dodges a fireball, `wis` resists divine power); monsters use their
  `"save"` bonus from `monsters.json`, heroes their ability modifier —
  and dwarves add their racial `save_bonus` to every save.
- Magic Missile (`"auto": true`) allows no save at all
- **Conditions** (`data/conditions.json`): a failed save against a fireball
  leaves you *burning*; the giant rat's bite can *poison* (CON save, DC 12).
  In battle a condition ticks at the start of the afflicted creature's own
  turn — colored pips mark the afflicted on the battlefield and the sidebar.
  Battle-only conditions (burning, paralysis) end with the fight; poison
  follows you onto the map, ticking every 10 map turns — and camp is 50
  turns, so cure poison *before* you sleep, or wake up the worse for it.
- Slow monsters (`"speed": 2`) move every other turn and strike every other battle round

## Roadmap

- **Phase 1** ✓ — walking skeleton: map, movement, party, battle screen, loot
- **Phase 2** ✓ — character creation (roll 3d6, pick race/class/row)
- **Phase 3a** ✓ — battlefield tactics: grid movement, initiative, tactical templates
- **Phase 3b** ✓ — spells and ranged attacks on the battlefield
- **Phase 3c** — inventory, equipment, potions
- **Phase 4** — the town of Novamagus: shops, temple, tavern, training
- **Phase 5** — procedural dungeons, secret doors, traps, automap
- **Phase 6** — save/load, music, balance, polish
