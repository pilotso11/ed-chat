# ED Overlay

A small Claude chat window on top of Elite Dangerous. Press a hotkey, ask a
question, press Enter, and keep flying. The reply shows in a corner of the
screen. Star system and station names in the reply become numbered chips;
Ctrl+Shift+1…9 copies one, ready to paste into the galaxy map search.

Windows 10 and 11 only.

## Requirements

- Elite Dangerous in **Borderless** or **Windowed** mode (Options → Graphics →
  Display). The overlay cannot show over exclusive fullscreen.
- [Claude Code](https://claude.com/claude-code), installed and logged in. The
  overlay starts your own `claude` command and uses your login and settings.
- Recommended: [ed-mcp](https://github.com/pilotso11/ed-mcp) for game tools.
  Add it for your user, not one project:

  ```
  claude mcp add ed-mcp -s user -- npx -y ed-mcp
  ```

## Install

Download `ED Overlay Setup <version>.exe` from Releases and run it. The
installer is not code signed yet, so Windows SmartScreen warns on first run.
Select **More info → Run anyway**. Releases are not public yet.

## Use

| Key | Action |
| --- | --- |
| Ctrl+Shift+Space | Open the chat. Enter sends and returns to the game. Esc closes. |
| Ctrl+Shift+1…9 | Copy chip 1…9 |
| Ctrl+Shift+Y / N | Allow / deny a tool that Claude asks to run |
| Ctrl+Shift+X | Stop the current reply |
| Ctrl+Shift+H | Show or hide the history |
| Ctrl+Shift+O | Hide or show the overlay |
| Ctrl+Alt+Arrows | Move the overlay around the screen edge |
| Ctrl+Alt+M | Move the overlay to the next monitor |

Type `/new` in the chat to start a new conversation.

The overlay has an orange ring icon in the notification area (system tray).
Right-click it to show or hide the overlay, open `settings.json`, open the log
folder, or quit.

Hotkeys work only while the game or the overlay is in front, so they do not
take keys from other apps. While the ship is in danger, the chat does not open.

## Permissions

The overlay runs Claude in auto mode: a classifier approves low-risk actions
and blocks risky ones. When Claude asks, the overlay shows the request; answer
with Ctrl+Shift+Y or Ctrl+Shift+N. To never be asked about ed-mcp tools, add
`"mcp__ed-mcp__*"` to `permissions.allow` in `~/.claude/settings.json`.

## Settings

`%APPDATA%\ed-overlay\settings.json` is written with the defaults on first run.
Changes apply when you save the file. The file is plain JSON. Settings for
`claude` apply after `/new`; the overlay shows `ⓘ claude settings apply after /new`.

| Key | Default | Meaning |
| --- | --- | --- |
| `hotkeys.*` | see above | Electron accelerator strings; `copyChip` must contain `{n}` |
| `hotkeys.scope` | `game` | `game`: only while the game or overlay is in front. `always`: everywhere |
| `strip.lines` | `2` | `1`: status only. `2`: also the first line of the last reply |
| `strip.keepChips` | `true` | Keep the last reply's chips under the status line |
| `card.maxLines` | `4` | Reply lines shown (2–8) |
| `card.fadeSeconds` | `20` | Seconds before the reply card closes |
| `card.width` | `420` | Width in pixels at font size 14 |
| `chat.lines` | `14` | History lines in the chat |
| `style.fontSize` | `14` | Font size; scales the window |
| `position.anchor` | `top-right` | `top-left`, `top`, `top-right`, `left`, `right`, `bottom-left`, `bottom`, `bottom-right` |
| `position.offsetX` / `offsetY` | `24` | Pixels from the screen edges |
| `position.display` | `primary` | `primary` or a monitor number (0, 1, …) |
| `safety.blockWhenInDanger` | `true` | Do not open the chat while in danger |
| `approval.timeoutSeconds` | `120` | Deny a request that gets no answer |
| `claude.path` | `null` | Path to `claude`; `null` searches `PATH` |
| `claude.permissionMode` | `auto` | `auto` or `default` (ask for everything not allowed) |
| `claude.extraArgs` | `[]` | More arguments for `claude` |
| `journalDir` | `null` | The game's journal folder; `null` uses Saved Games |

A position chosen with the hotkeys is saved in `state.json`, until you change
`position` in `settings.json`.

## Troubleshooting

The first line of the overlay shows problems. If ed-mcp is added but does not
start, the overlay shows `⚠ ed-mcp failed to start; run claude mcp list`. If
the overlay cannot start at all, it shows an error dialog. The log is
`%APPDATA%\ed-overlay\logs\overlay.log`. It never contains chat text.
