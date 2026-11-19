# Privacy

ED Chat runs on your PC. It has no account, no telemetry, no analytics, and no
update check. ED Chat itself does not transfer any information to other
networked systems unless you specifically request it.

## What leaves your PC, and why

ED Chat is a window for the Claude Code CLI, which you install and sign in to
yourself. When you send a message, ED Chat passes it to that CLI on your PC.
The CLI sends the message to Anthropic to get Claude's reply. Anthropic's terms
and privacy policy apply to that data, not this one.

With each message, ED Chat adds a short note of the game state from your
journal: your current system and nearby body, the station when docked, what the
activity panel shows, and your route. It goes to Anthropic with the message.

Claude Code also starts the MCP servers that you added to it, such as ed-mcp.
Those servers can contact other services, for example EDSM, Inara, Spansh or
Frontier, when Claude uses them to answer you. Each server's own documentation
says what it sends.

ED Chat's only network connection is a local one: it listens on `127.0.0.1` so
that Claude Code can ask it for your approval of an action. Nothing outside your
PC can connect to it.

## What stays on your PC

All of these are in `%APPDATA%\ed-chat\`. You can delete any of them.

- `settings.json`: your settings.
- `approval-mcp.json`: what ED Chat gives Claude Code at start: the address of its
  local approval server and, when Claude Code has no ed-mcp of its own, a copy of
  the ed-mcp setup from Codex or another Claude project, with its settings,
  including your ed-mcp sync password if you set one.
- `state.json`: the overlay position, and the ID and time of your last
  conversation, so ED Chat can resume it.
- `history\`: one file per conversation, with your messages and Claude's
  replies.
- `logs\overlay.log`: errors and status. It does not record your messages or
  Claude's replies, but the last error lines from the CLI can quote part of a
  request.

ED Chat reads the game's `Status.json` in the journal folder to know when you
are docked or in danger. It does not send it anywhere.

## Uninstall

Uninstall ED Chat from Windows Settings. To remove your data too, delete
`%APPDATA%\ed-chat\`.
