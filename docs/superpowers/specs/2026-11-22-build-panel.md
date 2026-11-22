# Activity panel: ship and on-foot builds

Date: 2026-11-22
Status: proposed. Issue #81, widened by its author's comment to take in purchases, full ship
builds, upgrades of the current ship (a subset of a full build), and suit and on-foot weapon
upgrades. Follows the activity HUD spec (2026-11-15) and the trade, passenger and mining spec
(2026-11-21).

## Purpose

A build takes many visits over days: modules to buy or take from storage, engineers to unlock
and visit, blueprints rolled grade by grade, materials gathered and traded. The player keeps the
list in Coriolis or EDSY, a notes file or their head, and works out the order of visits
themselves.

The panel leads with that order. A build is a route of stops, and at each stop a few things to
do: buy the FSD here, roll it to G5 there, trade for the firmware on the way. The panel shows
the stop you are at or going to, what to do there and what each action still needs, and the
stop after it. It sees each action happen in the journal, ticks it off, and when a stop is
finished copies the next system, as the trade panel does for its buy and sell stops.

## What already exists

**In ed-mcp (0.9.1):**

- **Plans with stops.** A plan has ordered stops (`system`, `station`, `kind` such as `shop`,
  `trader`, `engineer`, `purpose`, `label`, `status`), a route (`route_stops`), and for trade
  stops a `cargo` list of buy and sell actions that ED Chat judges from the journal. A plan also
  has `items` (`buy`, `engineer`, `experimental`, `unlock_engineer`, `gather`, `trade`,
  `refit`, with a description, engineer and materials) and a free-form `target_build`. Nothing
  writes items from a build: the assistant writes them by hand, and they have no order or place.
- **Builds.** `build_parse_slef` reads SLEF from Coriolis, EDSY or Inara into slots, modules,
  blueprints, grades, quality and experimentals. `build_stats` models a build from the journal
  `Loadout`, CAPI, SLEF or a plan's `target_build`, applies what-if `changes` and returns the
  changed build as SLEF.
- **Engineering data.** `catalog_blueprint` (materials per grade, experimentals),
  `catalog_engineers` (engineers for a blueprint, max grade, location, unlock requirements),
  `catalog_module` (symbol, class, rating). Blueprints and modules come from coriolis-data and
  FDevIDs at run time; `engineers.json` (committed) has each engineer's system, base and an
  `odyssey` flag.
- **Materials.** `materials_plan` gives the needs for blueprints at chosen rolls per grade,
  compares them with the inventory, plans trades at exact trader rates (`planTrades`), and finds
  the nearest trader of each type.
- **Shops.** `spansh_find_stations` finds stations selling a module or ship; `route_stops`
  orders shops, traders and engineers, with `after` for an engineer that needs a module first.
- **Journal state.** `materials` (kept up to date from every material event), `engineers`
  (Known, Invited, Unlocked, rank), `ship`, `credits` and the latest `Loadout`. `EngineerCraft`,
  `MaterialTrade`, `Materials`, `EngineerProgress`, `TechnologyBroker`, `Synthesis` and
  `ShipyardSwap` are kept.

**Not in ed-mcp:** stop actions other than trade cargo; any tool that turns a build into an
ordered route; the module events (`ModuleBuy`, `ModuleSell`, `ModuleSwap`, `ModuleStore`,
`ModuleRetrieve`, `StoredModules`, `FetchRemoteModule`) and shipyard purchases in the kept
events; anything on foot (journal state skips suits and has no ship locker).

**In ED Chat** (`origin/t3/trade-panel`): the trade panel judges each action of the current stop
(`actionDone()`), and `TradeStopFinisher` (`tradeStops.ts`) marks the stop done once, keyed by
plan, lap, stop and docking, after judging it again on the plan as it is now, then copies the
next stop's system. The build panel follows the same pattern with more kinds of action.

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

- **The plan is a route of actions.** A build plan is ordered stops, each with the actions to
  take there, as a trade stop has its cargo. The target build is where the route leads, not what
  the panel tracks. It is kept in `target_build` for Claude and shows on the panel as one summary
  line at most.
- **Claude plans, the panel follows.** ed-mcp's `build_plan` turns a target build (SLEF) or an
  upgrade request ("G5 my FSD and thrusters") into the route: which modules to buy where, which
  engineer rolls what, which trades make up the short materials, in a sensible visit order. The
  panel makes no assistant calls and no catalog downloads.
- **Each action carries its needs.** The materials and credits an action takes are written into
  it by ed-mcp (or by Claude for on-foot recipes), so the panel needs no recipe database: it
  compares the needs with the inventory in the journal.
- **The journal's actions decide.** An action is done when the journal shows it done: a
  `ModuleBuy`, an `EngineerCraft` at the grade, a `MaterialTrade`, an `UpgradeSuit`. The
  `Loadout` is a cross-check only: a done action whose module is no longer fitted shows amber.
- **The user's decisions.** An engineering action is done at the target grade, whatever the
  roll's quality. On a ship swap the panel may point the activity note at that ship's plan. A
  done action whose module is no longer fitted shows amber, and the plan is left alone.
- **Ship builds first; on foot in a later phase.** The current suit and weapon grades and
  modifications are in the journal (`SuitLoadout`, the source Inara uses), and the costs go
  into each action as data, so on foot is not blocked on a data source. It is later work only to
  keep the first PRs small.

## Actions

Every action has an `id`, a `kind`, a `label` ("Buy FSD 5A"), a `status` (`todo`, `done`,
`skipped`), optional `needs` (`materials` with name, symbol, kind, grade, trade group and count;
`credits`), and the fields its kind is judged by. An action is judged from the journal events
after the plan's `started_at` (written by `build_plan`; the plan's `created_at` when missing).

Module symbols are compared lower case, with `$`, `_name;` and `_free` taken off, since
`Loadout` gives `int_hyperdrive_size5_class5` and `ModuleBuy` gives
`$int_hyperdrive_size5_class5_name;`. "The ship" is the plan's `build.ship_id`; `EngineerCraft`
has no `ShipID`, so it counts for the ship of the newest `Loadout` or `ShipyardSwap` before it.

### At an outfitting station

| Kind | Example | Fields | Done when |
|---|---|---|---|
| `buy_module` | Buy FSD 5A | `module`, `slot`? | A `ModuleBuy` for the ship with that `BuyItem` (and `Slot`, if given) |
| `retrieve_module` | Retrieve stored Shield Booster (Heavy Duty G5) | `module`, `blueprint`?, `grade`? | A `ModuleRetrieve` for the ship with that `RetrievedItem` (and `EngineerModifications`, `Level` at least `grade`, if given) |
| `fetch_module` | Transfer stored Power Plant 6A here (15 min) | `module`, `storage_slot`? | A `FetchRemoteModule` with that `StoredItem` (or `StorageSlot`). A `retrieve_module` follows at the same stop once it arrives |
| `store_module` | Store Fuel Scoop 6A | `module` | A `ModuleStore` with that `StoredItem`, or a `ModuleBuy` or `ModuleRetrieve` that stored it as the old module (`StoredItem`, `SwapOutItem`) |
| `sell_module` | Sell AFM Unit 2A | `module` | A `ModuleSell` or `ModuleSellRemote` with that `SellItem`, or a `ModuleBuy` that sold it (`SellItem`) |
| `move_module` | Move Shield Cell Bank to Slot05 | `module`, `slot` | A `ModuleSwap` with that item and `ToSlot` (or `FromSlot`, for the item moved the other way) |
| `buy_ship` | Buy Python Mk II | `ship` | A `ShipyardBuy` with that `ShipType`; the next `ShipyardNew` gives the plan its `ship_id` |
| `swap_ship` | Take out the Python | `ship_id` | A `ShipyardSwap` (or `ShipyardBuy` / `ShipyardNew`) to that ship |
| `unlock_tech` | Unlock Guardian FSD Booster | `broker`, `item` | A `TechnologyBroker` whose `ItemsUnlocked` has that `Name` |

### At an engineer

| Kind | Example | Fields | Done when |
|---|---|---|---|
| `unlock_engineer` | Unlock Felicity Farseer (1 Meta-Alloy) | `engineer` | `engineers` shows that engineer `Unlocked` (from `EngineerProgress`) |
| `engineer` | Roll FSD Increased Range to G5 | `slot`, `module`?, `blueprint`, `grade`, `engineer`? | An `EngineerCraft` for the ship, that `Slot`, that `BlueprintName` and a `Level` at least `grade`. Any quality. Lower levels show the grade reached |
| `experimental` | Apply Mass Manager to FSD | `slot`, `experimental` | An `EngineerCraft` for the ship and slot with `ApplyExperimentalEffect` (or `ExperimentalEffect`) of that key |

An `engineer` action's `needs` is the materials for every grade it still has to roll at the
plan's rolls per grade, and `needs_by_grade` the same split by grade. Once the journal shows the
module at G3, the panel counts only the needs of G4 and G5.

### At a material trader, or anywhere

| Kind | Example | Fields | Done when |
|---|---|---|---|
| `trade_material` | Trade 6 Cracked Industrial Firmware → 2 Modified Embedded Firmware | `paid` (material, count), `received` (material, count) | `MaterialTrade` events with that `Received.Material` add up to the count |
| `collect_material` | Collect 12 Arsenic | `material`, `count` (to hold) | The inventory (`materials` in journal state) holds the count. Collection is spread over many events, so the count held decides |
| `synthesis` | Synthesise FSD Injection (premium) | `recipe` | A `Synthesis` with that `Name` |

A stop of kind `trader` holds trades. Collecting has no station: `build_plan` puts collect
actions at a stop of kind `gather` when it knows a place (a system with a known site, or a
mining or surface site in `notes`), and otherwise in the plan's `anywhere` list, which the panel
shows under the current stop ("Also: collect 12 Arsenic, 7/12"). An action at a later stop done
early still counts: the journal shows it, and the stop has one less thing to do.

### On foot (later phase)

| Kind | Example | Fields | Done when |
|---|---|---|---|
| `buy_suit` | Buy Dominator G3 | `suit` (name), `grade` | A `BuySuit` whose `Name` is that suit (its `_ClassN` suffix at least `grade`); its `SuitID` is written into later actions for it |
| `buy_weapon` | Buy Karma AR-50 G2 | `weapon`, `grade` | A `BuyWeapon` with that `Name` and `Class` at least `grade` |
| `upgrade_suit` | Upgrade Maverick to G3 | `suit_id`, `grade` | An `UpgradeSuit` for that `SuitID` with `Class` at least `grade` |
| `upgrade_weapon` | Upgrade Karma AR-50 to G4 | `weapon_id`, `grade` | An `UpgradeWeapon` for that `SuitModuleID` with `Class` at least `grade` |
| `modify_suit` | Apply Extra Ammo Capacity to Maverick | `suit_id`, `modification` | A loadout event (`SuitLoadout`, `SwitchSuitLoadout`, `CreateSuitLoadout`) for that `SuitID` whose `SuitMods` has it |
| `modify_weapon` | Apply Faster Handling to Karma AR-50 | `weapon_id`, `modification` | A loadout event, or `LoadoutEquipModule`, whose weapon with that `SuitModuleID` has it in `WeaponMods` |
| `trade_resource` | Trade for 4 Health Monitor (bartender) | `received`, `count` | `TradeMicroResources` with that `Received` add up to the count |
| `buy_resource` | Buy 10 Mineral Survey (bartender) | `resource`, `count` | `BuyMicroResources` with it add up to the count |
| `collect_resource` | Collect 3 Suit Schematic | `resource`, `count` (to hold) | The ship locker (`ShipLocker.json`, through ed-mcp's journal state) holds the count |

The game writes no event when an on-foot modification is applied. It shows in the next loadout
event, written when the loadout is equipped or at the next login. Until then a modify action
just done shows "equip to check" after a visit to its engineer. An upgrade or modification that
is already on the suit or weapon in the newest loadout event is done too: on foot the loadout is
the record, as it is for Inara.

### The Loadout as a cross-check

For a done `buy_module`, `retrieve_module`, `engineer` or `experimental`, the newest `Loadout` of
the ship should have the module (with that blueprint at that grade, or that experimental) in a
slot of the right kind and size. When it does not, the action's row shows amber, "not fitted
now", and the plan is left as it is. The panel never reopens an action.

## What the panel shows

### Ship build

```
BUILD · Python Mk II · stop 2/6                      7/19 actions
● Deciat · Farseer Inc                                 engineer
  ✓ Unlock Felicity Farseer
  ✓ Roll Power Distributor Charge Enhanced to G5
  Roll FSD Increased Range to G5                G3 → G5 · ~7 rolls
    short 3 Datamined Wake Exceptions (have 1/4)
  Apply Mass Manager to FSD                     ready
  Also: collect 12 Arsenic                      7/12
▸ Shinrarta Dezhra · Jameson Memorial       buy 2 · retrieve 1
4 stops after · 33.4M to spend · 1.2B held
Target: FSD G5 · PD G5 · shields Reinforced G5 · 8 boosters HD G5
```

- **Header:** BUILD, the ship (type, then its `ShipName` when the panel is wide enough), the
  current stop's place in the route, and the actions done out of all.
- **The current stop (●):** the plan's current stop in visit order, as the route rows have it,
  with its kind on the right and the jumps left on the plotted route when away from it. Then its
  actions in order:
  - Done ones with ✓, dim. More than three done ones fold into "✓ 3 done".
  - Ones to do, with their key need on the right or on a dim line below: the grade reached and
    rolls left for an engineer action ("G3 → G5 · ~7 rolls"), the price for a purchase, the
    first material short against the inventory ("short 3 Datamined Wake Exceptions (have 1/4)"),
    the credits short in amber, or "ready" when everything is in hand.
  - An action blocked by another one at the same stop (an experimental before its blueprint is
    rolled) shows after it, with no need line.
  - Amber "not fitted now" for a done action the `Loadout` no longer shows.
  - The plan's `anywhere` actions not yet done, as "Also:" lines, at most two.
- **The next stop (▸):** its place and a count of its actions by kind ("buy 2 · retrieve 1").
- **Footer:** the stops after it, the credits still to spend on open purchases against the
  credits held (amber when short), and at most one line of the target from the plan
  (`build.summary`, written by `build_plan`). Nothing else from the target is shown.
- **The route rows** are not repeated below: the panel is the route. The galaxy map copy works as
  it does for every plan.

### At an outfitting station

```
BUILD · Python Mk II · stop 3/6                      9/19 actions
● Shinrarta Dezhra · Jameson Memorial                  docked
  ✓ Buy FSD 5A                                         5.1M
  Retrieve stored Shield Booster (Heavy Duty G5)       here
  Transfer Power Plant 6A from Belach               ~25 min
  Buy Shield Generator 6A                            18.9M
    not sold here
  Sell AFM Unit 2A
▸ Deciat · Farseer Inc                   roll 2 · apply 1
3 stops after · 18.9M to spend · 1.2B held
```

- While docked at the stop, `Outfitting.json` (written when the outfitting screen opens) shows
  "not sold here" in amber for a module it does not list, so the player can ask Claude for
  another station. The panel does not search Spansh: `build_plan` chose the station.
- A retrieve shows "here" when the newest `StoredModules` has the module at this station, else
  the transfer time.

### At a material trader

```
BUILD · Python Mk II · stop 1/6                      0/19 actions
● Jotunheim · Gaspar de Lemos Ring            trader · encoded
  Trade 18 Unusual Encrypted Files → 3 Datamined Wake    ready
  Trade 6 Cracked Industrial Firmware → 2 Modified Embedded
    have 4/6 Cracked Industrial Firmware
▸ Deciat · Farseer Inc                   unlock 1 · roll 2 · apply 1
5 stops after
```

### Upgrade of the current ship

The same panel with a shorter route. The header says UPGRADE when the plan's `build.scope` is
`upgrade`:

```
UPGRADE · Krait Mk II · stop 1/2                      1/4 actions
● Deciat · Farseer Inc                                   2 jumps
  ✓ Roll FSD Increased Range to G3
  Roll FSD Increased Range to G5                G3 → G5 · ~9 rolls
    short 4 Chemical Manipulators
▸ Kuwemaki · Elvira Martuuk                 roll 1
Target: FSD G5 · thrusters Dirty G5
```

### Purchases only

A plan of purchases alone (a new hull and its modules, or a few modules to swap) is a route of
outfitting stops. A `buy_ship` stop first, then the outfitting stops. After the `ShipyardNew`,
the panel writes the new `ShipID` into the plan's `build.ship_id`, once.

### No build plan

With no build plan for the ship, outfitting and engineering events show what was done this
visit, and nothing more:

```
OUTFITTING · Jameson Memorial                         this visit
Bought FSD 5A 5.1M · sold AFM Unit 2A 1.3M · stored 1
FSD 5A  Increased Range G4 → G5                        7 rolls
Traded 2 · used 41 materials
Ask Claude to plan a build to track what is left.
```

The visit runs from docking to undocking, and the view ends on undocking. With no plan, the
panel cannot say what is left, so it says only what was done.

### On foot (later phase)

```
BUILD · Dominator loadout · stop 1/2                  2/6 actions
● Kuwemaki · Mitchell Ring · Pioneer Supplies           docked
  ✓ Upgrade Dominator to G3
  Upgrade Dominator to G4                             2.25M
    short 1 Health Monitor (have 1/2)
  Upgrade Karma AR-50 to G4                           ready
▸ Shinrarta Dezhra · Domino Green               apply 2
  Also: collect 3 Weapon Schematic                    0/3
Target: Dominator G5 · Karma AR-50 G5 · Extra Ammo · Faster Handling
```

- A plan for one suit loadout (`build.loadout_id`): its suit and weapons.
- The needs (credits and resources for each grade step, each modification's recipe) are written
  into each action by Claude, which can take them from Inara or from what the player tells it.
  The panel compares them with the ship locker and the backpack.
- Bartender trades are at the station's offer, not fixed rates, so the panel shows only what is
  short.
- On foot (`Status.json` on-foot flag, or after `Disembark`) the panel shows the on-foot plan;
  in the ship, the ship plan. The newer event wins when both have work.

## When the mode turns on and ends

The mode is `build`. `hud.modes.build` turns it off.

| Source | Sets | Ends when |
|---|---|---|
| The activity note's `kind` `engineering` with a build plan | build | every action is done or skipped, and the ship undocks |
| Docking at a stop of the build plan | build | a newer activity |
| An event that judges an action: `ModuleBuy`, `ModuleSell`, `ModuleSellRemote`, `ModuleSwap`, `ModuleStore`, `ModuleRetrieve`, `FetchRemoteModule`, `EngineerCraft`, `MaterialTrade`, `TechnologyBroker`, `ShipyardBuy`, `Synthesis` | build | with a build plan for the ship: a newer activity. With no plan: undocking |
| On foot (later): `BuySuit`, `BuyWeapon`, `UpgradeSuit`, `UpgradeWeapon`, `TradeMicroResources` | build | as above |

- **Ranking.** Massacre still wins while a stack is open. Otherwise the newest choice wins, as
  for every mode: a scan, a prospect or a trade after the last build event takes over, and
  docking at the next build stop brings the build back. A jump never ends it: a build means
  travelling between stops. Under another mode, the plan's route rows still show the next build
  stop, dimmed, as now.
- `noteMode("engineering")` gives `build`; the note kind exists already. A note of that kind
  whose plan has no stop actions shows the route rows only, as now.
- `MaterialCollected` and `Materials` change the counts but never turn the mode on: collecting
  happens during every other activity.
- **Done.** When every action is done, the header says "Build complete" in green until undocking.
  Then the mode ends. The note stays for Claude to clear.

## Auto-advance

As `TradeStopFinisher` does, after each poll (`BuildFinisher`, in `src/core/hud/buildStops.ts`):

- Each action the journal shows done, whose plan status is `todo`, is marked done through
  `PlanStore.updateAction()`, once per key (plan ID, action ID, and the event that did it). The
  plan is read again first and the action judged again on it; a changed plan or a failed write
  leaves it for the next poll.
- An engineer action with the blueprint at a lower grade stays `todo`, and its row shows the
  grade reached.
- When the current stop's actions are all done or skipped, the stop is marked done through
  `updateStop()`, and the next stop's system is copied for the galaxy map with a note in the chat
  strip ("📋 Deciat · Farseer Inc: done. Next stop copied: Shinrarta Dezhra"). A stop finished
  while not current (its actions all done early) is marked done quietly.
- After a `ShipyardNew` for a `buy_ship`, the plan's `build.ship_id` is written once.
- On a ship swap (`ShipyardSwap`, or a `Loadout` with another `ShipID`) to a ship with a build
  plan, when the note's plan is another ship's build, ED Chat sets the note's `plan_id` to that
  ship's plan through the `ActivityStore`, so the panel, the route rows and Claude agree.
- `routeNext` and `routePrev` still mark the current stop done or reopen the last one, for a
  stop the journal cannot judge.

## Answers to the issue's questions

- **One build at a time, or one for each ship?** One for each ship (and each suit loadout), one
  active: the activity note's `plan_id`. A ship swap points the note at the new ship's plan.
- **A ship with no build plan:** only what was done this visit, while docked. Nothing otherwise.
- **Does it use ed-mcp's plan storage?** Yes. The plan is the shared record: Claude writes it with
  `build_plan` and reads what the panel ticked off. The panel writes only action and stop status,
  `build.ship_id` once after a hull purchase, and the note's `plan_id` on a ship swap.

## Part 1: ed-mcp

### Schema (all optional, so old files load)

- `StopSchema` gains `actions`, beside trade's `cargo`:

  ```ts
  const Needs = z.object({
    materials: z.array(z.object({
      name: z.string().min(1),
      symbol: z.string().optional(),
      kind: z.string().optional(),          // Raw, Manufactured, Encoded; on foot Item, Component, Data
      grade: z.number().int().optional(),
      trade_group: z.string().optional(),
      count: z.number().int().positive(),
    })).optional(),
    credits: z.number().optional(),
  });

  const ActionSchema = z.object({
    id: z.string().min(1),
    kind: ActionKind,                       // the kinds in Actions above
    label: z.string().min(1),               // "Roll FSD Increased Range to G5"
    status: z.enum(["todo", "done", "skipped"]).default("todo"),
    needs: Needs.optional(),
    needs_by_grade: z.record(z.string(), Needs).optional(),
    // What it is judged by; each kind uses some.
    module: z.string().optional(), slot: z.string().optional(),
    storage_slot: z.number().int().optional(),
    blueprint: z.string().optional(), grade: z.number().int().min(1).max(5).optional(),
    experimental: z.string().optional(), engineer: z.string().optional(),
    ship: z.string().optional(), ship_id: z.number().int().optional(),
    broker: z.string().optional(), item: z.string().optional(), recipe: z.string().optional(),
    paid: z.object({ material: z.string(), count: z.number().int() }).optional(),
    received: z.object({ material: z.string(), count: z.number().int() }).optional(),
    material: z.string().optional(), count: z.number().int().optional(),
    suit: z.string().optional(), suit_id: z.number().int().optional(),
    weapon: z.string().optional(), weapon_id: z.number().int().optional(),
    modification: z.string().optional(), resource: z.string().optional(),
    notes: z.string().optional(),
  });
  ```

  `StopKind` gains `gather` and, for on foot, `pioneer` (Pioneer Supplies) and `bartender`.
- `PlanInputSchema` gains `build` and `anywhere`:

  ```ts
  build: z.object({
    target: z.enum(["ship", "suit_loadout"]),
    scope: z.enum(["full", "upgrade"]),
    ship: z.string().optional(),             // journal ship type
    ship_id: z.number().int().optional(),    // journal ShipID; set after a hull purchase
    loadout_id: z.number().int().optional(), // on foot: LoadoutID
    started_at: z.string().optional(),       // actions count from journal events after this
    summary: z.string().optional(),          // one line of the target
  }).optional(),
  anywhere: z.array(ActionSchema).optional(), // collect actions with no place
  ```

- `PlanStore.updateAction(planId, { stop, action }, patch)` and `setBuildShip(planId, shipId)`,
  in one locked write each, as `updateStop()` is. `plan_update_stop` gains an `action` to set an
  action's status, for Claude and the player.
- `items` stay for plans written by hand; `build_plan` no longer writes them. `target_build`
  stays as the SLEF of the target, for `build_stats`.

### `build_plan` (new tool)

From a target (SLEF, a plan's `target_build`, or `build_stats`-style `changes` on the current
ship for an upgrade) and the ship now (the journal `Loadout`, or CAPI), it writes the route:

1. **What changes:** the slots that differ. Modules to buy, to take from storage (from
   `StoredModules`: retrieve here, or fetch first), to store or sell, to move; blueprints to roll
   from the grade fitted now to the target, and experimentals. With `scope: "upgrade"`, only the
   slots asked for.
2. **Needs:** for each engineer action, the materials per grade from the catalog at the rolls per
   grade (default 1, 2, 3, 4, 5); for each experimental, its materials; for each purchase, the
   price from Spansh.
3. **Trades and collecting:** what the actions need beyond the inventory, as `materials_plan`
   works it out: trades at the nearest trader of each type (`trade_material` actions at a
   `trader` stop), and what no trade covers as `collect_material` actions (at a `gather` stop
   when a place is known, else in `anywhere`).
4. **Engineers:** for each blueprint, the engineer from `catalog_engineers`, preferring one
   unlocked with the rank; an `unlock_engineer` action first when none is.
5. **Order:** trades before the engineers that need them, purchases before the engineering of
   the module, an engineer's `after` its shops, then `route_stops` for the travel order. Each
   stop's actions in the order they must be done.
6. `save_to_plan` (default true) and `plan_id`; saving sets the activity note to `engineering`
   with the plan, as the trade tools do.

On foot (later): `build_plan` with `target: "suit_loadout"` turns the grades and modifications
asked for into upgrade and modify actions at Pioneer Supplies and Odyssey engineers. With no
catalog of costs, Claude passes each action's needs in the request, and the tool orders the
stops and checks the needs against the ship locker.

### Journal state, kept events, exports

- `KEPT_EVENTS` gains `StoredModules`, `ShipyardBuy`, `ShipyardNew`, `ModuleStore`,
  `ModuleRetrieve`, `FetchRemoteModule`, `ModuleSellRemote` (for `build_plan`'s stored
  modules). Journal state gains `stored_modules`.
- Later, on foot: `SuitLoadout`, `SwitchSuitLoadout`, `CreateSuitLoadout`, `LoadoutEquipModule`,
  `BuySuit`, `BuyWeapon`, `UpgradeSuit`, `UpgradeWeapon`, `ShipLocker`; journal state gains
  `suits` (each suit and weapon seen, with grade and mods) and `locker` (from `ShipLocker.json`,
  as `Cargo.json` is read now).
- Library exports (`ed-mcp/journal`): `normaliseModule()` for the symbol forms, and
  `planTrades` so the panel can say a trade is still possible from the inventory now.

### Release

A minor version for the ship part (new optional fields, a new tool, new exports), and another
for on foot. ED Chat pins each.

## Part 2: ED Chat

- **Settings:** `hud.modes.build` (default true), and `hud.build`:

  ```json
  "build": { "doneShown": 3, "outfittingVisit": true }
  ```

  `doneShown`: done actions listed at the current stop before they fold into "✓ N done".
  `outfittingVisit`: the no-plan view.
- **Mode:** a rule in `journalMode` for the events above, with `buildActive` (the plan has an
  action to do, or a visit to show) as `runActive` is for passengers. `noteMode("engineering")`
  gives `build`.
- **`HUD_EVENTS`** gains `ModuleBuy`, `ModuleSell`, `ModuleSellRemote`, `ModuleSwap`,
  `ModuleStore`, `ModuleRetrieve`, `FetchRemoteModule`, `StoredModules`, `ShipyardBuy`,
  `ShipyardNew`, `Outfitting`, and lists those ed-mcp keeps already (`EngineerCraft`,
  `MaterialTrade`, `Materials`, `EngineerProgress`, `TechnologyBroker`, `Synthesis`,
  `ShipyardSwap`, `Loadout`), as trade's `TRADE_EVENTS` does, with a test that the reader keeps
  every one.
- **`src/core/hud/build.ts`:** `actionDone()` for each kind, the needs against the inventory,
  the panel and the visit view. **`src/core/hud/buildStops.ts`:** `BuildFinisher`, wired in
  `src/main/index.ts` beside `TradeStopFinisher`.
- **Feed:** `Outfitting.json` while docked at an outfitting stop. The ship locker comes from
  ed-mcp's journal state.
- **Game note:** the panel's rows go to Claude with each message, so "what's next on the Python?"
  needs no tool call.
- **Docs:** a Build section in `docs/activity-panel.md`; the mode in `docs/settings.md`.
- **Tests:** event sequences from real journals (scrubbed): a G1 to G5 roll sequence with an
  experimental; a buy that sells the old module; a retrieve of an engineered module; a module
  moved between internal slots; trades that add up to the count; a hull bought then fitted; a
  swap between two ships with plans; an action done at a later stop first; a done action no
  longer fitted.

## Order of work

1. **ed-mcp: schema and store.** Stop `actions`, plan `build` and `anywhere`, `updateAction`,
   `setBuildShip`, `plan_update_stop` for actions, the kept events and `stored_modules`,
   `normaliseModule` and `planTrades` exports. Release.
2. **ED Chat: build panel for ship plans.** Pins the release. Mode rules, the panel, the judge,
   `BuildFinisher`, the ship-swap note rule. Usable at once with plans Claude writes with
   `plan_upsert`.
3. **ed-mcp: `build_plan`.** The diff, needs, trades, engineers and route, `save_to_plan`.
   Tested against SLEF from Coriolis and EDSY and real `Loadout` events. Release.
4. **ED Chat: the no-plan outfitting visit.** Needs no ed-mcp change; can go at any point.
5. **ed-mcp: on foot.** The on-foot action kinds' journal state (`suits`, `locker`), kept
   events, `build_plan` for a suit loadout with needs given by Claude. Release.
6. **ED Chat: on-foot actions.** Their judges, the on-foot or ship choice, "equip to check".

Each is its own PR.

## Known limits

- `EngineerCraft` has no `ShipID`; the ship is the one flown at the time. A remote workshop
  craft is always for the ship flown, so this holds.
- The rolls left are an estimate from the plan's rolls per grade; a lucky roll finishes sooner.
- A pinned blueprint and the remote workshop are not in the journal, so the panel always points
  to the engineer's base.
- On foot, a modification shows only when the loadout is next written.
- Actions are judged from the journal's 14-day window. An action done and marked stays done in
  the plan, so only an action done while ED Chat was not running and more than 14 days ago is
  missed; `routeNext` or Claude can mark it.
- On-foot needs are as good as what Claude writes: ed-mcp has no table to check them against.

## Open questions

1. **On or in the ship.** With an on-foot plan and a ship plan both open, proposed: the on-foot
   plan while on foot, the ship plan in the ship. Or only the plan the note names?
2. **Collect actions with no place.** Proposed: they go in the plan's `anywhere` list and show as
   "Also:" lines under every stop, and an engineer action short of them shows the shortfall. Or
   should `build_plan` always give them a stop (the nearest known site), so the route has a step
   for them?
3. **The no-plan visit view.** Proposed: show what was done this visit while docked, with a line
   inviting a plan. Or nothing at all without a plan?
4. **On-foot costs.** Claude writes each upgrade's and modification's needs, so on foot is not
   blocked. Should ed-mcp later get a small table of these costs to check them, or is Claude's
   figure, corrected by the player, enough?
