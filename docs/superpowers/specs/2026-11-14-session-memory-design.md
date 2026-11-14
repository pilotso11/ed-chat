# Session memory, routes and journal tools

Date: 2026-11-14
Status: draft, for review

## Purpose

When ED Chat restarts, Claude forgets what the player was doing. The player must explain again
that they are scanning bios on a planet, running a massacre stack or hauling. Plans in ed-mcp
hold build items and stops by system and station, but cannot hold a trip such as "system X,
planet Y for bios, then planet Z, then station A to hand in". And the journal tools do not cover
exobiology, exploration scans or massacre progress, so Claude falls back to Bash and greps the
journal files.

This work has three parts:

1. ED Chat resumes the last conversation, and Claude reads a saved activity note.
2. ed-mcp stores the activity note, and plans hold routes: stops with a body, a kind and a status.
3. ed-mcp reads the journal for exobiology, exploration, massacre missions and any other event.

## Decisions

- **Both resume and note.** The conversation gives full context for a short break. The note
  survives `/new`, compaction and long breaks.
- **ed-mcp stores the note and the routes.** They go in the sync folder with plans and preferences,
  so ED Chat, Claude Code and Claude Desktop see the same activity and route on every computer.
- **Routes are plans.** A plan already has `stops`. A route is a plan whose stops have bodies,
  kinds and a status. No second store.
- **Read the journal in ed-mcp, not with Bash.** Each new tool is read-only and returns a compact
  summary, so it is cheap in tokens and needs no approval.

## Part 1: ED Chat

### Resume the last conversation

- `state.json` gains `session: { id, lastUsed }`. ED Chat writes it on each `result` event, an error reply
  included: the conversation was used.
- On start, if `lastUsed` is less than `claude.resumeHours` ago, the first spawn passes
  `--resume <id>`. Default 12 hours. 0 turns resume off. The setting is in the schema.
- `/new` clears `session`.
- When the CLI says `No conversation found`, ED Chat clears `session`, starts a fresh
  conversation once, and resends the message in flight. Any other exit before `init` is
  reported as a normal exit, and the next spawn tries the same conversation again; a second
  one gives up on it in the same way. The status line flashes "ⓘ could not resume the last
  conversation; started a new one".
- A resumed start flashes "↺ resumed your last conversation" at the first `init`, when the
  CLI has confirmed the conversation.
- `session` also names the history file. A resumed start appends to that file and loads its
  last 200 turns, so the history view (Ctrl+Shift+H) shows the conversation that Claude remembers. A failed
  resume drops those turns from the view and starts a new file.

### Prompt

The HUD prompt gains:

- At the start of a conversation, call `activity_get`. When it has an activity, use it and its
  route as context; do not repeat it back unless asked.
- When the player starts a new activity or the goal changes, update it with `activity_set`.
- When the player finishes a route stop, mark it with `plan_update_stop`.

### Tests

- State store round-trips `session`.
- The resume decision: within the window, outside it, setting 0, after `/new`.
- The fallback: a resume that exits before `init` starts a fresh session once, not in a loop.
- The prompt test checks the new lines and stays cmd-safe.

## Part 2: ed-mcp, activity and routes

### Activity note

New file `activity.json` in the sync folder, or the settings folder without one.

```json
{
  "kind": "exobiology",
  "summary": "HIP 87621 2 b a: 2 of 5 genera done; Clypeus, Concha, Osseus left",
  "plan_id": "hip-87621-bios",
  "updated_at": "2026-11-14T20:00:00Z"
}
```

- `kind`: `exobiology`, `exploration`, `massacre`, `missions`, `hauling`, `trading`, `mining`,
  `engineering`, `combat` or `other`.
- `summary`: at most 500 characters.
- `plan_id`: optional, the active route or build plan.

Tools:

- `activity_get`: the note, its age, and the commander's location from the journal, so Claude
  can tell when the player has moved on. With no note, it says so.
- `activity_set`: replaces the note. `kind` and `summary` are required. `clear: true` deletes it.

### Routes in plans

`StopSchema` gains:

| Field | Type | Meaning |
|---|---|---|
| `body` | string, optional | Planet or moon, for example `HIP 87621 2 b a` |
| `status` | `todo`, `done`, `skipped`; default `todo` | Progress |
| `notes` | string, optional | For example "Osseus on the slopes south of the landing site" |

`StopKind` gains `exobiology`, `exploration`, `combat`, `mission`, `hand_in`, `trade`, `mining`
and `fuel`. The old kinds stay.

- When a plan has no computed `route`, the order of `stops` is the visit order.
- `plan_get` and `plan_list` add `next_stop`, the first stop with status `todo`, in route order
  when a route is computed.
- New tool `plan_update_stop`: `plan_id`, the stop by `label` or index, and `status` and/or
  `notes`.
- Tool descriptions say "plan" for both builds and routes. Old files load unchanged, because
  every new field is optional or has a default.
- `route_stops` still orders stops. It keeps the new fields and skips stops that are `done` or
  `skipped`.
- The plan Markdown export shows body, kind, status and notes, and marks the next stop.

## Part 3: ed-mcp, journal tools

All read recent journal files through the existing reader and cache. Each says how fresh the
journal is, as the other journal tools do.

### `journal_exobiology`

Input: `system` (default: current), `body` (optional).

For each body with biological signals: signal count (`FSSBodySignals`, `SAASignalsFound`),
genera from the surface scan (`SAASignalsFound.Genuses`), and each species sampled with its
stage (`ScanOrganic`: Log 1/3, Sample 2/3, Analyse 3/3). Genera with no sample are listed as
not started. It also gives the count of analysed species not yet sold, since the last
`SellOrganicData`. The journal has no sample positions, so the tool does not give them.

### `journal_exploration`

Input: `system` (default: current).

The system's discovery scan (`FSSDiscoveryScan` body count, `FSSAllBodiesFound`), and for each
scanned body (`Scan`): type, distance, landable, terraformable, atmosphere, rings, whether
someone discovered or mapped it first, whether the commander mapped it (`SAAScanComplete`), and
signals. Values are not estimated in this version.

### `journal_massacre`

Input: none.

Active massacre missions grouped by issuing faction and target faction: kills required, kills
counted from `Bounty` and `FactionKillBond` events since each mission was accepted, and kills
left. Each kill counts toward the oldest open mission of each issuing faction, as the game does.
`MissionRedirected` marks a mission done. The counts are an estimate, and the tool says so.

### `journal_events`

Input: `events` (names, optional), `since` (time, optional), `system` (optional), `limit`
(default 50, at most 200).

Matching events, newest first, as recorded. Long arrays are cut to 20 entries with a count. For
anything that no other tool covers, so Claude never needs Bash for the journal.

## Delivery

| PR | Repo | Content | Depends on |
|---|---|---|---|
| A | ed-mcp | Journal tools (Part 3) | nothing |
| B | ed-mcp | Activity note and route stops (Part 2) | nothing |
| C | ed-chat | Resume and prompt (Part 1) | B released, for the prompt lines |

C's resume works without B. Its prompt lines say "if the tool is listed", so an older ed-mcp
does no harm.

## Not in this version

- Automatic stop progress from the journal (arrive at a body, mark the stop done). It belongs to
  the route HUD, sub-project 2 in the roadmap.
- Exploration and exobiology value estimates.
- Sample positions, which need `Status.json` polling while the player samples.
