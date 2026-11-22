# Activity panel: ship and on-foot builds

Date: 2026-11-22
Status: proposed. Issue #81, widened by its author's comment to take in purchases, full ship
builds, upgrades of the current ship (a subset of a full build), and suit and on-foot weapon
upgrades. Follows the activity HUD spec (2026-11-15) and the trade, passenger and mining spec
(2026-11-21).

## Purpose

A build takes many visits over days: modules to buy or move from storage, engineers to unlock
and visit, blueprints rolled grade by grade, materials gathered and traded. The player keeps the
list in Coriolis or EDSY, a notes file or their head, and checks the material counts in the
game's menus. ED Chat can hold the list as an ed-mcp plan, which the assistant writes and the
panel follows. The panel shows what is left for the ship (or suit) you are in, judges progress
from the journal, and marks plan items done as they happen, as the trade panel does for stops.

## What already exists

**In ed-mcp (0.9.1):**

- **Plans with items.** `PlanItemSchema` has `kind` (`buy`, `engineer`, `experimental`,
  `unlock_engineer`, `gather`, `trade`, `refit`), `description`, `status`, `station`, `engineer`,
  `materials` (name and count) and `notes`. A plan has `target_build` (any value, used as SLEF)
  and stops of kind `shop`, `trader` and `engineer`. `plan_update_item` and
  `PlanStore.updateItem()` set an item's status. Nothing in ed-mcp writes items from a build yet:
  the assistant writes them by hand with `plan_upsert`.
- **Builds.** `build_parse_slef` reads SLEF from Coriolis, EDSY or Inara into slots, modules,
  blueprints, grades, quality and experimental effects. `build_stats` models a build from the
  journal `Loadout`, CAPI, SLEF or a plan's `target_build`, applies what-if `changes` (swap,
  engineer, remove) and returns the changed build as SLEF.
- **Engineering data.** `catalog_blueprint` gives the materials for each grade and the
  experimentals for a module, `catalog_engineers` the engineers for a blueprint with their max
  grade, location and unlock requirements, `catalog_module` the outfitting symbol, class and
  rating. The blueprints and modules come from coriolis-data and FDevIDs, downloaded at run time.
  `engineers.json` (EliteDangerousCore, committed) has every engineer's system, base, planet and
  an `odyssey` flag.
- **Materials.** `materials_plan` takes blueprints (from and to grade, count, experimental,
  rolls per grade) and extra needs, compares them with the inventory (journal or EDSM), plans
  trades at exact trader rates (`planTrades`), lists what is still short, and finds the nearest
  trader of each type on Spansh.
- **Journal state.** `materials` (raw, manufactured, encoded, kept up to date from `Materials`,
  `MaterialCollected`, `MaterialDiscarded`, `MaterialTrade`, `EngineerCraft`, `Synthesis`,
  `TechnologyBroker`, `ScientificResearch`, `EngineerContribution` and mission rewards), `engineers`
  (progress Known, Invited or Unlocked, rank and rank progress, from `EngineerProgress`), `ship`
  (type, name, ident), `credits` and the latest `Loadout`. These events are in `STATE_EVENTS`, so
  `KEPT_EVENTS` keeps them. `ShipyardSwap` is kept too.
- **Shops.** `spansh_find_stations` finds stations that sell a module (name, class, rating) or a
  ship, ranked by travel time and price. `route_stops` orders a build's shops, traders and
  engineers, with `after` for an engineer that needs a module bought first.

**Not in ed-mcp:** nothing reads on-foot gear. Journal state skips suits (`NOT_A_SHIP`), and has
no ship locker. The catalog has no suit or weapon grades, upgrade costs or on-foot
modifications. None of the module events (`ModuleBuy`, `ModuleSell`, `ModuleSwap`,
`ModuleStore`, `ModuleRetrieve`, `StoredModules`, `FetchRemoteModule`) are kept.

**In ED Chat:** the panel modes, route rows and copy, and the trade panel's auto-advance
(`tradeAdvance()`, `finishTradeStop()` in `src/main/index.ts`: judge on each poll, mark once per
key through the `PlanStore`, judge again on the plan as it is now, copy the next system).

## The journal, as the game writes it

From real journals (2021 to November 2026). Field names are exact.

- **`Loadout`**: `Ship`, `ShipID`, `ShipName`, `ShipIdent`, `HullValue`, `ModulesValue`,
  `Rebuy`, `CargoCapacity`, `MaxJumpRange`, and `Modules[]` with `Slot`, `Item` (lower case, as
  `int_hyperdrive_size5_class5`), `On`, `Priority`, `Health`, `Value` and, when engineered,
  `Engineering` with `Engineer`, `EngineerID`, `BlueprintID`, `BlueprintName` (as
  `FSD_LongRange`), `Level` (the grade), `Quality` (0 to 1), `ExperimentalEffect` (as
  `special_engine_overloaded`), `ExperimentalEffect_Localised` and `Modifiers[]`. Written on
  login, after each outfitting change and on a ship swap.
- **`ModuleBuy`**: `Slot`, `BuyItem` (as `$int_fighterbaymk2_size5_class1_free_name;`),
  `BuyItem_Localised`, `BuyPrice`, `MarketID`, `Ship`, `ShipID`, and `SellItem` / `SellPrice` or
  `StoredItem` when the old module was sold or stored.
- **`ModuleSell`**: `Slot`, `SellItem`, `SellPrice`, `MarketID`, `Ship`, `ShipID`.
  **`ModuleSellRemote`**: `StorageSlot`, `SellItem`, `ServerId`, `SellPrice`.
- **`ModuleSwap`**: `FromSlot`, `ToSlot`, `FromItem`, `ToItem` (`Null` for an empty slot),
  `MarketID`, `Ship`, `ShipID`.
- **`ModuleStore`**: `Slot`, `StoredItem`, `Ship`, `ShipID`, `Hot`, and `EngineerModifications`,
  `Level`, `Quality` for an engineered module. **`ModuleRetrieve`**: `Slot`, `RetrievedItem`,
  the same engineering fields, and `SwapOutItem` when the slot was full.
- **`StoredModules`**: `MarketID`, `StationName`, `StarSystem`, `Items[]` with `Name`,
  `StorageSlot`, `StarSystem` and `MarketID` (where it is stored), `InTransit` while moving,
  `TransferCost`, `TransferTime` (seconds), `BuyPrice`, `Hot`, `EngineerModifications`,
  `Level`, `Quality`. Written when the outfitting screen opens.
  **`FetchRemoteModule`**: `StorageSlot`, `StoredItem`, `ServerId`, `TransferCost`,
  `TransferTime`, `ShipID`.
- **`EngineerCraft`**: `Slot`, `Module`, `Engineer`, `EngineerID`, `BlueprintName`, `BlueprintID`,
  `Level`, `Quality`, `Ingredients[]` (`Name`, `Count`), `Modifiers[]`, and for an experimental
  `ApplyExperimentalEffect`, `ExperimentalEffect`, `ExperimentalEffect_Localised`. One event per
  roll. It has **no `ShipID`**: it is for the ship flown at the time.
- **`EngineerProgress`**: at login `Engineers[]` with `Engineer`, `EngineerID`, `Progress`
  (`Known`, `Invited`, `Unlocked`), `Rank` and `RankProgress`; later single-engineer updates.
- **`MaterialTrade`**: `MarketID`, `TraderType` (`raw`, `manufactured`, `encoded`), `Paid` and
  `Received`, each with `Material`, `Material_Localised`, `Category`, `Quantity`.
- **`Materials`**: at login, `Raw[]`, `Manufactured[]`, `Encoded[]` with `Name`, `Count`.
- **`ShipyardBuy`**: `ShipType`, `ShipPrice`, `StoreOldShip`, `StoreShipID` (or `SellOldShip`),
  `MarketID`. **`ShipyardNew`**: `ShipType`, `NewShipID`. **`ShipyardSwap`**: `ShipType`,
  `ShipID`, `StoreOldShip`, `StoreShipID`, `MarketID`. **`StoredShips`** lists the fleet.
- **`TechnologyBroker`**: `BrokerType` (`guardian`, `human`), `ItemsUnlocked[]`,
  `Commodities[]`, `Materials[]`.
- **On foot:**
  - **`BuySuit`**: `Name` (as `TacticalSuit_Class2`), `Price`, `SuitID`, `SuitMods[]`.
    **`BuyWeapon`**: `Name` (as `Wpn_M_Launcher_Rocket_SAuto`), `Name_Localised`, `Class`,
    `Price`, `SuitModuleID`, `WeaponMods[]`.
  - **`UpgradeSuit`**: `Name`, `SuitID`, `Class` (the new grade), `Cost`, `Resources[]` (`Name`,
    `Name_Localised`, `Count`). **`UpgradeWeapon`**: `Name`, `Name_Localised`, `SuitModuleID`,
    `Class`, `Cost`, `Resources[]`.
  - **`SuitLoadout`** (at login), **`SwitchSuitLoadout`**, **`CreateSuitLoadout`**: `SuitID`,
    `SuitName` (the grade is its `_classN` suffix; `SuitName_Localised` is often an unresolved
    `$ExplorationSuit_Class1_Name;`), `SuitMods[]` (as `suit_increasedammoreserves`), `LoadoutID`,
    `LoadoutName`, `Modules[]` with `SlotName`, `SuitModuleID`, `ModuleName`, `Class`,
    `WeaponMods[]` (as `weapon_range`). **`LoadoutEquipModule`** has one weapon the same way.
  - **There is no event for an on-foot modification.** In these journals a mod applied at an
    Odyssey engineer shows only in the next loadout event's `SuitMods` or `WeaponMods`. A suit
    or weapon not in the equipped loadout is not seen until it is equipped.
  - **`ShipLocker`**: `Items[]`, `Components[]`, `Consumables[]`, `Data[]` with `Name`,
    `Name_Localised`, `OwnerID`, `MissionID`, `Count`. Most of these events have no lists: the
    game writes `ShipLocker.json` instead (as with `Cargo.json`). `Backpack` and
    `Backpack.json` the same. **`BackpackChange`** has `Added[]` / `Removed[]` with `Type`.
    **`BuyMicroResources`**, **`SellMicroResources`**, **`TradeMicroResources`** (`Offered[]`,
    `Received`, `Count`, `Category`) and **`TransferMicroResources`** change the locker.

Module symbols differ by event. `Loadout` and `EngineerCraft` give `int_engine_size7_class2`;
`ModuleBuy`, `ModuleSell`, `ModuleStore` give `$int_engine_size7_class2_name;`; SLEF gives
`Int_Engine_Size7_Class2`; a free module ends `_free`. They are compared lower case with the `$`,
`_name;` and `_free` taken off.

## Decisions

- **Claude plans, the panel follows.** As for trade, the panel makes no assistant calls and no
  catalog downloads. Claude turns a target build (SLEF, or "G5 my FSD and thrusters") into a
  plan with ed-mcp, which works out the modules, blueprints, engineers, materials, trades and
  stops. The panel compares that plan with the journal.
- **The plan says what is needed in full.** Each item carries the slot, module, blueprint,
  grade, experimental and the materials per roll, so the panel can judge it and count what is
  left without the catalog.
- **A full build and an upgrade are the same plan.** A full build lists every slot of the
  target (and may start with buying the hull). An upgrade lists only the slots that change;
  every other slot is left as it is. The panel judges only the items listed.
- **A build is for one ship, or one suit loadout.** See "One build or one per ship".
- **Ship builds first; on-foot gear second.** The on-foot part needs game data ed-mcp does not
  have and the journal shows less (no event for a modification). It is designed here, and
  built as its own later PRs.

## What the panel shows

### Ship build

```
BUILD · Python Mk II · Wanderer                        7/12 done
FSD 5A  Increased Range G5 · Mass Manager      G4 92% → G5
  Felicity Farseer · rank 5 · ~2 rolls left
Shield booster ×4  Heavy Duty G5                       2/4 G5
Power plant 6A  Overcharged G5         stored · Jameson Memorial
Shield gen 6A  Reinforced G5                  buy 6A · 18.9M
Thrusters 6A  Dirty Drives G5 · Drag Drives                ✓
5 done · 33.4M to spend · 1.2B held
Short: 3 Datamined Wake Exceptions · 2 Proto Light Alloys
  trade 18 Unusual Encrypted Files → 3 Datamined Wake (encoded)
● Deciat · Farseer Inc          FSD G5, PD G5          12 jumps
▸ Shinrarta Dezhra · Jameson Memorial   retrieve PP, buy shield
```

- **Header:** BUILD, the ship type and its name (from `Loadout` `ShipName`), and the items done
  out of all. A plan for a ship not owned yet shows the hull to buy first.
- **One row per item still to do**, in the plan's order, then a count of the done ones. Items
  for the same blueprint on several modules (four shield boosters) share one row with a count.
  At most `hud.build.rows` (default 6) item rows; "+3 more" after that. Each row:
  - The module in short form ("FSD 5A") from the item's `label`, the target blueprint, grade and
    experimental.
  - On the right, what is next for it:
    - **To buy:** "buy 6A · 18.9M" with the plan's price, or "stored · Station" when the
      newest `StoredModules` holds that module (with "15m" transfer time when it is elsewhere and
      can be fetched). A stored module with engineering of the plan's blueprint and grade shows
      "stored · G5 ✓", since retrieving it finishes the item.
    - **To engineer:** the grade now against the target, with the roll's quality: "G4 92% → G5".
      A module engineered with another blueprint shows "Dirty G5 → Clean G5" in amber, since
      changing the blueprint starts again at grade 1.
    - **Experimental:** "+ Mass Manager" until applied.
    - **To move:** "move to Slot05" for a `refit` item.
  - A second, dim line for the current item only: the engineer, their rank with you, and the
    rolls left at the plan's rolls per grade. A rank under the target grade shows "rank 3: craft
    to raise". An engineer not unlocked shows what unlocking needs, from the item.
- **Footer:** the items done, the credits the buy items still need against `credits` from the
  journal (amber when short), and **materials**:
  - "Short:" the materials the open items still need and the journal does not have, most
    missing first, at most three.
  - For each, the trade from the plan that covers it, checked again against the inventory now
    with ed-mcp's `planTrades` (exported): "trade 18 Unusual Encrypted Files → 3 Datamined Wake
    (encoded)". A trade the inventory can no longer pay for drops out, and the material stays
    short.
  - All needs met: "Materials: all in hand".
- **Where next:** the route rows, from the plan's stops in visit order (`shop`, `trader`,
  `engineer`), with what each stop is for from its items ("FSD G5, PD G5"). Arriving copies the
  next stop's system, as for any plan. When a stop's items are all done, the panel marks the stop
  done and copies the next one (see Auto-advance).

### Upgrade of the current ship

The same panel with fewer items. The header says "UPGRADE" when the plan's `build.scope` is
`upgrade`:

```
UPGRADE · Krait Mk II · Jumper                          1/3 done
FSD 5A  Increased Range G5                   G3 100% → G5
  Felicity Farseer · rank 5 · ~9 rolls left
Power distributor 4A  Charge Enhanced G5               G1 → G5
Short: 4 Chemical Manipulators
  trade 24 Chemical Processors → 4 Chemical Manipulators (manufactured)
● Deciat · Farseer Inc                     here · engineer
```

### Purchases

A buy item is a module (or the hull) with its class, rating, price and where to buy it, which
Claude found with `spansh_find_stations` when making the plan. The panel does not search: prices
and stock change, and the station is on the plan's route. While docked at the stop, the panel
checks `Outfitting.json` (written when the outfitting screen opens) and shows "not sold here" in
amber when the module is missing, so the player can ask Claude for another station.

### No build plan

With no build plan for the ship, outfitting and engineering events show what changed this visit,
and nothing more:

```
OUTFITTING · Jameson Memorial                         this visit
Bought FSD 5A 5.1M · sold AFM Unit 2A 1.3M · stored 1
FSD 5A  Increased Range G4 → G5 100%                   7 rolls
Traded 2 · used 41 materials
Ask Claude to plan a build to track what is left.
```

- The visit runs from docking to undocking. The panel ends on undocking.
- Rows: modules bought, sold, stored, retrieved and swapped (`ModuleBuy` … `ModuleRetrieve`,
  `ModuleSwap`) with the credits; each module engineered with the grade before and after, the
  last quality and the rolls (`EngineerCraft`); and the material trades and materials spent.
- This costs nothing to keep, shows that the panel saw the work, and invites a plan. It is not
  a build tracker: with no target, the panel cannot say what is left.

### Suits and on-foot weapons (later PRs)

```
BUILD · Dominator loadout                               2/5 done
Dominator suit  G3 → G4         Pioneer Supplies · 2.25M
  2/2 Suit Schematic · 1/2 Health Monitor · 4/4 Motor
Karma L-6  G3 → G5 · Faster Handling               Pioneer Supplies
Karma L-6  + Magazine Size                   at Domino Green
Executioner  G5 ✓ · Greater Range ✓ · Noise Suppressor ✓
Short: 1 Health Monitor · 3 Weapon Schematic
```

- A plan for one suit loadout (`LoadoutID`): its suit and weapons. Items are:
  - **Grade** upgrades at Pioneer Supplies, with the credits and the resources for each step.
  - **Modifications** at an Odyssey engineer, with the resources and the engineer.
  - **Buying** a suit or weapon (with any mods it comes with).
- Grades come from the newest `SuitLoadout` / `SwitchSuitLoadout` / `CreateSuitLoadout` /
  `LoadoutEquipModule` (`SuitName` suffix, weapon `Class`), and from `UpgradeSuit` /
  `UpgradeWeapon`, which are newer when they follow. Mods come from the loadout events only.
  Since no event marks a mod, an item for a mod stays open until the next loadout event shows it
  (equip the loadout, or relog). The panel says "equip to check" after a visit to its engineer.
- "Have" comes from `ShipLocker.json` (Items, Components, Data), plus the backpack. On-foot
  resources have no material trader rates: the bartender trades (`TradeMicroResources`) are by
  the station's offer, so the panel shows only what is short.
- The panel shows the on-foot plan while on foot (`Status.json` flag on foot, or `Disembark`)
  and the ship plan in the ship; the newer event wins when both have work.

## When the mode turns on and ends

The mode is `build`. `hud.modes.build` turns it off.

| Source | Sets | Ends when |
|---|---|---|
| The activity note's `kind` `engineering` with a build plan | build | the plan has nothing left to do and the ship undocks |
| `EngineerCraft`, `ModuleBuy`, `ModuleSell`, `ModuleSellRemote`, `ModuleSwap`, `ModuleStore`, `ModuleRetrieve`, `FetchRemoteModule`, `MaterialTrade`, `TechnologyBroker`, `ShipyardBuy` | build | with a build plan for the ship: a newer activity. With no plan: undocking |
| Docking at a stop of the build plan (an engineer base, a shop, a trader) | build | a newer activity |
| `UpgradeSuit`, `UpgradeWeapon`, `BuySuit`, `BuyWeapon` (on-foot PRs) | build | as above |

- **Ranking.** Massacre still wins while a stack is open. Otherwise the newest choice wins, as
  for every mode. A scan, a prospect or a trade after the last build event takes over, and the
  next build event, or docking at a build stop, brings the build back. A jump alone never ends
  the build mode: a build means travelling between engineers. Under another mode, the plan's
  route rows still show the next build stop, dimmed, as now.
- **Plan only:** a build plan set by the note and no build event since shows the panel too: the
  player said "I'm engineering the Python".
- **Note kind.** The activity note already has `engineering`. `noteMode("engineering")` gives
  `build`. A note of kind `engineering` whose plan is not a build plan (no `build` field and no
  engineering items) shows the route only, as now.
- **Done.** When every item is done, the header says "Build complete" in green, until undocking.
  Then the mode ends, the panel says nothing more, and the note stays for Claude to clear.

## How progress is judged

The panel judges each item on each poll from the journal state, so a judgement is never stale.
The plan's item `status` is what was written; the panel's view is what is fitted now.

- **The ship.** A plan names its ship by `build.ship_id` (the journal `ShipID`), or by
  `build.ship` (the type) for a ship not bought yet. The fitted modules are the newest `Loadout`
  with that `ShipID`. Engineering after it (`EngineerCraft`, which has no `ShipID`) counts for
  the ship flown at the time: the `ShipID` of the newest `Loadout` or `ShipyardSwap` before it.
  With no `Loadout` for the ship in the journal's 14-day window, its items show "fly it to
  check" and nothing is marked.
- **Matching a slot.** An item names a slot (`Slot05_Size5`, `FrameShiftDrive`,
  `TinyHardpoint3`). Core slots are matched by slot. Internal, hardpoint and utility items match
  any slot of the right kind and size that holds the module, since players move modules about.
  Each fitted module counts for one item only. A `refit` item (a module to move) matches by slot.
- **`buy`:** done when the module is fitted (by normalised symbol). For the hull: when a
  `ShipyardNew` of the plan's ship type follows the plan's creation. The panel then writes the
  new `NewShipID` into the plan's `build.ship_id` (once), so later judging is by `ShipID`.
- **`engineer`:** done when the fitted module has the item's `BlueprintName` and a `Level` of at
  least its grade. In progress (written as `in_progress`) when it has the blueprint at a lower
  grade. A higher grade of the same blueprint counts as done. The quality shown is `Quality`
  from the newest `EngineerCraft` for the slot, else the `Loadout`. Quality does not decide done
  (see Open questions).
- **`experimental`:** done when the fitted module's `ExperimentalEffect` is the item's.
- **`unlock_engineer`:** done when `engineers` shows `Progress` `Unlocked` for that engineer.
- **`gather` and `trade`:** done when the inventory holds the item's materials (journal state
  `materials`). These are means, not ends: they finish when the materials are in hand, however
  they were got.
- **`refit`:** done when the slot holds the module.
- **Materials left.** For each engineer item still open, the materials for each grade above the
  fitted grade up to the target, times the plan's rolls for that grade, from the item's
  per-grade recipe; for the grade the module is at now, nothing more is counted (the player
  decides when the roll is good enough). Plus each open experimental's materials. Short is what
  that total needs beyond the inventory. The trades are worked out again with `planTrades` on
  the inventory now, so trades done already, or materials collected since, are counted.
- **Stored modules.** The newest `StoredModules` (and `ModuleStore`, `ModuleRetrieve`,
  `FetchRemoteModule`, `ModuleSellRemote` since) gives what is in storage and where. A stored
  module matching a buy item is shown instead of the price.

### Auto-advance

As `finishTradeStop()` does for trade stops, on each poll:

- An item the panel judges done, whose plan status is not `done`, is marked done through
  `PlanStore.updateItem()`, once per item and judgement key (plan ID, item ID, the `Loadout` or
  event it was judged from). The plan is read again first, and the write is skipped when the
  item changed, as for trade.
- An engineer item with the blueprint at a lower grade is marked `in_progress`.
- A stop whose items (the new stop `items` list) are all done or skipped is marked done, and the
  next stop's system is copied for the galaxy map with a note in the chat strip ("📋 FSD G5:
  done. Next stop copied: Shinrarta Dezhra"), as trade does. A stop with no `items` list is left
  to arrival and the route keys, as now.
- **Nothing is reopened by the panel.** When a module marked done is later swapped out or
  re-engineered, the panel shows the row again in amber ("not fitted now") and leaves the plan's
  status. Claude, or the player, decides whether the plan changed (see Open questions).
- Items the player marked `skipped` are left alone and not shown.

## Answers to the issue's questions

- **One build at a time, or one for each ship?** One for each ship, one active. Any number of
  build plans can exist, each for one ship (`build.ship_id`) or one suit loadout. The active one
  is the activity note's `plan_id`, as now. When the player swaps to a ship that has a build plan
  (`ShipyardSwap`, or a `Loadout` with another `ShipID`), and the note's plan is another ship's
  build, ED Chat sets the note's `plan_id` to that ship's plan through the `ActivityStore`, so
  the panel, the route rows and Claude agree. With no plan for the new ship, the note is left.
- **A ship with no build plan:** only what changed this visit (the outfitting view above), and
  only while docked. Nothing otherwise. The last line invites Claude to plan a build.
- **Does it use ed-mcp's plan storage?** Yes. The plan is the shared record: Claude writes it with
  `build_plan`, can read what the panel marked done, and re-plans when it is stale. The panel
  reads it each poll and writes only item and stop status, `build.ship_id` once after a hull
  purchase, and the note's `plan_id` on a ship swap.

## Part 1: ed-mcp

### Schema (all optional, so old files load)

- `PlanInputSchema` gains `build`:

  ```ts
  build: z.object({
    target: z.enum(["ship", "suit_loadout"]),
    scope: z.enum(["full", "upgrade"]),
    ship: z.string().optional(),          // journal ship type, e.g. "python_nx"
    ship_id: z.number().int().optional(), // journal ShipID; set after the hull is bought
    loadout_id: z.number().int().optional(), // on foot: SuitLoadout LoadoutID
    rolls_per_grade: z.array(z.number().int().min(0)).length(5).optional(),
  }).optional()
  ```

- `PlanItemSchema` gains the target, so an item can be judged:

  ```ts
  slot: z.string().optional(),          // journal slot name
  module: z.string().optional(),        // outfitting symbol, e.g. int_hyperdrive_size5_class5
  label: z.string().optional(),         // short: "FSD 5A"
  blueprint: z.string().optional(),     // journal BlueprintName, e.g. FSD_LongRange
  grade: z.number().int().min(1).max(5).optional(),
  experimental: z.string().optional(),  // journal key, e.g. special_fsd_heavy
  price: z.number().optional(),         // credits, for buy items
  count: z.number().int().positive().optional(), // modules sharing the item
  recipe: z.record(z.string(), z.array(MaterialSchema)).optional(), // per roll, by grade
  // on foot
  suit_id: z.number().int().optional(),
  weapon_id: z.number().int().optional(), // SuitModuleID
  modification: z.string().optional(),  // as suit_increasedammoreserves, weapon_range
  ```

  `materials` entries gain optional `symbol`, `kind`, `grade` and `trade_group`, so the panel
  can run `planTrades` without the catalog. `ItemKind` gains `upgrade` (an on-foot grade at
  Pioneer Supplies).
- `StopSchema` gains `items: string[]` (the item IDs done at the stop), as it has `missions`.

### Tools

- **`build_plan`** (new): from a target (SLEF, a plan's `target_build`, or `build_stats`-style
  `changes` on the current ship for an upgrade) and the ship now (the journal `Loadout`, or CAPI):
  - The slots that differ, as items: `buy` (with `spansh_find_stations`' best station and price),
    a retrieve when `StoredModules` has the module, `refit`, `engineer` and `experimental` (with
    the recipe per grade from the catalog, and the engineer from `catalog_engineers`, preferring
    one already unlocked with the rank), and `unlock_engineer` when no unlocked engineer can do
    it.
  - The materials, trades and traders, as `materials_plan` gives them, as `gather` and `trade`
    items.
  - The stops (shop, trader, engineer) with their `items`, ordered by `route_stops`.
  - `scope: "upgrade"` lists only the changed slots; `"full"` every slot of the target.
  - `save_to_plan` (default true) and `plan_id`; saving sets the activity note to `engineering`
    with the plan, as the trade tools do.
- `materials_plan` and `build_stats` are unchanged. Claude can still write a plan by hand: the
  panel judges any item with the target fields, and shows an item without them as text only.
- **On foot (later):** `build_plan` with `target: "suit_loadout"`, and `catalog_suit` /
  `catalog_weapon` for grades, upgrade costs and modifications.

### Journal state and kept events

- `KEPT_EVENTS` gains `StoredModules`, `StoredShips`, `ShipyardBuy`, `ShipyardNew`,
  `ModuleStore`, `ModuleRetrieve`, `FetchRemoteModule`, `ModuleSellRemote` (for `build_plan`'s
  stored modules). On foot, later: `SuitLoadout`, `SwitchSuitLoadout`, `CreateSuitLoadout`,
  `LoadoutEquipModule`, `UpgradeSuit`, `UpgradeWeapon`, `BuySuit`, `BuyWeapon`, `ShipLocker`.
- Journal state gains `stored_modules` (from the newest `StoredModules` and the moves since) and,
  later, `suits` and `locker` (read from `ShipLocker.json` as `Cargo.json` is read now).
- **Library exports** (`ed-mcp/journal`): `planTrades`, `matKey` and `tradeRate` (pure); the
  engineers' static data (system, base, planet), so the panel can name an engineer's base; and
  `normaliseModule()` for the symbol forms above.

### On-foot data

The catalog has no on-foot data. It needs, per suit and weapon: the grade upgrade costs (credits
and resources for each step), each modification's recipe, and which Odyssey engineers apply
which modification. The upgrade costs are fixed game data; the source and its licence must be
checked before any of it is committed or downloaded (see Open questions).

### Release

A minor version: new optional fields, a new tool, new exports. ED Chat pins it. The on-foot data
is a second minor version.

## Part 2: ED Chat

- **Settings:** `hud.modes.build` (default true), and `hud.build`:

  ```json
  "build": { "rows": 6, "outfittingVisit": true }
  ```

  `rows`: item rows before "+N more". `outfittingVisit`: the no-plan view.
- **Mode:** a rule in `journalMode` for the events above, with `buildActive` (the panel has items
  to show, or a visit to show) as `runActive` is for passengers. `noteMode("engineering")` →
  `build`.
- **`HUD_EVENTS`** gains `ModuleBuy`, `ModuleSell`, `ModuleSellRemote`, `ModuleSwap`,
  `ModuleStore`, `ModuleRetrieve`, `FetchRemoteModule`, `StoredModules`, `ShipyardBuy`,
  `ShipyardNew`, `Outfitting` (the event marks when `Outfitting.json` was written). ed-mcp
  already keeps `Loadout`, `EngineerCraft`, `MaterialTrade`, `Materials`, `EngineerProgress`,
  `TechnologyBroker` and `ShipyardSwap`; the panel lists them too, as mining does, and a test
  checks the reader keeps every event the panel reads.
- **`src/core/hud/build.ts`:** the judge (`buildState()`: the item, what is fitted, done or not),
  the materials left, the panel, the no-plan visit view, and `buildAdvance()` for the item and
  stop writes. `finishBuildItems()` in `src/main/index.ts`, beside `finishTradeStop()`.
- **Feed:** `Outfitting.json` while docked at a shop stop. `ShipLocker.json` comes from ed-mcp's
  journal state, as `Cargo.json` does.
- **Game note:** the panel's rows go to Claude with each message, as for the other modes, so
  "what's left on the Python?" needs no tool call.
- **Docs:** a Build section in `docs/activity-panel.md`; the mode in `docs/settings.md`.
- **Tests:** event sequences from real journals (scrubbed): a G1 to G5 roll sequence, a
  retrieve of an engineered module, a module moved between internal slots, a hull bought then
  built, a swap between two ships with plans, a trade that leaves a material short, and the
  no-plan visit.

## Order of work

1. **ed-mcp: schema, kept events, exports.** `build` and the item and stop fields,
   `stored_modules`, `planTrades` and the engineers in the library. No new tool yet. Release.
2. **ed-mcp: `build_plan`.** The diff, items, recipes, trades and stops, `save_to_plan`. Tested
   against SLEF from Coriolis and EDSY and real Loadouts. Release (or together with 1).
3. **ED Chat: ship build panel.** Pins the release. Mode rules, the panel, the judge,
   auto-advance and copy, the swap rule for the note. The upgrade header comes free.
4. **ED Chat: the no-plan outfitting visit.** Small, and needs no ed-mcp change; can go before 3.
5. **ed-mcp: on-foot.** The data source, `catalog_suit` / `catalog_weapon`, `suits` and
   `locker` in journal state, the kept events, `build_plan` for a suit loadout. Release.
6. **ED Chat: on-foot rows.** The suit loadout plan, the on-foot switch, the "equip to check"
   rule.

Each is its own PR.

## Known limits

- `EngineerCraft` has no `ShipID`; the ship is inferred from the newest `Loadout` or swap before
  it. A remote workshop craft is always for the ship flown, so this holds.
- The rolls left are an estimate from the plan's rolls per grade; a lucky roll finishes sooner.
- A pinned blueprint and the remote workshop are not in the journal, so the panel always points
  to the engineer's base.
- On foot, a modification shows only after the loadout is next written.
- Stored modules are known only from the newest `StoredModules` (outfitting opened) in the
  journal's 14-day window.

## Open questions

1. **On-foot data source.** Suit and weapon upgrade costs and modification recipes are not in
   coriolis-data or FDevIDs. Which source is acceptable to ship or download (for example a
   hand-made table from the game, or a community dataset whose licence allows it)? Until there
   is one, the on-foot part cannot start.
2. **When is a grade done?** Proposed: reaching the target grade, whatever the quality, since the
   player chooses when to stop rolling. Or should a plan be able to ask for a full roll (quality
   1, as an EDSY build at 100% says), so the item stays open until then?
3. **A done item that is no longer fitted.** Proposed: the panel shows it in amber and leaves the
   plan alone. Or should the panel reopen the item itself?
4. **The panel changing the note.** Proposed: on a ship swap, the panel sets the note's `plan_id`
   to that ship's build plan. Is it all right for the panel to change the note, which until now
   only Claude and the player set?
5. **On foot or in the ship.** With both an on-foot plan and a ship plan open, proposed: the
   on-foot plan while on foot, the ship plan in the ship. Or one plan at a time, whichever the
   note names?
