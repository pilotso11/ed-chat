# Activity HUD: massacre, exploration and exobiology panels

Date: 2026-11-15
Status: draft, for review

## Purpose

The player runs EDMC plugins (EDMC-Massacres, Canonn) and checks EDSM to track massacre stacks,
what to scan in a system and which bio samples are still needed. Those tools show everything all
the time, in windows outside the game. ED Chat already sits on top of the game. A small panel can
show only what matters for what the player is doing now, and switch itself on and off.

EDMC stays for EDSM and EDDN uploads and for EDR. This work replaces the tracking views only.

## Decisions

- **A separate window.** The panel has its own anchor, offsets, display and move hotkeys, so the
  player can put it in a different corner or on another monitor from the chat.
- **One first release.** Massacre, exploration (with exobiology) and the route breadcrumbs ship
  together. Other modes are follow-on ideas, at the end of this spec.
- **Mode: automatic, Claude, and a hotkey.** Journal events switch the mode. Telling Claude
  ("I'm doing massacres") sets the ed-mcp activity note, which the panel follows. A hotkey cycles
  the mode or turns the panel off. The newest of the three wins.
- **No Claude calls.** The panel is deterministic. It reads the journal and `Status.json`
  directly, so it costs no tokens and works when Claude is busy or offline.
- **ed-mcp is the library.** ed-mcp already turns the journal into massacre stacks, exploration
  bodies and exobiology samples for Claude. It exports that code, and ED Chat imports it. Claude
  and the panel then always agree, and a fix in one place fixes both.

## Part 1: ed-mcp exports a journal library

- A new subpath export `ed-mcp/journal` in `package.json` `exports`, built by tsup as a separate
  entry with type declarations. The `ed-mcp` binary does not change.
- It exports:
  - `JournalReader`, `listJournals` and `JournalEvent`.
  - `buildState` and `STATE_EVENTS`, for the missions list.
  - `massacre()`, `exploration()`, `exobiology()` and `systemAddress()`.
  - `ActivityStore` and a `dataPaths()` function that resolves `activity.json` the same way the
    server does (the sync folder, or the config folder).
  - The new value functions below.
- A semver promise: the export is public API from this release, so breaking changes need a major
  version. ED Chat pins an exact ed-mcp version and Dependabot proposes updates.

### Body value estimates

`bodyValue(scan, { mapped, efficient, firstDiscovery, firstMapped })` returns credits, using
the community formula for the current game (the `k` base per planet class, the terraformable
bonus, the mass term, the mapping multiplier, the efficiency bonus and the first-discovery
multiplier). `exploration()` gains `value_scanned` and `value_mapped` per body. Tests use known
values from game sales.

### Exobiology values and colony distances

A data file `exobiology.json` has, for each species: the base value and the genus's minimum
distance between samples (the colony range). `exobiology()` gains `value` per species (the
first-footfall bonus is shown separately) and `colony_m` per genus. The values come from the
in-game Codex. The source and its licence are recorded in `LICENSES`, as for the other data
files.

## Part 2: ED Chat activity panel

### Window

- A second transparent, topmost, click-through `BrowserWindow`, made like the chat window.
- Settings in a new `hud` section of the schema:

  ```json
  "hud": {
    "enabled": true,
    "position": { "anchor": "top-right", "offsetX": 24, "offsetY": 120, "display": "primary" },
    "width": 340,
    "fontSize": 16,
    "backgroundOpacity": 0.5,
    "modes": { "massacre": true, "exploration": true, "exobiology": true, "route": true },
    "valuableMin": 500000
  }
  ```

- New hotkeys: `hudToggle` (show or hide), `hudMode` (cycle auto → massacre → exploration →
  exobiology → route → off → auto), `routeNext` and `routePrev` and `hudMove` (a chord, so the arrow keys move the panel and not the
  chat). The move uses the same 3 × 3 anchor grid as the chat (`src/core/anchor.ts`).
- The panel hides when the game is not in front, as the chat does, and when the game window is
  at the main menu (no `Flags` in `Status.json`).

### Live data

- A `JournalTail` in `src/core/` polls the newest journal file every second, reads from the last
  offset and handles a new file when the game starts a new session. On start it reads the
  journals in the ed-mcp state window, so the massacre stack is right after a restart.
- `Status.json` is already polled. The panel also reads `Latitude`, `Longitude`, `PlanetRadius`
  and `BodyName` from it.
- The panel model is recomputed with the ed-mcp functions when a relevant event arrives, at most
  four times a second.

### Mode

The mode comes from the newest of these:

| Source | Sets |
|---|---|
| `MissionAccepted` for a massacre mission | massacre |
| `FSSDiscoveryScan`, or a `Scan` of type `Detailed` | exploration |
| `ApproachBody` or `Touchdown` on a body with bio signals, or `ScanOrganic` | exobiology |
| `LeaveBody`, when exploration was the mode before | exploration |
| The activity note changes (`updated_at` is newer) | its `kind`, if it is one of the three |
| The `hudMode` hotkey | the chosen mode, or off |

- Turning in the last massacre mission ends massacre mode. The panel goes back to the mode before
  it, or hides.
- In auto, an `FSDJump` with active massacre missions keeps massacre mode. A jump never starts
  exploration by itself, so the panel does not appear on a plain trip.
- The chosen mode is kept in `state.json`, so it survives a restart.

### Massacre panel

```
MASSACRE  · Kumo Crew Pirates            42 left
 ███████████░░░░  Lugh Purple Ltd      18/30
 ██████████████░  Eravate Network      26/28
 ████████░░░░░░░  Ross 128 Partners    12/24
 2 ready to hand in · next expires 1d 4h
```

- One block per target faction. The number on the right is the kills still needed, which is the
  largest stack, because a kill counts for one mission from each giver.
- One line per giver faction, with a bar.
- Missions that are done and the soonest expiry.
- A kill flashes the bar that moved.

### Exploration panel (in a system)

```
EXPLORE  · Pru Aescs NC-M d7-192    11/14 bodies
 ★ A 3   Earth-like          1,204 ls   2.1M  scan
 ★ B 1   Water world tf        840 ls   1.4M  map
   A 5   HMC tf · 2 bio        2,310 ls  0.9M  ✓
 Unsold: 18.4M cartographic · 3 bio (41.2M)
```

- The FSS discovery progress.
- Only bodies worth the time: valued over `hud.valuableMin` when mapped, or with bio or geo
  signals. Each one shows its distance, its value if mapped, and what is left: `scan`, `map` or
  ✓. ★ marks first discovery.
- Unsold cartographic and bio value since the last sale or death.

### Exobiology panel (at a body)

```
EXOBIOLOGY · A 5                 3 genera
 Bacterium Cerbrus      2/3   1.7M   ↔ 312 m / 500 m
 Stratum Tectonicas     ✓     19.0M
 Frutexa                not started
```

- The genera on the body, and the species sampled for each, with value.
- For the species in progress, the distance from the last sample, worked out from `Status.json`
  latitude, longitude and planet radius, against the genus colony range. The line turns green
  when the player is far enough to take the next sample.
- A genus with no sample yet shows `not started`.

### Session totals

A footer line in the exploration and exobiology panels: systems visited, bodies scanned and
mapped, and first discoveries this session.

### Route breadcrumbs

The route shows as a compact trail. It has two levels:

- **Plan stops**, from the active ed-mcp plan: the systems, bodies and stations of a trip
  ("Synuefe XR-H, planet A 5 for bios, then Jameson Memorial to hand in").
- **Jumps**, from `NavRoute.json`: the route plotted in the galaxy map to the next stop.

```
ROUTE  ✓ Shinrarta ▸ ✓ Col 285 ▸ ● Synuefe XR-H A 5 bio ▸ Jameson Mem.
 ◂ HIP 2345 ▸ Synuefe EN-H ⛽ ▸ Synuefe XR-H     3 jumps · fuel 5
```

- Line 1 shows the plan stops. ✓ marks a stop that is done, ● the current stop. The trail shows the
  previous stop, the current one and the next two. A long trail is shortened with `…` at the
  ends.
- Line 2 shows the plotted jumps: the last system, the next three, and the jumps left. ⛽ marks a
  star that can be scooped (classes K, G, B, F, O, A and M). `fuel 5` is the number of jumps the
  fuel in the tank allows, from `Status.json` and the last `Loadout`.
- If there is a plan but no plotted route, only line 1 shows. If there is a plotted route and no
  plan, only line 2 shows.
- **As a mode:** route mode is on when the plan has an active stop or `NavRoute.json` has jumps
  left, and no other mode is on. A jump never starts the other modes, so the route is what a
  normal trip shows.
- **As a footer:** when another mode is on and a route is active, line 1 shows as a single dim
  footer under that panel. Then the player can see where they go next while they finish the
  massacre stack or the bios.
- On arrival at a stop's system, the next stop's system name is copied to the clipboard, ready
  for Ctrl+V in the galaxy map (roadmap sub-project 2). The `routeNext` and `routePrev` hotkeys
  move the current stop. They change the plan in ed-mcp, so Claude sees the change.

## Mode registry

Each mode is one module in `src/core/hud/modes/` with the same shape:

```ts
interface HudMode<M> {
  id: string;
  events: readonly string[]; // journal events the mode reads
  triggers(e: JournalEvent, ctx: ModeContext): "start" | "end" | null;
  model(journal: JournalView, status: StatusView): M | null; // null: nothing to show
  render: (m: M) => PanelView; // pure; rendered by one shared component
  footer?: (m: M) => string | null; // a one-line summary, for when another mode is on
}
```

The mode switch, the window, the settings (`hud.modes.<id>`) and the tests take any mode in the
registry. A new mode is one module and its tests, with no change to the panel window.

## Follow-on design ideas

These modes are not part of this release. They are recorded here so the mode registry is built to
take them. Each one gets its own short spec and its own PR later.

| Mode | Turns on | Shows | Live progress from |
|---|---|---|---|
| Ground mission | `MissionAccepted` for an on-foot mission; `ApproachSettlement` or `Disembark` at its settlement | Objective, settlement, body, item or target, count, expiry | `Backpack.json` for collect and salvage; `Bounty` and `ShipTargeted` for kill targets; otherwise only `MissionCompleted` |
| Cargo and wing missions | `MissionAccepted` for a delivery or source mission; `CargoDepot` | Item, collected / delivered / total, destination, expiry | `CargoDepot` |
| Colonisation | `ColonisationConstructionDepot` when docked at a construction site | Each resource still needed against what is in the hold | `ColonisationConstructionDepot`, `Cargo.json` |
| Mining | `ProspectedAsteroid`, `LaunchDrone` (prospector) | The last asteroid's contents against a set threshold, motherlode, tons refined per hour, cargo space left, limpets | `ProspectedAsteroid`, `MiningRefined`, `Cargo.json` |
| Combat | `FactionKillBond` or `Bounty` when no massacre mission is active | Bonds and bounties earned per faction this session, unclaimed value | `FactionKillBond`, `Bounty`, `RedeemVoucher` |
| Materials | A plan with material needs, and `MaterialCollected` | "Need 4 more Polonium" for the active plan | `MaterialCollected`, `Materials` |

For ground missions, the game does not write the objective progress of most mission types to
the journal. The panel shows an objective card with the progress it can see, not a full quest
tracker.

Powerplay, fleet carrier fuel and Thargoid combat are left out: they are niche, or the game's own
UI shows them well.

## Testing

- ed-mcp: unit tests for `bodyValue`, the species values and the export entry (a test imports
  `ed-mcp/journal` from the built package).
- ED Chat: unit tests for the mode rules (a table of event sequences and the expected mode), the
  journal tail (new lines, a new file, a partly written line) and the colony distance (the
  great-circle distance on a sphere).
- The panel view models are pure functions from the ed-mcp results, with snapshot tests.
- A manual checklist item for each panel in `docs/manual-checklist.md`, played in the game.

## Order of work

1. ed-mcp: the `ed-mcp/journal` export, body values and exobiology values. Release.
2. ED Chat: the second window, `hud` settings, hotkeys and the journal tail.
3. ED Chat: the mode registry and the mode rules, then the massacre, exploration, exobiology and
   route panels.
4. Follow-on ideas, each with its own spec: ground and cargo missions, colonisation, mining,
   combat, materials.

## Open questions

- Which source for the species values and colony ranges has a licence that allows copying
  into ed-mcp? If none does, the values are typed in from the in-game Codex.
- The fuel estimate needs the fuel use per jump for the ship's FSD and mass. ed-mcp has the
  catalog for this; if it is not accurate enough, `fuel N` is left out of the first version.
