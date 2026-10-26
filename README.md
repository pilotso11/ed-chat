# ED Chat

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
  Add it for your user, not one project. Windows needs `cmd /c` to run `npx`:

  ```
  claude mcp add ed-mcp -s user -- cmd /c npx -y ed-mcp
  ```

## Install

Download `ED Chat Setup <version>.exe` from Releases and run it. The
installer is not code signed yet, so Windows SmartScreen warns on first run.
Select **More info → Run anyway**. Releases are not public yet.

## Use

| Key | Action |
| --- | --- |
| Ctrl+Alt+C | Open the chat. Enter sends and returns to the game. Esc closes. |
| Ctrl+Shift+1…9 | Copy chip 1…9 |
| Ctrl+Shift+Y / N | Allow / deny a tool that Claude asks to run |
| Ctrl+Alt+X | Stop the current reply |
| Ctrl+Shift+H | Show or hide this session's history |
| ` (backquote) | Switch between the full overlay and a small icon |
| Ctrl+Alt+O | Hide or show the overlay |
| Ctrl+Alt+Arrows | Move the overlay around the screen edge |
| Ctrl+Alt+M | Move the overlay to the next monitor |

Type `/new` in the chat to start a new conversation.

The overlay has an orange ring icon in the notification area (system tray).
Right-click it to show or hide the overlay, open `settings.json`, open the log
folder, or quit.

In icon mode a reply, an approval or the chat expands the overlay. It stays
expanded until you press ` again. The icon shows a dot when the last reply
has chips or a notice is waiting.

Hotkeys work only while the game or the overlay is in front, so they do not
take keys from other apps. While the ship is in danger, the chat does not open.

If the overlay shows `⚠ hotkeys not registered`, another app already uses
that key. Set a different key in `settings.json`.

## Permissions

The overlay runs Claude in auto mode by default. A classifier reviews each
action, but it runs a command that you ask for explicitly without asking you
first. In testing, auto mode ran `curl … | sh` when asked to, with no prompt.
Claude also acts on text it reads, such as tool results, so be careful what you
ask it to do.

For an approval before every action that your Claude Code rules do not already
allow, set `"claude": { "permissionMode": "default" }`. The overlay then shows
each request; answer with Ctrl+Shift+Y or Ctrl+Shift+N. To never be asked about
ed-mcp tools, add `"mcp__ed-mcp__*"` to `permissions.allow` in
`~/.claude/settings.json`.

## Settings

`%APPDATA%\ed-chat\settings.json` holds only the settings you change. It starts
as `{}`; add a key to override its default, for example
`{ "hotkeys": { "openChat": "Ctrl+Alt+Space" } }`. Every default is listed in
`settings.defaults.json` next to it, which is rewritten at each start; do not
edit that one. Version 0.1.0 wrote every default into `settings.json`, so the
0.1.0 hotkeys stay in effect there: delete the keys you did not change, or the
whole file, to get the current defaults.

Changes apply when you save the file. The file is plain JSON. Settings for
`claude` apply after `/new`; the overlay shows `ⓘ claude settings apply after /new`.

| Key | Default | Meaning |
| --- | --- | --- |
| `hotkeys.*` | see above | Electron accelerator strings; `copyChip` must contain `{n}` |
| `hotkeys.scope` | `game` | `game`: only while the game or overlay is in front. `always`: everywhere |
| `strip.lines` | `2` | `1`: status only. `2`: also the first line of the last reply |
| `strip.keepChips` | `true` | Keep the last reply's chips under the status line |
| `strip.startAsIcon` | `false` | Start as the icon on first run (later runs remember the last choice) |
| `card.maxLines` | `4` | Reply lines shown (2–8) |
| `card.fadeSeconds` | `20` | Seconds before the reply card closes |
| `card.width` | `420` | Width in pixels at font size 14 |
| `chat.lines` | `14` | History lines in the chat |
| `style.fontSize` | `14` | Font size; scales the window |
| `style.backgroundOpacity` | `0.78` | Panel background opacity, from 0 (none) to 1 (solid). Text stays opaque |
| `position.anchor` | `bottom-left` | `top-left`, `top`, `top-right`, `left`, `right`, `bottom-left`, `bottom`, `bottom-right` |
| `position.offsetX` / `offsetY` | `24` | Pixels from the screen edges |
| `position.display` | `primary` | `primary` or a monitor number (0, 1, …) |
| `safety.blockWhenInDanger` | `true` | Do not open the chat while in danger |
| `approval.timeoutSeconds` | `120` | Deny a request that gets no answer |
| `claude.path` | `null` | Path to `claude`; `null` searches `PATH` |
| `claude.permissionMode` | `auto` | `auto` or `default` (ask for everything not allowed) |
| `claude.extraArgs` | `[]` | More arguments for `claude` |
| `journalDir` | `null` | The game's journal folder; `null` uses Saved Games |

With the chat open you can also drag the overlay by its status line. It snaps
to the nearest edge or corner when you let go.

A position chosen with the hotkeys or by dragging is saved in `state.json`, until you change
`position` in `settings.json`.

## Troubleshooting

The first line of the overlay shows problems. If ed-mcp is added but does not
start, the overlay shows `⚠ ed-mcp failed to start; run claude mcp list`. If
the overlay cannot start at all, it shows an error dialog. The log is
`%APPDATA%\ed-chat\logs\overlay.log`. It does not record your messages or
Claude's replies. When the `claude` CLI stops, the log keeps its last error
lines, cut to 160 characters each, and those can quote part of a request. Check
the log before you share it.

Each session's messages are also saved in `%APPDATA%\ed-chat\history\`, one
file per session. The overlay does not read them back; they are an archive you
can open or delete.
