# Activity panel in detail

What each mode of the activity panel shows, and how it works it out. The panel
reads the game journal directly and never calls the assistant, so it costs no
tokens. It shows only while the game is in front: switch to another window and it
hides until you come back. The [README](../README.md#pictures) has pictures of each
mode. The keys are in
[the Keys section](#keys) below, and the panel's settings, all under
`hud`, in [Settings](settings.md).

## Keys

| Key | Action |
| --- | --- |
| Ctrl+Alt+P | Show or hide the panel |
| Ctrl+Alt+Shift+P | Choose the mode: automatic, then each mode that is on, then off |
| Ctrl+Alt+Home | Move the panel: for 15 seconds the move keys move the panel, not the chat |
| Ctrl+Alt+PageDown / PageUp | Mark the current route stop done / go back one stop, and copy the stop's system |
| Ctrl+Alt+B | Bookmark where you are on a planet |

## Massacre

Each target faction, the kills still needed for the stack, a bar for each faction
that gave you missions, missions ready to hand in, and the next expiry.

The footer shows what the whole stack pays and what is ready to hand in. Each
target shows what its unfinished missions still pay for each kill left. Below
`hud.massacre.minPerKill` (1M) it is marked ⚠, a sign to take more missions.

## Exploration

The discovery scan progress and the bodies worth the time: Earth-like, water and
ammonia worlds, terraformable planets, bodies with biological signals, and other
bodies worth `hud.valuableMin` when mapped. Each shows its distance, its value and
whether it still needs a scan or a map. ★ marks a first discovery. Bodies worth
less with geological signals are only counted.

Earth-like, water and ammonia worlds and terraformables are listed from
[Spansh](https://spansh.co.uk) as soon as you arrive: grey until you scan them,
then green. Planets with biological signals are listed the same way, with the
likely species of each genus (marked ?) and what they are likely worth: grey
before the scan, plain after, and green once every species is analysed. ★ marks a
first discovery and ×5 a first-footfall bonus.

The prediction compares the planet's atmosphere, type, temperature, gravity,
pressure, volcanism, star and galactic region with where Canonn has recorded each
species. Planets likely worth less than `hud.bioMin` are left off.

Before you scan a planet, its value is a range: the low end has no bonus, and the
high end includes the first-discovery and first-mapped bonuses, or the 5×
first-footfall bonus for biology. A planet listed on Spansh can still pay these
bonuses if nobody has handed in its data. After the scan, the game says which
bonuses apply. A system Spansh does not know gets ★ as a hint, since not everyone
uploads their scans.

The Session line ends with credits an hour, and the last half hour's rate in
brackets. They count what each scan, map and analysed species is worth when you
make it, with its bonuses, sold or not. A gap of more than 10 minutes with no
journal events (docked, or away) counts as 10, and a rate shows after 5 minutes.

## Exobiology

On a body with biological signals: each species with its samples (2/3) and value,
the genera not started yet, and, while you sample, the distance from your last
sample against the minimum distance for that genus. Genera not started show their
likely species. The system's Earth-like, water and ammonia worlds, terraformables
and other bio planets stay listed below.

The last line compares this planet's credits an hour with the session's and the
last half hour's. When the planet falls behind, it may be time to move on. The
planet's clock runs while you are at it, from approaching it, mapping it or taking
its first sample, and its rate counts its map and its species.

## Mining

Turns on when you launch a prospector, prospect, refine or crack a rock. It shows
the last prospected rock against `hud.mining.targets` (MINE or skip, and any
motherlode), the ring's hotspots, the hold, limpets left, tons refined per hour,
and the tons refined this session.

It also suggests where to sell what is in the hold, with what each load sells for:
the best price on [Spansh](https://spansh.co.uk) that has a pad for your ship and
takes the whole load, and a nearer station that pays at least 90% of that. The
session line ends with what the cargo sells for in all. When the hold fills, the
best buyer's system is copied for the galaxy map.

With `hud.mining.useCarrier`, the search is around your fleet carrier and includes
what you moved to it in the last 12 hours. After a jump, the panel stays on while
mined cargo is aboard.

## Passengers and deliveries

Turns on when you take a passenger or delivery mission, and stays while one is
open, until a newer activity. Each destination station shows its passengers (with
VIP and wanted counts) or goods and the soonest expiry, amber under two hours. The
header shows berths used against the cabins fitted, and the total reward.

Ask Claude to plan the route (ed-mcp's `missions_route`): the stops then follow its
order, the route below shows the next stop, and arriving copies the next system.
When you take a mission the route does not cover, the panel says the route is
stale.

## Trade

Turns on when you buy at a market (limpets aside) with no mission cargo aboard, or
dock at a stop of the trade plan. A stop with no station stands for any station in
its system. Ask Claude for a trade loop or route (ed-mcp's `trade_loops` or
`trade_route` with `save_to_plan`) to make the plan.

The panel shows the plan's current stop with what to buy or sell there (tons and
planned price), and the hold against the planned tons. While you are docked there,
it also shows the market's price against the plan, amber when it is more than 5%
worse. The next stop and its action follow. A loop shows its lap; on the first lap
there is nothing to sell at the first stop, so only its buy shows. When the plan's
prices are more than a day old, the header says how old.

The header and the Session line show profit an hour: each sale less what its tons
cost, counted as for exploration, with the last half hour in brackets. When a stop's
buys are bought there and in the hold, and its sales are sold there, the stop is marked done and the next
stop's system is copied for the galaxy map. Undocking first leaves the stop open;
the route keys still work. Passengers taken on a trade run show on a footer line.
Trade ends when the hold is empty with no trade stop left. With no trade stop to do,
five jumps with no trade end it too; a long haul to a trade stop does not.

## Route

The current stop of the active ed-mcp plan (with its body or station, what it is
for and the jumps left on the plotted route), the next stop, and how many stops
follow. It shows under the other panels too. When you arrive in a stop's system,
the next stop's system is copied for the galaxy map.

## Bookmarks

Ctrl+Alt+B saves where you are on a planet. On that body, the panel shows each
bookmark with its distance, its bearing and which way to turn: under the
exploration and exobiology panels, and on their own when the exploration or
exobiology panel has nothing to list, in route mode, or when no mode is on. Massacre,
mining and passenger mode leave them out. A
bookmark at a bio site is marked done once every species there is analysed.
Bookmarks are an ed-mcp plan, so Claude can see and change them. `hud.bookmarks`
turns them off.

## How the mode is chosen

The mode changes by itself. Accepting a massacre mission turns on massacre mode
until the stack is handed in. A discovery scan or a detailed scan turns on
exploration, and five jumps with no scan turn it off again. Approaching a body with
biological signals, landing on one, or taking a sample, turns on exobiology, and
leaving the body goes back to exploration, when that mode is on. Launching a
prospector limpet, prospecting, refining or cracking a rock turns on mining, and
taking a passenger or delivery mission turns on passenger mode. Buying at a market
(not limpets), or docking at a stop of the trade plan, turns on trade. A jump alone starts nothing.

Telling Claude what you are doing ("I'm doing massacres") sets the ed-mcp activity
note, which the panel follows. Ctrl+Alt+Shift+P chooses a mode yourself: automatic,
then each mode that is on in `hud.modes`, then off. Bookmarks are not a mode: they
show with the modes above.

## ed-mcp

The panel uses the same activity note and plans as ed-mcp. ED Chat finds the
ed-mcp sync folder where ed-mcp is set up: Claude Code's `~/.claude.json`, the
ed-mcp plugin's options, or Codex's `~/.codex/config.toml` (`CLAUDE_CONFIG_DIR` and
`CODEX_HOME` move them, as they do for the CLIs). The panel reads only
`ED_MCP_SYNC_DIR`, never the password. Set `hud.edMcpDataDir` if it is somewhere
else.

ed-mcp needs to be set up only once. If Claude Code has no ed-mcp of its own, ED
Chat gives it the one from another Claude project or else from Codex's config, with
its whole `env`, sync password included. That copy is written to
`approval-mcp.json` in ED Chat's data folder, `%APPDATA%\ed-chat`.
