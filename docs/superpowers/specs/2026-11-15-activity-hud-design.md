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
- **Both panels in one release.** Massacre and exploration (with exobiology) ship together.
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
    "modes": { "massacre": true, "exploration": true, "exobiology": true },
    "valuableMin": 500000
  }
  ```

- New hotkeys: `hudToggle` (show or hide), `hudMode` (cycle auto → massacre → exploration →
  exobiology → off → auto) and `hudMove` (a chord, so the arrow keys move the panel and not the
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
3. ED Chat: the mode rules, then the three panels.

## Open questions

- Which source for the species values and colony ranges has a licence that allows copying
  into ed-mcp? If none does, the values are typed in from the in-game Codex.
- Should the panel also show the next stop of the active route plan (sub-project 2 of the
  roadmap) when no other mode is on? This spec leaves it out. The window and the mode switch
  are built so a route mode can be added.
