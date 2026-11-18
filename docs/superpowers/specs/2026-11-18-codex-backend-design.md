# Codex as an alternative to Claude

Date: 2026-11-18
Status: draft. Step 0 (protocol probe) done, see "Step 0 results".

## Purpose

ED Chat drives the Claude Code CLI. Some players use OpenAI's Codex instead, or have both. ED Chat
should run on either, chosen by one global setting, with the same overlay, HUD, approvals and
ed-mcp tools. A player who has set up ed-mcp for one of them must not have to set it up again.

## Decisions

- **One global setting.** `agent: "claude" | "codex"` in `settings.json`. Default `claude`.
- **The model cannot switch it.** `agent` is a player-only setting, like the `claude` block: it
  decides which company receives the conversation. The schema marks it readOnly, so the model
  declines and tells the player to type `/codex`. If the file changes anyway, `PlayerOnlyGuard`
  shows its Undo/Apply dialog.
- **Ways to switch.** The `/claude` and `/codex` commands, which ED Chat handles and never sends
  to the model. They write through `PlayerOnlyGuard.playerWrite()`, so no dialog. The tray menu.
  Editing `settings.json`. ED Chat posts "Switched to Codex" in the chat when it happens.
- **Codex runs as `codex app-server`.** It is long-lived JSON-RPC over stdio, as `claude -p
  --input-format stream-json` is today. `codex exec --json` is one process per turn, so it is not
  used.
- **Native Windows sandbox.** Codex's Windows sandbox needs an admin install
  (`[windows] sandbox = "elevated"`). Without it, ED Chat shows a notice that names the fix. It does
  not fall back to running unsandboxed.
- **ed-mcp tools run without approval**, as with Claude. The scope is the sandbox: workspace-write
  limited to ED Chat's data folder. Shell commands and file changes outside it go to the
  approval card.
- **ed-mcp is configured once.** ED Chat finds the ed-mcp definition in either CLI's config and
  gives it to whichever backend runs, if that backend does not already have it.
- **Sessions are kept per backend.** Switching back to Claude within `resumeHours` resumes the old
  Claude conversation. A Claude session id is never given to Codex, or the reverse.

## Mapping

| Concern | Claude | Codex |
|---|---|---|
| Process | `claude -p --input-format stream-json …` | `codex app-server` |
| Start a conversation | first stdin message | `initialize`, `initialized`, `thread/start` |
| Send a message | stream-json user line | `turn/start { threadId, input: [{type:"text", text, text_elements:[]}] }` |
| Reply text | `stream_event` text deltas | `item/agentMessage/delta { delta }` |
| Final reply | `result` | `turn/completed { turn: { status, error, durationMs } }` |
| Interim reply | n/a | `agentMessage` items with `phase: "commentary"`. Shown like any text. |
| Tool start/end | `tool_use` / `tool_result` | `item/started` / `item/completed` with type `mcpToolCall`, `commandExecution`, `fileChange`, `webSearch` |
| System prompt | `--append-system-prompt HUD_PROMPT` | `developerInstructions` on `thread/start` and `thread/resume` |
| Approval | MCP tool `mcp__ed_chat__approve` | server requests `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`, answered with `{ decision: "accept" \| "acceptForSession" \| "decline" }` |
| Stop a reply | kill and respawn | `turn/interrupt { threadId, turnId }`. The turn ends `interrupted`. The process stays. |
| Resume | `--resume <id>`; stderr "No conversation found" | `thread/resume { threadId }`; error `-32600 "no rollout found for thread id …"` |
| ed-mcp status | `mcp_servers` in the init message | `mcpServer/startupStatus/updated { name, status: starting \| ready \| failed, error }` |
| Permission mode `auto` | `--permission-mode auto` | `approvalPolicy: "on-request"`, `sandbox: "workspace-write"` |
| Permission mode `default` | `--permission-mode default` | `approvalPolicy: "untrusted"`, `sandbox: "workspace-write"` |

## Part 1: refactor with no change in behaviour

- `ClaudeBackend` becomes `AgentBackend`. `BackendEvent` and `SessionEvent` do not change: they are
  already neutral.
- The Claude code moves to `src/core/backends/claude/`: `command.ts` (from `claudeCommand.ts`),
  `session.ts` and `streamJson.ts`.
- `ApprovalServer` splits in two. `ApprovalBroker` holds the queue, the timeout, "allow until /new"
  and `summarize()`. The MCP HTTP server is the Claude adapter on top of it.
- `HUD_PROMPT` and `settingsPrompt` stop naming Claude. Notices, `/version` and the first-run
  dialog use the backend's display name.
- The shared ed-mcp lookup (Part 3) replaces `edMcpSyncDir`, and Claude uses it too.
- `resolveClaude` becomes `resolveCli({ names, defaultPaths })`, used by both backends. The order
  is: the configured path, then each name on PATH, then the default install locations. Electron
  started from a shortcut or the Store may not see a PATH change made after login, and some
  installers do not touch PATH at all. Claude's defaults are `~/.local/bin/claude.exe` (native
  installer) and `%APPDATA%\npm\claude.cmd` (npm). A `.cmd` result still runs through a shell.
  The "not found" notice lists the places it looked.
- The current tests pass unchanged.

## Part 2: the Codex backend

- `src/core/backends/codex/`:
  - `command.ts` finds `codex` with the shared `resolveCli()` (Part 1): `codex.exe`, `codex.cmd`
    on PATH, then `~/.codex/packages/standalone/current/bin/codex.exe` (the standalone installer
    does not always add itself to PATH; `current` is a link to the newest release) and
    `%APPDATA%\npm\codex.cmd`.
  - `rpc.ts`: a line-delimited JSON-RPC client. Requests have `id` and `method`; responses have
    `id` and `result` or `error`; notifications have `method` only; server requests have `id`
    and `method`. Messages carry no `jsonrpc` field.
  - `session.ts` implements `AgentBackend`. One process, one thread. `send` is `turn/start`.
    `cancel` is `turn/interrupt`. `newSession` is a new `thread/start` in the same process.
    Exit and crash handling reuse `CrashTracker`.
  - `events.ts` maps notifications to `SessionEvent`s. Unknown methods map to `unknown` and are
    ignored. Codex sends many (`account/rateLimits/updated`, `thread/tokenUsage/updated`, …).
- Approval requests go to `ApprovalBroker`. `summarize()` learns `command` (a full command line,
  often `powershell.exe -Command …`), `cwd`, `reason` and `commandActions`. "Allow until /new"
  answers `acceptForSession`.
- `mcpServer/elicitation/request` is declined for now. ed-mcp does not use elicitation.
- `codex_apps` is Codex's own MCP server. Only `ed-mcp` drives the ed-mcp notices.
- Tests: `test/fake-codex.mjs`, like `fake-claude.mjs`. Fixtures in `test/fixtures/codex/`,
  recorded with `scripts/codex-probe.mjs` and scrubbed (Part 5). Session tests mirror
  `claudeSession.test.ts`.

## Part 3: shared ed-mcp config

- `findEdMcp()` returns `{ source, command, args, env }` or nothing. It looks in this order:
  1. `~/.claude.json` user-scope `mcpServers["ed-mcp"]`.
  2. `~/.claude.json` project-scope entries.
  3. `~/.codex/config.toml` `[mcp_servers.ed-mcp]`. A TOML parser is needed (`smol-toml`).
  4. An installed Claude plugin `plugin:*:ed-mcp`, for its sync folder only.
- `ED_MCP_SYNC_DIR` for the HUD comes from the same result.
- **Claude.** If Claude's own config has no ed-mcp, ED Chat adds it to the `approval-mcp.json`
  that it already passes with `--mcp-config`.
- **Codex.** If Codex's `config.toml` has no ed-mcp, ED Chat passes it in the `config` field of
  `thread/start` and `thread/resume`, as `{ mcp_servers: { "ed-mcp": { command, args, env } } }`.
  Not as `-c` arguments: the env can hold `ED_MCP_SYNC_PASSWORD`, and command lines are visible to
  other processes.
- The backend's own definition always wins, so ed-mcp is never registered twice.
- One setup notice, shown only when ed-mcp is in neither config. It gives the `claude mcp add`
  line, or `codex mcp add ed-mcp -- cmd /c npx -y ed-mcp@latest` if only Codex is installed.

## Part 4: settings and switching

- Schema: top-level `agent`, and a `codex: { path, permissionMode, extraArgs }` block next to
  `claude`. `resumeHours` moves to the top level, and the old `claude.resumeHours` still loads.
- `state.json`: `session` becomes `sessions: { claude?, codex? }`. The old `session` loads as
  `sessions.claude`.
- `agent` and the `codex` block are added to `SETTINGS_DICTIONARY` with `playerOnly: true`. The
  `playerOnly` tests cover a model edit of `agent` (dialog) and `/codex` (no dialog).
- `/claude` and `/codex` join `/new` and `/version` in `send()`. They write `agent` with
  `playerWrite()`. The file watcher does the rest. A tray submenu, "Assistant: Claude / Codex",
  does the same.
- When `agent` changes, ED Chat stops the running backend, starts the other one and resumes its
  saved session if it is fresh. A reply in progress is interrupted first.
- `/version` shows the active backend and its CLI version. Each backend has its own tested version
  (`TESTED_CLI_VERSION` for Claude, `TESTED_CODEX_VERSION = "0.170.0"`).
- First run: if only one CLI is installed, use it. If both are, use Claude and say how to switch.

## Part 5: fixtures and docs

- `scripts/scrub-fixtures.mjs` learns the Codex fixtures: home paths, user name, commander name,
  thread and turn ids kept as they are, `account/*` and `remoteControl/*` lines removed.
- README: either CLI works, logged in. ed-mcp is set up once, in either.
- `PRIVACY.md`: with Codex chosen, messages and tool results go to OpenAI.
- `docs/manual-checklist.md`: a Codex pass, and a switch pass.
- Store listing and package description name both.

## Step 0 results

Run on 2026-11-18 with codex-cli 0.170.0 (standalone install, elevated Windows sandbox), using
`scripts/codex-probe.mjs` in both config modes. Everything ED Chat needs works:

1. **Native Windows.** The app server starts, and a command outside the workspace raises
   `item/commandExecution/requestApproval`. Declining it ends the command and the turn continues.
2. **Streaming.** 40 to 70 `item/agentMessage/delta` notifications in a short reply.
3. **Developer instructions.** "Begin every reply with ROGER" was followed in every reply,
   including after resume in a new process.
4. **ed-mcp from Claude's definition.** Both `thread/start` `config` and `-c` overrides start
   ed-mcp through `cmd /c npx`. `journal_status` ran as an `mcpToolCall` item, with no approval
   request. Startup failures are reported with `status: "failed"` and an error text.
5. **Interrupt and resume.** `turn/interrupt` ends the turn with status `interrupted`.
   `thread/resume` by id in a new process keeps the conversation. An unknown id gives error
   `-32600`.

Notes from the probe:

- `thread/start` `cwd` must be absolute. A relative path makes MCP servers fail with "The
  directory name is invalid (os error 267)".
- The generated protocol types (`codex app-server generate-ts --out <dir>`) are the reference.
  They change between versions, so `events.ts` reads only the fields it needs.
