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
- **`MassModuleStore`**: `MarketID`, `Ship`, `ShipID`, `Items[]` with `Slot`, `Name`, `Hot`,
  `EngineerModifications`, `Level`, `Quality`: several modules stored in one transaction.
  **`ModuleBuyAndStore`**: `BuyItem`, `BuyPrice`, `MarketID`, `Ship`, `ShipID`: a module bought
  straight into storage. Both are in Frontier's journal documentation; neither occurs in the
  journals read for this spec, so their fields are as documented.
- **`ShipyardRedeem`** (a ship redeemed, such as a pre-order): `ShipType`, `MarketID`, followed
  by `ShipyardNew`. **`ShipyardTransfer`**: `ShipType`, `ShipID`, `System`, `ShipMarketID`,
  `Distance`, `TransferPrice`, `TransferTime`, `MarketID` (the station it is coming to).
- **`StoredModules`**: `MarketID`, `StationName`, `StarSystem`, `Items[]` with `Name`,
  `StorageSlot`, `StarSystem` and `MarketID` (where it is stored), `InTransit` while moving,
  `TransferCost`, `TransferTime` (seconds), `BuyPrice`, `Hot`, `EngineerModifications`,
  `Level`, `Quality`: every module in storage. In the journals read for this spec it was written
  1,798 times: 1,188 beside an `Outfitting` event (the outfitting screen opened), 608 right after
  a `ModuleStore`, `ModuleRetrieve`, `ModuleSellRemote` or `FetchRemoteModule`, and 2 at login.
  Wherever it is written, the newest one is the whole store, and its items' own `StarSystem` and
  `MarketID` say where each module is, whatever station the event names.
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
- **Collecting is a stop.** Materials that no trade covers are collected at a stop of their
  own, at the nearest known site, so the route has a step for every action. There are no
  actions without a place.
- **No plan, no tracking.** With no build plan for the ship, the panel shows only what was done
  this visit while docked, with a line inviting a plan.
- **Two plans open.** With an on-foot plan and a ship plan both open, the panel shows the plan
  that has work to do where the player is: docked at a stop of either plan (of any kind), that
  plan; otherwise the plan whose action was done most recently; else the plan the activity note
  names. Being on foot or in the ship does not choose: on-foot steps such as the bartender's
  material exchange can be done from the ship too, so an action is judged done from its journal
  event either way (`TradeMicroResources` and `BuyMicroResources` count on foot or in the ship).
  When the plan chosen is not the note's plan, the panel shows it and leaves the note to Claude;
  the one case where the panel changes the note is a ship swap (see Auto-advance).
- **On-foot costs come from Claude.** Claude writes each upgrade's and modification's needs
  into the action. ed-mcp gets no table of on-foot costs; the player corrects a wrong figure by
  telling Claude.
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
`$int_hyperdrive_size5_class5_name;`.

**The ship.** An event is for the plan's ship when its `ShipID` is the plan's `build.ship_id`.
`EngineerCraft` has no `ShipID`, so it counts for the ship of the newest `Loadout`,
`ShipyardSwap` or `ShipyardNew` before it. ed-mcp's journal state gives the current ship's
`id`, so Claude writes `ship_id` from the start for a ship the player owns (see Part 1).

A plan with no `ship_id` gets one in exactly one of two ways:

- **A plan with a `buy_ship` action never binds by type.** Its ship does not exist yet, so
  until then it matches no ship, even one of the same type (a ModuleBuy on the player's
  current Python never binds a plan for a second Python). It is chosen only by being the
  activity note's plan, or by the ship being docked at one of its stops. Its `buy_ship` is judged
  by `ShipyardBuy` (or `ShipyardRedeem`), and the next `ShipyardNew`'s `NewShipID` becomes
  `build.ship_id`. Module events and `EngineerCraft` after that `ShipyardNew` count for the new
  ship.
- **A plan with no `buy_ship` action binds by type** (a plan Claude wrote by hand without the
  `ShipID`): events match by `build.ship` (`Ship` in the module events and `Loadout`, `ShipType`
  in the shipyard events) for the ship being flown, and the first time an action is judged
  done that way the panel writes that `ShipID` into `build.ship_id`.

**One event, one action per role.** An event can do several things at once, and each is a
role: it finishes at most one action for each role it plays, the first open action in plan order
(stops in visit order, then actions in stop order) that the role matches. The roles are:

| Role | Played by |
|---|---|
| bought module | `ModuleBuy` (`BuyItem`), `ModuleBuyAndStore` (`BuyItem`) |
| sold module | `ModuleSell`, `ModuleSellRemote`, `ModuleBuy` (`SellItem`) |
| stored module | `ModuleStore` (`StoredItem`), each `MassModuleStore` item, `ModuleBuy` (`StoredItem`), `ModuleRetrieve` (`SwapOutItem`) |
| retrieved module | `ModuleRetrieve` (`RetrievedItem`) |
| fetched module | `FetchRemoteModule` (`StoredItem`) |
| moved module | `ModuleSwap`: one role for `FromItem`, one for `ToItem` |
| new ship | `ShipyardBuy` or `ShipyardRedeem` (`ShipType`) |
| swapped-to ship | `ShipyardSwap` (`ShipID`), `ShipyardNew` (`NewShipID`) |
| transferred ship | `ShipyardTransfer` (`ShipID`) |
| blueprint rolled | `EngineerCraft` (`BlueprintName`, `Level`) |
| experimental applied | `EngineerCraft` (`ApplyExperimentalEffect`) |
| material received | `MaterialTrade` (`Received`), `TradeMicroResources` (`Received`), `BuyMicroResources` (each item) |
| synthesised | `Synthesis` |
| unlocked tech | `TechnologyBroker` (each of `ItemsUnlocked`) |
| suit or weapon bought, upgraded | `BuySuit`, `BuyWeapon`, `UpgradeSuit`, `UpgradeWeapon` |

So a `ModuleBuy` that sells the old module can finish a `buy_module` and a `sell_module`, and a
`ShipyardBuy` plus its `ShipyardNew` can finish a `buy_ship` and a `swap_ship`. Within a role,
eight `buy_module` actions for the same shield booster need eight `ModuleBuy` events. Sums are
shared out the same way: a `MaterialTrade` that received 6 fills the first open trade action for
that material up to its count, and the rest goes to the next one.

**Which events an action used.** So that the share-out is the same on every poll, the panel
writes into each action it marks done the events it used (`done_by`). An event is named by its
`timestamp`, its `event` name and `n`, its place among the events with that name and that
timestamp in the journal (0 for the first): journal files are only appended to, so two events in
the same second keep their names. With the role and, for a sum, the amount taken, that names each
claim exactly. An action marked done with `done_by` keeps those events.

**An action marked done by hand** (by Claude, the player or a route key) has no `done_by`. When
the panel first sees it, it gives it the first unclaimed events that match it, at or before the
plan's `updated_at` at that moment (when it was marked, or later), and writes them as its
`done_by`, so the real event is not counted again for the next identical action. With no such
event it writes an empty `done_by`, and the action claims nothing. The events after `started_at`
not claimed by a done action are shared out to the open actions.

**Writing once.** The panel writes an action's status once, keyed by kind:

- **By event** (the purchases, moves and sales, `buy_ship`, `transfer_ship`, `swap_ship`, `unlock_tech`,
  `engineer`, `experimental`, `synthesis`, `buy_suit`, `buy_weapon`, `upgrade_suit`,
  `upgrade_weapon`): the key is the plan, the action and the event that did it.
- **By sum** (`trade_material`, `trade_resource`, `buy_resource`): written once, when the
  events shared to it first reach the count; the key is the plan, the action and the last event.
- **By state** (`collect_material`, `collect_resource`, `unlock_engineer`, `modify_suit`,
  `modify_weapon`): written once, when the state (the inventory, the engineer's progress, the
  newest loadout event) first meets the target; the key is the plan and the action. Spending the
  materials afterwards does not reopen it.

### At an outfitting station

| Kind | Example | Fields | Done when |
|---|---|---|---|
| `buy_module` | Buy FSD 5A | `module`, `slot`? | A `ModuleBuy` for the ship with that `BuyItem` (and `Slot`, if given). With no `slot`, a `ModuleBuyAndStore` of it counts too: the module is then in storage, and a `retrieve_module` fits it |
| `retrieve_module` | Retrieve stored Shield Booster (Heavy Duty G5) | `module`, `blueprint`?, `grade`? | A `ModuleRetrieve` for the ship with that `RetrievedItem` (and `EngineerModifications`, `Level` at least `grade`, if given) |
| `fetch_module` | Transfer stored Power Plant 6A here (15 min) | `module`, `storage_slot`? | A `FetchRemoteModule` with that `StoredItem` (or `StorageSlot`). A `retrieve_module` follows at the same stop once it arrives |
| `store_module` | Store Fuel Scoop 6A | `module` | A `ModuleStore` with that `StoredItem`; a `MassModuleStore` item with that `Name` (each item counts for one action); or a `ModuleBuy` or `ModuleRetrieve` that stored it as the old module (`StoredItem`, `SwapOutItem`) |
| `sell_module` | Sell AFM Unit 2A | `module` | A `ModuleSell` or `ModuleSellRemote` with that `SellItem`, or a `ModuleBuy` that sold it (`SellItem`) |
| `move_module` | Move Shield Cell Bank to Slot05 | `module`, `slot` | A `ModuleSwap` with that item and `ToSlot` (or `FromSlot`, for the item moved the other way) |
| `buy_ship` | Buy Python Mk II | `ship` | A `ShipyardBuy` (or `ShipyardRedeem`) with that `ShipType`; the next `ShipyardNew` gives the plan its `ship_id` |
| `transfer_ship` | Transfer the Python here (40 min) | `ship_id` | A `ShipyardTransfer` of that `ShipID` |
| `swap_ship` | Take out the Python | `ship_id` | A `ShipyardSwap` (or `ShipyardBuy` / `ShipyardNew`) to that ship |
| `unlock_tech` | Unlock Guardian FSD Booster | `broker`, `item` | A `TechnologyBroker` whose `ItemsUnlocked` has that `Name` |

### At an engineer

| Kind | Example | Fields | Done when |
|---|---|---|---|
| `unlock_engineer` | Unlock Felicity Farseer (1 Meta-Alloy) | `engineer` | `engineers` shows that engineer `Unlocked` (from `EngineerProgress`) |
| `engineer` | Roll FSD Increased Range to G5 | `slot`, `module`?, `blueprint`, `grade`, `engineer`? | An `EngineerCraft` for the ship, that `Slot`, that `BlueprintName` and a `Level` at least `grade`. Any quality. Lower levels show the grade and quality reached |
| `experimental` | Apply Mass Manager to FSD | `slot`, `experimental` | An `EngineerCraft` for the ship and slot with `ApplyExperimentalEffect` (or `ExperimentalEffect`) of that key |

An `engineer` action's `needs` is the materials for every grade it still has to roll at the
plan's rolls per grade (`build.rolls_per_grade`; 1, 2, 3, 4, 5 for grades 1 to 5 when
missing, as `materials_plan` has it), and `needs_by_grade` gives one roll's
materials for each grade. The game opens the next grade only when the current one is full
(`Quality` 1), so what is left counts both:

- At grade G with quality q below 1: the rolls to fill G, estimated as the plan's rolls for G
  times (1 - q), rounded up; then the plan's rolls for each grade above G up to the one below
  the target; then one roll of the target grade, which finishes the action at any quality.
- At grade G with quality 1: no more rolls of G.
- A module with no blueprint yet, or with another blueprint, starts again: the rolls are counted
  from G1 at quality 0, since the game starts a new blueprint at grade 1.
- The panel uses the same default as the plan: 1, 2, 3, 4, 5 rolls for grades 1 to 5 when
  `build.rolls_per_grade` is missing.
- The materials left are those rolls times each grade's one-roll materials. The row shows the
  grade and quality reached: "G3 64% → G5 · ~7 rolls" (2 to fill G3, 4 for G4, 1 for G5 at rolls 1, 2, 3, 4, 5).

### At a material trader, or anywhere

| Kind | Example | Fields | Done when |
|---|---|---|---|
| `trade_material` | Trade 6 Cracked Industrial Firmware → 2 Modified Embedded Firmware | `paid` (material, count), `received` (material, count) | `MaterialTrade` events with that `Received.Material` add up to the count |
| `collect_material` | Collect 12 Arsenic | `material`, `count` (to hold) | The inventory (`materials` in journal state) holds the count. Collection is spread over many events, so the count held decides |
| `synthesis` | Synthesise FSD Injection (premium) | `recipe` | A `Synthesis` with that `Name` |

A stop of kind `trader` holds trades. Collect actions always have a stop of their own, of kind
`gather`, at the nearest known site for the material: a system and body, with the site (a
crystalline shard field, a mining hotspot, a settlement type to raid) in the stop's `notes`.
`build_plan` (or Claude) chooses the site and puts the stop before the stops whose actions need
the material. An engineer or trade action short of a material that a collect stop provides
names that stop ("collect at stop 2"). An action at a later stop done
early still counts: the journal shows it, and the stop has one less thing to do.

### On foot (later phase)

| Kind | Example | Fields | Done when |
|---|---|---|---|
| `buy_suit` | Buy Dominator G3 | `suit` (name), `grade`, `gear` | A `BuySuit` whose `Name` is that suit (its `_ClassN` suffix at least `grade`); the panel writes its `SuitID` as `suit_id` into every action with the same `gear` |
| `buy_weapon` | Buy Karma AR-50 G2 | `weapon`, `grade`, `gear` | A `BuyWeapon` with that `Name` and `Class` at least `grade`; the panel writes its `SuitModuleID` as `weapon_id` into every action with the same `gear` |
| `upgrade_suit` | Upgrade Maverick to G3 | `suit_id`, `grade` | An `UpgradeSuit` for that `SuitID` with `Class` at least `grade` |
| `upgrade_weapon` | Upgrade Karma AR-50 to G4 | `weapon_id`, `grade` | An `UpgradeWeapon` for that `SuitModuleID` with `Class` at least `grade` |
| `modify_suit` | Apply Extra Ammo Capacity to Maverick | `suit_id`, `modification` | A loadout event (`SuitLoadout`, `SwitchSuitLoadout`, `CreateSuitLoadout`) for that `SuitID` whose `SuitMods` has it |
| `modify_weapon` | Apply Faster Handling to Karma AR-50 | `weapon_id`, `modification` | A loadout event, or `LoadoutEquipModule`, whose weapon with that `SuitModuleID` has it in `WeaponMods` |
| `trade_resource` | Trade for 4 Health Monitor (bartender) | `received` (material, count) | `TradeMicroResources` events whose `Received` is that material add up (by their `Count`) to `received.count` |
| `buy_resource` | Buy 10 Mineral Survey (bartender) | `resource`, `count` | `BuyMicroResources` with it add up to the count |
| `collect_resource` | Collect 3 Suit Schematic | `resource`, `count` (to hold) | The ship locker and the backpack together (ed-mcp's journal state `locker` and `backpack`) hold the count |

**Gear keys.** A suit or weapon not bought yet has no ID, so `build_plan` (or Claude) gives
its buy and every later upgrade or modification of it the same plan-local `gear` key, such as
`dominator-1`. An upgrade or modify action with a `gear` and no ID yet waits; when the buy is
done, the ID is written into every action with that key. Gear the player owns already gets its
`suit_id` or `weapon_id` from the start, from journal state `suits`.

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

The examples below are moments of one route: six stops, sixteen actions.

| Stop | Place | Actions |
|---|---|---|
| 1 | Jotunheim · Gaspar de Lemos Ring (encoded trader) | 2 trades |
| 2 | HIP 36601 · C 3 b (collect) | collect 12 Arsenic |
| 3 | Deciat · Farseer Inc | unlock Farseer, roll PD to G5, roll FSD to G5, apply Mass Manager |
| 4 | Shinrarta Dezhra · Jameson Memorial | buy Shield Booster 0A (0.3M), retrieve stored Shield Booster, transfer Power Plant (0.1M), buy Shield Generator 6A (18.9M), sell AFM Unit |
| 5 | Kuwemaki · Elvira Martuuk | roll thrusters Dirty Drives to G5, roll shield generator Reinforced to G5 |
| 6 | Laksak · Didi Vatermann | roll 2 Shield Boosters Heavy Duty to G5 |

Credits to spend are the open purchases and transfers: 19.3M until the 0A booster is bought.

```
BUILD · Python Mk II · stop 3/6                      4/16 actions
● Deciat · Farseer Inc                        engineer · docked
  ✓ Unlock Felicity Farseer
  ✓ Roll Power Distributor Charge Enhanced to G5
  Roll FSD Increased Range to G5            G3 64% → G5 · ~7 rolls
    short 5 Arsenic (have 7/12) · collect at stop 2
  Apply Mass Manager to FSD                     after FSD G5
▸ Shinrarta Dezhra · Jameson Memorial
    buy 2 · retrieve 1 · transfer 1 · sell 1
1 open before · 3 after · 19.3M to spend · 1.2B held
Target: FSD G5 · PD G5 · shields Reinforced G5 · boosters HD G5
```

Here the player docked at Farseer before collecting the Arsenic, so stop 3 is current (docked,
with work to do) and stop 2 is still open before it.

- **Header:** BUILD, the ship (type, then its `ShipName` when the panel is wide enough), the
  current stop's place in the route, and the actions done out of all.
- **The current stop (●):** the plan stop the ship is docked at (or landed at, for a collect
  stop) while it has actions to do; otherwise `currentStop()`, the first stop to do in visit
  order, as the route rows and keys have it on `origin/t3/trade-panel`. So the panel's current
  stop differs from `currentStop()` only while docked at a later stop with work to do, and then
  the footer says how many stops before it are still open. Its kind is on the right, with the jumps left on the plotted route when away
  from it. Then its actions in order:
  - Done ones with ✓, dim. More than three done ones fold into "✓ 3 done".
  - Ones to do, with their key need on the right or on a dim line below: the grade reached and
    quality and rolls left for an engineer action ("G3 64% → G5 · ~7 rolls"), the price for a purchase, the
    first material short against the inventory, with the stop that collects or trades for it
    ("short 5 Arsenic (have 7/12) · collect at stop 2"), the credits short in amber, or "ready"
    when everything is in hand.
  - An action blocked by another one at the same stop (an experimental before its blueprint is
    rolled) shows after it, with "after <the action>" in place of a need ("after FSD G5").
  - Amber "not fitted now" for a done action the `Loadout` no longer shows.
- **The next stop (▸):** its place and a count of every kind of action still to do there, in
  the stop's order ("buy 2 · retrieve 1 · transfer 1 · sell 1"), on a second line when it does
  not fit beside the place. No kind is left out.
- **Footer:** the stops still open before the current one ("1 open before", only when the player
  came here early) and the stops after it, the next one included ("3 after"),
  the credits still to spend on open purchases against the credits held (amber when short), and
  at most one line of the target from the plan (`build.summary`, written by `build_plan`).
  Nothing else from the target is shown. The credits held are `Balance` from `Status.json`,
  which the feed already polls: ed-mcp's journal `credits` changes only at `LoadGame`.
- **The route rows** are not repeated below: the panel is the route. The galaxy map copy works as
  it does for every plan.
- **The plan shown leads everything.** When the panel shows a plan that is not the note's (see
  Two plans open), the route rows under other modes, the arrival copy and the `routeNext` /
  `routePrev` keys all follow the plan shown, not the note's. The game note sent to Claude has
  the panel's rows, so it is about the plan shown, and when that is not the note's plan it adds
  one line: "Showing build plan <id> (docked at its stop); the activity note names <id>." Claude
  then knows which plan the player is working on without the note being changed.

### At an outfitting station

```
BUILD · Python Mk II · stop 4/6                      8/16 actions
● Shinrarta Dezhra · Jameson Memorial                  docked
  ✓ Buy Shield Booster 0A                              0.3M
  Retrieve stored Shield Booster (Heavy Duty G5)       here
  Transfer Power Plant 6A from Belach        0.1M · ~25 min
  Buy Shield Generator 6A                            18.9M
    not sold here
  Sell AFM Unit 2A
▸ Kuwemaki · Elvira Martuuk                         roll 2
2 after · 19.0M to spend · 1.2B held
```

- While docked at the stop, `Outfitting.json` (written when the outfitting screen opens) shows
  "not sold here" in amber for a module it does not list, so the player can ask Claude for
  another station. The file is used only when its `MarketID` is the docked station's and its
  `timestamp` is after this docking; an older file, or one for another station, shows nothing. The panel does not search Spansh: `build_plan` chose the station.
- A retrieve shows "here" when `stored_modules` has the module with this station's `MarketID`,
  else the transfer time. A `StoredModules` written at login counts like any other: each item
  says where it is.

### At a material trader

```
BUILD · Python Mk II · stop 1/6                      0/16 actions
● Jotunheim · Gaspar de Lemos Ring            trader · encoded
  Trade 18 Unusual Encrypted Files → 3 Datamined Wake    ready
  Trade 6 Cracked Industrial Firmware → 2 Modified Embedded
    have 4/6 Cracked Industrial Firmware
▸ HIP 36601 · C 3 b                                  collect 1
5 after · 19.3M to spend · 1.2B held
```

### At a collect stop

```
BUILD · Python Mk II · stop 2/6                      2/16 actions
● HIP 36601 · C 3 b                                     collect
  Collect 12 Arsenic                                      7/12
    Outcrop field near 12.4, -60.1 · mine with SRV
▸ Deciat · Farseer Inc              unlock 1 · roll 2 · apply 1
4 after · 19.3M to spend · 1.2B held
```

- The count held against the count to hold, from journal state `materials` (the ship locker on
  foot). The stop's `notes` say where on the body and how.
- The stop is done when every collect action holds its count, wherever the material came from.

### Upgrade of the current ship

The same panel with a shorter route. The header says UPGRADE when the plan's `build.scope` is
`upgrade`. Here the route is three stops and four actions: a trade at a material trader (stop 1,
not done yet, since the player went to the engineer first), the unlock and the FSD at Farseer
(stop 2), and the thrusters at Martuuk (stop 3). The player is docked at Farseer with work to do
there, so stop 2 is current although stop 1 is the first stop to do:

```
UPGRADE · Krait Mk II · stop 2/3                      1/4 actions
● Deciat · Farseer Inc                        engineer · docked
  ✓ Unlock Felicity Farseer
  Roll FSD Increased Range to G5          G3 100% → G5 · ~5 rolls
    short 4 Chemical Manipulators · trade at stop 1
▸ Kuwemaki · Elvira Martuuk                               roll 1
1 stop open before · 1 after
Target: FSD G5 · thrusters Dirty G5
```

### Purchases only

A plan of purchases alone (a new hull and its modules, or a few modules to swap) is a route of
outfitting stops. A `buy_ship` stop first, then the outfitting stops. Until the hull exists the
plan is followed as the note's plan, or while docked at one of its stops (see "A ship not bought
yet"). After the `ShipyardNew`, the panel writes the new `ShipID` into the plan's
`build.ship_id`, once.

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
BUILD · Dominator loadout · stop 1/3                  1/6 actions
● Kuwemaki · Mitchell Ring · Pioneer Supplies           docked
  ✓ Upgrade Dominator to G3
  Upgrade Dominator to G4                             2.25M
    short 1 Health Monitor (have 1/2) · trade at stop 2
  Upgrade Karma AR-50 to G4                    1.5M · ready
▸ Kuwemaki · Mitchell Ring · bartender                 trade 1
2 after · 3.75M to spend · 1.2B held
Target: Dominator G5 · Karma AR-50 G5 · Extra Ammo · Faster Handling
```

- A plan for one suit loadout (`build.loadout_id`): its suit and weapons. Here three stops and
  six actions: three upgrades at Pioneer Supplies (stop 1), a trade at the bartender (stop 2),
  and two modifications at Domino Green (stop 3).
- The needs (credits and resources for each grade step, each modification's recipe) are written
  into each action by Claude, which can take them from Inara or from what the player tells it.
  The panel compares them with the ship locker and the backpack. ed-mcp has no table of on-foot
  costs to check them against; a wrong figure is corrected by telling Claude.
- Bartender trades are at the station's offer, not fixed rates, so the panel shows only what is
  short.
- With a ship plan open too, the panel shows the plan of the stop the ship is docked at, else the
  plan with the newest done action, else the note's plan (see Decisions). Whether the player is
  on foot or in the ship does not matter, to the choice or to judging an action.
- In the journals read for this spec (2021 to November 2026), every `TradeMicroResources` (71),
  `BuyMicroResources` (50), `SellMicroResources` (79), `BuySuit`, `BuyWeapon`, `UpgradeSuit` and
  `UpgradeWeapon` came after a `Disembark`, so on foot; `TransferMicroResources` came both on
  foot and in the ship. None of these events records where the player was, so the judges must
  not look at it: an exchange done from the ship menus is the same event.

## When the mode turns on and ends

The mode is `build`. `hud.modes.build` turns it off.

| Source | Sets | Ends when |
|---|---|---|
| The activity note's `kind` `engineering` with a build plan | build | every action is done or skipped, and the ship undocks |
| Docking at a stop of the build plan | build | a newer activity |
| An event that matches an open action of the plan: `ModuleBuy`, `ModuleBuyAndStore`, `ModuleSell`, `ModuleSellRemote`, `ModuleSwap`, `ModuleStore`, `MassModuleStore`, `ModuleRetrieve`, `FetchRemoteModule`, `EngineerCraft`, `MaterialTrade`, `TechnologyBroker`, `ShipyardBuy`, `ShipyardRedeem`, `ShipyardNew`, `ShipyardTransfer`, `ShipyardSwap`, `Synthesis` | build | a newer activity |
| `EngineerProgress` for one engineer (not the list at login) that unlocks the engineer of an open `unlock_engineer` action | build | as above |
| On foot (later): a `BuySuit`, `BuyWeapon`, `UpgradeSuit`, `UpgradeWeapon`, `TradeMicroResources` or `BuyMicroResources` that matches an open action; a `SwitchSuitLoadout`, `CreateSuitLoadout` or `LoadoutEquipModule` that completes an open modify action | build | as above |
| No build plan for the ship: a module event or `EngineerCraft` while docked (the visit view) | build | undocking |

- **Ranking.** Massacre still wins while a stack is open. Otherwise the newest choice wins, as
  for every mode: a scan, a prospect or a trade after the last build event takes over, and
  docking at the next build stop brings the build back. A jump never ends it: a build means
  travelling between stops. Under another mode, the plan's route rows still show the next build
  stop, dimmed, as now.
- `noteMode("engineering")` gives `build`; the note kind exists already. A note of that kind
  whose plan has no stop actions shows the route rows only, as now.
- **Only a matching event.** With a plan open, an event turns the mode on only when it matches an
  open action of the plan (the same match the judge uses), not because of its kind. Players
  synthesise ammunition, chaff and FSD injections and trade materials all the time: a
  `Synthesis` or `MaterialTrade` the plan does not ask for changes nothing. With no plan,
  `Synthesis` and `MaterialTrade` never turn the visit view on; only module events and
  `EngineerCraft` while docked do.
- `MaterialCollected` and `Materials` change the counts but never turn the mode on: collecting
  happens during every other activity. Nor do the events written at every login
  (`EngineerProgress` with its list, `SuitLoadout`, `Loadout`), and a `ShipyardSwap` turns it on
  only when it judges a `swap_ship` action or the new ship has a build plan.
- **Done.** When every action is done, the header says "Build complete" in green until undocking.
  Then the mode ends. The note stays for Claude to clear.

## Auto-advance

As `TradeStopFinisher` does, after each poll (`BuildFinisher`, in `src/core/hud/buildStops.ts`):

- Each action the journal shows done, whose plan status is `todo`, is marked done through
  `PlanStore.updateAction()`, with its `done_by`, once per key (see "Writing once"). The plan is
  read again first and the action judged again on it; a changed plan or a failed write leaves it
  for the next poll.
- An engineer action with the blueprint at a lower grade stays `todo`, and its row shows the
  grade and quality reached.
- **A stop is marked done only on the change.** When the panel marks a stop's last open action
  done, or sees it become done (Claude marked it), the stop is marked done through
  `updateStop()` in the same step, and the next stop's system is copied for the galaxy map with a
  note in the chat strip ("📋 Deciat · Farseer Inc: done. Next stop copied: Shinrarta Dezhra").
  A stop finished while not current (its actions all done early) is marked done quietly. A stop
  whose actions were all done already is not marked again, so a stop reopened with `routePrev`
  stays open until `routeNext`. The first poll after ED Chat starts only notes which stops have
  open actions, and marks nothing.
- A stop with no actions is never marked done by the panel: only `routeNext` marks it.
- After a `ShipyardNew` for a `buy_ship`, the plan's `build.ship_id` is written once
  (`setBuildShip()`). After a `BuySuit` or `BuyWeapon`, its `SuitID` or `SuitModuleID` is written
  into every action with the same `gear` key (`updateAction()` with `suit_id` or `weapon_id`),
  once.
- On a ship swap (`ShipyardSwap`, or a `Loadout` with another `ShipID`) to a ship with a build
  plan, when the note's plan is another ship's build, ED Chat sets the note's `plan_id` to that
  ship's plan through the `ActivityStore`, so the panel, the route rows and Claude agree. This is
  the only time the panel changes the note: when it shows another plan for any other reason
  (docked at its stop, its newest done action), the note is left to Claude.
- `routeNext` and `routePrev` act on the stop the panel shows as current (the docked one, when it
  differs from `currentStop()`), so the key marks what the player sees. They still mark the
  current stop done or reopen the last one, for a
  stop the journal cannot judge.

## Answers to the issue's questions

- **One build at a time, or one for each ship?** One for each ship (and each suit loadout), one
  active: the activity note's `plan_id`. A ship swap points the note at the new ship's plan.
- **A ship with no build plan:** only what was done this visit, while docked. Nothing otherwise.
- **Does it use ed-mcp's plan storage?** Yes. The plan is the shared record: Claude writes it with
  `build_plan` and reads what the panel ticked off. The panel writes only action and stop status
  (with each action's `done_by`), `build.ship_id` once (after a hull purchase, or the first
  action judged by ship type), a new suit's `SuitID` or weapon's `SuitModuleID` into the actions
  for it, and the note's `plan_id` on a ship swap.

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
    // The events the panel counted for it. An event is its timestamp, name and n, its place
    // among the events of that name and timestamp; role and amount say what it was used for.
    done_by: z.array(z.object({
      at: z.string(), event: z.string(), n: z.number().int().min(0),
      role: z.string(), amount: z.number().int().optional(),
    })).optional(),
    // On foot: a plan-local key shared by a buy and the later actions for that suit or weapon.
    gear: z.string().optional(),
    needs: Needs.optional(),
    // One roll's materials for each grade, for an engineer action.
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
- `PlanInputSchema` gains `build`:

  ```ts
  build: z.object({
    target: z.enum(["ship", "suit_loadout"]),
    scope: z.enum(["full", "upgrade"]),
    ship: z.string().optional(),             // journal ship type
    ship_id: z.number().int().optional(),    // journal ShipID; set after a hull purchase
    loadout_id: z.number().int().optional(), // on foot: LoadoutID
    started_at: z.string().optional(),       // actions count from journal events after this
    summary: z.string().optional(),          // one line of the target
    // Rolls for grades 1-5, for the needs and the rolls left; [1, 2, 3, 4, 5] when missing.
    rolls_per_grade: z.array(z.number().int().min(0)).length(5).optional(),
  }).optional(),
  ```

- `PlanStore.updateAction(planId, { stop, action }, patch)`, where the patch can set `status`,
  `done_by`, `suit_id` and `weapon_id`, and `setBuildShip(planId, shipId)`, in one locked write
  each, as `updateStop()` is. `plan_update_stop` gains an `action` to set an
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
2. **Needs:** for each engineer action, one roll's materials for each grade from the catalog
   (`needs_by_grade`), and the total for the grades it still has to roll (`needs`) at the rolls
   per grade (an argument, default 1, 2, 3, 4, 5, saved as `build.rolls_per_grade`); for each
   experimental, its materials; for each purchase, the price from Spansh.
3. **Trades and collecting:** what the actions need beyond the inventory, as `materials_plan`
   works it out: trades at the nearest trader of each type (`trade_material` actions at a
   `trader` stop), and what no trade covers as `collect_material` actions at a `gather` stop of
   their own, at the nearest known site, placed before the stops that need the material.
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

- Journal state's `ship` gains `id` (the `ShipID` of the newest `Loadout`, `ShipyardSwap` or
  `ShipyardNew`); it has `name` and `ident` already. So Claude can write `build.ship_id` before
  `build_plan` exists, and the panel can name the ship.
- `KEPT_EVENTS` gains `StoredModules`, `ShipyardBuy`, `ShipyardNew`, `ShipyardRedeem`,
  `ShipyardTransfer`, `ModuleStore`, `MassModuleStore`, `ModuleBuyAndStore`, `ModuleRetrieve`,
  `FetchRemoteModule`, `ModuleSellRemote` (for `build_plan`'s stored modules). Journal state
  gains `stored_modules`: the newest `StoredModules`, wherever it was written (at login, on
  opening outfitting, or after a storage change), with the store, retrieve, sale and transfer
  events after it applied, until the next one replaces it.
- Later, on foot: `SuitLoadout`, `SwitchSuitLoadout`, `CreateSuitLoadout`, `LoadoutEquipModule`,
  `BuySuit`, `BuyWeapon`, `UpgradeSuit`, `UpgradeWeapon`, `ShipLocker`; journal state gains
  `suits` (each suit and weapon seen, with grade and mods), `locker` (from `ShipLocker.json`,
  as `Cargo.json` is read now) and `backpack` (from `Backpack.json`, kept up to date between
  writes by `BackpackChange`'s `Added` and `Removed`). `Backpack` and `BackpackChange` are kept
  too.
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
  `ModuleStore`, `MassModuleStore`, `ModuleBuyAndStore`, `ModuleRetrieve`, `FetchRemoteModule`,
  `StoredModules`, `ShipyardBuy`, `ShipyardRedeem`, `ShipyardNew`, `ShipyardTransfer`,
  `Outfitting`, and lists those ed-mcp keeps already (`EngineerCraft`,
  `MaterialTrade`, `Materials`, `EngineerProgress`, `TechnologyBroker`, `Synthesis`,
  `ShipyardSwap`, `Loadout`), as trade's `TRADE_EVENTS` does, with a test that the reader keeps
  every one.
- **`src/core/hud/build.ts`:** `actionDone()` for each kind, the needs against the inventory,
  the panel and the visit view. **`src/core/hud/buildStops.ts`:** `BuildFinisher`, wired in
  `src/main/index.ts` beside `TradeStopFinisher`.
- **Feed:** `Outfitting.json` while docked at an outfitting stop, used only for that station and
  this visit. `parseShipStatus()` gains `balance` from `Status.json`'s `Balance`, for the credits
  held. The ship locker and the backpack come from ed-mcp's journal state (on-foot phase).
- **Game note:** the panel's rows go to Claude with each message, so "what's next on the Python?"
  needs no tool call.
- **Docs:** a Build section in `docs/activity-panel.md`; the mode in `docs/settings.md`.
- **Tests:** event sequences from real journals (scrubbed): a G1 to G5 roll sequence with an
  experimental; a buy that sells the old module; a retrieve of an engineered module; a module
  moved between internal slots; trades that add up to the count; a hull bought then fitted; a
  swap between two ships with plans; an action done at a later stop first; a done action no
  longer fitted; eight identical buys needing eight events; a trade shared across two actions;
  a stop reopened with `routePrev` that stays open; a stop with no actions; a partial roll's
  rolls left; a `MassModuleStore` filling two store actions; a `ModuleBuy` that sells the old
  module finishing a buy and a sell; a `ShipyardBuy` and `ShipyardNew` finishing a buy and a
  swap; an action marked done by hand claiming its event, so the next identical action stays
  open; two events in the same second; a plan with a `buy_ship` not binding to a ship of that
  type; a new blueprint counted from G1; a buy writing its ID into the actions with its `gear`.
- **Mode tests,** as event sequences and the mode expected: a matching module event, docking at a
  build stop and the note each turn it on; a `Synthesis` or `MaterialTrade` the plan does not ask
  for, the login events and a jump do not; massacre wins while a stack is open and the build
  comes back after; a scan or a prospect after the last build event takes over, and docking at
  the next build stop brings it back; the visit view ends on undocking; "Build complete" ends on
  undocking; two plans open, docked at a stop of the one the note does not name, with the route
  rows and the game note following the plan shown.
- **Gather stop tests:** a collect stop done when the inventory reaches the count (from
  collecting and from a trade), not reopened when the materials are spent, and its "collect at
  stop N" pointer on the engineer action short of the material.

## Order of work

0. **ED Chat: merge the trade panel (PR #83).** The build panel builds on its
   `TradeStopFinisher` and `actionDone()`.
1. **ed-mcp: schema and store.** Stop `actions` (with `done_by`), plan `build`, `updateAction`,
   `setBuildShip`, `plan_update_stop` for actions, `ship.id` in journal state, the kept events
   and `stored_modules`, `normaliseModule` and `planTrades` exports. Release.
2. **ED Chat: build panel for ship plans.** Pins the release. Mode rules, the panel, the judge,
   `BuildFinisher`, the ship-swap note rule, `Balance` from `Status.json`. Usable at once with
   plans Claude writes with `plan_upsert`, with `ship_id` from journal state or matched by ship
   type.
3. **ed-mcp: `build_plan`.** The diff, needs, trades, engineers and route, `save_to_plan`.
   Tested against SLEF from Coriolis and EDSY and real `Loadout` events. Release.
4. **ED Chat: the no-plan outfitting visit.** Needs no ed-mcp change; can go at any point.
5. **ed-mcp: on foot.** The on-foot action kinds' journal state (`suits`, `locker`, `backpack`), kept
   events, `build_plan` for a suit loadout with needs given by Claude. Release.
6. **ED Chat: on-foot actions.** Their judges, the choice between two open plans, "equip to check".

Each is its own PR.

## Known limits

- `EngineerCraft` has no `ShipID`; the ship is the one flown at the time. A remote workshop
  craft is always for the ship flown, so this holds.
- The rolls left are an estimate from `build.rolls_per_grade` and the quality reached; a lucky
  roll finishes sooner.
- A stop whose last action was done while ED Chat was not running is not marked done on the next
  start (the first poll marks nothing); `routeNext` marks it.
- A pinned blueprint and the remote workshop are not in the journal, so the panel always points
  to the engineer's base.
- On foot, a modification shows only when the loadout is next written.
- Actions are judged from the journal's 14-day window. An action done and marked stays done in
  the plan, so only an action done while ED Chat was not running and more than 14 days ago is
  missed; `routeNext` or Claude can mark it.
- On-foot needs are as good as what Claude writes: ed-mcp has no table to check them against.
