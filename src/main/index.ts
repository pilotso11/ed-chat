import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { watchFile } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Menu,
  Tray,
  app,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
  type BrowserWindow,
} from "electron";
import { chooseDisplay, place, snap, step } from "../core/anchor.js";
import { ApprovalServer } from "../core/approvalServer.js";
import {
  TESTED_CLI_VERSION,
  buildClaudeArgs,
  edMcpState,
  isOlder,
  parseCliVersion,
  quoteForCmd,
  resolveClaude,
} from "../core/claudeCommand.js";
import { ClaudeSession, type BackendEvent } from "../core/claudeSession.js";
import {
  INITIAL_STATE,
  canOpenChat,
  currentApproval,
  currentChips,
  reduce,
  windowProps,
  type Action,
  type OverlayState,
  type Turn,
  type WindowProps,
} from "../core/controller.js";
import { FocusManager, type Foreground } from "../core/focus.js";
import {
  HotkeyManager,
  activeBindings,
  bindings,
  chordBinding,
  keyRows,
  type HotkeyAction,
} from "../core/hotkeys.js";
import { Logger } from "../core/logger.js";
import { setsKey, type Position, type Settings } from "../core/settings.js";
import { StatusWatcher, fullscreenMode } from "../core/status.js";
import {
  HistoryStore,
  SettingsStore,
  StateStore,
  effectivePosition,
  savePosition,
  type SavedState,
} from "../core/stores.js";
import { buildView, pickNotice, shortTool } from "../core/view.js";
import { IPC } from "../shared/ipc.js";
import {
  answerArg,
  boolArg,
  capLines,
  chipArg,
  describeUnknown,
  heightArg,
  hotkeysWanted,
  textArg,
} from "./guards.js";
import { loadWin32 } from "./win32.js";
import { applyWindow, createOverlayWindow } from "./window.js";

const dataDir = path.join(app.getPath("appData"), "ed-chat");
app.setPath("userData", dataDir);
const logDir = path.join(dataDir, "logs");
const log = new Logger(path.join(logDir, "overlay.log"));
const settingsFile = path.join(dataDir, "settings.json");

// A command in backticks is copied when the player clicks the notice.
const ED_MCP_MISSING =
  "⚠ ed-mcp not connected; click to copy `claude mcp add ed-mcp -s user -- cmd /c npx -y ed-mcp`";
const ED_MCP_FAILED = "⚠ ed-mcp failed to start; run `claude mcp list`";
const ED_MCP_AUTH = "⚠ ed-mcp needs authentication; run `claude mcp list`";
const SCOPE_GAME = "ⓘ hotkeys work while Elite is in front";
const COMMAND_COPIED = "📋 copied; paste it in a terminal";
const KEYS_SECONDS = 15;
const FULLSCREEN = "⚠ Elite is in fullscreen; switch to Borderless to see the overlay";
const NO_CLAUDE = "⚠ claude not found: install Claude Code or set claude.path";
const REFOCUS = "⚠ click the game to refocus";
const IN_DANGER = "⛔ in danger: chat blocked";
const NO_AUTO = "⚠ auto mode unavailable, using manual approvals";
const BUSY = "⚠ Claude is busy";
const GAVE_UP = "⚠ Claude keeps stopping";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function fatal(err: unknown): void {
  log.log("warn", `fatal: ${message(err)}`);
  dialog.showErrorBox("ed-chat", `ed-chat could not start: ${message(err)}`);
  app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(main).catch(fatal);

// Last resort: a stray rejection must not end the process while the player flies.
process.on("unhandledRejection", (err) => log.log("warn", `unhandled rejection: ${message(err)}`));

async function main(): Promise<void> {
  const settingsStore = new SettingsStore(settingsFile);
  const stateStore = new StateStore(path.join(dataDir, "state.json"));
  const history = new HistoryStore(path.join(dataDir, "history"));
  history.newSession();

  let state: OverlayState = INITIAL_STATE;
  let prevProps: WindowProps | null = null;
  let contentHeight = 48;
  let fadeTimer: NodeJS.Timeout | undefined;
  const timers = new Map<string, NodeJS.Timeout>();

  const first = await settingsStore.load();
  let settings: Settings = settingsStore.settings;
  let saved: SavedState = await stateStore.read();
  let position: Position;
  ({ position, saved } = effectivePosition(settings.position, saved));
  state = { ...state, iconMode: saved.iconMode ?? settings.strip.startAsIcon };

  const win: BrowserWindow = createOverlayWindow(
    path.join(import.meta.dirname, "../preload/index.cjs"),
    process.env.ELECTRON_RENDERER_URL,
    path.join(import.meta.dirname, "../renderer/index.html"),
  );

  const viewSettings = (): Settings => ({ ...settings, position });

  // When the approval on screen appeared; an answer key pressed just before that is ignored.
  let shownApproval: { id: string; at: number } | null = null;
  function render(): void {
    const req = currentApproval(state);
    if (req?.id !== shownApproval?.id) shownApproval = req ? { id: req.id, at: Date.now() } : null;
    const props = windowProps(state);
    applyWindow(win, props, prevProps);
    prevProps = props;
    win.webContents.send(IPC.view, buildView(state, viewSettings()));
  }

  // Disk writes must never take the overlay down: on Windows an antivirus or indexer can
  // hold state.json or a history file for a moment.
  function writeState(): void {
    stateStore.write(saved).catch((err) => log.log("warn", `state.json: ${message(err)}`));
  }
  function appendHistory(t: Turn): void {
    history.append(t).catch((err) => log.log("warn", `history: ${message(err)}`));
  }

  function dispatch(a: Action): void {
    const wasIcon = state.iconMode;
    state = reduce(state, a);
    if (state.iconMode !== wasIcon) {
      saved = { ...saved, iconMode: state.iconMode };
      writeState();
    }
    render();
  }

  // The card closes after a reply, and after a turn that ends without one.
  function scheduleFade(): void {
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(
      () => dispatch({ type: "cardTimeout" }),
      settings.card.fadeSeconds * 1000,
    );
  }

  function flash(key: string, text: string, ms = 4_000): void {
    clearTimeout(timers.get(key));
    dispatch({ type: "notice", key, text });
    timers.set(
      key,
      setTimeout(() => dispatch({ type: "notice", key, text: null }), ms),
    );
  }

  // Where reposition() last put the window, so its own moves are not taken as drags.
  let placed: { x: number; y: number } | null = null;
  // While the user drags, height updates must not put the window back at its anchor.
  let dragging = false;

  function reposition(): void {
    if (dragging) return;
    const display = chooseDisplay(
      screen.getAllDisplays(),
      screen.getPrimaryDisplay(),
      position.display,
    );
    const width = Math.round(settings.card.width * (settings.style.fontSize / 14));
    const size = { width, height: Math.max(24, Math.ceil(contentHeight)) };
    const { x, y } = place(
      position.anchor,
      position.offsetX,
      position.offsetY,
      display.workArea,
      size,
    );
    placed = { x, y };
    win.setBounds({ x, y, ...size });
  }

  // A window dropped by the user snaps to the nearest anchor, so it keeps its place
  // when the resolution or the content height changes. will-move fires only for user
  // moves. Windows sends one "moved" when the drag ends; macOS sends it during the drag,
  // so finish once the window has been still for a moment. The long timer only covers a
  // drag that never reports its end.
  let dragTimer: NodeJS.Timeout | undefined;
  function finishDrag(): void {
    dragging = false;
    const b = win.getBounds();
    // No real move: apply any height change that waited for the drag.
    if (placed && b.x === placed.x && b.y === placed.y) return reposition();
    const d = screen.getDisplayMatching(b);
    const display =
      d.id === screen.getPrimaryDisplay().id
        ? ("primary" as const)
        : Math.max(
            0,
            screen.getAllDisplays().findIndex((x) => x.id === d.id),
          );
    void movePosition({ ...position, ...snap(b, d.workArea), display });
  }
  win.on("will-move", () => {
    if (!state.chatOpen) return;
    dragging = true;
    clearTimeout(dragTimer);
    dragTimer = setTimeout(finishDrag, 2_000);
  });
  win.on("moved", () => {
    if (!dragging) return;
    clearTimeout(dragTimer);
    dragTimer = setTimeout(finishDrag, 250);
  });

  async function movePosition(next: Position): Promise<void> {
    position = next;
    saved = savePosition(settings.position, saved, position);
    writeState();
    reposition();
    render();
  }

  // Focus and topmost.
  const win32 = process.platform === "win32" ? loadWin32() : null;
  const overlayHwnd = () => {
    const b = win.getNativeWindowHandle();
    return b.length >= 8 ? Number(b.readBigUInt64LE()) : b.readUInt32LE();
  };
  const hotkeys = new HotkeyManager(
    {
      register: (acc, cb) => globalShortcut.register(acc, cb),
      unregister: (acc) => globalShortcut.unregister(acc),
    },
    (a) => runAction(a, "hotkey"),
  );
  // The full list is long; the strip gets the count and the tray menu lists each key.
  let failedHotkeys: string[] = [];
  function reportHotkeys(failed: string[]): void {
    failedHotkeys = failed;
    dispatch({
      type: "notice",
      key: "hotkeys",
      text: failed.length
        ? `⚠ ${failed.length} hotkey${failed.length > 1 ? "s" : ""} taken by other apps; see tray menu`
        : null,
    });
    if (state.keys) dispatch({ type: "keys", rows: keyRows(settings.hotkeys, hotkeys.failedKeys) });
  }

  let wasGame: boolean | null = null;
  function onForeground(f: Foreground): void {
    // For diagnosing game detection on the PC; only the flag and the process name are logged.
    if (f.isGame !== wasGame) {
      wasGame = f.isGame;
      log.log("info", `game in front: ${f.isGame} (${f.processName ?? "-"})`);
    }
    // Some games make their own borderless window topmost; the last activated topmost window wins.
    if (f.isGame) {
      win.setAlwaysOnTop(true, "screen-saver");
      win.moveTop();
    }
    syncHotkeys(f);
  }
  let overlayFocused = false;
  function bindHotkeys(): void {
    const active = activeBindings(
      bindings(settings.hotkeys),
      overlayFocused,
      settings.hotkeys.scope,
    );
    const failed = hotkeys.setBindings(active);
    // Inactive bindings report nothing; keep the last known problems until the next activation.
    if (hotkeys.active) reportHotkeys(failed);
  }

  function syncHotkeys(f: Foreground | null): void {
    if ((f?.isOverlay ?? false) !== overlayFocused) {
      overlayFocused = f?.isOverlay ?? false;
      bindHotkeys();
    }
    const want = hotkeysWanted(settings.hotkeys.scope, f);
    if (want && !hotkeys.active) reportHotkeys(hotkeys.activate());
    if (!want && hotkeys.active) hotkeys.deactivate();
    // Without this, a hotkey pressed away from the game does nothing and says nothing.
    const scopeNotice = want ? undefined : SCOPE_GAME;
    if (state.notices.scope !== scopeNotice)
      dispatch({ type: "notice", key: "scope", text: scopeNotice ?? null });
  }
  const focus = win32 ? new FocusManager(win32, { overlayHwnd, onChange: onForeground }) : null;

  async function giveFocusBack(): Promise<void> {
    if (focus && !(await focus.restore())) {
      log.log("warn", "focus restore refused");
      flash("focus", REFOCUS, 5_000);
    }
  }

  // Claude.
  const approval = new ApprovalServer({
    timeoutMs: settings.approval.timeoutSeconds * 1000,
    onRequest: (request) => {
      dispatch({ type: "approval", request });
      // The player's eyes are on the game; a sound says a request is waiting.
      if (settings.approval.sound) shell.beep();
    },
    onSettled: (id, outcome) => {
      const req = state.approvals.find((r) => r.id === id);
      dispatch({ type: "approvalSettled", id });
      if (outcome === "timeout" && req)
        flash("approval", `⛔ denied ${shortTool(req.toolName)}: no answer`, 6_000);
    },
    // The message only: the request body can hold chat text.
    onError: (err) => log.log("warn", `approval request failed: ${message(err)}`),
  });
  const mcpConfigFile = path.join(dataDir, "approval-mcp.json");
  const workspace = path.join(dataDir, "workspace");
  // Without the approval server Claude cannot ask for permission, so the overlay runs without Claude.
  let claudeBlocked: string | null = null;
  try {
    await approval.start();
  } catch (err) {
    log.log("warn", `approval server: ${message(err)}`);
    claudeBlocked = `⚠ Can't start the approval server: ${message(err)}`;
  }
  if (!claudeBlocked) {
    try {
      await writeFile(mcpConfigFile, JSON.stringify(approval.mcpConfig()));
      await mkdir(workspace, { recursive: true });
    } catch (err) {
      log.log("warn", `data folder: ${message(err)}`);
      claudeBlocked = `⚠ Can't write to ${dataDir}: ${message(err)}`;
    }
  }
  const noClaude = () => claudeBlocked ?? NO_CLAUDE;

  const claudeCommand = (s: Settings) => {
    if (claudeBlocked) return null;
    const resolved = resolveClaude(s.claude.path);
    if (!resolved) return null;
    const args = buildClaudeArgs({
      permissionMode: s.claude.permissionMode,
      mcpConfigFile,
      extraArgs: s.claude.extraArgs,
    });
    return { ...resolved, args };
  };

  let session: ClaudeSession | null = null;
  function startSession(c: { command: string; args: string[]; shell: boolean }): void {
    session = new ClaudeSession({
      command: c.command,
      args: c.args,
      shell: c.shell,
      cwd: workspace,
    });
    session.onEvent(onBackend);
    session.start();
    checkVersion(c.command, c.shell);
  }

  // Auto mode runs most tools without asking, so the player chooses once, before Claude starts.
  async function askPermissionMode(): Promise<void> {
    // A broken settings.json shows its own error; the question waits for a good file.
    if (first.error || setsKey(settingsStore.text, "claude", "permissionMode")) return;
    const r = await dialog.showMessageBox({
      type: "question",
      title: "ED Chat",
      message: "How should Claude run tools?",
      detail:
        "Ask me: the overlay shows each tool that Claude wants to run, and you allow or deny it " +
        "with a hotkey.\n\nAuto: Claude decides, and runs most tools without asking, including " +
        "commands that you ask for.\n\nYou can change this later in settings.json, " +
        "claude.permissionMode.",
      buttons: ["Ask me", "Auto"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    const mode = r.response === 1 ? "auto" : "default";
    try {
      await settingsStore.set("claude", "permissionMode", mode);
      await settingsStore.load();
      settings = settingsStore.settings;
    } catch (err) {
      log.log("warn", `settings.json: ${message(err)}`);
    }
  }
  await askPermissionMode();

  const cmd = claudeCommand(settings);
  if (cmd) startSession(cmd);
  else dispatch({ type: "notice", key: "claude", text: noClaude() });

  function onBackend(e: BackendEvent): void {
    dispatch({ type: "backend", event: e });
    switch (e.type) {
      case "ready":
        {
          const ed = edMcpState(e.mcpServers);
          dispatch({
            type: "notice",
            key: "edmcp",
            text:
              ed === "missing"
                ? ED_MCP_MISSING
                : ed === "failed"
                  ? ED_MCP_FAILED
                  : ed === "needsAuth"
                    ? ED_MCP_AUTH
                    : null,
          });
        }
        dispatch({
          type: "notice",
          key: "mode",
          text:
            settings.claude.permissionMode === "auto" &&
            e.permissionMode &&
            e.permissionMode !== "auto"
              ? NO_AUTO
              : null,
        });
        break;
      case "result":
        appendHistory({ role: "assistant", text: state.reply });
        scheduleFade();
        break;
      case "exit":
      case "gaveUp":
        scheduleFade();
        // stderr is kept for diagnosis; capped because it can quote request content.
        log.log("warn", `claude ${e.type}: ${capLines(e.stderrTail).join(" | ")}`);
        break;
      case "spawnError":
        scheduleFade();
        log.log("warn", `claude spawn error: ${e.message}`);
        break;
      case "unknown": {
        const d = describeUnknown(e.raw);
        if (d) log.log("debug", `unknown stream-json: ${d}`);
        break;
      }
    }
  }

  function checkVersion(command: string, shell: boolean): void {
    const file = shell ? quoteForCmd(command) : command;
    execFile(file, ["--version"], { shell, windowsHide: true }, (err, stdout) => {
      const v = err ? null : parseCliVersion(stdout);
      const tested = parseCliVersion(TESTED_CLI_VERSION)!;
      if (v && isOlder(v, tested)) {
        dispatch({
          type: "notice",
          key: "version",
          text: `⚠ claude ${v.join(".")} is older than ${TESTED_CLI_VERSION}; run \`claude update\``,
        });
      }
    });
  }

  function newConversation(): void {
    session?.newSession();
    history.newSession();
    approval.clearAllowed();
    dispatch({ type: "newSession" });
  }

  // A key that was on its way when the card appeared must not allow something unread.
  const ANSWER_GUARD_MS = 750;
  function answerApproval(id: string, a: "approve" | "deny" | "alwaysAllow"): void {
    const req = state.approvals.find((r) => r.id === id);
    if (!req) return;
    const early = shownApproval?.id === id && Date.now() - shownApproval.at < ANSWER_GUARD_MS;
    if (a !== "deny" && early) return;
    approval.answer(id, a === "deny" ? "deny" : "allow");
    if (a === "alwaysAllow") {
      approval.allowTool(req.toolName);
      // Requests for the same tool that already wait in the queue are allowed too.
      for (const r of state.approvals)
        if (r.toolName === req.toolName) approval.answer(r.id, "allow");
      flash("approval", `✓ ${shortTool(req.toolName)} allowed until /new`, 4_000);
    }
  }

  let keysTimer: NodeJS.Timeout | undefined;
  function showKeys(): void {
    clearTimeout(keysTimer);
    dispatch({ type: "keys", rows: keyRows(settings.hotkeys, hotkeys.failedKeys) });
    keysTimer = setTimeout(() => dispatch({ type: "keys", rows: null }), KEYS_SECONDS * 1000);
  }
  function hideKeys(): void {
    clearTimeout(keysTimer);
    dispatch({ type: "keys", rows: null });
  }

  async function send(text: string): Promise<boolean> {
    const t = text.trim();
    if (!t) return false;
    if (t === "/new") {
      newConversation();
      await giveFocusBack();
      dispatch({ type: "closeChat" });
      return true;
    }
    if (!session) {
      dispatch({ type: "notice", key: "claude", text: noClaude() });
      return false;
    }
    if (!session.send(t)) {
      flash("chat", session.busy ? BUSY : GAVE_UP);
      return false;
    }
    clearTimeout(fadeTimer);
    appendHistory({ role: "user", text: t });
    // "sent" first, so stream events that arrive during a focus retry land on this turn.
    dispatch({ type: "sent", text: t });
    // Give focus back before the window stops being focusable, while the overlay still holds the foreground.
    await giveFocusBack();
    dispatch({ type: "closeChat" });
    return true;
  }

  function copyChip(n: number): void {
    const chips = currentChips(state);
    const chip = chips[n - 1];
    if (!chip) {
      const has = chips.length ? `the reply has ${chips.length}` : "the reply has none";
      return flash("copy", `📋 no chip ${n}; ${has}`, 2_000);
    }
    clipboard.writeText(chip.text);
    flash("copy", `📋 copied ${chip.text}`, 2_000);
  }

  // Hotkeys and the tray share one error path: a failed action is logged, never fatal.
  function runAction(a: HotkeyAction, source: "hotkey" | "tray"): void {
    runHotkey(a).catch((err) => log.log("warn", `${source} ${a.type}: ${message(err)}`));
  }

  async function runHotkey(a: HotkeyAction): Promise<void> {
    switch (a.type) {
      case "openChat":
        if (!canOpenChat(state, settings.safety.blockWhenInDanger)) return flash("chat", IN_DANGER);
        focus?.save();
        return dispatch({ type: "openChat" });
      case "toggleOverlay":
        return dispatch({ type: "toggleVisible" });
      case "toggleIcon":
        return dispatch({ type: "toggleIcon" });
      case "showHistory":
        return dispatch({ type: "toggleHistory" });
      case "approve":
      case "deny":
      case "alwaysAllow": {
        const req = currentApproval(state);
        if (req) answerApproval(req.id, a.type);
        return;
      }
      case "showMore":
        if (!state.cardOpen) {
          dispatch({ type: "showMore" });
          return scheduleFade();
        }
        return dispatch({ type: "showMore" });
      case "cancel":
        if (!session?.busy) return;
        session.cancel();
        dispatch({ type: "cancelled" });
        return scheduleFade();
      case "copyChip":
        return copyChip(a.n);
      case "move":
        return movePosition({ ...position, anchor: step(position.anchor, a.dir) });
      case "nextDisplay": {
        const all = screen.getAllDisplays();
        const now =
          position.display === "primary"
            ? all.findIndex((d) => d.id === screen.getPrimaryDisplay().id)
            : position.display;
        return movePosition({ ...position, display: (Math.max(0, now) + 1) % all.length });
      }
    }
  }

  // Renderer IPC.
  // The renderer is sandboxed but still untrusted input; a bad value must not throw in main.
  ipcMain.handle(IPC.send, (_e, v: unknown) => {
    const text = textArg(v);
    return text === null ? false : send(text);
  });
  ipcMain.on(IPC.closeChat, () => {
    void giveFocusBack().then(() => dispatch({ type: "closeChat" }));
  });
  ipcMain.on(IPC.copyChip, (_e, v: unknown) => {
    const n = chipArg(v);
    if (n !== null) copyChip(n);
  });
  ipcMain.on(IPC.chord, (_e, v: unknown) => {
    const chord = textArg(v);
    const b = chord === null ? null : chordBinding(bindings(settings.hotkeys), chord);
    if (b) runAction(b.action, "hotkey");
  });
  // The open chat takes all clicks already; otherwise only a chip or the icon under the pointer does.
  ipcMain.on(IPC.hover, (_e, v: unknown) => {
    const over = boolArg(v);
    if (over === null || windowProps(state).interactive) return;
    win.setIgnoreMouseEvents(!over, { forward: true });
  });
  ipcMain.on(IPC.expand, () => {
    if (state.iconMode) dispatch({ type: "toggleIcon" });
  });
  // The card does not fade while the player reads it with the pointer on it.
  ipcMain.on(IPC.holdCard, (_e, v: unknown) => {
    const hold = boolArg(v);
    if (hold === null || !state.cardOpen || state.session === "thinking") return;
    if (hold) clearTimeout(fadeTimer);
    else scheduleFade();
  });
  ipcMain.on(IPC.copyNotice, () => {
    const command = pickNotice(state.notices)?.command;
    if (!command) return;
    clipboard.writeText(command);
    flash("copy", COMMAND_COPIED, 3_000);
  });
  ipcMain.on(IPC.showNotices, () => noticeMenu().popup({ window: win }));
  ipcMain.on(IPC.closeKeys, hideKeys);
  ipcMain.on(IPC.showMore, () => runAction({ type: "showMore" }, "hotkey"));
  ipcMain.on(IPC.answerApproval, (_e, id: unknown, a: unknown) => {
    const answer = answerArg(a);
    if (typeof id === "string" && answer) answerApproval(id, answer);
  });
  ipcMain.on(IPC.height, (_e, v: unknown) => {
    const h = heightArg(v);
    if (h === null) return;
    contentHeight = h;
    reposition();
  });
  win.webContents.on("did-finish-load", render);

  // Game files.
  const journalDir = (s: Settings) =>
    s.journalDir ??
    path.join(os.homedir(), "Saved Games", "Frontier Developments", "Elite Dangerous");
  let status = new StatusWatcher(path.join(journalDir(settings), "Status.json"), (flags) =>
    dispatch({ type: "flags", flags }),
  );
  status.start();

  const displayXml = path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    "Frontier Developments",
    "Elite Dangerous",
    "Options",
    "Graphics",
    "DisplaySettings.xml",
  );
  const checkFullscreen = async () => {
    const xml = await readFile(displayXml, "utf8").catch(() => "");
    dispatch({
      type: "notice",
      key: "fullscreen",
      text: fullscreenMode(xml) === "fullscreen" ? FULLSCREEN : null,
    });
  };
  void checkFullscreen();
  watchFile(displayXml, { interval: 5_000 }, () => void checkFullscreen());

  // Settings, live.
  function applySettings(): void {
    bindHotkeys();
    syncHotkeys(focus?.current ?? null);
    approval.setTimeoutMs(settings.approval.timeoutSeconds * 1000);
    reposition();
    render();
  }
  if (first.error) dispatch({ type: "notice", key: "settings", text: first.error });
  applySettings();
  settingsStore.watch((r) => {
    dispatch({ type: "notice", key: "settings", text: r.error });
    if (!r.changed) return;
    const old = settings;
    settings = settingsStore.settings;
    ({ position, saved } = effectivePosition(settings.position, saved));
    writeState();
    if (JSON.stringify(old.claude) !== JSON.stringify(settings.claude)) {
      const c = claudeCommand(settings);
      dispatch({ type: "notice", key: "claude", text: c ? null : noClaude() });
      if (c && session) {
        session.configure(c);
        flash("claudeSettings", "ⓘ claude settings apply after /new", 6_000);
      } else if (c) startSession(c);
    }
    if (journalDir(old) !== journalDir(settings)) {
      status.stop();
      // Flags from the old journal folder no longer describe the ship.
      dispatch({ type: "flags", flags: null });
      status = new StatusWatcher(path.join(journalDir(settings), "Status.json"), (flags) =>
        dispatch({ type: "flags", flags }),
      );
      status.start();
    }
    applySettings();
  });

  // Tray: the only way to quit, since the overlay has no window frame.
  const openPath = (p: string) =>
    void shell.openPath(p).then((err) => {
      if (err) log.log("warn", `open ${path.basename(p)}: ${err}`);
    });
  const trayIconFile = app.isPackaged
    ? path.join(process.resourcesPath, "tray.png")
    : path.join(app.getAppPath(), "resources", "tray.png");
  // A menu label treats & as a mnemonic marker.
  const label = (s: string) => s.replace(/&/g, "&&");

  function showHotkeyProblems(): void {
    void dialog
      .showMessageBox({
        type: "warning",
        title: "ED Chat",
        message: "Other apps already use these keys, so ED Chat could not register them.",
        detail:
          failedHotkeys.join("\n") +
          "\n\nSet other keys in settings.json, under hotkeys. Each setting takes one key or a list.",
        buttons: ["Open settings", "OK"],
        defaultId: 1,
      })
      .then((r) => {
        if (r.response === 0) openPath(settingsFile);
      });
  }

  function noticeMenu(): Menu {
    return Menu.buildFromTemplate(
      Object.values(state.notices).map((text) => {
        const command = /`([^`]+)`/.exec(text)?.[1];
        return {
          label: label(command ? `${text.replace(/`/g, "")}  (click to copy)` : text),
          click: () => {
            if (!command) return;
            clipboard.writeText(command);
            flash("copy", COMMAND_COPIED, 3_000);
          },
        };
      }),
    );
  }

  // Built when opened, so the chips and problems are current.
  function trayMenu(): Menu {
    const chips = currentChips(state);
    const tray = (a: HotkeyAction) => () => runAction(a, "tray");
    return Menu.buildFromTemplate([
      ...chips.map((c) => ({
        label: label(`Copy ${c.n}: ${c.text}`),
        click: () => copyChip(c.n),
      })),
      ...(chips.length ? [{ type: "separator" as const }] : []),
      { label: "Open chat", click: tray({ type: "openChat" }) },
      { label: "New conversation", click: newConversation },
      { label: "Show hotkeys", click: showKeys },
      ...(failedHotkeys.length
        ? [{ label: `Hotkey problems (${failedHotkeys.length})…`, click: showHotkeyProblems }]
        : []),
      { type: "separator" },
      {
        label: "Icon mode",
        type: "checkbox",
        checked: state.iconMode,
        click: tray({ type: "toggleIcon" }),
      },
      // Minimized, the overlay still shows the chat and approvals, and the hotkeys still work.
      {
        label: state.visible ? "Minimize to tray" : "Restore overlay",
        click: () => {
          runAction({ type: "toggleOverlay" }, "tray");
          trayIcon.setToolTip(state.visible ? "ED Chat" : "ED Chat (minimized)");
        },
      },
      { label: "Open settings", click: () => openPath(settingsFile) },
      { label: "Open log folder", click: () => openPath(logDir) },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]);
  }

  const trayIcon = new Tray(nativeImage.createFromPath(trayIconFile));
  trayIcon.setToolTip("ED Chat");
  // Left and right click open the same menu.
  const popTray = () => trayIcon.popUpContextMenu(trayMenu());
  trayIcon.on("click", popTray);
  trayIcon.on("right-click", popTray);

  screen.on("display-removed", reposition);
  screen.on("display-metrics-changed", reposition);
  app.on("second-instance", () => {
    if (!state.visible) dispatch({ type: "toggleVisible" });
  });
  focus?.start();
  render();
  log.log("info", `started; claude ${cmd ? cmd.command : "not found"}`);
  // After the first foreground check, so the list shows which keys other apps hold.
  if (settings.startup.showKeys) setTimeout(showKeys, 1_000);

  app.on("will-quit", () => {
    trayIcon.destroy();
    globalShortcut.unregisterAll();
    focus?.stop();
    status.stop();
    settingsStore.unwatch();
    session?.stop();
    void approval.stop();
  });
}
