# Activity HUD: passenger, trade and mining panels

Date: 2026-11-21
Status: mining, passengers and trade implemented. Follows the activity HUD spec
(2026-11-15), which lists mining as a follow-on.

## Purpose

The panel has modes for massacre stacks, exploration and exobiology. Passenger runs, trade runs
and mining are the other common money loops, and each has the same problem: the player keeps
state in their head (who goes where, what to buy at this stop, is this rock worth it) or in a
tool outside the game.

## What already exists

- **Stop order.** ed-mcp already optimises stops. `missions_route` orders passenger, delivery and
  hand-in stops against deadlines (exact up to 12 stops). `trade_route` and `trade_loops` find
  multi-hop runs and repeatable loops. Claude calls these; the panel does not, since the panel
  makes no Claude calls and the solvers need Spansh coordinates and market data.
- **Next hop and copy.** The route rows show the current and next stop of the active plan.
  Arriving at a stop copies the next stop's system, and `routeNext` / `routePrev` step through
  the plan. A plan stop already has the kinds `mission`, `hand_in`, `trade` and `mining`.
- **Missions.** ed-mcp's journal state keeps each mission's destination, passenger count, VIP and
  wanted flags, commodity, count, reward and expiry.

So the work is mostly to join these up: the solvers save their order as the active plan, and the
panel shows what to do at each stop. The route rows then give the next hop and the copy for free.

## Decisions

- **Claude optimises, the panel follows.** The panel stays deterministic. When the plan no longer
  matches the missions or the hold (a new mission, a mission gone), the panel says so
  ("route stale: 2 new missions") and the player asks Claude to re-route. The panel does not
  re-solve on its own.
- **The solvers save plans.** `missions_route`, `trade_route` and `trade_loops` gain
  `save_to_plan`, as `route_stops` has. Saving sets the activity note's `plan_id` and `kind`, so
  the panel follows at once.
- **Mining needs no ed-mcp change.** It reads journal events and `Cargo.json` only.

## Part 1: ed-mcp

- `missions_route`, `trade_route` and `trade_loops` gain `save_to_plan: boolean` (default false)
  and an optional `plan_id`. The saved plan has one stop per station in visit order, with
  `kind`, a `label` such as "Drop 4 passengers (2 VIP)" or "Buy 720 t Gold", and the route.
- `StopSchema` gains an optional `cargo` list, so the panel can check the hold against the plan:

  ```ts
  cargo: z.array(z.object({
    commodity: z.string().min(1),
    action: z.enum(["buy", "sell"]),
    amount: z.number().int().positive(),
    price: z.number().optional(),        // the planned unit price
    mission_id: z.number().int().optional(),
  })).optional()
  ```

  and `missions` (mission IDs the stop serves). Both are optional, so old files load.
- A plan gains an optional `repeat: boolean` for trade loops: when the last stop is done, every
  stop goes back to todo and a lap count goes up.
- The activity note needs no new kinds: it already has `missions`, `hauling`, `trading` and
  `mining`. ED Chat shows `missions` and `hauling` notes as the passenger panel, and `mining`
  notes as the mining panel, and `trading` notes as the trade panel while the plan has a trade
  stop to do.
- The journal library exports the mission list (`JournalState.missions` is already typed).
- This is a minor version (new optional fields and exports). ED Chat pins the new version.

## Part 2: ED Chat panels

### Settings

`hud.modes` gains `passenger`, `trade` and `mining` (default true). Mining, as built:

```json
"mining": {
  "targets": { "Platinum": 20, "Painite": 25, "Osmium": 25, "Low Temperature Diamonds": 25,
               "Bromellite": 25, "Tritium": 30 },
  "useCarrier": false,
  "carrierMarkets": false,
  "sellRadiusLy": 100,
  "carrierRadiusLy": 500,
  "maxPriceAgeDays": 7
}
```

- `targets`: the least percentage of each commodity, by English name, that is worth mining.
- `useCarrier`: sell from the player's fleet carrier (see Fleet carrier below).
- `carrierMarkets`: include other players' carriers as buyers. Off by default: their buy orders
  change often and Spansh's copy is often old.
- `maxPriceAgeDays`: 7, not ed-mcp's 2. In November 2026 Spansh went three days with no new
  market data, and a 2-day limit found no buyer at all. A price over a day old shows its age.

### Mode rules

| Source | Sets | Ends when |
|---|---|---|
| `MissionAccepted` with `PassengerCount` | passenger | no passenger mission left |
| `MarketBuy` while the hold has no mission cargo, or a plan stop of kind `trade` | trade | hold empty and no trade stop to do, or 5 jumps with no market trade |
| `ProspectedAsteroid`, `LaunchDrone` of type `Prospector`, `MiningRefined`, `AsteroidCracked` | mining | a jump (`FSDJump`, or `CarrierJump` aboard) or a `MarketSell`, once no mined cargo is waiting: none in the hold, and with `useCarrier` none moved to the carrier in the last 12 hours. A relog does not end it: miners relog to reset the rocks |
| The activity note's `kind` | that mode | |

Massacre still wins while a stack is open. Passenger and trade are both "a run": when both are on
(passengers taken on a trade run), the panel shows trade with a passenger footer line.

### Passenger panel (built)

```
PASSENGERS                              10/22 berths · 4.0M
Ochosi · Perez Market                    6 pax (6 VIP)  1h 0m
Ngalinn · Haber Hub                    4 pax (4 wanted)  1d 0h
Wolf 397 · Brooks Estate                   32 t Gold  2d 2h
Sol · Abraham Lincoln                              hand in
Route stale: 1 new mission. Ask Claude to re-route
3 missions · 1 to hand in
● Ngalinn · Haber Hub                               4 jumps
  Drop 4 passengers (4 wanted) at Haber Hub
▸ Wolf 397 · Brooks Estate
```

- Passenger missions, and deliveries (a commodity and a count, not massacres), grouped by the
  station where they are handed over: the destination, or the giver once complete. The title is
  DELIVERIES when no passengers are aboard.
- One row per station, in the plan's order when the plan has those stops, else the soonest expiry
  first. Amber under two hours left; dim for stations with only rewards to collect.
- Berths from the `Loadout` cabins (economy, business, first, luxury by size).
- **Route.** ed-mcp's `missions_plan` (ed-mcp PR) saves the `missions_route` order as the active
  plan, one stop per station with the mission IDs it serves. The route rows then show the next
  stop and copy its system, as for any plan.
- **Stale.** With a plan whose stops list their missions, an open mission no stop to do serves
  shows "Route stale". Without a plan, two or more stations suggest asking Claude for a route. A
  plan read by an ed-mcp too old to keep the stops' missions counts as a route, with no stale check,
  until ED Chat bundles the new ed-mcp.
- Mode: a `MissionAccepted` with `PassengerCount`, or a delivery, turns it on while any such mission
  is open, until a newer activity (a scan, mining). Massacre stacks win. The activity note's kinds
  `missions` and `hauling` choose it too.

### Trade panel (built)

```
TRADE  Loop: Kremainn ⇄ Wolf 397              stop 1/2 · lap 3
● Kremainn · Wohler Terminal                  BUY  720 t Gold
  hold 0/720 · price 9,410 (plan 9,380)
▸ Wolf 397 · Brooks Estate                    SELL 720 t Gold · 2 jumps
Session: 31.6M profit · 46m · 41.2M/h (30m 40.0M/h)
```

- The current stop's action from its `cargo`: what to buy or sell and how much. While docked at
  that stop, the second line shows the hold against the plan, and the price in `Market.json`
  against the planned price, so a market that has moved is visible before buying.
- `MarketBuy` and `MarketSell` keep the session's profit: each sale's total less the average cost
  paid for those tons. Profit an hour is on the Session line, over the active time since the first
  trade of the session (gaps of more than 10 minutes count 10), with the last half hour in
  brackets. The header has the stop (stop n/m, in visit order over all the plan's stops) and the
  lap.
- When the stop's action is done (hold filled, or the commodity sold), the panel marks the stop
  done through the `PlanStore`, as `routeNext` does, and copies the next system. Undocking with
  the action not done leaves the stop open.
- For a loop, finishing the last stop starts the next lap.
- Price data from Spansh can be hours old. When the plan's price age is over a day, the header
  shows it ("prices 30h old").

### Mining panel (built)

```
MINING · 2 A Ring                                     48 t/h
Platinum 31.4% · High                                   MINE
  Gallite 5.0%
Hotspots: Platinum ×2 · Painite
Hold 256/256 t                        0 t free · 10 limpets
Sell Platinum 246 t                          60.0M · 12 ly
  Haber Hub, Ngalinn · 244k/t
  or nearer                                  56.6M · 4.0 ly
  Brooks Estate, Wolf 397 · 230k/t
Session: 23 prospected · 4 worth mining · 86 t refined · 60.0M to sell
```

- The newest `ProspectedAsteroid` since arriving in the system: the material that best clears its
  target (else the richest), its content and what is left of the rock, and MINE (green) or skip
  (dim). The other materials wrap below. A motherlode shows in amber with "crack".
- The ring comes from `SupercruiseExit` (`BodyType: PlanetaryRing`), `AsteroidCracked` or
  `Status.json`. Its hotspots come from the ring's `SAASignalsFound`.
- The hold, from `Cargo.json` through ed-mcp's journal state, against the `Loadout` capacity, and
  the limpets. Amber with no space or no limpets.
- Tons per hour: `MiningRefined` events over the last 15 minutes, or since mining started if that
  is shorter (at least 3 minutes). None when nothing was refined for 15 minutes.
- **Where to sell.** For the three mined commodities with the most tons aboard, a Spansh station
  search near the ship (`sellRadiusLy`), sorted by sale price, with buyers that have the market
  filter's demand and are newer than `maxPriceAgeDays`. Only the system name and commodity are
  sent. The search runs only while the mining panel shows, is kept for 30 minutes, and is retried
  after 5 minutes when it fails.
  - The pick is the best price at a station with a pad for the ship (from the ship type) that
    takes the whole load, else the best price. A nearer station that pays at least 90% of it is
    shown below. A station whose demand is less than the load says so.
  - Each sell row shows what the load sells for there (what the buyer takes, when its demand is
    less), and the buyer line its price a ton. The session line ends with the tons refined this
    session and the total to sell: the cargo to sell at the picked prices. It is a floor (16.6M+)
    when any mined cargo has no usable price: not looked up yet, no usable buyer, a buyer that
    takes less than the load, or more commodities aboard than have sell rows.
  - When the hold fills while still mining in the ring, the best buyer's system is copied for the
    galaxy map, with a note in the chat strip, once per trip (until the next sale or move to the
    carrier), whichever buyer is best. Not after leaving, where the route
    copies the next stop, and not while the panel is hidden.
  - Known limit: ed-mcp keeps the cargo's localised name only, so on a non-English game client the
    hold's mined commodities are not recognised. Fixing it needs ed-mcp to keep the cargo's
    journal name.
- The panel's rows go to Claude in the game note, so Claude can plan the sale route with
  `commodity_prices` and the plan tools.

### Fleet carrier

Many miners fill the hold, drop the load on their own carrier in the same system, and sell the
whole stock later, either by jumping the carrier near a buyer or by carrying it over.

- The carrier is the newest `FleetCarrier` in `CarrierBuy`, `CarrierStats` or `CarrierLocation`.
  `CarrierLocation` is written at each login, so the carrier's system is always known. A
  `CarrierJumpRequest` shows "→ destination" until its `DepartureTime` (or 15 minutes after the
  request in older journals), then the carrier is in the new system. `CarrierJumpCancelled`
  undoes it.
- Cargo moved this game session: `CargoTransfer` to and from the carrier, and `MarketSell` /
  `MarketBuy` at the carrier's own market (its `MarketID` is the carrier ID). The game does not
  log what other players sell to or buy from the carrier, so this is "moved in the last 12 hours", not
  the stock. Free space is the newest `CarrierStats` less the moves since.
- With `useCarrier`, the buyer search is around the carrier (`carrierRadiusLy`, 500 ly, about
  one laden carrier jump) for the hold plus what was moved, and a full hold copies nothing,
  since the load goes to the carrier. The player's own carrier is never suggested as a buyer.

### Trade with a fleet carrier (proposal)

A carrier trade run is different from a ship run: the carrier is the hold, and the ship shuttles
between it and a station in the same system.

- **Loading.** The carrier sits by a source station. The ship buys at the station and moves the
  cargo to the carrier (`CargoTransfer`), or the carrier's buy order fills it. The panel shows
  the carrier's progress toward the plan's tonnage, the trips left at the ship's capacity, and
  the free space.
- **Moving.** The carrier jumps to the sell system: the panel shows "→ system" and the departure
  time, and when the jump is done it copies nothing (the ship is aboard).
- **Selling.** The ship carries loads from the carrier to the station, or the carrier's sell
  order runs while the player does something else. Profit is the sale less the cost basis.
- **Plan.** The trade tools gain a carrier option: legs are carrier jumps (500 ly each, limited by
  tritium, 15 minutes of countdown and jump), and the run is ranked by profit per hour including
  the shuttle trips. A plan stop gets a `carrier: true` flag, so the route rows show "carrier
  jump" rather than a ship route.
- **Tritium.** Jumps cost fuel. `CarrierStats.FuelLevel` and the jump distance give the jumps
  left, and tritium mined or bought can be moved to the carrier's fuel.

## Code layout

As before: a rule per mode in `mode.ts`, a panel function in `panels.ts` (or a file per mode if
`panels.ts` grows past easy reading), and tests from journal event sequences. New `HUD_EVENTS`:
`MarketBuy`, `MarketSell`, `ProspectedAsteroid`, `MiningRefined`, `LaunchDrone`, `Passengers`.
The hold comes from ed-mcp's journal state, which reads `Cargo.json` (newer game builds write
`Cargo` events without the list); ED Chat's feed reads neither file itself. A trade panel can use
ed-mcp's `Market.json` reader the same way.

## Order of work

1. **Mining.** ED Chat only. No ed-mcp release needed. Built in this PR, with the carrier.
2. **Passengers.** ed-mcp: `save_to_plan` on `missions_route`, stop `missions`, the mission
   export. ED Chat: the panel and the stale rule.
3. **Trade.** ed-mcp: stop `cargo`, plan `repeat`, `save_to_plan` on the two trade tools. ED Chat:
   the panel, auto-advance on a finished action.

Each is its own PR, as the HUD spec says for follow-on modes.

## Open questions

- ~~Should the panel mark trade stops done on its own?~~ Decided: on its own. A stop is done
  while docked there when every buy was bought there and is in the hold (the planned tons, or
  a full hold) and every sale was sold there with none left aboard; a stop with nothing to buy or
  sell is done on docking. It is judged once per docking, again on the plan as it is now, before
  ED Chat writes it.
- Passenger missions to a station the player is docked at, but not yet completed (the hand-in is
  in the mission board): show as "hand in here"?
- ed-mcp's `commodity_prices` keeps a 2-day default age. While Spansh's market data lags, as it
  did in November 2026, it finds nothing. Raise it, or retry with a longer age before saying
  "no stations"?
