# Activity HUD: massacre, exploration, exobiology and route panels

Date: 2026-11-15
Status: implemented in ED Chat #36 (release 0.3.0), with ed-mcp 0.7.0 (#88). This spec describes
what was built.

## Purpose

The player runs EDMC plugins (EDMC-Massacres, Canonn) and checks EDSM to track massacre stacks,
what to scan in a system and which bio samples are still needed. Those tools show everything all
the time, in windows outside the game. ED Chat already sits on top of the game. A small panel can
show only what matters for what the player is doing now, and switch itself on and off.

EDMC stays for EDSM and EDDN uploads and for EDR. This work replaces the tracking views only.

## Decisions

- **A separate window.** The panel has its own anchor, offsets, display and move mode, so the
  player can put it in a different corner or on another monitor from the chat.
- **One first release.** Massacre, exploration, exobiology and the route ship together. Other
  modes are follow-on ideas, at the end of this spec.
- **Mode: automatic, Claude, and a hotkey.** Journal events switch the mode. Telling Claude
  ("I'm doing massacres") sets the ed-mcp activity note, which the panel follows. A hotkey cycles
  the mode or turns the panel off. The newest of the three wins.
- **No Claude calls.** The panel is deterministic. It reads the journal, `Status.json`,
  `NavRoute.json` and the ed-mcp sync folder directly, so it costs no tokens and works when Claude
  is busy or offline. The one network call is the optional Spansh lookup below.
- **ed-mcp is the library.** ed-mcp already turns the journal into massacre stacks, exploration
  bodies and exobiology samples for Claude. It exports that code, and ED Chat bundles it. The
  journal tail, the parsers and the plan store exist once, in ed-mcp.

## Part 1: ed-mcp exports a journal library

- A subpath export `ed-mcp/journal`, built by tsup as a second entry (`dist/journal.js`) with
  type declarations. The `ed-mcp` binary does not change, and the plugin runs only
  `dist/index.js`.
- The entry follows the same self-contained rule as the binary: all dependencies are inlined and
  the package has no runtime `dependencies`. It has no shebang banner. `zod` is an optional peer
  dependency, for its types only.
- It exports:
  - `openStores()`, which gives a `JournalService` (the journal tail, with an option to keep extra
    event types), an `ActivityStore` and a `PlanStore` on the same data folder as the server.
  - `massacre()`, `exploration()`, `exobiology()` and `systemAddress()`.
  - `nextStop()` and `visitOrder()` for plans. A plan has no "active" flag: the active plan is the
    activity note's `plan_id`.
  - The value and prediction functions below.
- The export is public API from 0.7.0, so a breaking change needs a major version. ED Chat pins an
  exact ed-mcp version.

### Version skew

Claude runs ed-mcp with `npx -y ed-mcp@latest` (or as a plugin), and the panel runs the version
bundled in ED Chat, so the two can differ. Both read and write the same `activity.json` and plan
files through ed-mcp's stores. If the panel's copy cannot read a file a newer copy wrote, the
store's error is logged and the panel shows what it can without the note or the plan. Dependabot
proposes ed-mcp updates, so the gap stays small.

### Body value estimates

`bodyValue(scan, { mapped, efficient, firstDiscovery, firstMapped })` returns credits, using the
community formula for the current game. `exploration()` gains `value_scanned` and `value_mapped`
per body, with the first-discovery and first-mapped bonuses from the scan's `WasDiscovered` and
`WasMapped`. Tests use known values from game sales.

### Exobiology values, colony distances and species prediction

- A data file has each species' value and each genus's minimum distance between samples (the
  colony range). `exobiology()` gains `value` per species, without the first-footfall bonus, and
  `colony_m`. The values come from the Canonn Research codex reference. The journal data files
  are credited in ed-mcp's `NOTICE` (`src/catalog/data/SOURCES.md` covers the catalog's files).
- `predictSpecies(genus, conditions)` lists the species of a genus likely on a planet, from Canonn
  Research's codex statistics: atmosphere, planet class, volcanism, parent star, temperature,
  gravity, pressure and galactic region (from klightspeed's EliteDangerousRegionMap, MIT).
  `exobiology()` gains `likely` per genus not started. Checked against 649 of the player's own
  analysed samples, the true species was among the candidates for 98.9%.

## Part 2: ED Chat activity panel

### Window

- A second transparent, topmost, click-through `BrowserWindow`. It sizes itself to its content,
  so long system names widen it instead of being cut, up to the display's width.
- Settings in a `hud` section:

  ```json
  "hud": {
    "enabled": true,
    "position": { "anchor": "top-right", "offsetX": 24, "offsetY": 120, "display": "primary" },
    "width": 380,
    "fontSize": 15,
    "backgroundOpacity": 0.55,
    "modes": { "massacre": true, "exploration": true, "exobiology": true, "route": true },
    "valuableMin": 500000,
    "spansh": true,
    "bioMin": 5000000,
    "edMcpDataDir": null
  }
  ```

  - `width` is the minimum width.
  - `modes`: a mode set to `false` is left out of the hotkey cycle, and when the journal or the
    activity note picks it, the panel hides instead of showing it.
  - `valuableMin`: bodies worth less than this when mapped are left off the exploration panel,
    unless they have biological or geological signals.
  - `spansh`: look up the system's planets on Spansh on arrival (only the system address is
    sent).
  - `bioMin`: bio planets likely worth less than this are left off.
  - `edMcpDataDir`: the ed-mcp sync folder. When null, it is read from `ED_MCP_SYNC_DIR` in the
    ed-mcp entry of Claude Code's `~/.claude.json`, else ed-mcp's own config folder.
- Hotkeys, through the same `globalShortcut` registration as the chat's:
  - `hudToggle` (Ctrl+Alt+P): show or hide.
  - `hudMode` (Ctrl+Alt+Shift+P): cycle auto → each enabled mode → off → auto.
  - `hudMove` (Ctrl+Alt+Home): for 15 seconds the chat's move keys (Ctrl+Alt+Arrows) move the
    panel instead of the chat, on the same 3 × 3 anchor grid. The panel shows a dashed border
    while it moves. Moving takes no key of its own beyond `hudMove`.
  - `routeNext` (Ctrl+Alt+PageDown) and `routePrev` (Ctrl+Alt+PageUp): see Route.
  - The default keys all have a modifier. A player can set a key without one in `settings.json`.
    As with the chat's keys, such a key is registered only while the game is in front (`game`
    scope), and never in `always` scope.
- The panel shows only while the game window is in front, as the chat does.

### Live data

`HudFeed` polls once a second:

- The journal, through ed-mcp's `JournalService`, which keeps the extra events the panel reads
  (`ApproachBody`, `Touchdown`, `LeaveBody`, the exploration sales, `NavRoute`, `NavRouteClear`).
  There is no second journal tail in ED Chat.
- `Status.json`, read by the feed itself for `Latitude`, `Longitude`, `PlanetRadius` and
  `BodyName`. The chat's `StatusWatcher`, which watches only the docked and danger flags, does not
  change.
- `NavRoute.json`, unless the journal's newest route event is `NavRouteClear`: the game does not
  rewrite the file when the player clears the route.
- The activity note and the active plan, through ed-mcp's stores.

Since every source is polled, a change to the note, the plan or the plotted route shows within a
second, with no journal event needed.

### Mode

The mode is the newest of three choices, each with a time:

| Source | Sets | Time |
|---|---|---|
| `MissionAccepted` for a massacre mission | massacre | the event's timestamp |
| `FSSDiscoveryScan`, or a `Scan` of type `Detailed` (an FSS or probe scan) | exploration | the event's timestamp |
| `ApproachBody` or `Touchdown` on a body with bio signals, or `ScanOrganic` | exobiology | the event's timestamp |
| `LeaveBody`, when exobiology was the mode | exploration | the event's timestamp |
| The activity note's `kind`, if it is one of the three | that mode | the note's `updated_at` |
| The `hudMode` hotkey | the chosen mode, or off | the moment of the key press |

- Massacre mode ends when ed-mcp's mission list has no massacre mission left. `MissionCompleted`,
  `MissionFailed` and `MissionAbandoned` remove missions, and the `Missions` list at login drops
  any the game no longer has. The panel then goes back to the mode before massacre, or hides.
- While massacre mode is on, scans and samples do not switch the mode.
- A jump never starts a mode, so the panel does not appear on a plain trip. Five jumps with no
  scan end exploration mode.
- The hotkey choice is saved in `state.json` with its time, so after a restart it is still
  ordered correctly against the journal and the note. "Off" from the hotkey holds until the
  hotkey is used again.

### Massacre panel

```
MASSACRE                                 12 left
Kumo Crew Pirates                        12 left
 ███████░░░░░░░░  Lugh Purple Ltd      18/30
 ██████████████░  Eravate Network      26/28
 ████████░░░░░░░  Ross 128 Partners    12/24
 2 ready to hand in · next expires 1d 4h
```

- One block per target faction. Its number is the kills still needed: the largest remaining
  stack among its givers, because a kill counts for one mission from each giver.
- One line per giver faction, with a bar. It turns green when that giver's missions are done.
- The footer shows the missions ready to hand in and the soonest expiry.

### Exploration panel

```
EXPLORE  Pru Aescs NC-M d7-192          9/14 bodies
★ 4  Water world                 40 ls  1.5M  map
1  Earth-like          1,210 ls  ~1.5–4.4M  not scanned
★ A 3  3 bio · Stratum Tectonicas?, …  820 ls  ~111M ×5  1/3
C 2  Icy · 3 geo                   3,100 ls  62k  map
Unsold: 7.9M cartographic · 5 bio (156M)
Session: 14 jumps · 95 scanned · 10 mapped · 24 ★
```

- The header shows the FSS discovery progress.
- **Before a body is scanned, the journal knows nothing about it.** Earth-like, water and ammonia
  worlds, terraformables and bio planets therefore come from Spansh as soon as the player arrives
  (`hud.spansh`), from `https://spansh.co.uk/api/dump/<system address>`, cached for 50 systems.
  They show grey until scanned.
- Before the scan, a value is a range: the low end has no bonus. The high end has the
  first-discovery and first-mapped bonuses, or the 5× first-footfall bonus for biology. A planet
  listed on Spansh can still pay them if nobody has handed in its data. After the scan, the
  journal's `WasDiscovered`, `WasMapped` and `WasFootfalled` decide.
- Bio planets show the likely species of each genus (marked ?) and what they are likely worth.
  They are grey before the scan, plain after it, and green with ✓ once every species is analysed.
- Other bodies show only when worth the time: over `hud.valuableMin` when mapped, or with
  geological signals.
- ★ marks a first discovery and ×5 a first-footfall bonus. A system Spansh does not know gets
  "★ Not on Spansh: may be undiscovered" until the arrival star's scan settles it.
- The footer shows the unsold cartographic and bio value and the session counts.
  - The unsold cartographic value is everything scanned since the data was last sold. A sale also
    clears data more than 20 ly from the station, since that data could have been sold there.
  - The unsold bio value includes the first-footfall bonus.
  - A death clears both.

### Exobiology panel

```
EXOBIOLOGY  A 3          first footfall ×5 · 3 genera
Stratum Tectonicas                         ✓  95.1M
Bacterium Cerbrus                          2/3  8.4M
  ↔ 182 m / 500 m
Fungoida  likely Bullarum / Stabitis          ~18.5M
In system
★ 4  Water world                     40 ls  1.5M  map
```

- Each species on the body with its stage and value, and the genera not started with their likely
  species.
- **Sample positions.** The journal does not record where a sample was taken. The feed reads
  `Status.json` when it sees each new `ScanOrganic` and stores the position, by system address,
  body and species.
  - The game rejects a sample inside the colony range of any earlier sample of that species, not
    only the last one. So the line shows the great-circle distance to the nearest stored sample,
    against the genus's colony range. It turns green when the player is far enough.
  - Samples taken before ED Chat started, or while the game was not writing a position, have no
    stored position. Then the distance line is not shown, rather than a wrong number.
- A species started and then left for another must be started again (the game drops the
  unfinished sample), so it shows `restart`.
- The system's highlights and other bio planets stay listed under "In system".

### Route

The route shows as rows: the current stop (●) with its body or station, its label, and the jumps
left on the plotted route; then the next stop (▸); then "+N more stops".

- Stops come from the active plan (the activity note's `plan_id`) in visit order (`visitOrder`).
  Only stops still to do are shown, since stops can be finished out of order.
- Jumps come from `NavRoute.json`. With a plotted route and no plan, the rows show the
  destination and the jumps left.
- **As a mode:** route mode is on when the plan has a stop to do or a route is plotted, and no
  other mode is on. **As a footer:** under another mode's panel, the route rows show dimmed.
- **Copying systems:**
  - Arriving in the current stop's system copies the next stop's system for the galaxy map, and
    a note in the chat strip says so.
  - `routeNext` marks the current stop done. `routePrev` reopens the stop finished most recently
    in visit order and leaves skipped stops alone. Both change the plan through ed-mcp's
    `PlanStore`, so Claude sees the change, and both copy the new current stop's system.
  - Chips in Claude's replies copy systems too. A chip can carry a body or station target
    (`⟦System › 4 d⟧`), which shows on the chip, and the plan fills in a missing target.

## Code layout

The mode registry first sketched here was not needed. The modes are small, pure functions:

- `src/core/hud/mode.ts`: the mode rules (`journalMode`, `pickMode`, `cycleMode`, `noteMode`).
- `src/core/hud/panels.ts`: one function per panel, from ed-mcp's results to a `PanelView` of
  rows, plus the route rows.
- `src/core/hud/hud.ts`: picks the mode and builds the view. `src/core/hud/feed.ts` reads the
  sources, and `src/core/hud/known.ts` is the Spansh lookup.
- `src/core/hud/edMcpConfig.ts`: finds the ed-mcp sync folder from `ED_MCP_SYNC_DIR` in Claude
  Code's `~/.claude.json`, for `hud.edMcpDataDir` when it is null.
- `src/renderer/hud.tsx`: one component renders any `PanelView`.

A new mode is a rule in `mode.ts`, a panel function and its tests.

## Follow-on design ideas

These modes are not part of this release. Each one gets its own short spec and its own PR later.

| Mode | Turns on | Shows | Live progress from |
|---|---|---|---|
| Codex: geology and Horizons bio | Geological or Horizons biological signals on a body | The kinds on each body, and a count logged in the codex, such as (0/3) | `FSSBodySignals`, `SAASignalsFound`, `CodexEntry` |
| Ground mission | `MissionAccepted` for an on-foot mission; `ApproachSettlement` or `Disembark` at its settlement | Objective, settlement, body, item or target, count, expiry | `Backpack.json` for collect and salvage; `Bounty` and `ShipTargeted` for kill targets; otherwise only `MissionCompleted` |
| Cargo and wing missions | `MissionAccepted` for a delivery or source mission; `CargoDepot` | Item, collected / delivered / total, destination, expiry | `CargoDepot` |
| Colonisation | `ColonisationConstructionDepot` when docked at a construction site | Each resource still needed against what is in the hold | `ColonisationConstructionDepot`, `Cargo.json` |
| Mining | `ProspectedAsteroid`, `LaunchDrone` (prospector) | The last asteroid's contents against a set threshold, motherlode, tons refined per hour, cargo space left, limpets | `ProspectedAsteroid`, `MiningRefined`, `Cargo.json` |
| Combat | `FactionKillBond` or `Bounty` when no massacre mission is active | Bonds and bounties earned per faction this session, unclaimed value | `FactionKillBond`, `Bounty`, `RedeemVoucher` |
| Materials | A plan with material needs, and `MaterialCollected` | "Need 4 more Polonium" for the active plan | `MaterialCollected`, `Materials` |

For ground missions, the game does not write the objective progress of most mission types to
the journal. The panel would show an objective card with the progress it can see, not a full
quest tracker.

Powerplay, fleet carrier fuel and Thargoid combat are left out: they are niche, or the game's own
UI shows them well.

## Testing

- ed-mcp: `bodyValue` against known sale values, species values, the species predictor (each
  species has conditions, region limits, and the fallback when regions leave nothing), and a test
  that the `ed-mcp/journal` entry exports the journal, value, plan and activity code.
- ED Chat:
  - The mode rules, as event sequences and the expected mode.
  - Each panel: massacre, exploration with Spansh highlights, value ranges and bio rows, and
    exobiology, including the distance row, samples from another system, the first-footfall
    values and the restart row.
  - The cartographic sale rule.
  - Sample positions recorded by the feed.
  - The route rows, `previousStop` and `nextStopAfter` on a plan visited out of listing order,
    and a cleared route.
  - The Spansh parse, cache and retry.
- `scripts/hud-probe.ts` prints the panel for the current journal, and
  `scripts/hud-screenshots.cjs` renders the README's mock-ups.
- Tested live in the game: exobiology, exploration with Spansh highlights, route rows and chip
  targets.

## Known limits

- A massacre mission that expires while the game is closed stays in the stack until the next
  login's `Missions` list removes it.
- Sample positions are kept in memory, so a restart of ED Chat in the middle of a species loses
  the distance line until the next sample.
