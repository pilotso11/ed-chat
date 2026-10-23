import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { watchFile } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  app,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  type BrowserWindow,
} from "electron";
import { chooseDisplay, place, step } from "../core/anchor.js";
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
  type WindowProps,
} from "../core/controller.js";
import { FocusManager, type Foreground } from "../core/focus.js";
import { HotkeyManager, bindings, type HotkeyAction } from "../core/hotkeys.js";
import { Logger } from "../core/logger.js";
import type { Position, Settings } from "../core/settings.js";
import { StatusWatcher, fullscreenMode } from "../core/status.js";
import {
  HistoryStore,
  SettingsStore,
  StateStore,
  effectivePosition,
  savePosition,
  type SavedState,
} from "../core/stores.js";
import { buildView } from "../core/view.js";
import { IPC } from "../shared/ipc.js";
import { capLines, chipArg, describeUnknown, heightArg, hotkeysWanted, textArg } from "./guards.js";
import { loadWin32 } from "./win32.js";
import { applyWindow, createOverlayWindow } from "./window.js";

const dataDir = path.join(app.getPath("appData"), "ed-overlay");
app.setPath("userData", dataDir);
const log = new Logger(path.join(dataDir, "logs", "overlay.log"));

const ED_MCP_MISSING =
  "⚠ ed-mcp not connected. Run: claude mcp add ed-mcp -s user -- npx -y ed-mcp";
const ED_MCP_FAILED = "⚠ ed-mcp failed to start; run claude mcp list";
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
  dialog.showErrorBox("ed-overlay", `ed-overlay could not start: ${message(err)}`);
  app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(main).catch(fatal);

async function main(): Promise<void> {
  const settingsStore = new SettingsStore(path.join(dataDir, "settings.json"));
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

  const win: BrowserWindow = createOverlayWindow(
    path.join(import.meta.dirname, "../preload/index.cjs"),
    process.env.ELECTRON_RENDERER_URL,
    path.join(import.meta.dirname, "../renderer/index.html"),
  );

  const viewSettings = (): Settings => ({ ...settings, position });

  function render(): void {
    const props = windowProps(state);
    applyWindow(win, props, prevProps);
    prevProps = props;
    win.webContents.send(IPC.view, buildView(state, viewSettings()));
  }

  function dispatch(a: Action): void {
    state = reduce(state, a);
    render();
  }

  function flash(key: string, text: string, ms = 4_000): void {
    clearTimeout(timers.get(key));
    dispatch({ type: "notice", key, text });
    timers.set(
      key,
      setTimeout(() => dispatch({ type: "notice", key, text: null }), ms),
    );
  }

  function reposition(): void {
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
    win.setBounds({ x, y, ...size });
  }

  async function movePosition(next: Position): Promise<void> {
    position = next;
    saved = savePosition(settings.position, saved, position);
    await stateStore.write(saved);
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
    (a) => void runHotkey(a),
  );
  const reportHotkeys = (failed: string[]) =>
    dispatch({
      type: "notice",
      key: "hotkeys",
      text: failed.length ? `⚠ hotkeys not registered: ${failed.join(", ")}` : null,
    });

  function onForeground(f: Foreground): void {
    // Some games make their own borderless window topmost; the last activated topmost window wins.
    if (f.isGame) {
      win.setAlwaysOnTop(true, "screen-saver");
      win.moveTop();
    }
    syncHotkeys(f);
  }
  function syncHotkeys(f: Foreground | null): void {
    const want = hotkeysWanted(settings.hotkeys.scope, f);
    if (want && !hotkeys.active) reportHotkeys(hotkeys.activate());
    if (!want && hotkeys.active) hotkeys.deactivate();
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
    onRequest: (request) => dispatch({ type: "approval", request }),
    onSettled: (id) => dispatch({ type: "approvalSettled", id }),
    // The message only: the request body can hold chat text.
    onError: (err) => log.log("warn", `approval request failed: ${message(err)}`),
  });
  const mcpConfigFile = path.join(dataDir, "approval-mcp.json");
  const workspace = path.join(dataDir, "workspace");
  // Without the approval server Claude cannot ask for permission, so the overlay runs without Claude.
  let claudeBlocked: string | null = null;
  try {
    await approval.start();
    await writeFile(mcpConfigFile, JSON.stringify(approval.mcpConfig()));
    await mkdir(workspace, { recursive: true });
  } catch (err) {
    log.log("warn", `approval server: ${message(err)}`);
    claudeBlocked = `⚠ Can't start the approval server: ${message(err)}`;
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
            text: ed === "missing" ? ED_MCP_MISSING : ed === "failed" ? ED_MCP_FAILED : null,
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
        void history.append({ role: "assistant", text: state.reply });
        clearTimeout(fadeTimer);
        fadeTimer = setTimeout(
          () => dispatch({ type: "cardTimeout" }),
          settings.card.fadeSeconds * 1000,
        );
        break;
      case "exit":
      case "gaveUp":
        // stderr is kept for diagnosis; capped because it can quote request content.
        log.log("warn", `claude ${e.type}: ${capLines(e.stderrTail).join(" | ")}`);
        break;
      case "spawnError":
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
          text: `⚠ claude ${v.join(".")} is older than ${TESTED_CLI_VERSION}; update Claude Code`,
        });
      }
    });
  }

  async function send(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return;
    if (t === "/new") {
      session?.newSession();
      history.newSession();
      await giveFocusBack();
      dispatch({ type: "newSession" });
      dispatch({ type: "closeChat" });
      return;
    }
    if (!session) {
      dispatch({ type: "notice", key: "claude", text: noClaude() });
      return;
    }
    if (!session.send(t)) return flash("chat", session.busy ? BUSY : GAVE_UP);
    clearTimeout(fadeTimer);
    void history.append({ role: "user", text: t });
    // Give focus back before the window stops being focusable, while the overlay still holds the foreground.
    await giveFocusBack();
    dispatch({ type: "sent", text: t });
  }

  function copyChip(n: number): void {
    const chip = currentChips(state)[n - 1];
    if (!chip) return;
    clipboard.writeText(chip.text);
    flash("copy", `📋 copied ${chip.text}`, 2_000);
  }

  async function runHotkey(a: HotkeyAction): Promise<void> {
    switch (a.type) {
      case "openChat":
        if (!canOpenChat(state, settings.safety.blockWhenInDanger)) return flash("chat", IN_DANGER);
        focus?.save();
        return dispatch({ type: "openChat" });
      case "toggleOverlay":
        return dispatch({ type: "toggleVisible" });
      case "showHistory":
        return dispatch({ type: "toggleHistory" });
      case "approve":
      case "deny": {
        const req = currentApproval(state);
        if (req) approval.answer(req.id, a.type === "approve" ? "allow" : "deny");
        return;
      }
      case "cancel":
        if (!session?.busy) return;
        session.cancel();
        return dispatch({ type: "cancelled" });
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
  ipcMain.on(IPC.send, (_e, v: unknown) => {
    const text = textArg(v);
    if (text !== null) void send(text);
  });
  ipcMain.on(IPC.closeChat, () => {
    void giveFocusBack().then(() => dispatch({ type: "closeChat" }));
  });
  ipcMain.on(IPC.copyChip, (_e, v: unknown) => {
    const n = chipArg(v);
    if (n !== null) copyChip(n);
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
    reportHotkeys(hotkeys.setBindings(bindings(settings.hotkeys)));
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
    void stateStore.write(saved);
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

  screen.on("display-removed", reposition);
  screen.on("display-metrics-changed", reposition);
  app.on("second-instance", () => {
    if (!state.visible) dispatch({ type: "toggleVisible" });
  });
  focus?.start();
  render();
  log.log("info", `started; claude ${cmd ? cmd.command : "not found"}`);

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    focus?.stop();
    status.stop();
    settingsStore.unwatch();
    session?.stop();
    void approval.stop();
  });
}
