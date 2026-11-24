# Using ED Chat

The [README](../README.md) has the short version. This page has the details: the keys and
commands, permissions, other model providers and troubleshooting. The activity panel has
[its own page](activity-panel.md), and every setting is in [settings.md](settings.md).

## Setting up the assistant and ed-mcp

- Elite Dangerous in **Borderless** or **Windowed** mode (Options → Graphics →
  Display). The overlay cannot show over exclusive fullscreen.
- One of these assistants, installed and logged in. The overlay starts your
  own command and uses your login and settings.
  - [Claude Code](https://claude.com/claude-code) (`claude`), the default.
  - [OpenAI's Codex CLI](https://github.com/openai/codex) (`codex`). Log
    in with `codex login`. Codex runs commands in its Windows sandbox, which
    needs its admin install: see the Codex documentation for
    `[windows] sandbox = "elevated"`.

  With both installed, ED Chat uses Claude Code; type `/codex` in the chat to
  switch. With only Codex installed, ED Chat uses Codex.
- Recommended: [ed-mcp](https://github.com/pilotso11/ed-mcp) for game tools.
  Set it up once, in either assistant: ED Chat finds it and gives the same
  ed-mcp, with its settings, to the other one. For Claude Code, add it for your
  user, not one project. Windows needs `cmd /c` to run `npx`, and `@latest`
  gets each new release:

  ```
  claude mcp add ed-mcp -s user -- cmd /c npx -y ed-mcp@latest
  ```

  Every ed-mcp setting is optional. Add an `-e NAME=value` for each one that you
  use, before the `--`. For example, a sync folder and password let ED Chat,
  Claude Desktop and your other computers share plans and logins:

  ```
  claude mcp add ed-mcp -s user -e ED_MCP_SYNC_DIR=<folder> -e ED_MCP_SYNC_PASSWORD=<password> -- cmd /c npx -y ed-mcp@latest
  ```

  For Codex instead:

  ```
  codex mcp add ed-mcp -- cmd /c npx -y ed-mcp@latest
  ```

  The [ed-mcp README](https://github.com/pilotso11/ed-mcp#readme) lists every
  setting (Inara and EDSM keys, journal folder). The ed-mcp Claude Code plugin
  also works. If you have both and one fails, ED Chat uses the one that works.

## Keys and commands

| Key | Action |
| --- | --- |
| Ctrl+` | Step: the last reply, then the whole reply, then the chat; a press in the chat closes it |
| Ctrl+Alt+Enter | Open the chat directly. Enter sends and returns to the game. Esc closes. |
| Ctrl+Alt+1…9 | Copy chip 1…9 (top-row digits). A click on a chip also copies it. |
| Ctrl+Alt+Y / N | Allow / deny a tool that the assistant asks to run |
| Ctrl+Alt+A | Allow the tool, and allow it without asking until `/new` |
| Ctrl+Alt+X | Stop the current reply |
| Ctrl+Alt+H | Show or hide this session's history |
| Ctrl+Alt+Shift+Enter | Switch between the full overlay and a small icon |
| Ctrl+Alt+Arrows | Move the overlay around the screen edge |
| Ctrl+Alt+M | Move the overlay to the next monitor |

Type `/new` in the chat to start a new conversation, and `/quit` or `/exit` to quit ED Chat
(as the tray menu's Quit does). Type `/version` to see the versions
of ED Chat, the assistant's CLI, the ed-mcp that ED Chat carries for the activity panel
and the latest ed-mcp on npm, which `npx ed-mcp@latest` runs. Type `/claude` or `/codex`
to switch between Claude Code and OpenAI's Codex; the tray menu's Assistant item does the
same. Type `/settings` to open the settings window. Type `/dismiss-plan` to skip the rest of the plan on the activity panel, and
`/dismiss-step` to skip its current stop (see
[Dismissing a plan](activity-panel.md#dismissing-a-plan)). None of these commands goes to
the assistant.

Each assistant keeps its own conversation. Switching back within 12 hours resumes it.
With Codex chosen, your messages and tool results go to OpenAI instead of Anthropic.

When ED Chat starts within 12 hours of your last reply, it resumes that
conversation, and the history (Ctrl+Alt+H) shows its turns. With an ed-mcp that has
the activity tools, the assistant also keeps a short note of what you are doing, for example
scanning bios on a planet or running a massacre stack, and the route that
you are flying. It reads the note when a conversation starts, so it knows
after `/new` or a long break. Set `resumeHours` to change the 12 hours.

At startup the overlay shows its hotkeys for 15 seconds. Click the list to
close it.

The overlay has an orange chat bubble icon in the notification area (system tray).
Windows 11 may hide it under the **^** arrow; drag it to the taskbar to keep it
in view. Click it for a menu: copy a chip, open the chat, start a new
conversation, show the hotkeys, switch icon mode, minimize the overlay to the
tray or restore it, open the settings window (**Settings…**), `settings.json` or the log folder, open ED Chat's home
page on GitHub (**About ED Chat**), or quit. While the overlay is minimized, the
hotkeys still work, and the chat and approvals still show.

In icon mode a reply, an approval or the chat shows over the icon, and the
overlay goes back to the icon when the reply card closes. A click on the icon
switches icon mode off. The icon shows a dot when the last reply has chips or a
notice is waiting.

A long reply shows **▾ more**; click it to see the whole reply. The card does
not close while the pointer is on it.

Ctrl+` steps through what is on screen, one press at a time:

1. The last reply's card. If the overlay is minimized, it comes back too.
2. The whole reply.
3. The chat.
4. Back to rest: the chat, the history and the card close (a reply still
   arriving keeps its card), focus goes back to the game, and
   an overlay that step 1 brought back is minimized again. Closing the chat with
   Esc also minimizes it again.

The step follows what is on screen: after the card fades, the next press starts
again at step 1. With no reply yet, the first press opens the chat. With the
history open (Ctrl+Alt+H), the next press adds the input to it.

The status line shows **● sending** until the reply starts, then
**● receiving**.

Hotkeys work only while the game or the overlay is in front, so they do not
take keys from other apps. Away from the game the overlay shows
`ⓘ hotkeys work while Elite is in front`. While the ship is in danger, the chat
does not open.

While you type in the chat, the overlay leaves typing keys to the chat input,
including AltGr letters. Ctrl+Alt hotkeys such as Ctrl+Alt+X still work there:
use the left Ctrl and Alt keys, because AltGr types the letter.

Outside the chat, Windows sends AltGr as Ctrl+Alt, so in the game's own chat
AltGr+Y, N or A answers a waiting tool request, AltGr+H shows the history and
AltGr+1…9 copies a chip instead of typing a character: € on a UK keyboard, and
@, #, {, [, ] or \ on German, French, Spanish, Nordic and other layouts. With
`hotkeys.scope` set to `"always"` this happens in every app. If that gets in your
way, set other keys in the settings window, for example Ctrl+Shift+digit for **Copy chip**.

If the overlay shows `⚠ 2 hotkeys not working`, another app already uses those
keys, or `settings.json` sets the same key for two actions. The tray menu item
**Hotkey problems** lists them. Set other keys in the settings window, which marks each
clash with ⚠.

The status line shows one message at a time. **+2** after it means two more are
waiting; click it to see them all. A message with a command in it, such as
`run claude update`, copies the command when you click it.

## Permissions

On first run the overlay asks how the assistant should run tools, and saves the
answer as `claude.permissionMode` or `codex.permissionMode` in `settings.json`.
Codex is asked the first time it runs.

- **Ask me** (`default`): the overlay shows each tool that the assistant's own
  rules do not already allow (with Claude Code, your permission rules), and you
  answer it.
- **Auto** (`auto`): with Claude Code, a classifier reviews each action, but it
  runs a command that you ask for explicitly without asking you first. In
  testing, auto mode
  ran `curl … | sh` when asked to, with no prompt. The assistant also acts on
  text it reads, such as tool results, so be careful what you ask it to do. The
  status line shows **AUTO** while auto mode is on.

With Codex, both modes keep its sandbox to ED Chat's data folder: a command or a
file change outside it comes to the approval card. **Auto** lets Codex decide
inside the sandbox; **Ask me** asks before anything Codex does not know to be
safe. Codex never brings MCP tool calls such as ed-mcp to the card. With Claude
Code, your own permission rules decide: in Ask me mode each ed-mcp tool asks
until you allow it, for example with Ctrl+Alt+A until `/new`.

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

## Other model providers

ED Chat starts your own `claude` or `codex` command, so a third-party model
provider that you set up in that assistant also works in ED Chat. Follow your
provider's instructions for Claude Code or Codex, then change these ED Chat
settings:

- **Claude Code**: the provider's settings go in the `env` of
  `~/.claude/settings.json` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and
  the model names). Set `claude.permissionMode` to `default`. Auto mode needs
  Anthropic's safety check, which does not run through another provider, so in
  auto mode every tool call fails, ed-mcp included. Set `claude.model` to a
  model that the provider has, or keep `sonnet` if the provider maps it to one
  of its models.
- **Codex**: the provider goes in `~/.codex/config.toml`, with
  `wire_api = "responses"` (Codex no longer accepts `"chat"`). Set
  `codex.model` to the provider's model, or to `null` to use the model in
  `config.toml`. The default `gpt-6.1-terra` replaces the model in
  `config.toml`, and the provider does not have it.

This was tested with the z.ai GLM Coding Plan and `glm-5.3`, in both
assistants. A Coding Plan needs a key made for that plan: a standard API key
gets `1113 Insufficient balance`. With Codex, `glm-5.3` asked for approval
before shell commands that OpenAI's models ran without asking.

## Troubleshooting

The first line of the overlay shows problems. If ed-mcp is added but does not
start, the overlay shows `⚠ ed-mcp failed to start; run claude mcp list` (or
`codex mcp list`).
Click the message to copy the command. If
the overlay cannot start at all, it shows an error dialog. The log is
`%APPDATA%\ed-chat\logs\overlay.log`. It does not record your messages or
the assistant's replies. When the CLI stops, the log keeps its last error
lines, cut to 160 characters each, and those can quote part of a request. Check
the log before you share it.

Each conversation's messages are also saved in `%APPDATA%\ed-chat\history\`, one
file per conversation. When ED Chat resumes a conversation, it reads the last 200
turns of that file back into the history view and adds new turns to the same
file. You can open or delete the files. If you delete the file of the last
conversation, ED Chat still resumes it, but the history view starts empty.
