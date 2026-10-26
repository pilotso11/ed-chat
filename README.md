# ED Chat

A small Claude chat window on top of Elite Dangerous. Press a hotkey, ask a
question, press Enter, and keep flying. The reply shows in a corner of the
screen. Star system and station names in the reply become numbered chips;
Ctrl+Shift+1…9 or a click copies one, ready to paste into the galaxy map search.

Windows 10 and 11 only. The overlay is a desktop window, so it does not show in
VR.

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
| Ctrl+Shift+1…9 | Copy chip 1…9 (top-row digits). A click on a chip also copies it. |
| Ctrl+Shift+Y / N | Allow / deny a tool that Claude asks to run |
| Ctrl+Shift+A | Allow the tool, and allow it without asking until `/new` |
| Ctrl+Alt+X | Stop the current reply |
| Ctrl+` | Show the whole last reply, or go back to the short card |
| Ctrl+Shift+H | Show or hide this session's history |
| ` (backquote) | Switch between the full overlay and a small icon |
| Ctrl+Alt+Arrows | Move the overlay around the screen edge |
| Ctrl+Alt+M | Move the overlay to the next monitor |

Type `/new` in the chat to start a new conversation.

At startup the overlay shows its hotkeys for 15 seconds. Click the list to
close it.

The overlay has an orange ring icon in the notification area (system tray).
Windows 11 may hide it under the **^** arrow; drag it to the taskbar to keep it
in view. Click it for a menu: copy a chip, open the chat, start a new
conversation, show the hotkeys, switch icon mode, minimize the overlay to the
tray or restore it, open `settings.json` or the log folder, or quit. While the
overlay is minimized, the hotkeys still work, and the chat and approvals still
show.

In icon mode a reply, an approval or the chat shows over the icon, and the
overlay goes back to the icon when the reply card closes. A click on the icon
switches icon mode off. The icon shows a dot when the last reply has chips or a
notice is waiting.

A long reply shows **▾ more**; click it, or press Ctrl+`, to see the whole
reply. Ctrl+` also brings back the last reply after its card closed. The card
does not close while the pointer is on it.

The status line shows **● sending** until the reply starts, then
**● receiving**.

Hotkeys work only while the game or the overlay is in front, so they do not
take keys from other apps. Away from the game the overlay shows
`ⓘ hotkeys work while Elite is in front`. While the ship is in danger, the chat
does not open.

While you type in the chat, the overlay leaves typing keys to the chat input,
including AltGr letters. Ctrl+Alt hotkeys such as Ctrl+Alt+X still work there:
use the left Ctrl and Alt keys, because AltGr types the letter.

If the overlay shows `⚠ 2 hotkeys taken by other apps`, another app already
uses those keys. The tray menu item **Hotkey problems** lists them. Set other
keys in `settings.json`.

The status line shows one message at a time. **+2** after it means two more are
waiting; click it to see them all. A message with a command in it, such as
`run claude update`, copies the command when you click it.

## Permissions

On first run the overlay asks how Claude should run tools, and saves the answer
as `claude.permissionMode` in `settings.json`:

- **Ask me** (`default`): the overlay shows each tool that your Claude Code
  rules do not already allow, and you answer it.
- **Auto** (`auto`): a classifier reviews each action, but it runs a command
  that you ask for explicitly without asking you first. In testing, auto mode
  ran `curl … | sh` when asked to, with no prompt. Claude also acts on text it
  reads, such as tool results, so be careful what you ask it to do. The status
  line shows **AUTO** while auto mode is on.

An approval card shows the tool, up to three lines of what it will do, and
`⚠ runs a shell command` for shell tools. It plays a sound (`approval.sound`)
and shows **1 of 3** when more requests wait. Answer with the keys or by
clicking **Allow**, **Deny** or **Always**. **Always** allows that tool without
asking until `/new`. A key pressed in the first moment after the card appears
does not allow, so a key already on its way cannot approve something you have
not read. A bar counts down to `approval.timeoutSeconds`; then the request is
denied and the overlay shows `⛔ denied … no answer`.

To never be asked about ed-mcp tools, add `"mcp__ed-mcp__*"` to
`permissions.allow` in `~/.claude/settings.json`.

## Settings

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
`claude` apply after `/new`; the overlay shows `ⓘ claude settings apply after /new`.

| Key | Default | Meaning |
| --- | --- | --- |
| `hotkeys.*` | see above | An Electron accelerator string, or a list of them for more than one key. `copyChip` must contain `{n}` |
| `hotkeys.copyChipNumpad` | `false` | Also copy chips with Ctrl+numpad 1…9. Windows changes Shift+numpad keys, so these use Ctrl only |
| `hotkeys.scope` | `game` | `game`: only while the game or overlay is in front. `always`: everywhere, except keys without a modifier such as ` |
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
| `claude.path` | `null` | Path to `claude`; `null` searches `PATH` |
| `claude.permissionMode` | asked on first run | `auto` or `default` (ask for everything not allowed). Without an answer the code default is `auto` |
| `claude.extraArgs` | `[]` | More arguments for `claude` |
| `journalDir` | `null` | The game's journal folder; `null` uses Saved Games |

With the chat open you can also drag the overlay by its status line. It snaps
to the nearest edge or corner when you let go.

A position chosen with the hotkeys or by dragging is saved in `state.json`, until you change
`position` in `settings.json`.

## Troubleshooting

The first line of the overlay shows problems. If ed-mcp is added but does not
start, the overlay shows `⚠ ed-mcp failed to start; run claude mcp list`.
Click the message to copy the command. If
the overlay cannot start at all, it shows an error dialog. The log is
`%APPDATA%\ed-chat\logs\overlay.log`. It does not record your messages or
Claude's replies. When the `claude` CLI stops, the log keeps its last error
lines, cut to 160 characters each, and those can quote part of a request. Check
the log before you share it.

Each session's messages are also saved in `%APPDATA%\ed-chat\history\`, one
file per session. The overlay does not read them back; they are an archive you
can open or delete.
