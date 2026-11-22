# Activity HUD: surface bookmarks

Date: 2026-11-22
Status: built, on ed-mcp 0.9.0, which adds `position` to plan stops and `PlanStore.addStop` (ed-mcp #99).

## Purpose

Mark a place on a planet and come back to it: a bio you cannot scan now (wrong suit, low on time,
a species needed later for a colony range), a crashed ship, a good landing spot.

## Design

- **Making one.** A hotkey, `bookmark` (Ctrl+Alt+B), saves where the ship or the commander is,
  from `Status.json`: system, body, latitude and longitude. The label says why when it can: on a
  planet with biology still to sample, the species and genera not finished ("Bio: Bacterium
  Cerbrus, Fungoida"); else "Bookmark 3". A note in the chat strip confirms it. Asking Claude
  ("bookmark this for the Concha I couldn't reach") works too, and Claude can rename or delete them.
- **Where they live.** A plan, `bookmarks`, in ed-mcp's plan store: one stop per bookmark, with
  `kind: exobiology` or `other`, the body, and `position: { latitude, longitude }`. Claude sees
  and edits them with the plan tools, and they sync like other plans.
- **Getting back.** Ask Claude to take you there: it makes `bookmarks` the activity note's plan,
  so the route rows show the next bookmark and arriving copies its system, as for any plan.
- **On the body.** When the ship or commander is on or near a bookmarked body, the panel adds a row
  per bookmark there, under the exploration or exobiology panel, or on its own (titled
  BOOKMARKS) when no panel shows; not under massacre or mining. Each row has the label, the
  great-circle distance (from the planet radius), the bearing, and how far to turn from the
  current heading ("469 m · 7° · turn right 141°"). Green within 100 m. In the system but away
  from the body, one dim line counts the bookmarks on each body.
- **Done.** `routeNext` marks the current bookmark done, as for any plan stop, and Claude can
  delete one. A bio bookmark is marked done by itself once every signal on its body is sampled
  and analysed (not while `hud.bookmarks` is off).
- The game has its own surface bookmarks in the system map, but setting one takes the map, the
  journal does not record them, and Claude cannot see them. This is a one-key version that the
  panel and Claude both use.

## Code

`src/core/hud/bookmarks.ts`: the stop for "here" (`bookmarkHere`), the label, the bearing and
turn, and the panel rows. The feed reads the `bookmarks` plan each poll; `buildHud` adds the rows.
