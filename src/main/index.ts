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
import { chipLabel, withTargets, type Chip, type StopTarget } from "../core/chips.js";
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
  answerAllowed,
  canOpenChat,
  escapeAction,
  stepAction,
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
import { HUD_MODES, keyList, setsKey, type Position, type Settings } from "../core/settings.js";
import { StatusWatcher, fullscreenMode } from "../core/status.js";
import {
  HistoryStore,
  SettingsStore,
  StateStore,
  effectiveHudPosition,
  effectivePosition,
  saveHudPosition,
  savePosition,
  type SavedState,
} from "../core/stores.js";
import { resumeId } from "../core/resume.js";
import { openStores } from "ed-mcp/journal";
import { edMcpSyncDir } from "../core/hud/edMcpConfig.js";
import { HudFeed, type FeedData } from "../core/hud/feed.js";
import { KnownBodies, fetchSpansh } from "../core/hud/known.js";
import { buildHud, currentMode, type HudView } from "../core/hud/hud.js";
import { gameContext, noteIsFresh, withGameContext } from "../core/hud/context.js";
import { HUD_EVENTS, cycleMode } from "../core/hud/mode.js";
import { currentStop, nextStopAfter, previousStop, todoStops } from "../core/hud/panels.js";
import {
  describeChanges,
  keepPlayerOnly,
  playerOnlyChanges,
  restorePaths,
} from "../core/playerOnly.js";
import { buildView, noticeCommand, pickNotice, shortTool } from "../core/view.js";
import { fetchLatestEdMcp, versionText, type Versions } from "../core/version.js";
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
  "⚠ ed-mcp not connected; click to copy `claude mcp add ed-mcp -s user -- cmd /c npx -y ed-mcp@latest`";
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
const RESUMED = "↺ resumed your last conversation";
const RESUME_FAILED = "ⓘ could not resume the last conversation; started a new one";

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

  let state: OverlayState = INITIAL_STATE;
  let prevProps: WindowProps | null = null;
  let contentHeight = 48;
  let fadeTimer: NodeJS.Timeout | undefined;
  const timers = new Map<string, NodeJS.Timeout>();

  const first = await settingsStore.load();
  // The file as it was when the player-only settings now in use were applied; Undo puts
  // them back from it. ED Chat trusts the file it starts with.
  let trustedText = settingsStore.text;
  let settings: Settings = settingsStore.settings;
  let saved: SavedState = await stateStore.read();
  let position: Position;
  ({ position, saved } = effectivePosition(settings.position, saved));
  state = { ...state, iconMode: saved.iconMode ?? settings.strip.startAsIcon };
  // The conversation from the last run, used by the first session only.
  let resumeFrom = resumeId(saved.session, new Date(), settings.claude.resumeHours);
  const resumedTurns =
    resumeFrom && saved.session?.history ? await history.resume(saved.session.history) : [];
  if (!history.fileName) history.newSession();
  state = { ...state, history: resumedTurns, resumedTurns: resumedTurns.length };

  const win: BrowserWindow = createOverlayWindow(
    path.join(import.meta.dirname, "../preload/index.cjs"),
    process.env.ELECTRON_RENDERER_URL,
    path.join(import.meta.dirname, "../renderer/index.html"),
  );

  // The activity panel: a second click-through window with its own place on screen.
  const hudWin: BrowserWindow = createOverlayWindow(
    path.join(import.meta.dirname, "../preload/index.cjs"),
    process.env.ELECTRON_RENDERER_URL && `${process.env.ELECTRON_RENDERER_URL}/hud.html`,
    path.join(import.meta.dirname, "../renderer/hud.html"),
  );
  let hudPosition: Position;
  ({ position: hudPosition, saved } = effectiveHudPosition(settings.hud.position, saved));

  const viewSettings = (): Settings => ({ ...settings, position });

  // When the approval on screen appeared; an answer key pressed just before that is ignored.
  let shownApproval: { id: string; at: number } | null = null;
  // The route stops still to do, current first: chips in their systems show the body or station.
  let chipStops: StopTarget[] = [];
  function render(): void {
    const req = currentApproval(state);
    if (req?.id !== shownApproval?.id) shownApproval = req ? { id: req.id, at: Date.now() } : null;
    const props = windowProps(state);
    applyWindow(win, props, prevProps);
    prevProps = props;
    const view = buildView(state, viewSettings());
    const t = (c: Chip[]) => withTargets(c, chipStops);
    win.webContents.send(IPC.view, {
      ...view,
      chips: t(view.chips),
      card: view.card && { ...view.card, chips: t(view.card.chips) },
      chat: view.chat && { ...view.chat, chips: t(view.chat.chips) },
    });
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
  // The pointer is on the card. Kept even while a reply streams, so the fade that the result
  // schedules waits until the pointer leaves.
  let cardHeld = false;
  function scheduleFade(): void {
    clearTimeout(fadeTimer);
    if (cardHeld) return;
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
      hudWin.setAlwaysOnTop(true, "screen-saver");
      hudWin.moveTop();
    }
    syncHotkeys(f);
    renderHud();
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

  /** False when Windows refused; the strip then says to click the game. */
  async function giveFocusBack(): Promise<boolean> {
    if (!focus || (await focus.restore())) return true;
    log.log("warn", "focus restore refused");
    flash("focus", REFOCUS, 5_000);
    return false;
  }

  /**
   * After the chat window has closed: Windows can report the hand-back as done and still leave
   * the game in the background, so check, retry once, and say so when it still fails.
   */
  async function settleFocus(): Promise<void> {
    const r = await focus?.settle();
    if (!r) return;
    if (r.result === "ok") return;
    if (r.result === "retried") return log.log("info", "focus back: needed a second try");
    log.log("warn", `focus back failed; in front: ${r.foreground ?? "-"}`);
    flash("focus", REFOCUS, 5_000);
  }

  // Activity panel.
  let hudSize = { width: 0, height: 0 };
  let hudData: FeedData | null = null;
  // The panel's last view, for the game note sent with each message.
  let lastHudView: HudView | null = null;
  // When the feed last read the game, so a note is never sent from a stopped feed.
  let hudFreshAt = 0;
  let hudMoving = false;
  let hudMoveTimer: NodeJS.Timeout | undefined;
  let hudShown = false;
  let hudMode: string | null = null;
  const HUD_MOVE_SECONDS = 15;

  function placeHud(): void {
    const display = chooseDisplay(
      screen.getAllDisplays(),
      screen.getPrimaryDisplay(),
      hudPosition.display,
    );
    // The panel is at least hud.width wide, and grows so long names fit, up to the screen width.
    const least = Math.round(settings.hud.width * (settings.hud.fontSize / 15));
    const width = Math.min(display.workArea.width, Math.max(least, Math.ceil(hudSize.width)));
    const size = { width, height: Math.max(8, Math.ceil(hudSize.height)) };
    const { x, y } = place(
      hudPosition.anchor,
      hudPosition.offsetX,
      hudPosition.offsetY,
      display.workArea,
      size,
    );
    hudWin.setBounds({ x, y, ...size });
  }

  const hudChoice = () =>
    saved.hudMode ? { mode: saved.hudMode.mode, at: Date.parse(saved.hudMode.at) } : null;

  function renderHud(): void {
    const input = {
      journal: null,
      status: null,
      nav: null,
      activity: null,
      plan: null,
      samples: new Map(),
      known: null,
      ...hudData,
      hotkey: hudChoice(),
      settings: settings.hud,
      now: Date.now(),
    };
    const k = settings.hotkeys;
    const first = (x: Parameters<typeof keyList>[0]) => keyList(x)[0];
    const moveHint = hudMoving
      ? `Move panel: ${first(k.moveUp)} / ${first(k.moveDown)} / ${first(k.moveLeft)} / ${first(k.moveRight)} · monitor ${first(k.nextDisplay)}`
      : null;
    const view = buildHud(input, moveHint);
    lastHudView = view;
    const mode = String(currentMode(input));
    if (mode !== hudMode) {
      hudMode = mode;
      log.log("info", `panel mode: ${mode}`);
    }
    const f = focus?.current ?? null;
    // Shown over the game only, like the hotkeys in game scope.
    const gameUp = !f || f.isGame || f.isOverlay;
    const show =
      settings.hud.enabled &&
      !saved.hudHidden &&
      gameUp &&
      (view.panel !== null || view.route !== null || hudMoving);
    hudWin.webContents.send(IPC.hud, view);
    if (show !== hudShown) {
      hudShown = show;
      if (show) hudWin.showInactive();
      else hudWin.hide();
      log.log("debug", `panel ${show ? "shown" : "hidden"} ${JSON.stringify(hudWin.getBounds())}`);
    }
  }

  let hudFeed: HudFeed | null = null;
  const knownBodies = new KnownBodies(fetchSpansh, {
    onError: (m) => log.log("warn", `panel spansh: ${m}`),
  });
  let hudPlans: ReturnType<typeof openStores>["plans"] | null = null;
  async function openHudFeed(): Promise<void> {
    let syncDir = settings.hud.edMcpDataDir;
    if (!syncDir) {
      const text = await readFile(path.join(os.homedir(), ".claude.json"), "utf8").catch(() => "");
      syncDir = edMcpSyncDir(text);
    }
    const stores = openStores(
      { ED_JOURNAL_DIR: journalDir(settings), ED_MCP_SYNC_DIR: syncDir ?? undefined },
      { keep: HUD_EVENTS },
    );
    hudFeed = new HudFeed(stores, journalDir(settings), {
      onError: (what, m) => log.log("warn", `panel ${what}: ${m}`),
      known: settings.hud.spansh ? knownBodies : undefined,
    });
    hudPlans = stores.plans;
    log.log("info", `panel data: ${syncDir ? "ed-mcp sync folder" : "ed-mcp config folder"}`);
  }

  let hudPolling = false;
  let lastSystem: string | null = null;
  async function pollHud(): Promise<void> {
    if (hudPolling || !hudFeed || !settings.hud.enabled) return;
    hudPolling = true;
    try {
      hudData = await hudFeed.poll();
      hudFreshAt = Date.now();
      const stops = todoStops(hudData.plan);
      if (JSON.stringify(stops) !== JSON.stringify(chipStops)) {
        chipStops = stops;
        render();
      }
      const system = hudData.journal?.location.system ?? null;
      if (system && lastSystem && system !== lastSystem) onArrival(system);
      lastSystem = system;
      renderHud();
    } catch (err) {
      log.log("warn", `panel: ${message(err)}`);
    } finally {
      hudPolling = false;
    }
  }

  // Arriving in the current stop's system copies the next stop's system for the galaxy map.
  function onArrival(system: string): void {
    const plan = hudData?.plan;
    if (!plan) return;
    const i = currentStop(plan);
    if (i === null || plan.stops[i]!.system.toLowerCase() !== system.toLowerCase()) return;
    const j = nextStopAfter(plan, i);
    if (j === null) return;
    const next = plan.stops[j]!;
    clipboard.writeText(next.system);
    flash("copy", `📋 next stop copied: ${next.system}`, 4_000);
  }

  async function stepRoute(dir: 1 | -1): Promise<void> {
    const plan = hudData?.plan;
    if (!plan || !hudPlans) return flash("route", "ⓘ no active route plan", 3_000);
    const i = currentStop(plan);
    if (dir === 1) {
      if (i === null) return flash("route", "ⓘ route finished", 3_000);
      await hudPlans.updateStop(plan.id, { index: i }, { status: "done" });
    } else {
      // The stop done last before the current one, in visit order, goes back to todo.
      const prev = previousStop(plan);
      if (prev === null) return flash("route", "ⓘ at the first stop", 3_000);
      await hudPlans.updateStop(plan.id, { index: prev }, { status: "todo" });
    }
    // Read the plan back rather than through pollHud(), which skips while the timer's poll runs
    // and would leave the plan from before the change.
    const now = await hudPlans.get(plan.id).catch(() => null);
    void pollHud();
    const cur = now ? currentStop(now) : null;
    if (now && cur !== null) {
      clipboard.writeText(now.stops[cur]!.system);
      flash("copy", `📋 copied ${now.stops[cur]!.system}`, 3_000);
    }
  }

  function setHudMoving(on: boolean): void {
    clearTimeout(hudMoveTimer);
    hudMoving = on;
    if (on) hudMoveTimer = setTimeout(() => setHudMoving(false), HUD_MOVE_SECONDS * 1000);
    renderHud();
  }

  function moveHud(next: Position): void {
    hudPosition = next;
    saved = saveHudPosition(settings.hud.position, saved, hudPosition);
    writeState();
    placeHud();
    setHudMoving(true);
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
      settingsFile,
    });
    return { ...resolved, args };
  };

  let session: ClaudeSession | null = null;
  let resumePending = false;
  // For /version.
  let claudeVersion: string | null = null;
  let edMcpStatus: Versions["edMcpStatus"] = null;
  function startSession(c: { command: string; args: string[]; shell: boolean }): void {
    session = new ClaudeSession({
      command: c.command,
      args: c.args,
      shell: c.shell,
      cwd: workspace,
      resumeId: resumeFrom,
    });
    // Shown at the first ready: the CLI confirms the conversation only then.
    resumePending = resumeFrom !== null;
    resumeFrom = null;
    session.onEvent(onBackend);
    session.start();
    checkVersion(c.command, c.shell);
  }

  // Auto mode runs most tools without asking, so the player chooses once, before Claude starts.
  async function askPermissionMode(): Promise<void> {
    // A broken settings.json shows its own error; the question waits for a good file.
    if (settingsStore.broken || setsKey(settingsStore.text, "claude", "permissionMode")) return;
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
      trustedText = settingsStore.text;
    } catch (err) {
      // The choice still holds for this run; the player sees that it was not saved.
      log.log("warn", `settings.json: ${message(err)}`);
      settings = { ...settings, claude: { ...settings.claude, permissionMode: mode } };
      dispatch({
        type: "notice",
        key: "settings",
        text: `⚠ settings.json: could not save ${mode} mode`,
      });
    }
  }
  // Runs after the tray exists: the question can open behind a fullscreen game, and the tray is
  // how the player quits. Settings reloads start no session before the answer.
  let claudeStarted = false;
  async function startClaude(): Promise<void> {
    await askPermissionMode();
    claudeStarted = true;
    const cmd = claudeCommand(settings);
    log.log("info", `started; claude ${cmd ? cmd.command : "not found"}`);
    if (session) return;
    if (cmd) startSession(cmd);
    else dispatch({ type: "notice", key: "claude", text: noClaude() });
  }

  function onBackend(e: BackendEvent): void {
    dispatch({ type: "backend", event: e });
    switch (e.type) {
      case "ready":
        if (resumePending) {
          resumePending = false;
          flash("resume", RESUMED, 6_000);
        }
        {
          const ed = edMcpState(e.mcpServers);
          edMcpStatus = ed;
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
        // An error reply still counts as use: the conversation exists and was used just now.
        if (e.sessionId && history.fileName) {
          saved = {
            ...saved,
            session: {
              id: e.sessionId,
              lastUsed: new Date().toISOString(),
              history: history.fileName,
            },
          };
          writeState();
        }
        break;
      case "resumeFailed":
        resumePending = false;
        history.newSession();
        // The reducer dropped the old conversation's turns; what is left is the question in
        // flight, which the new conversation answers, so it starts the new file.
        for (const t of state.history) appendHistory(t);
        saved = { ...saved, session: undefined };
        writeState();
        flash("resume", RESUME_FAILED, 6_000);
        log.log(
          "info",
          `could not resume the saved conversation: ${capLines(e.stderrTail).join(" | ")}`,
        );
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
      claudeVersion = v ? v.join(".") : null;
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
    resumePending = false;
    saved = { ...saved, session: undefined };
    writeState();
    approval.clearAllowed();
    dispatch({ type: "newSession" });
  }

  function answerApproval(id: string, a: "approve" | "deny" | "alwaysAllow"): void {
    const req = state.approvals.find((r) => r.id === id);
    if (!req) return;
    if (!answerAllowed(a, id, shownApproval, Date.now())) return;
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

  // The npm lookup is cached, so asking again does not wait on the network.
  let edMcpLatest: { version: string | null; at: number } | null = null;
  const LATEST_TTL_MS = 10 * 60_000;

  function showVersion(): boolean {
    if (state.session === "thinking") {
      flash("chat", "⚠ wait for the reply, then ask for /version", 4_000);
      return false;
    }
    const base: Omit<Versions, "edMcpLatest"> = {
      app: app.getVersion(),
      claude: claudeVersion,
      edMcpStatus,
    };
    const cached = edMcpLatest && Date.now() - edMcpLatest.at < LATEST_TTL_MS ? edMcpLatest : null;
    const first = versionText({ ...base, edMcpLatest: cached ? cached.version : "checking" });
    dispatch({ type: "localReply", text: first });
    scheduleFade();
    if (!cached) {
      void fetchLatestEdMcp().then((version) => {
        edMcpLatest = { version, at: Date.now() };
        dispatch({
          type: "localReply",
          text: versionText({ ...base, edMcpLatest: version }),
          replaces: first,
        });
      });
    }
    return true;
  }

  async function send(text: string): Promise<boolean> {
    const t = text.trim();
    if (!t) return false;
    // ED Chat's own commands. They do not reach Claude.
    if (t === "/new" || t === "/version") {
      if (t === "/new") newConversation();
      else if (!showVersion()) return false;
      const ok = await giveFocusBack();
      dispatch({ type: "closeChat" });
      if (ok) void settleFocus();
      return true;
    }
    if (!session) {
      dispatch({ type: "notice", key: "claude", text: noClaude() });
      return false;
    }
    const fresh = noteIsFresh(settings.hud.enabled, hudFreshAt, Date.now());
    const where = fresh ? (hudData?.journal?.location ?? null) : null;
    const note = fresh ? gameContext(where, hudData?.status ?? null, lastHudView) : null;
    if (!session.send(withGameContext(t, note))) {
      flash("chat", session.busy ? BUSY : GAVE_UP);
      return false;
    }
    clearTimeout(fadeTimer);
    appendHistory({ role: "user", text: t });
    // "sent" first, so stream events that arrive during a focus retry land on this turn.
    dispatch({ type: "sent", text: t });
    // Give focus back before the window stops being focusable, while the overlay still holds the foreground.
    const ok = await giveFocusBack();
    dispatch({ type: "closeChat" });
    if (ok) void settleFocus();
    return true;
  }

  function copyChip(n: number): void {
    const chips = withTargets(currentChips(state), chipStops);
    const chip = chips[n - 1];
    if (!chip) {
      const has = chips.length ? `the reply has ${chips.length}` : "the reply has none";
      return flash("copy", `📋 no chip ${n}; ${has}`, 2_000);
    }
    clipboard.writeText(chip.text);
    flash("copy", `📋 copied ${chip.text}${chip.detail ? ` (for ${chip.detail})` : ""}`, 2_000);
  }

  // The player starts reading now, so the card gets a full fade time. A reply still arriving
  // does not fade; its end starts the fade.
  function refreshFade(): void {
    if (state.session !== "thinking") scheduleFade();
  }

  // The step key shows one more each press (see nextStep). A press in the chat puts the
  // overlay back as it was (see stepRest).
  async function stepView(): Promise<void> {
    const action = stepAction(state);
    switch (action.type) {
      case "openChat":
        // In danger the chat does not open, so the overlay is not marked as brought back.
        return runHotkey(action, "hotkey");
      case "stepRest": {
        // A refused focus leaves the overlay shown, so its "click the game" notice can be read.
        const keepShown = !(await giveFocusBack());
        dispatch({ ...action, keepShown });
        if (!keepShown) void settleFocus();
        return;
      }
      default:
        dispatch(action);
        return refreshFade();
    }
  }

  // Hotkeys and the tray share one error path: a failed action is logged, never fatal.
  function runAction(a: HotkeyAction, source: "hotkey" | "tray"): void {
    runHotkey(a, source).catch((err) => log.log("warn", `${source} ${a.type}: ${message(err)}`));
  }

  async function runHotkey(a: HotkeyAction, source: "hotkey" | "tray"): Promise<void> {
    switch (a.type) {
      case "openChat":
        if (!canOpenChat(state, settings.safety.blockWhenInDanger)) return flash("chat", IN_DANGER);
        focus?.save(source === "tray");
        return dispatch({ type: "openChat", step: a.step });
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
        dispatch({ type: "showMore" });
        return refreshFade();
      case "step":
        return stepView();
      case "cancel":
        if (!session?.busy) return;
        session.cancel();
        dispatch({ type: "cancelled" });
        return scheduleFade();
      case "copyChip":
        return copyChip(a.n);
      case "move":
        if (hudMoving) return moveHud({ ...hudPosition, anchor: step(hudPosition.anchor, a.dir) });
        return movePosition({ ...position, anchor: step(position.anchor, a.dir) });
      case "nextDisplay": {
        const all = screen.getAllDisplays();
        const pos = hudMoving ? hudPosition : position;
        const now =
          pos.display === "primary"
            ? all.findIndex((d) => d.id === screen.getPrimaryDisplay().id)
            : pos.display;
        const next = { ...pos, display: (Math.max(0, now) + 1) % all.length };
        return hudMoving ? moveHud(next) : movePosition(next);
      }
      case "hudToggle":
        saved = { ...saved, hudHidden: !saved.hudHidden };
        writeState();
        flash("hud", saved.hudHidden ? "ⓘ activity panel hidden" : "ⓘ activity panel shown", 2_000);
        return renderHud();
      case "hudMode": {
        const enabled = HUD_MODES.filter((m) => settings.hud.modes[m]);
        const next = cycleMode(saved.hudMode?.mode ?? "auto", enabled);
        const { hudMode: _m, ...rest } = saved;
        saved =
          next === "auto"
            ? { ...rest, hudHidden: false }
            : { ...rest, hudHidden: false, hudMode: { mode: next, at: new Date().toISOString() } };
        writeState();
        flash("hud", `ⓘ panel: ${next}`, 2_000);
        return renderHud();
      }
      case "hudMove":
        return setHudMoving(!hudMoving);
      case "route":
        return stepRoute(a.dir);
    }
  }

  // Renderer IPC.
  // The renderer is sandboxed but still untrusted input; a bad value must not throw in main.
  ipcMain.handle(IPC.send, (_e, v: unknown) => {
    const text = textArg(v);
    return text === null ? false : send(text);
  });
  ipcMain.on(IPC.closeChat, () => {
    // Read at the press, before the focus wait (see escapeAction).
    const action = escapeAction(state);
    // A refused focus leaves the overlay shown, so its "click the game" notice can be read.
    void giveFocusBack().then((ok) => {
      dispatch({ ...action, keepShown: !ok });
      if (ok) void settleFocus();
    });
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
    if (hold === null) return;
    cardHeld = hold;
    if (hold) clearTimeout(fadeTimer);
    else if (state.cardOpen && state.session !== "thinking") scheduleFade();
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
  ipcMain.on(IPC.hudSize, (_e, w: unknown, h: unknown) => {
    const width = heightArg(w);
    const height = heightArg(h);
    if (width === null || height === null) return;
    hudSize = { width, height };
    placeHud();
  });
  hudWin.webContents.on("did-finish-load", renderHud);
  hudWin.webContents.on("console-message", (e) => {
    if (e.level === "error") log.log("warn", `panel renderer: ${e.message}`);
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

  await openHudFeed().catch((err) => log.log("warn", `panel: ${message(err)}`));
  const hudTimer = setInterval(() => void pollHud(), 1_000);
  void pollHud();

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
    placeHud();
    renderHud();
    bindHotkeys();
    syncHotkeys(focus?.current ?? null);
    approval.setTimeoutMs(settings.approval.timeoutSeconds * 1000);
    reposition();
    render();
  }
  if (first.error) dispatch({ type: "notice", key: "settings", text: first.error });
  applySettings();
  let askingPlayerOnly = false;

  settingsStore.watch((r) => {
    dispatch({ type: "notice", key: "settings", text: r.error });
    if (r.changed) onSettingsChanged();
  });

  // Other changes apply at once; a change to a player-only setting waits for the player.
  function onSettingsChanged(): void {
    const next = settingsStore.settings;
    if (!playerOnlyChanges(settings, next).length) {
      trustedText = settingsStore.text;
      return applyNewSettings(next);
    }
    applyNewSettings(keepPlayerOnly(next, settings));
    if (!askingPlayerOnly) void askPlayerOnly();
  }

  async function askPlayerOnly(): Promise<void> {
    askingPlayerOnly = true;
    dispatch({
      type: "notice",
      key: "playerOnly",
      text: "⚠ settings.json: a change waits for your answer",
    });
    const first = settingsStore.settings;
    const r = await dialog.showMessageBox({
      type: "warning",
      title: "ED Chat",
      message: "settings.json changed settings that only you should change.",
      detail:
        describeChanges(settings, first, playerOnlyChanges(settings, first)).join("\n") +
        "\n\nThese settings control what Claude may run. If you did not make this change " +
        "yourself, or ask Claude for it, choose Undo.",
      buttons: ["Undo", "Apply"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    askingPlayerOnly = false;
    dispatch({ type: "notice", key: "playerOnly", text: null });
    // The file can have changed again while the question was open.
    const next = settingsStore.settings;
    const changed = playerOnlyChanges(settings, next);
    if (!changed.length) return;
    if (r.response === 1) {
      log.log("info", `player-only settings applied: ${changed.join(", ")}`);
      trustedText = settingsStore.text;
      return applyNewSettings(next);
    }
    log.log("info", `player-only settings undone: ${changed.join(", ")}`);
    try {
      await settingsStore.write(restorePaths(settingsStore.text, trustedText, changed));
    } catch (err) {
      log.log("warn", `settings.json: ${message(err)}`);
      dispatch({
        type: "notice",
        key: "playerOnly",
        text: "⚠ settings.json: could not undo the change; it is not applied",
      });
    }
  }

  function applyNewSettings(next: Settings): void {
    const old = settings;
    settings = next;
    ({ position, saved } = effectivePosition(settings.position, saved));
    ({ position: hudPosition, saved } = effectiveHudPosition(settings.hud.position, saved));
    writeState();
    if (
      journalDir(old) !== journalDir(settings) ||
      old.hud.edMcpDataDir !== settings.hud.edMcpDataDir ||
      old.hud.spansh !== settings.hud.spansh
    ) {
      void openHudFeed().then(pollHud, (err) => log.log("warn", `panel: ${message(err)}`));
    }
    if (JSON.stringify(old.claude) !== JSON.stringify(settings.claude)) {
      const c = claudeCommand(settings);
      dispatch({ type: "notice", key: "claude", text: c ? null : noClaude() });
      // /version must not report the binary that is no longer configured.
      claudeVersion = null;
      if (c && session) {
        session.configure(c);
        checkVersion(c.command, c.shell);
        flash("claudeSettings", "ⓘ claude settings apply after /new", 6_000);
      } else if (c && claudeStarted) startSession(c);
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
  }

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
      Object.entries(state.notices).map(([key, text]) => {
        const command = noticeCommand(key, text);
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
    const chips = withTargets(currentChips(state), chipStops);
    const tray = (a: HotkeyAction) => () => runAction(a, "tray");
    return Menu.buildFromTemplate([
      ...chips.map((c) => ({
        label: label(`Copy ${c.n}: ${chipLabel(c)}`),
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

  const placeAll = () => {
    reposition();
    placeHud();
  };
  screen.on("display-removed", placeAll);
  screen.on("display-metrics-changed", placeAll);
  app.on("second-instance", () => {
    if (!state.visible) dispatch({ type: "toggleVisible" });
  });
  focus?.start();
  render();
  startClaude().catch((err) => log.log("warn", `claude start: ${message(err)}`));
  // After the first foreground check, so the list shows which keys other apps hold.
  if (settings.startup.showKeys) setTimeout(showKeys, 1_000);

  app.on("will-quit", () => {
    trayIcon.destroy();
    globalShortcut.unregisterAll();
    focus?.stop();
    status.stop();
    clearInterval(hudTimer);
    settingsStore.unwatch();
    session?.stop();
    void approval.stop();
  });
}
