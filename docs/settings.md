# Settings

`%APPDATA%\ed-chat\settings.json` holds only the settings you change; every
other setting uses its default. It starts with only a `$schema` line, which
gives editors such as VS Code completion and the default of each setting. Add a
key to override its default, for example
`{ "hotkeys": { "openChat": "Ctrl+Alt+Space" } }`. Every default is listed in
`settings.defaults.json` next to it, which is rewritten at each start; do not
edit that one. Version 0.1.0 wrote every default into `settings.json`, so the
0.1.0 hotkeys stay in effect there: delete the keys you did not change, or the
whole file, to get the current defaults.

Changes apply when you save the file. The file is plain JSON. Settings for
`claude` or `codex` apply after `/new`; the overlay shows, for example,
`ⓘ claude settings apply after /new`.

You can also ask the assistant, for example "what is my bio threshold?" or "only
show bio planets worth 2M or more". It knows where `settings.json` is and reads
`settings.schema.json`, which describes each setting with its default and
limits. It does not change the settings marked player only: `agent`,
`resumeHours`, `claude`, `codex`, `approval`, `safety`, `journalDir` and
`hud.edMcpDataDir`. Change those yourself
from the tray menu, **Open settings**. ED Chat also checks: when one of these
settings changes in the file, by your edit or the assistant's, ED Chat keeps the old
value and asks whether to apply the change. **Undo** puts the old value back in
the file. The other changes in the same save apply at once. ED Chat keeps the
values you last applied in `state.json`, so a change that is still unanswered
when you quit, or that is made while ED Chat is closed, is asked about at the
next start.

| Key | Default | Meaning |
| --- | --- | --- |
| `hotkeys.*` | see [the overlay's keys](using.md#keys-and-commands) and [the panel's](activity-panel.md#keys) | An Electron accelerator string, or a list of them for more than one key. `copyChip` must contain `{n}` |
| `hotkeys.copyChipNumpad` | `false` | Also copy chips with Ctrl+numpad 1…9. Windows changes Shift+numpad keys, so these use Ctrl only |
| `hotkeys.scope` | `game` | `game`: only while the game or overlay is in front. `always`: everywhere, except keys without a modifier, such as a bare backquote |
| `startup.showKeys` | `true` | Show the hotkeys at startup |
| `strip.lines` | `2` | `1`: status only. `2`: also the first line of the last reply |
| `strip.keepChips` | `true` | Keep the last reply's chips under the status line |
| `strip.startAsIcon` | `false` | Start as the icon on first run (later runs remember the last choice) |
| `card.maxLines` | `4` | Reply lines shown before **▾ more** (2–10) |
| `card.fadeSeconds` | `20` | Seconds before the reply card closes |
| `card.width` | `420` | Width in pixels at font size 14 |
| `chat.lines` | `14` | History lines in the chat |
| `style.fontSize` | `14` | Font size; scales the whole overlay, the icon too |
| `style.backgroundOpacity` | `0.78` | Panel background opacity, from 0 (none) to 1 (solid). Text stays opaque and gets a dark outline as the background gets clearer |
| `position.anchor` | `bottom-left` | `top-left`, `top`, `top-right`, `left`, `right`, `bottom-left`, `bottom`, `bottom-right` |
| `position.offsetX` / `offsetY` | `24` | Pixels from the screen edges |
| `position.display` | `primary` | `primary` or a monitor number (0, 1, …) |
| `safety.blockWhenInDanger` | `true` | Do not open the chat while in danger |
| `approval.timeoutSeconds` | `120` | Deny a request that gets no answer |
| `approval.sound` | `true` | Play a sound when a request arrives |
| `agent` | `claude` | The assistant: `claude` or `codex`. Only you change it, with `/claude`, `/codex` or the tray |
| `resumeHours` | `12` | Resume the assistant's last conversation when ED Chat starts, or switches to it, within this many hours. `0` turns it off. An older `claude.resumeHours` still works |
| `claude.path` | `null` | Path to `claude`; `null` searches `PATH`, then the default install folders |
| `claude.permissionMode` | asked on first run | `auto` or `default` (ask for everything not allowed). Without an answer the code default is `auto` |
| `claude.model` | `sonnet` | The Claude model: `sonnet`, `opus`, `haiku` or a full model name. It replaces the model you chose in Claude Code. `null` uses Claude Code's default |
| `claude.extraArgs` | `[]` | More arguments for `claude` |
| `codex.path` | `null` | Path to `codex`; `null` searches `PATH`, then the default install folders |
| `codex.permissionMode` | asked the first time Codex runs | `auto` (Codex decides inside its sandbox) or `default` (ask before anything not known to be safe) |
| `codex.model` | `gpt-6.1-terra` | The Codex model. It replaces the model in Codex's `config.toml`; if your account does not have it, set another or `null`, which uses `config.toml` |
| `codex.extraArgs` | `[]` | More arguments for `codex app-server` |
| `journalDir` | `null` | The game's journal folder; `null` uses Saved Games |
| `hud.enabled` | `true` | Show the activity panel |
| `hud.position` | `top-right`, 24, 120 | Where the panel sits, like `position` |
| `hud.width` | `380` | Least panel width in pixels at font size 15. The panel grows so long names fit |
| `hud.fontSize` / `hud.backgroundOpacity` | `15` / `0.55` | Panel text size and background |
| `hud.modes.*` | `true` | Turn off `massacre`, `exploration`, `exobiology`, `mining`, `passenger`, `trade` or `route` |
| `hud.massacre.minPerKill` | `1000000` | Credits a kill. A target whose unfinished missions pay less than this for each kill left is marked ⚠. `0` turns it off |
| `hud.valuableMin` | `500000` | Bodies worth less when mapped are left off the exploration panel. Those with geological signals are counted on one line |
| `hud.bioMin` | `5000000` | Planets whose likely species are worth less than this in total are left off the exploration panel |
| `hud.spansh` | `true` | Look up each system's planets on Spansh when you arrive, and buyers for mined cargo. Only the system's ID, or for buyers the system name and commodity, is sent |
| `hud.mining.targets` | Platinum 20, Painite 25, … | The least percentage of each commodity in a rock that is worth mining; entries change or add to the defaults |
| `hud.mining.useCarrier` | `false` | Sell from your fleet carrier: search for buyers around it |
| `hud.mining.carrierMarkets` | `false` | Include other players' fleet carriers as buyers |
| `hud.mining.sellRadiusLy` / `carrierRadiusLy` | `100` / `500` | How far to search for buyers from the ship, or from the carrier |
| `hud.mining.maxPriceAgeDays` | `7` | Leave out buyers with older Spansh market data |
| `hud.bookmarks` | `true` | Show surface bookmarks (Ctrl+Alt+B) on the body and in the system |
| `hud.edMcpDataDir` | `null` | The ed-mcp sync folder; `null` finds it in ed-mcp's setup |

With the chat open you can also drag the overlay by its status line. It snaps
to the nearest edge or corner when you let go.

A position chosen with the hotkeys or by dragging is saved in `state.json`, until you change
`position` in `settings.json`.
