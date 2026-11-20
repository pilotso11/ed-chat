# Codex as an alternative to Claude

Date: 2026-11-18
Status: draft. Step 0 (protocol probe) done, see "Step 0 results". Parts 1 to 4 done; Part 5
(fixtures, the answer comparison, store listing) is left. See the notes from each part.

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
  1. `~/.claude.json`, the project entry for ED Chat's workspace (Claude ranks it above user
     scope).
  2. `~/.claude.json` user-scope `mcpServers["ed-mcp"]`.
  3. `~/.claude.json` other project-scope entries.
  4. `~/.codex/config.toml` `[mcp_servers.ed-mcp]`. A TOML parser is needed (`smol-toml`).
  5. An installed Claude plugin `plugin:*:ed-mcp`, for its sync folder only.
- `ED_MCP_SYNC_DIR` for the HUD comes from the ed-mcp that the running backend uses: its own,
  or the one ED Chat gives it. When neither runs as a command (an http server, or switched off
  in Codex), the first entry that names a sync folder (see "Notes from Part 3").
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
- **Answer comparison.** `scripts/compare-agents.ts` sends the same 10 to 15 typical player
  questions (route, engineering, materials, trade, exobiology, a settings change) through the
  real `ClaudeSession` and `CodexSession`, with ED Chat's HUD prompt and ed-mcp. For each answer
  it records the tools called, the approvals asked, the reply length, the time to the first text
  and the total time, and writes one report with both replies side by side. Each reply is
  checked by hand; the report goes into the PR, and the results guide the README's advice on
  which CLI to choose.

### Comparing Claude and Codex

Run `npx tsx scripts/compare-agents.ts --dry-run` first: it lists the questions, each installed
CLI with its arguments, the permission mode and where its ed-mcp comes from, and starts nothing.
Then run it without `--dry-run`. This spends tokens on both assistants. The questions are in
`scripts/compare-questions.json`; `--questions <file>` takes another list, and `--only claude` or
`--only codex` runs one assistant. Each CLI is found as ED Chat finds it, with the path,
permission mode and extra arguments from the player's `settings.json`. It runs in a new temp
folder, with a copy of `settings.json` and its schema, so a settings change touches only the
copy. Each question starts a new conversation. Approvals are declined and counted, except ed-mcp
tools, which are allowed. Both assistants run the player's ed-mcp definition on a copy of its
data (activity note, plans, preferences), made fresh for each run, with `--strict-mcp-config`
for Claude, so a question that saves something changes only that copy; the first real run,
before this, overwrote the player's activity note. Secrets are not copied, and ed-mcp's config
and cache folders are moved into the temp folder (APPDATA and LOCALAPPDATA on Windows, the XDG
folders on Linux), so the assistants run as a player with no stored keys or Frontier login: a
login refreshed in a copy would spend the real one. npm keeps its own cache. A definition that
runs as a command is needed (not the plugin alone); macOS is not supported. Codex still loads the
player's other MCP servers from `config.toml` (only ed-mcp is replaced); a tool of theirs that
would change something asks, and the script declines it.
No `[Game state]` note is sent. The Markdown report goes to the temp folder, or to
`--out <file>` (never inside the repo), with the raw numbers in a `.json` file next to it.
`--timeout <seconds>` (default 300) limits each reply. Ctrl+C stops every CLI and writes what
was recorded. The pure parts are in `scripts/compare-lib.ts`, tested in
`test/compareAgents.test.ts`.

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

## Notes from Part 2

- The approval card's text comes from `CodexSession`, not `summarize()`: the command line (with
  its folder when that is not the workspace), or the changed files, which arrive with the
  `fileChange` item before the request. `brokerApprover()` connects it to `ApprovalBroker`.
- Main owns the `ApprovalBroker`; the Claude MCP approval server takes it, so both backends share
  one queue, timeout and "allow until /new".
- A stopped turn emits `spawned`, not `result`: the overlay goes back to idle with no reply. A
  turn that has not ended 5 seconds after `turn/interrupt` is ended with its process, and the
  thread resumes at the restart.
- `ready` is emitted when the thread starts, and again at each MCP startup status. Against the
  real CLI the first `ready` comes before any status, so Part 4 must not show "ed-mcp missing"
  from it for Codex: whether ed-mcp is set up comes from the config lookup (Part 3).
- Still to find out, with the real CLI: how Codex reports a Windows sandbox that is not
  installed (elevated), for the notice in "Decisions".
- For Part 4, when Codex is wired in: `brokerApprover()` tells "allow until /new" from "allow"
  by reading `isAllowed()` after the answer, which needs main to call `allowTool()` in the same
  tick; the broker should return the kind of allow instead. Codex's `unknown` events carry
  `{ method, params }`, and main's `describeUnknown` logs only `type` and `subtype`.
- An MCP status change during a turn sends `ready` only when the turn ends, since `ready`
  means idle to the overlay.
- A message sent while a stopped reply is still ending is held and sent once it has ended, as
  Claude's respawn does; a second one is refused as busy.
- A process that does not answer the handshake and open a thread within 60 seconds is ended
  and reported like an exit, so a message does not wait for ever.
- `thread/resume`: -32600 "no rollout found" starts a new thread at once. Any other refusal is
  tried once more in the same process, and a second refusal also starts a new thread with the
  player's message, so the old conversation is lost but the chat is not blocked. A process
  that dies during the resume keeps the thread for the restart. Each new process starts with no
  MCP statuses.
- Left for Part 4: approvals are keyed by request id alone, and each process counts from 0. A
  refused `turn/interrupt` for a turn that `/new` left is not retried, so that turn can run on.
  Cleanups: the process code shared with `ClaudeSession` (spawn,
  taskkill), and `isRecord`/`str`/`cut` copied across modules.
- Probe hardening was deferred to Part 5, before fixtures are recorded. It is done; see "Notes
  from Part 5".

## Notes from Part 3

- `edMcp.ts` reads `~/.claude.json`, `~/.claude/settings.json` (for the plugin) and
  `~/.codex/config.toml`, and follows `CLAUDE_CONFIG_DIR` and `CODEX_HOME` as the CLIs do.
- The plugin's options are in `pluginConfigs["<plugin>@<marketplace>"].options` in Claude's user
  settings; only enabled plugins count. Its password is in Claude's secret store, and its server
  runs from the plugin's folder, so it is never given to another backend: only its sync folder
  is read.
- A backend's own ed-mcp: for Claude, the project entry for ED Chat's workspace (Claude ranks it
  above user scope), user scope, or the plugin; for Codex, `[mcp_servers.ed-mcp]`, even with
  `enabled = false` (the player turned it off). `edMcpToAdd()` gives a backend the first runnable
  definition only when it has none, in the same order, so Codex gets the one Claude runs.
- Claude gets the added ed-mcp in `approval-mcp.json`, written at startup, so a change to either
  config applies when ED Chat starts again. Part 4 passes `edMcpToAdd("codex", …)` to
  `codexThreadSettings()`.
- The configs are read once at startup, for both the added ed-mcp and the panel's sync folder,
  so the two cannot disagree. An added `npx` or `.cmd` command runs through `cmd /c`.
- Not carried over: Codex's `env_vars` (variables passed by name from Codex's environment), and
  a Codex `cwd` or a Claude project folder, so a definition with relative paths fails to start.
  Only the user `settings.json` is read for the plugin, not local, project or managed settings,
  and Claude's per-project `disabledMcpServers` is not read.
- Also left for later: `startableOn()` does not quote for cmd, so a spaced command path with
  spaced arguments, or `&`, `|`, `^` in them, breaks; Claude expands `${VAR}` in the copied
  definition, which Codex does not; with an own entry that cannot run (http, or
  `enabled = false`), the panel falls back to the first sync folder in any entry.
- The setup notice still gives the running backend's `mcp add` line. Part 4 picks the line from
  the CLIs that are installed.

## Notes from Part 4

- Main keeps `agentId` and `agent` as variables. `switchAgent()` runs one switch at a time: it
  drops the old session's events, stops it, withdraws open approval cards, clears "allow until
  /new", resumes the new assistant's own conversation if it is fresh (history included), posts
  "Switched to …" and starts the new CLI. Before the first start (first run) it only changes
  the variables.
- `/claude`, `/codex` and the tray's Assistant submenu write `agent` with `playerWrite()` and
  apply it at once; the file watcher then sees no change.
- The approval server is needed by Claude only. When it cannot start, Codex still runs.
- `ApprovalBroker` returns `allowSession` for "allow until /new" and for a tool already allowed,
  so Codex answers `acceptForSession` without reading the broker's state afterwards.
- The ed-mcp "missing" notice for Codex comes from the config files: ed-mcp is there when Codex's
  own config runs one (`hasOwnEdMcp()`) or ED Chat gives it one, never from an empty `ready`.
  Its setup line is Claude's `mcp add` when Claude is installed, else Codex's.
- First run (no state.json yet, `agent` not in settings.json): only Codex installed picks
  Codex; both installed keeps Claude and says how to switch, once.
- A write ED Chat makes for the player (`/codex`, the permission question) trusts only the one
  value it sets: a change in the file still waiting for the player's answer stays there, and
  still waits.
- `describeUnknown` logs a Codex notification's method only, and skips the routine ones.
- `resumeHours` is player-only, as it was in the `claude` group.
- Still to do with the real CLI: how Codex reports a Windows sandbox that is not installed, and
  whether it sends `mcpServer/elicitation/request` before an ed-mcp tool in `default` mode
  (ED Chat declines those).

## Notes from Part 5

- `scrub-fixtures.mjs` scrubs `test/fixtures/codex/recorded-*.jsonl` too. It keeps the probe's
  `>> ` and `<< ` marks, and also reads plain JSON lines. An `account/*` or `remoteControl/*`
  message is removed with the answer to it (same id, the other way). Thread and turn ids stay.
- The home folder matches with either slash, any number of backslashes (JSON-escaped once or
  twice) and in any case. The user name, the commander name (a whole word, any case) and the
  FID are replaced in Claude and Codex fixtures. The commander name comes from `--commander`,
  `ED_COMMANDER` or the newest game journal, which also gives the FID. Keys are scrubbed too.
- The probe hardening from Part 2 is done, in `codex-probe.mjs`, with its pure parts exported
  and tested (`test/codexProbe.test.ts`). The script still runs as before.
  - The outDir check runs git without inherited `GIT_*` variables and in English. Only "not a
    git repository" accepts the folder; any other git answer or error refuses it. A path with a
    `.git` part, or a folder git calls a git dir (a bare repository), is refused.
  - A turn ends on the `turn/completed` with its own turn id, also when it came before the wait.
    The interrupt uses the id from the `turn/start` answer.
  - Each codex is stopped on every exit path: the end of a run, a failure, an uncaught error, a
    `process.exit` and Ctrl+C. On Windows `taskkill /T` stops the tree. When codex has already
    gone, its children (found by parent id, started after it) are stopped the same way.
    Elsewhere codex runs in its own process group, and the group is stopped.
  - cli-config mode puts ed-mcp's env into codex's own environment and names it in
    `mcp_servers.ed-mcp.env_vars`. No env value goes on the command line; ed-mcp's args do,
    so a secret passed as an arg is visible to other processes while the probe runs. Use
    config-field mode for such a setup.
  - Redaction matches each secret with either slash, any escaping of backslashes and quotes,
    and in any case. Secrets in ed-mcp's args are the value after a secret-looking flag
    (`--password x`) and the value of `--token=x` or `API_KEY=x`.
- Not done: a process whose parent and grandparent have both gone (ed-mcp's node when codex and
  cmd have both ended) is not found. A secret in ed-mcp's args with no flag name is not known
  as one. So recordings are still read by hand before they become fixtures.
- The scrubber replaces every commander found in the journals (a machine can have two game
  accounts), with their FIDs, and checks each file afterwards: a name or FID that is still
  there stops it with an error instead of "scrubbed".

## Follow-ups after Part 5

- The first real comparison (Opus 5.5 against gpt-6.1-terra at low effort) found that Codex
  asks before an MCP tool that is not read-only, with `mcpServer/elicitation/request` and
  `_meta.codex_approval_kind: "mcp_tool_call"` (with `tool_name`, `tool_params_display`).
  ED Chat declined every one, so ed-mcp tools such as `activity_set` failed. ED Chat now
  accepts these for ed-mcp in auto mode, and in Ask me mode brings them to the card, as Claude
  Code does; another server's tool always comes to the card, as `mcp__<server>__<tool>`.
  "Allow until /new" answers `persist: "session"` only when the request offers it. Any other
  elicitation is still declined.
- `claude.model` (default `sonnet`) and `codex.model` (default `gpt-6.1-terra`) choose the
  model; `null` leaves the CLI's own default. Both are player-only, as their groups are.
- compare-agents takes `--run <agent>[:model]`, more than once, to compare models; each run
  gets a fresh copy of settings.json, and the report names each run's model.
