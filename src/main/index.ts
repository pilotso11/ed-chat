import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, unwatchFile, watchFile } from "node:fs";
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
  type MenuItemConstructorOptions,
} from "electron";
import { chooseDisplay, place, snap, step } from "../core/anchor.js";
import {
  agentArgs,
  blockedFor,
  displaySettingsFile,
  firstRunChoice,
  journalDir as journalFolder,
  localCommand,
  settingsChange,
  type LocalCommand,
} from "../core/agentSetup.js";
import {
  AGENTS,
  notFoundText,
  type AgentBackend,
  type AgentId,
  type BackendEvent,
} from "../core/backend.js";
import { ApprovalBroker, approvalAnswers } from "../core/approvals.js";
import { ApprovalServer } from "../core/backends/claude/approvalServer.js";
import { chipCopy, withTargets, type Chip, type StopTarget } from "../core/chips.js";
import {
  TESTED_CLI_VERSION,
  claudeLookup,
  resolveClaude,
} from "../core/backends/claude/command.js";
import { ClaudeSession } from "../core/backends/claude/session.js";
import {
  TESTED_CODEX_VERSION,
  codexLookup,
  codexThreadSettings,
  resolveCodex,
} from "../core/backends/codex/command.js";
import { brokerApprover } from "../core/backends/codex/approvals.js";
import { CodexSession } from "../core/backends/codex/session.js";
import { lookedIn, quoteForCmd, type CliLookup, type ResolvedCommand } from "../core/cli.js";
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
import { parseSettings, setsKey, type Position, type Settings } from "../core/settings.js";
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
import { openStores, type Plan } from "ed-mcp/journal";
import {
  configProblems,
  hasOwnEdMcp,
  edMcpState,
  ownConfigUnreadable,
  edMcpToAdd,
  readAgentConfigs,
  claudeMcpConfig,
  forCli,
  syncDirOf,
} from "../core/edMcp.js";
import { HudFeed, type FeedData } from "../core/hud/feed.js";
import { KnownBodies, fetchSpansh } from "../core/hud/known.js";
import {
  BOOKMARKS_PLAN,
  bookmarkHere,
  finishedBioBookmarks,
  isPlanNotFound,
  bookmarkRef,
  keepSavedBookmarks,
  type SavedBookmarks,
} from "../core/hud/bookmarks.js";
import { SellPrices, postSpansh, type SellQuery } from "../core/hud/sell.js";
import { buildHud, type HudView } from "../core/hud/hud.js";
import {
  hudCanShow,
  hudInput,
  hudVisible,
  moveHint,
  nextHudMode,
  panelCopy,
} from "../core/hud/panelState.js";
import { arrivalCopy, currentSystem, routeStep } from "../core/hud/routeSteps.js";
import { gameContext, noteIsFresh, withGameContext } from "../core/hud/context.js";
import { HUD_EVENTS } from "../core/hud/mode.js";
import { todoStops } from "../core/hud/panels.js";
import {
  ABOUT_URL,
  noticeMenuItems,
  trayItems,
  type TrayAction,
  type TrayItem,
} from "../core/menus.js";
import {
  COMMAND_COPIED,
  FULLSCREEN,
  IN_DANGER,
  PLAYER_ONLY_WAITING,
  REFOCUS,
  RESUMED,
  RESUME_FAILED,
  busyText,
  edMcpNotice,
  gaveUpText,
  hotkeysNotice,
  modeNotice,
  scopeNotice,
  versionNotice,
} from "../core/notices.js";
import { displaySetting, hudWindowSize, onNextDisplay, overlaySize } from "../core/placement.js";
import { PlayerOnlyGuard } from "../core/playerOnlyGuard.js";
import { PLAYER_ONLY_PATHS_V0_5 } from "../core/settingsDictionary.js";
import { buildView, pickNotice, shortTool } from "../core/view.js";
import { gameMatrixFrom, graphicsOverrideFile, lookVars, type Matrix } from "../core/theme.js";
import { fetchLatestEdMcp, freshLatest, versionText, type Versions } from "../core/version.js";
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
} from "../core/guards.js";
import { loadWin32 } from "./win32.js";
import { applyWindow, createOverlayWindow } from "./window.js";

const dataDir = path.join(app.getPath("appData"), "ed-chat");
app.setPath("userData", dataDir);
const logDir = path.join(dataDir, "logs");
const log = new Logger(path.join(logDir, "overlay.log"));
const settingsFile = path.join(dataDir, "settings.json");

// How ED Chat finds each CLI, and the version it was tested with.
const CLIS: Record<
  AgentId,
  {
    lookup: () => CliLookup;
    resolve: (path: string | null) => ResolvedCommand | null;
    tested: string;
  }
> = {
  claude: {
    lookup: () => claudeLookup(),
    resolve: (p) => resolveClaude(p),
    tested: TESTED_CLI_VERSION,
  },
  codex: {
    lookup: () => codexLookup(),
    resolve: (p) => resolveCodex(p),
    tested: TESTED_CODEX_VERSION,
  },
};

const KEYS_SECONDS = 15;

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
  const stateFile = path.join(dataDir, "state.json");
  // No state.json yet: ED Chat has never run here, so it may choose the assistant. A state.json
  // that cannot be read also reads as empty, so the file itself is checked, before anything
  // writes it.
  const firstRun = !existsSync(stateFile);
  const stateStore = new StateStore(stateFile);
  const history = new HistoryStore(path.join(dataDir, "history"));

  let state: OverlayState = INITIAL_STATE;
  let prevProps: WindowProps | null = null;
  let contentHeight = 48;
  let fadeTimer: NodeJS.Timeout | undefined;
  const timers = new Map<string, NodeJS.Timeout>();

  const first = await settingsStore.load();
  let saved: SavedState = await stateStore.read();
  // A change to a player-only setting waits for the player, also across a restart: the values
  // last applied are kept in state.json.
  const playerOnly = new PlayerOnlyGuard(
    {
      fileText: () => settingsStore.text,
      parse: (text) => {
        const r = parseSettings(text);
        return r.ok ? r.settings : null;
      },
      apply: (s) => applyNewSettings(s),
      write: (text) => settingsStore.write(text),
      ask: askPlayerOnly,
      waiting: (on) =>
        dispatch({
          type: "notice",
          key: "playerOnly",
          text: on ? PLAYER_ONLY_WAITING : null,
        }),
      save: (values, paths) => {
        saved = { ...saved, playerOnly: values, playerOnlyPaths: [...paths] };
        writeState();
      },
      log: (level, text) => log.log(level, text),
    },
    saved.playerOnly ?? null,
    saved.playerOnlyPaths ?? PLAYER_ONLY_PATHS_V0_5,
  );
  let settings: Settings = playerOnly.effective() ?? settingsStore.settings;
  let position: Position;
  ({ position, saved } = effectivePosition(settings.position, saved));
  state = { ...state, iconMode: saved.iconMode ?? settings.strip.startAsIcon };
  // The assistant that runs; the agent setting switches it.
  let agentId: AgentId = settings.agent;
  let agent = AGENTS[agentId];
  // The conversation from the last run, used by the first session only.
  let resumeFrom = resumeId(saved.sessions?.[agentId], new Date(), settings.resumeHours);
  const savedHistory = saved.sessions?.[agentId]?.history;
  const resumedTurns = resumeFrom && savedHistory ? await history.resume(savedHistory) : [];
  if (!history.fileName) history.newSession();
  state = { ...state, agent: agentId, history: resumedTurns, resumedTurns: resumedTurns.length };

  // The game's HUD colour, for style.theme "game". It is read before either window is made, so
  // a blue or green overlay does not draw orange first; it is read again when the player
  // changes it. null when the game has none.
  const colourXml = graphicsOverrideFile(process.env.LOCALAPPDATA, os.homedir());
  const readColourXml = () =>
    readFile(colourXml, "utf8").catch((err: NodeJS.ErrnoException) =>
      err.code === "ENOENT" ? undefined : null,
    );
  let gameMatrix: Matrix | null = gameMatrixFrom(await readColourXml(), null);

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
  const windowsGone = () => win.isDestroyed() || hudWin.isDestroyed();
  let hudPosition: Position;
  ({ position: hudPosition, saved } = effectiveHudPosition(settings.hud.position, saved));

  const viewSettings = (): Settings => ({ ...settings, position });

  // When the approval on screen appeared; an answer key pressed just before that is ignored.
  let shownApproval: { id: string; at: number } | null = null;
  // The route stops still to do, current first: chips in their systems show the body or station.
  let chipStops: StopTarget[] = [];
  function render(): void {
    // A CLI that exits while the app quits still dispatches; the windows are gone by then.
    if (windowsGone()) return;
    const req = currentApproval(state);
    if (req?.id !== shownApproval?.id) shownApproval = req ? { id: req.id, at: Date.now() } : null;
    const props = windowProps(state);
    applyWindow(win, props, prevProps);
    prevProps = props;
    const view = buildView(state, viewSettings(), gameMatrix);
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
    if (dragging || windowsGone()) return;
    const display = chooseDisplay(
      screen.getAllDisplays(),
      screen.getPrimaryDisplay(),
      position.display,
    );
    const size = overlaySize(settings, contentHeight);
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
    if (windowsGone()) return;
    const b = win.getBounds();
    // No real move: apply any height change that waited for the drag.
    if (placed && b.x === placed.x && b.y === placed.y) return reposition();
    const d = screen.getDisplayMatching(b);
    const display = displaySetting(d, screen.getAllDisplays(), screen.getPrimaryDisplay());
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
    if (win.isDestroyed()) return 0;
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
      text: hotkeysNotice(failed),
    });
    if (state.keys)
      dispatch({
        type: "keys",
        rows: keyRows(settings.hotkeys, hotkeys.failedKeys, hotkeys.duplicateKeys),
      });
  }

  let wasGame: boolean | null = null;
  function onForeground(f: Foreground): void {
    if (windowsGone()) return;
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
    const scope = scopeNotice(want);
    if ((state.notices.scope ?? null) !== scope)
      dispatch({ type: "notice", key: "scope", text: scope });
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
  // Where to sell mined cargo, searched on Spansh only while the mining panel shows.
  const sellPrices = new SellPrices(postSpansh, {
    onError: (m) => log.log("warn", `panel spansh prices: ${m}`),
  });
  // The panel's last copy for the galaxy map, so each is copied once.
  let hudCopied: string | null = null;
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
    if (windowsGone()) return;
    const display = chooseDisplay(
      screen.getAllDisplays(),
      screen.getPrimaryDisplay(),
      hudPosition.display,
    );
    const size = hudWindowSize(settings.hud, hudSize, display.workArea.width);
    const { x, y } = place(
      hudPosition.anchor,
      hudPosition.offsetX,
      hudPosition.offsetY,
      display.workArea,
      size,
    );
    hudWin.setBounds({ x, y, ...size });
  }

  function renderHud(): void {
    if (windowsGone()) return;
    // Spansh searches and clipboard copies only for a panel the player can see.
    const visible = hudCanShow(settings.hud, saved, focus?.current ?? null);
    const input = {
      ...hudInput(hudData, saved, settings.hud, Date.now()),
      look: lookVars(settings.style, gameMatrix),
      sell: settings.hud.spansh && visible ? (q: SellQuery) => sellPrices.get(q) : undefined,
    };
    const view = buildHud(input, hudMoving ? moveHint(settings.hotkeys) : null);
    lastHudView = view;
    const next = panelCopy(view.panel?.copy, visible, hudCopied);
    hudCopied = next.copied;
    if (next.copy) {
      clipboard.writeText(next.copy.text);
      flash("copy", `📋 ${next.copy.note}`, 6_000);
    }
    const mode = String(view.mode ?? null);
    if (mode !== hudMode) {
      hudMode = mode;
      log.log("info", `panel mode: ${mode}`);
    }
    const show = hudVisible(visible, view, hudMoving);
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
    if (!syncDir) syncDir = syncDirOf(agentConfigs, agentId, workspace);
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
  // The bookmarks plan a key press saved; a poll that started before it read the plan without it.
  let savedBookmarks: SavedBookmarks | null = null;
  // Polls started so far, which dates a save against the polls around it.
  let pollsStarted = 0;
  async function pollHud(): Promise<void> {
    if (hudPolling || !hudFeed || !settings.hud.enabled) return;
    hudPolling = true;
    const poll = ++pollsStarted;
    try {
      const read = await hudFeed.poll();
      const kept = keepSavedBookmarks(read, savedBookmarks, poll);
      savedBookmarks = kept.saved;
      hudData = kept.data;
      hudFreshAt = Date.now();
      const stops = todoStops(hudData.plan);
      if (JSON.stringify(stops) !== JSON.stringify(chipStops)) {
        chipStops = stops;
        render();
      }
      const system = hudData.journal?.location.system ?? null;
      if (system && lastSystem && system !== lastSystem) onArrival(system);
      void finishBioBookmarks(hudData).catch((err: unknown) =>
        log.log("warn", `panel bookmarks: ${message(err)}`),
      );
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
    const next = arrivalCopy(hudData?.plan, system);
    if (!next) return;
    clipboard.writeText(next);
    flash("copy", `📋 next stop copied: ${next}`, 4_000);
  }

  async function stepRoute(dir: 1 | -1): Promise<void> {
    const plans = hudPlans;
    const plan = plans ? hudData?.plan : null;
    const change = routeStep(plan, dir);
    if ("notice" in change) return flash("route", change.notice, 3_000);
    // routeStep gives an update only for a plan, and there is a plan only with its store.
    if (!plans || !plan) return;
    const { index, status } = change.update;
    await plans.updateStop(plan.id, { index }, { status });
    // Read the plan back rather than through pollHud(), which skips while the timer's poll runs
    // and would leave the plan from before the change.
    const now = await plans.get(plan.id).catch(() => null);
    void pollHud();
    const system = currentSystem(now);
    if (system) {
      clipboard.writeText(system);
      flash("copy", `📋 copied ${system}`, 3_000);
    }
  }

  // Saves where the ship or commander is on a planet to the bookmarks plan.
  // Bookmark key presses run one at a time, so two quick presses do not both read the same plan.
  let bookmarking: Promise<void> = Promise.resolve();
  function addBookmark(): Promise<void> {
    bookmarking = bookmarking.then(saveBookmark, saveBookmark);
    return bookmarking;
  }

  // Saves where the ship or commander is now (Status.json read fresh) to the bookmarks plan.
  async function saveBookmark(): Promise<void> {
    // PlanStore.addStop adds the stop in one locked write, so an edit Claude makes to the bookmarks
    // meanwhile is not lost.
    const plans = hudPlans;
    if (!settings.hud.enabled) {
      return flash("bookmark", "ⓘ the activity panel is off: turn it on to bookmark", 3_000);
    }
    if (!plans || !hudFeed) {
      return flash("bookmark", "ⓘ the activity panel could not open the journal or ed-mcp", 3_000);
    }
    if (!settings.hud.bookmarks) {
      return flash("bookmark", "ⓘ bookmarks are off: turn on hud.bookmarks", 3_000);
    }
    if (!hudData?.journal) {
      return flash("bookmark", "ⓘ the panel has not read the journal yet: try again", 3_000);
    }
    let old: Plan | null = null;
    try {
      old = await plans.get(BOOKMARKS_PLAN);
    } catch (err) {
      if (!isPlanNotFound(err)) throw err;
    }
    const status = await hudFeed.readStatus();
    const made = bookmarkHere(
      hudData.journal,
      status,
      (old?.stops ?? []).map((s) => s.label ?? s.purpose),
    );
    if ("reason" in made) return flash("bookmark", `ⓘ ${made.reason}`, 3_000);
    const saved = await plans.addStop(BOOKMARKS_PLAN, "Bookmarks", made.stop);
    flash("bookmark", `📍 bookmarked ${made.stop.purpose} on ${made.stop.body}`, 4_000);
    // Shown at once, not after the next poll, which may have read the plan before the save.
    savedBookmarks = { plan: saved, afterPoll: pollsStarted };
    if (hudData) hudData = { ...hudData, bookmarks: saved };
    renderHud();
  }

  // Bio bookmarks whose species are all analysed are marked done, once each.
  const bookmarksDone = new Set<string>();
  async function finishBioBookmarks(data: FeedData): Promise<void> {
    if (!hudPlans || !settings.hud.bookmarks) return;
    for (const i of finishedBioBookmarks(data.bookmarks ?? null, data.journal)) {
      const stop = data.bookmarks!.stops[i]!;
      // What and where it is: a new bookmark with the same label in another spot is another one.
      const id = JSON.stringify([stop.system, stop.body, stop.label, stop.purpose, stop.position]);
      if (bookmarksDone.has(id)) continue;
      bookmarksDone.add(id);
      try {
        // Found again in the plan as it is now: an edit since the poll can move it.
        const now = await hudPlans.get(BOOKMARKS_PLAN);
        const ref = bookmarkRef(now, stop);
        if (!ref) continue;
        await hudPlans.updateStop(BOOKMARKS_PLAN, ref, { status: "done" });
        flash("bookmark", `📍 done: ${stop.label ?? stop.purpose}`, 4_000);
      } catch (err) {
        // Tried again on the next poll; the other bookmarks are still marked.
        bookmarksDone.delete(id);
        log.log("warn", `panel bookmarks: ${message(err)}`);
      }
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

  // The assistant.
  // The player's side of approvals, for either backend: the cards, the timeout, "allow until /new".
  const approvals = new ApprovalBroker({
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
  });
  const approval = new ApprovalServer(approvals, {
    // The message only: the request body can hold chat text.
    onError: (err) => log.log("warn", `approval request failed: ${message(err)}`),
  });
  const mcpConfigFile = path.join(dataDir, "approval-mcp.json");
  const workspace = path.join(dataDir, "workspace");
  // Read once: the panel must read the sync folder of the ed-mcp that runs, which is set up
  // from these at startup.
  const agentConfigs = await readAgentConfigs();
  // Claude asks for approval through ED Chat's approval server, so Claude cannot run without it.
  // Codex asks through its own protocol. Both need the data folder.
  let approvalBlocked: string | null = null;
  let dataBlocked: string | null = null;
  try {
    await approval.start();
  } catch (err) {
    log.log("warn", `approval server: ${message(err)}`);
    approvalBlocked = `⚠ Can't start the approval server: ${message(err)}`;
  }
  const problems = configProblems(agentConfigs);
  if (problems.length) log.log("warn", `ed-mcp: cannot read or parse ${problems.join(", ")}`);
  // ed-mcp from the other CLI's config or another Claude project, when an assistant has none
  // of its own. Its env can hold the sync password: Claude gets it in a file in ED Chat's own
  // data folder, which already holds the approval server's token; Codex gets it in the request.
  const edMcpFor = (id: AgentId) => {
    if (ownConfigUnreadable(id, agentConfigs, workspace))
      log.log("warn", `ed-mcp: ${AGENTS[id].name}'s own config cannot be read; added none`);
    const add = edMcpToAdd(id, agentConfigs, workspace);
    if (add) log.log("info", `ed-mcp for ${AGENTS[id].name}: the definition from ${add.source}`);
    return forCli(add);
  };
  const codexEdMcp = edMcpFor("codex");
  try {
    if (!approvalBlocked) {
      const config = claudeMcpConfig(approval.mcpConfig().mcpServers, edMcpFor("claude"));
      await writeFile(mcpConfigFile, JSON.stringify(config));
    }
    await mkdir(workspace, { recursive: true });
  } catch (err) {
    log.log("warn", `data folder: ${message(err)}`);
    dataBlocked = `⚠ Can't write to ${dataDir}: ${message(err)}`;
  }
  const blocked = (id: AgentId) => blockedFor(id, { data: dataBlocked, approval: approvalBlocked });
  const notFound = () =>
    blocked(agentId) ??
    notFoundText(agent, lookedIn(CLIS[agentId].lookup(), settings[agentId].path));

  const agentCommand = (s: Settings, id: AgentId = agentId) => {
    if (blocked(id)) return null;
    const resolved = CLIS[id].resolve(s[id].path);
    if (!resolved) return null;
    return { ...resolved, args: agentArgs(id, s, { mcpConfigFile, settingsFile }) };
  };
  // What each Codex thread starts with; a change applies to the next thread.
  const codexThread = (s: Settings) =>
    codexThreadSettings({
      permissionMode: s.codex.permissionMode,
      model: s.codex.model,
      cwd: workspace,
      settingsFile,
      edMcp: codexEdMcp,
    });

  let session: AgentBackend | null = null;
  // Stops the running session's events from reaching the overlay, at a switch.
  let unsubscribe: (() => void) | null = null;
  let resumePending = false;
  // For /version.
  let cliVersion: string | null = null;
  let edMcpStatus: Versions["edMcpStatus"] = null;
  function startSession(c: { command: string; args: string[]; shell: boolean }): void {
    // Never two at once: one that is still running stops first.
    unsubscribe?.();
    session?.stop();
    const base = { command: c.command, args: c.args, shell: c.shell, cwd: workspace };
    session =
      agentId === "claude"
        ? new ClaudeSession({ ...base, resumeId: resumeFrom })
        : new CodexSession({
            ...base,
            resumeId: resumeFrom,
            thread: codexThread(settings),
            approve: brokerApprover(approvals),
            autoEditFiles: [settingsFile],
            clientVersion: app.getVersion(),
          });
    // Shown at the first ready: the CLI confirms the conversation only then.
    resumePending = resumeFrom !== null;
    resumeFrom = null;
    unsubscribe = session.onEvent(onBackend);
    session.start();
    checkVersion(c.command, c.shell);
  }

  // Auto mode runs most tools without asking, so the player chooses once, before the assistant starts.
  async function askPermissionMode(): Promise<void> {
    // The assistant asked about, even if the player switches while the question is open.
    const id = agentId;
    const a = AGENTS[id];
    // A broken settings.json shows its own error; the question waits for a good file.
    if (settingsStore.broken || setsKey(settingsStore.text, id, "permissionMode")) return;
    const r = await dialog.showMessageBox({
      type: "question",
      title: "ED Chat",
      message: `How should ${a.name} run tools?`,
      detail:
        `Ask me: the overlay shows each tool that ${a.name} wants to run, and you allow or ` +
        `deny it with a hotkey.\n\nAuto: ${a.name} decides, and runs most tools without ` +
        "asking, including commands that you ask for.\n\nYou can change this later in " +
        `settings.json, ${id}.permissionMode.`,
      buttons: ["Ask me", "Auto"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    const mode = r.response === 1 ? "auto" : "default";
    try {
      // The player chose this, so the guard does not ask about it.
      await playerOnly.playerWrite(
        settingsStore.textWith(id, "permissionMode", mode),
        `${id}.permissionMode`,
        mode,
      );
      await settingsStore.load();
      settings = playerOnly.effective() ?? settingsStore.settings;
    } catch (err) {
      // The choice still holds for this run; the player sees that it was not saved.
      log.log("warn", `settings.json: ${message(err)}`);
      settings = { ...settings, [id]: { ...settings[id], permissionMode: mode } };
      dispatch({
        type: "notice",
        key: "settings",
        text: `⚠ settings.json: could not save ${mode} mode`,
      });
    }
  }
  // Runs after the tray exists: the question can open behind a fullscreen game, and the tray is
  // how the player quits. Settings reloads start no session before the answer.
  let agentStarted = false;
  // First run, before any conversation: see firstRunChoice.
  async function firstRunAgent(): Promise<void> {
    const choice = firstRunChoice({
      firstRun,
      settingsText: settingsStore.text,
      settingsBroken: settingsStore.broken,
      claudeFound: () => !!CLIS.claude.resolve(settings.claude.path),
      codexFound: () => !!CLIS.codex.resolve(settings.codex.path),
      hintShown: !!saved.agentHintShown,
    });
    if (choice === "codex") await chooseAgent("codex");
    else if (choice === "hint") {
      flash("agent", "ⓘ Codex is installed too: type /codex to switch", 12_000);
      saved = { ...saved, agentHintShown: true };
      writeState();
    }
  }

  async function startAgent(): Promise<void> {
    await firstRunAgent();
    // Asked again if the player switched while the question was open: the assistant that
    // starts must be the one asked about.
    for (let asked: AgentId | null = null; asked !== agentId;) {
      // A switch still under way finishes first, so agentId is settled.
      await switching;
      asked = agentId;
      await askPermissionMode();
      await switching;
    }
    agentStarted = true;
    const cmd = agentCommand(settings);
    log.log("info", `started; ${agent.cli} ${cmd ? cmd.command : "not found"}`);
    if (session) return;
    if (cmd) startSession(cmd);
    else dispatch({ type: "notice", key: "claude", text: notFound() });
  }

  // The setup line: Claude's when Claude is installed (ED Chat then gives it to Codex too),
  // else Codex's.
  const setupCommand = () =>
    (CLIS.claude.resolve(settings.claude.path) ? AGENTS.claude : AGENTS.codex).mcpAddCommand;

  function onBackend(e: BackendEvent): void {
    dispatch({ type: "backend", event: e });
    switch (e.type) {
      case "ready":
        if (resumePending) {
          resumePending = false;
          flash("resume", RESUMED, 6_000);
        }
        {
          let ed = edMcpState(e.mcpServers);
          // Codex reports its servers only after the thread starts, so a missing ed-mcp is
          // read from the config files; an ed-mcp ED Chat gives it is set up too.
          if (agentId === "codex" && ed === "missing")
            ed = codexEdMcp || hasOwnEdMcp("codex", agentConfigs, workspace) ? "ok" : "missing";
          edMcpStatus = ed;
          dispatch({
            type: "notice",
            key: "edmcp",
            text: edMcpNotice(ed, agent, setupCommand()),
          });
        }
        dispatch({
          type: "notice",
          key: "mode",
          text: modeNotice(settings[agentId].permissionMode, e.permissionMode),
        });
        break;
      case "result":
        appendHistory({ role: "assistant", text: state.reply });
        scheduleFade();
        // An error reply still counts as use: the conversation exists and was used just now.
        if (e.sessionId && history.fileName) {
          const s = {
            id: e.sessionId,
            lastUsed: new Date().toISOString(),
            history: history.fileName,
          };
          saved = { ...saved, sessions: { ...saved.sessions, [agentId]: s } };
          writeState();
        }
        break;
      case "resumeFailed":
        resumePending = false;
        history.newSession();
        // The reducer dropped the old conversation's turns; what is left is the question in
        // flight, which the new conversation answers, so it starts the new file.
        for (const t of state.history) appendHistory(t);
        saved = { ...saved, sessions: { ...saved.sessions, [agentId]: undefined } };
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
        log.log("warn", `${agent.cli} ${e.type}: ${capLines(e.stderrTail).join(" | ")}`);
        break;
      case "spawnError":
        scheduleFade();
        log.log("warn", `${agent.cli} spawn error: ${e.message}`);
        break;
      case "unknown": {
        const d = describeUnknown(e.raw);
        if (d) log.log("debug", `unknown stream-json: ${d}`);
        break;
      }
    }
  }

  // Only the latest check counts: an earlier one can finish last after the CLI path changes.
  let versionCheck = 0;
  function checkVersion(command: string, shell: boolean): void {
    const file = shell ? quoteForCmd(command) : command;
    const n = ++versionCheck;
    execFile(file, ["--version"], { shell, windowsHide: true }, (err, stdout) => {
      if (n !== versionCheck) return;
      const v = versionNotice(err ? null : stdout, CLIS[agentId].tested, agent);
      cliVersion = v.version;
      dispatch({ type: "notice", key: "version", text: v.notice });
    });
  }

  function newConversation(): void {
    session?.newSession();
    history.newSession();
    resumePending = false;
    // A session a switch is about to start begins fresh too.
    resumeFrom = null;
    saved = { ...saved, sessions: { ...saved.sessions, [agentId]: undefined } };
    writeState();
    approvals.clearAllowed();
    dispatch({ type: "newSession" });
  }

  // The player's choice of assistant, from /claude, /codex or the tray. It is written as the
  // player's own change, so no dialog; the settings watcher then switches.
  async function chooseAgent(id: AgentId): Promise<boolean> {
    if (id === settings.agent) {
      flash("agent", `ⓘ ${AGENTS[id].name} is already the assistant`, 4_000);
      return true;
    }
    // The switch is read back from the file, which must be good first.
    if (settingsStore.broken) {
      flash("agent", "⚠ settings.json has an error: fix it, then switch", 6_000);
      return false;
    }
    try {
      await playerOnly.playerWrite(settingsStore.textWithTop("agent", id), "agent", id);
      await settingsStore.load();
      applyNewSettings(playerOnly.effective() ?? settingsStore.settings);
      await switching;
      return true;
    } catch (err) {
      log.log("warn", `settings.json: ${message(err)}`);
      flash("agent", `⚠ settings.json: could not switch to ${AGENTS[id].name}`, 6_000);
      return false;
    }
  }

  // Stops the running assistant and starts the other. Its own saved conversation is resumed if
  // it is fresh; a session id is never given to the other CLI.
  let switching = Promise.resolve();
  function switchAgent(id: AgentId): Promise<void> {
    switching = switching
      .then(() => doSwitch(id))
      .catch((err) => {
        log.log("warn", `switch to ${id}: ${message(err)}`);
      });
    return switching;
  }
  // While a switch runs (its question can be open), a settings reload starts no session: the
  // switch starts the one session, with the conversation to resume.
  let switchInProgress = false;
  async function doSwitch(id: AgentId): Promise<void> {
    if (id === agentId) return;
    switchInProgress = true;
    try {
      await switchTo(id);
    } finally {
      switchInProgress = false;
    }
  }
  async function switchTo(id: AgentId): Promise<void> {
    // What the old assistant still sends is not for the new one.
    unsubscribe?.();
    unsubscribe = null;
    session?.stop();
    session = null;
    approvals.denyAll();
    approvals.clearAllowed();
    resumePending = false;
    cliVersion = null;
    edMcpStatus = null;
    agentId = id;
    agent = AGENTS[id];
    // A version check still running is for the CLI that stopped.
    versionCheck++;
    const s = saved.sessions?.[id];
    resumeFrom = resumeId(s, new Date(), settings.resumeHours);
    const turns = resumeFrom && s?.history ? await history.resume(s.history) : [];
    if (!resumeFrom || !s?.history) history.newSession();
    for (const key of ["claude", "edmcp", "mode", "version"])
      dispatch({ type: "notice", key, text: null });
    dispatch({ type: "switchAgent", agent: id, history: turns });
    dispatch({ type: "localReply", text: `Switched to ${agent.name}.` });
    scheduleFade();
    log.log("info", `switched to ${agent.cli}`);
    void openHudFeed().then(pollHud, (err) => log.log("warn", `panel: ${message(err)}`));
    if (!agentStarted) return;
    await askPermissionMode();
    const cmd = agentCommand(settings);
    if (cmd) startSession(cmd);
    else dispatch({ type: "notice", key: "claude", text: notFound() });
  }

  function answerApproval(id: string, a: "approve" | "deny" | "alwaysAllow"): void {
    const req = state.approvals.find((r) => r.id === id);
    if (!req) return;
    if (!answerAllowed(a, id, shownApproval, Date.now())) return;
    const { allowTool, answers } = approvalAnswers(req, state.approvals, a);
    if (allowTool) approvals.allowTool(allowTool);
    for (const [rid, d] of answers) approvals.answer(rid, d);
    if (allowTool) flash("approval", `✓ ${shortTool(allowTool)} allowed until /new`, 4_000);
  }

  let keysTimer: NodeJS.Timeout | undefined;
  function showKeys(): void {
    clearTimeout(keysTimer);
    dispatch({
      type: "keys",
      rows: keyRows(settings.hotkeys, hotkeys.failedKeys, hotkeys.duplicateKeys),
    });
    keysTimer = setTimeout(() => dispatch({ type: "keys", rows: null }), KEYS_SECONDS * 1000);
  }
  function hideKeys(): void {
    clearTimeout(keysTimer);
    dispatch({ type: "keys", rows: null });
  }

  // The npm lookup is cached, so asking again does not wait on the network.
  let edMcpLatest: { version: string | null; at: number } | null = null;

  function showVersion(): boolean {
    if (state.session === "thinking") {
      flash("chat", "⚠ wait for the reply, then ask for /version", 4_000);
      return false;
    }
    const base: Omit<Versions, "edMcpLatest"> = {
      app: app.getVersion(),
      agent: agentId,
      [agentId]: cliVersion,
      edMcpStatus,
    };
    const cached = freshLatest(edMcpLatest, Date.now());
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

  /** False when the command could not run; the chat then stays open. "quit" quits after it. */
  async function runLocal(command: LocalCommand): Promise<boolean | "quit"> {
    switch (command) {
      case "/new":
        newConversation();
        return true;
      case "/version":
        return showVersion();
      case "/claude":
      case "/codex":
        return chooseAgent(command === "/claude" ? "claude" : "codex");
      case "/quit":
      case "/exit":
        return "quit";
      default:
        // A command added to LOCAL_COMMANDS must be handled here.
        return command satisfies never;
    }
  }

  async function send(text: string): Promise<boolean> {
    const t = text.trim();
    if (!t) return false;
    // ED Chat's own commands. They do not reach the assistant.
    const command = localCommand(t);
    if (command) {
      const done = await runLocal(command);
      if (!done) return false;
      const ok = await giveFocusBack();
      dispatch({ type: "closeChat" });
      if (done === "quit") {
        // Focus settles on the game before the windows go, so quitting does not leave it behind.
        if (ok) await settleFocus();
        app.quit();
        return true;
      }
      if (ok) void settleFocus();
      return true;
    }
    if (!session) {
      dispatch({ type: "notice", key: "claude", text: notFound() });
      return false;
    }
    const fresh = noteIsFresh(settings.hud.enabled, hudFreshAt, Date.now());
    const where = fresh ? (hudData?.journal?.location ?? null) : null;
    const note = fresh ? gameContext(where, hudData?.status ?? null, lastHudView) : null;
    if (!session.send(withGameContext(t, note))) {
      flash("chat", session.busy ? busyText(agent) : gaveUpText(agent));
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
    const c = chipCopy(withTargets(currentChips(state), chipStops), n);
    if (c.text !== null) clipboard.writeText(c.text);
    flash("copy", c.notice, 2_000);
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
        const pos = hudMoving ? hudPosition : position;
        const next = onNextDisplay(pos, screen.getAllDisplays(), screen.getPrimaryDisplay());
        return hudMoving ? moveHud(next) : movePosition(next);
      }
      case "hudToggle":
        saved = { ...saved, hudHidden: !saved.hudHidden };
        writeState();
        flash("hud", saved.hudHidden ? "ⓘ activity panel hidden" : "ⓘ activity panel shown", 2_000);
        return renderHud();
      case "hudMode": {
        const next = nextHudMode(saved, settings.hud, new Date());
        saved = next.saved;
        writeState();
        flash("hud", `ⓘ panel: ${next.mode}`, 2_000);
        return renderHud();
      }
      case "hudMove":
        return setHudMoving(!hudMoving);
      case "route":
        return stepRoute(a.dir);
      case "bookmark":
        return void addBookmark().catch((err: unknown) =>
          flash("bookmark", `⚠ bookmark not saved: ${message(err)}`, 4_000),
        );
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
    // A message the renderer sent just before its window closed can arrive after.
    if (over === null || windowProps(state).interactive || win.isDestroyed()) return;
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
  ipcMain.on(IPC.showNotices, () => {
    if (!win.isDestroyed()) noticeMenu().popup({ window: win });
  });
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
  const journalDir = (s: Settings) => journalFolder(s, os.homedir());
  let status = new StatusWatcher(path.join(journalDir(settings), "Status.json"), (flags) =>
    dispatch({ type: "flags", flags }),
  );
  status.start();

  const readGameMatrix = async () => {
    const next = gameMatrixFrom(await readColourXml(), gameMatrix);
    if (JSON.stringify(next) === JSON.stringify(gameMatrix)) return;
    gameMatrix = next;
    if (settings.style.theme === "game") {
      render();
      renderHud();
    }
  };
  watchFile(colourXml, { interval: 5_000 }, () => void readGameMatrix());

  await openHudFeed().catch((err) => log.log("warn", `panel: ${message(err)}`));
  const hudTimer = setInterval(() => void pollHud(), 1_000);
  void pollHud();

  const displayXml = displaySettingsFile(process.env.LOCALAPPDATA, os.homedir());
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
    approvals.setTimeoutMs(settings.approval.timeoutSeconds * 1000);
    reposition();
    render();
  }
  if (first.error) dispatch({ type: "notice", key: "settings", text: first.error });
  applySettings();
  settingsStore.watch((r) => {
    dispatch({ type: "notice", key: "settings", text: r.error });
    if (r.changed) playerOnly.fileChanged();
  });
  // A change made while ED Chat was closed.
  playerOnly.check();

  async function askPlayerOnly(lines: string[]): Promise<boolean> {
    const r = await dialog.showMessageBox({
      type: "warning",
      title: "ED Chat",
      message: "settings.json changed settings that only you should change.",
      detail:
        lines.join("\n") +
        `\n\nThese settings control what ${agent.name} may run. If you did not make this ` +
        `change yourself, or ask ${agent.name} for it, choose Undo.`,
      buttons: ["Undo", "Apply"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return r.response === 1;
  }

  function applyNewSettings(next: Settings): void {
    const old = settings;
    settings = next;
    ({ position, saved } = effectivePosition(settings.position, saved));
    ({ position: hudPosition, saved } = effectiveHudPosition(settings.hud.position, saved));
    writeState();
    const change = settingsChange(old, settings, agentId, os.homedir());
    if (change.reopenFeed) {
      void openHudFeed().then(pollHud, (err) => log.log("warn", `panel: ${message(err)}`));
    }
    if (change.switchAgent) void switchAgent(settings.agent);
    else if (change.agentSettings) {
      const c = agentCommand(settings);
      dispatch({ type: "notice", key: "claude", text: c ? null : notFound() });
      // /version must not report the binary that is no longer configured.
      cliVersion = null;
      if (c && session) {
        session.configure(c);
        if (session instanceof CodexSession) session.configureThread(codexThread(settings));
        checkVersion(c.command, c.shell);
        flash("agentSettings", `ⓘ ${agent.cli} settings apply after /new`, 6_000);
      } else if (c && agentStarted && !switchInProgress) startSession(c);
    }
    if (change.journal) {
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

  // Tray: one way to quit, with /quit in the chat, since the overlay has no window frame.
  const openPath = (p: string) =>
    void shell.openPath(p).then((err) => {
      if (err) log.log("warn", `open ${path.basename(p)}: ${err}`);
    });
  const trayIconFile = app.isPackaged
    ? path.join(process.resourcesPath, "tray.png")
    : path.join(app.getAppPath(), "resources", "tray.png");

  function showHotkeyProblems(): void {
    void dialog
      .showMessageBox({
        type: "warning",
        title: "ED Chat",
        message:
          "ED Chat could not register these keys. Another app uses them, or settings.json " +
          "sets the same key for two actions.",
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
      noticeMenuItems(state.notices).map(({ label, command }) => ({
        label,
        click: () => {
          if (!command) return;
          clipboard.writeText(command);
          flash("copy", COMMAND_COPIED, 3_000);
        },
      })),
    );
  }

  function runTray(a: TrayAction): void {
    switch (a.type) {
      case "copyChip":
        return copyChip(a.n);
      case "openChat":
        return runAction({ type: "openChat" }, "tray");
      case "newConversation":
        return newConversation();
      case "chooseAgent":
        return void chooseAgent(a.id);
      case "showKeys":
        return showKeys();
      case "hotkeyProblems":
        return showHotkeyProblems();
      case "toggleIcon":
        return runAction({ type: "toggleIcon" }, "tray");
      case "toggleOverlay":
        runAction({ type: "toggleOverlay" }, "tray");
        return trayIcon.setToolTip(state.visible ? "ED Chat" : "ED Chat (minimized)");
      case "openSettings":
        return openPath(settingsFile);
      case "openLogs":
        return openPath(logDir);
      case "about":
        // A fixed https address: the home page, in the default browser.
        return void shell
          .openExternal(ABOUT_URL)
          .catch((err: unknown) => log.log("warn", `open about: ${message(err)}`));
      case "quit":
        return app.quit();
      default:
        // A tray action added in menus.ts must be handled here.
        return a satisfies never;
    }
  }
  const menuTemplate = (items: TrayItem[]): MenuItemConstructorOptions[] =>
    items.map((i): MenuItemConstructorOptions =>
      "separator" in i
        ? { type: "separator" }
        : "submenu" in i
          ? { label: i.label, submenu: menuTemplate(i.submenu) }
          : {
              label: i.label,
              ...(i.kind ? { type: i.kind, checked: i.checked } : {}),
              click: () => runTray(i.action),
            },
    );
  // Built when opened, so the chips and problems are current.
  function trayMenu(): Menu {
    const items = trayItems({
      chips: withTargets(currentChips(state), chipStops),
      agentId,
      failedHotkeys: failedHotkeys.length,
      iconMode: state.iconMode,
      visible: state.visible,
    });
    return Menu.buildFromTemplate(menuTemplate(items));
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
  startAgent().catch((err) => log.log("warn", `${agent.cli} start: ${message(err)}`));
  // After the first foreground check, so the list shows which keys other apps hold.
  if (settings.startup.showKeys) setTimeout(showKeys, 1_000);

  // Everything that could still reach the windows stops as soon as quitting starts: will-quit
  // comes only after the windows are gone. Once only.
  let stopped = false;
  function shutDown(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(dragTimer);
    screen.off("display-removed", placeAll);
    screen.off("display-metrics-changed", placeAll);
    trayIcon.destroy();
    globalShortcut.unregisterAll();
    focus?.stop();
    status.stop();
    clearInterval(hudTimer);
    unwatchFile(colourXml);
    unwatchFile(displayXml);
    settingsStore.unwatch();
    session?.stop();
    void approval.stop();
  }
  app.on("before-quit", shutDown);
  // ED Chat is no use with a window gone (Alt+F4 on the open chat closes it), so it quits; the
  // other window would otherwise keep a process running with no tray icon or hotkeys.
  win.on("closed", () => app.quit());
  hudWin.on("closed", () => app.quit());
  app.on("will-quit", shutDown);
}
