# Activity panel in detail

What each mode of the activity panel shows, and how it works it out. The panel
reads the game journal directly and never calls the assistant, so it costs no
tokens. It shows only while the game is in front: switch to another window and it
hides until you come back. The [README](../README.md#pictures) has pictures of each
mode. The keys are in
[the Keys section](#keys) below, and the panel's settings, all under
`hud`, in [Settings](settings.md).

When everything a panel tracks is done, its header turns green with a ✓: every
species on the planet analysed, every body found and every one worth mapping
mapped, every massacre kill done, or every passenger or delivery mission ready to
hand in. Analysed species and mapped bodies are green with a ✓ too.

## Keys

| Key | Action |
| --- | --- |
| Ctrl+Alt+P | Show or hide the panel |
| Ctrl+Alt+Shift+P | Choose the mode: automatic, then each mode that is on, then off |
| Ctrl+Alt+Home | Move the panel: for 15 seconds the move keys move the panel, not the chat |
| Ctrl+Alt+PageDown / PageUp | Mark the current route stop done / go back one stop, and copy the stop's system |
| Ctrl+Alt+B | Bookmark where you are on a planet |
| Ctrl+Alt+- | Clear the nearest bookmark on the body you are on |

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
stale. The route's stops name the missions they serve in their [stop actions](#stop-actions)
(ed-mcp 0.11.0 and later) or, in an older plan, in a missions list. Each stop's deliveries
to the station's cargo depot and hand-ins are ticked off from the journal, and when the last is
done the stop is marked done and the next stop's system is copied. The rows are the missions
in the journal, as before.

## Trade

Turns on when you buy at a market, or dock at a stop of the trade plan. Some buys
are not trade: limpets, goods a mission has aboard or asks for, and anything bought
within two hours of supplying a colonisation depot, and goods a colonisation depot you
viewed in the last two hours still needs. They do not count toward profit. A sale of
goods the plan sells counts, at the game's price paid, even when the buy was before
the journal the panel reads. A stop with no station stands for any station in
its system. Ask Claude for a trade loop or route (ed-mcp's `trade_loops` or
`trade_route` with `save_to_plan`) to make the plan.

The panel shows the plan's current stop with what to buy or sell there (tons and
planned price), and the hold against the planned tons. While you are docked there,
it also shows the market's price against the plan, amber when it is more than 5%
worse. The live price shows once the station's market has been opened on this visit
(a relog while docked keeps it). The next stop and its action follow. The header says how far through the
plan you are (stop 2/4) and, for a loop, its lap; on the first lap there is nothing
to sell at the first stop, so only its buy shows. When the plan's prices are more
than a day old, the header says how old. With a plotted route to the current or
next stop, the jumps left show on that stop's row. For a plan of only trade stops,
the route rows that other plans show below are left out, since the panel already
lists the stops. They show for a plan with a fuel or mission stop, for a plotted
route anywhere else (a fuel stop, home), and once the plan is done.

The Session line shows profit an hour: each sale less what its tons
cost, counted as for exploration, with the last half hour in brackets once the session
has more than half an hour of active time and a sale falls in that half hour. A plan
saved by ed-mcp's trade tools carries the rate it was chosen for (`profit_per_hour`:
for a loop, its sustained rate over a session), and the Session line shows yours
against it, such as `51.1M/h of 60.0M/h planned`. It turns amber when you are behind:
after your first sale, the session's rate is under 80% of the plan's and, while the
last half hour's rate shows, that is under 80% too, so a slow start does not keep it
amber once the recent trading is on plan. A half hour with no sale (a long leg) shows
no half-hour rate and no amber. In the first half hour the session rate alone decides,
so a loop whose first sale comes late can read amber until it settles. Before your first
rate it shows the planned rate alone; a finished route shows no planned rate. Traded
cargo that leaves without a sale (to a depot, a mission or your carrier, or ejected) takes
its cost with it.

A plan saved by ed-mcp 0.11.0 or later gives each stop a buy or sale [action](#stop-actions)
for each row of its cargo, and the panel shows those rows as it showed the cargo. Each is
ticked off from the market's buys and sales at that station since the lap began, added up to
the tons; a buy that filled the hold, or a sale that left none of it aboard, counts as done
short of the tons while you are still docked there. When the stop's last action is done, the stop is marked done and the next
stop's system is copied for the galaxy map. A stop with no actions (a plan saved before, a stop
that only passes through, and a loop's first stop on its first lap when it only sells, since
the first lap has nothing to sell there yet and ed-mcp leaves out only those sales) is marked
done as before: when its buys are bought there and in the hold, and its sales
are sold there; undocking first leaves it open. The route keys still work.

Passengers taken on a trade run show on a footer line;
a passenger or delivery mission taken after your last trade shows the passenger
panel until you trade again. Trade ends when no traded cargo is aboard (mined ore
and salvage do not count) and no trade stop is left, or after five jumps with no
trade buy or sale of traded cargo, unless traded cargo is aboard on the way to a
trade stop. A stop with no actions is marked done only as the plan's current stop, when it is
a trade stop; a relog while docked is the same visit. A stop with actions is marked done when
its last action is, even before its turn, quietly.

Known limit: the hold and the market name goods as the game does, which matches the plan's
English names only on an English game client. On another language, the hold, the market's
price and a stop with no actions do not work, as for mining. A stop's actions are ticked off
from the journal's internal names too, which for most goods are the English name (those that
differ, such as Agri-Medicines, are known).

## Build

Follows a ship build or upgrade plan: an ed-mcp plan whose stops have actions, such as buying
a module, rolling a blueprint to a grade, a material trade or collecting a material. Ask Claude
to plan the build; it saves the plan with the actions at each stop and what each needs. The
panel makes no assistant calls: it ticks each action off from the journal.

The header says BUILD (UPGRADE for an upgrade of the ship you fly), the ship, the stop
(stop 2/3) and the actions done out of all. Then the current stop, with its actions in order:

- Done ones with ✓, dim. More than `hud.build.doneShown` (3) fold into "✓ N done". One the
  ship's newest loadout no longer shows is amber, "not fitted now"; the plan is left alone.
- For a blueprint, the grade and quality reached and the rolls left: "G3 64% → G5 · ~7 rolls".
  It is done at the target grade at any quality. The rolls are an estimate from the plan's rolls
  per grade (1, 2, 3, 4, 5 when it gives none) and the quality reached; a module with another
  blueprint starts again at G1.
- The first material short against your inventory, with the stop that collects or trades for
  it: "short 1 Arsenic (have 0/1) · collect at stop 2". "ready" when all is in hand.
- For a purchase, its price, amber when your credits (from Status.json) are short. While you
  are docked there with the outfitting screen opened on this visit, "not sold here" in amber for
  a module the station does not list.
- For a stored module, "here", the transfer time, or "in transit".
- An experimental waits for its blueprint at the same stop: "after FSD G5".

Then the next stop with a count of each kind of action left there ("buy 2 · retrieve 1"), and
a footer with the stops still open before this one (when you came here early), the stops after
it, the credits still to spend and the credits you hold, and the plan's target in one line.

The current stop is the one you are docked at (or landed at, for a collect stop on a body)
while it has work to do; else the plan's first stop to do. The route keys mark the stop the
panel shows. When the last action of a stop is done, the stop is marked done and the next
stop's system is copied for the galaxy map. When every action is done, the header says "Build
complete" in green until you undock.

**Which actions count.** Only journal events after the plan was started, and for the plan's
ship: by its ShipID, or for a plan with none, the first ship of its type an action is done on
(the panel writes that ShipID into the plan). A plan that buys its hull has no ship until the
hull is delivered. Each event does at most one action for each thing it does: a module bought
that sold the old one can finish a buy and a sale, but eight identical buys need eight
purchases. The panel writes into each action the events it used, so the count is the same on
every poll, and an action you or Claude mark done takes its event, so the next identical one
stays open.

**When it shows.** Docking at a stop of a build plan, landing at its collect stop, or an event
that does one of its open actions turns it on, as does an activity note of kind engineering
with a build plan. A synthesis or material trade the plan does not ask for changes nothing. A
jump never ends it; a newer activity (a scan, a prospect, a trade) takes over, and the next
build stop brings it back. With two build plans open, the one with a stop where you are docked
shows (the note's, when both have one), else the one you acted on last. That plan then leads
the route keys and the arrival copy, and Claude is told it differs from the note. Swapping to a
ship with its own build plan points the note at that plan.

**With no build plan.** When you are docked where no build plan has work (not at one of its
stops with an action to do, and nothing done here is one of its actions), buying, selling,
storing or moving a module, using the shipyard (a ship bought, sold, redeemed or transferred),
or an engineer's roll shows what you did this visit:

```
OUTFITTING · Farseer Inc                              this visit
Bought FSD 5A 5.1M · sold AFM Unit 2A 1.3M · stored 1
FSD Increased Range G3 → G5 · 100%                     6 rolls
Traded 2 · used 41 materials
Ask Claude to plan a build to track what is left.
```

The modules bought and sold with their credits (more than two kinds by name only, or as a count
and a total when the names do not fit two rows; a weapon with its size and mount, as "Pulse
Laser 2G" for a medium gimballed one),
and how many were stored, retrieved, transferred or moved; the ships; for each module
engineered, its blueprint from the grade before the visit to the grade and quality of the last
roll, and the number of rolls; an experimental applied; and the material trades and the
materials the rolls and syntheses used. There is no target, so nothing is left to do. A
synthesis, a material trade or a ship swap alone does not turn it on, though once it shows they
are listed ("took out Krait MkII"). It ends when you undock, and the activity before it (a trade
run, say) comes back; `hud.build.outfittingVisit` turns it off. The route rows still show under
it. Choosing build mode with the hotkey, an engineering activity note, or swapping to a ship
whose build plan has work, shows that plan instead while it has work to do.

A build's stops can also have the station's [actions](#stop-actions), such as a refuel or a
data sale, which are ticked off at that station. A plan with only those, or only trade and
mission actions, is not a build: the build panel follows a plan with a build, or with an action
of a build's kind.

Known limits: an action done while ED Chat was not running is ticked off on the next start, and
when that finishes its stop, the stop is marked done too. A stop whose actions were all marked
done already when ED Chat started waits for a route key.

## Stop actions

ed-mcp 0.11.0 and later writes what to do at each stop of any plan as the stop's actions: a
trade route's buys and sales, a mission run's deliveries and hand-ins, a build's purchases and
rolls, and the station's services. The panel judges them all the same way, from the journal,
and writes each one done into the plan, with the events that did it, so Claude sees it too.

| Action | Done by |
|---|---|
| `buy_commodity`, `sell_commodity` | `MarketBuy`, `MarketSell` of the commodity, added up to the tons |
| `complete_mission` | `MissionCompleted` of the mission |
| `collect_cargo`, `deliver_cargo` | `CargoDepot` collecting or delivering the mission's cargo, added up to the count, or showing all of it |
| `sell_data` | `MultiSellExplorationData`, `SellExplorationData` (exploration), `SellOrganicData` (organic) |
| `redeem_vouchers` | `RedeemVoucher` of the kind asked for (bounty, combat bond) |
| `refuel`, `repair`, `restock` | `RefuelAll` or `RefuelPartial`, `RepairAll` or `Repair`, `BuyAmmo` |
| the build's kinds | see [Build](#build) |

- Trades and services count only at the stop's own station (in its system, for a stop with no
  station), once the journal shows where you are. A mission counts wherever it is handed in: its
  ID says which it is.
- An action counts the events after its own start, not one at that very time (ed-mcp sets one
  on a mission's actions, and on each action when a loop's lap starts), else the build's, else
  the plan's (a trade or mission save sets it), else when the plan was made.
- One event finishes one action of each kind it matches, the first still to do in the plan's
  order; tons and counts are shared out in that order.
- When a stop's last action is done, the stop is marked done and, when it is the stop shown, the
  next stop's system is copied. The lap's newest claimed event goes with it as the next lap's
  start, so a loop's next lap counts what comes after it, and nothing the last lap claimed; with
  no claim, the newest journal event. The route keys give the newest journal event.
- The panel finishes the activity note's plan and every open build plan. Another plan with
  actions, such as an old trade loop left open, is left alone, or it would take this run's
  trades. A plan whose panel is turned off in `hud.modes` is left alone too.
- `accept_mission` is not judged yet, and does not hold its stop open: the stop is done when its
  other actions are. A stop with only `accept_mission` needs Claude or a route key.

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
bookmark at a bio site lists what is still to sample on its body, so finished
species drop off, and is marked done once every species there is analysed and
the journal has the body's signal count from a scan (Spansh's count, which can be
out of date, fills in the panel but does not mark a bookmark done). The
journal does not say what grows where, so the list is for the whole body, not
the spot. Only bookmarks the key made keep their list up to date: one renamed
keeps its label as saved.
Ctrl+Alt+- clears the nearest bookmark on the body you are on, one per press.
The tray menu's Bookmarks item clears bookmarks too:

- **Several on the body, none with a saved position (wherever you are):** the
  key clears none. The tray offers all of them, and asks first.
- **One on the body, or several with at least one saved position and your
  position known:** the key and the tray clear the nearest. A bookmark with no
  saved position counts as farthest.
- **Several on the body, at least one with a saved position, your position not
  known yet (in orbit):** neither clears any. Get closer to the surface.
- **In a system with bookmarks, not on a bookmarked body:** the key clears none.
  The tray offers every bookmark in the system, and asks first.
- **Anywhere:** the tray can clear every bookmark, after asking.

A cleared bookmark is marked skipped in the plan. Bookmarks are an ed-mcp plan,
so Claude can see and change them too. `hud.bookmarks` turns them off.

## How the mode is chosen

The mode changes by itself. Accepting a massacre mission turns on massacre mode
until the stack is handed in. A discovery scan or a detailed scan turns on
exploration, and five jumps with no scan turn it off again. Approaching a body with
biological signals, landing on one, or taking a sample, turns on exobiology, and
leaving the body goes back to exploration, when that mode is on. Launching a
prospector limpet, prospecting, refining or cracking a rock turns on mining, and
taking a passenger or delivery mission turns on passenger mode. Buying at a market
(not limpets), or docking at a stop of the trade plan, turns on trade. Docking at a stop of a
build plan, or doing one of its actions, turns on build; with no build plan that has work at
the station, so does using outfitting, the shipyard or an engineer while docked, until you
undock. A jump alone starts nothing.

Telling Claude what you are doing ("I'm doing massacres") sets the ed-mcp activity
note, which the panel follows. Ctrl+Alt+Shift+P chooses a mode yourself: automatic,
then each mode that is on in `hud.modes`, then off. Bookmarks are not a mode: they
show with the modes above.

## Dismissing a plan

The panel can show a plan for two reasons: the activity note names it, or it is a
build, trade or mission plan with stop actions still to do, at whose stop the ship is
docked or landed. Type in the chat:

- `/dismiss-plan` to clear the activity note. The note's plan leaves the panel. A
  plan with open stop actions still shows at its stops; the confirmation names those
  plans.
- `/dismiss-plan all` to also mark skipped every open stop action of every plan that
  has some: all builds, trade runs and mission plans, not only the one on the panel.
  They leave the panel at once, even while docked at one of their stops. The
  confirmation names each plan it skipped.

Neither deletes a plan: ask the assistant to reopen one (set its actions back to todo,
or set the activity note again). Both commands run in ED Chat and do not go to the
assistant.

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
