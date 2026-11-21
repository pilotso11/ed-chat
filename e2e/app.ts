import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import { TESTED_CLI_VERSION } from "../src/core/backends/claude/command.js";

const ROOT = path.resolve(import.meta.dirname, "..");

export interface TestApp {
  app: ElectronApplication;
  /** The chat window. */
  chat: Page;
  /** The activity panel window. */
  hud: Page;
  /** The Elite journal folder the app reads. */
  journalDir: string;
  close(): Promise<void>;
}

/**
 * Starts the built app with every folder it uses in a temporary place: its data and logs, the
 * home folder and the journal. The Claude CLI is test/fake-claude.mjs replaying `fixture`, so
 * nothing reaches the player's own setup or an API.
 */
export async function launch(
  opts: { fixture?: string; settings?: Record<string, unknown>; journal?: object[] } = {},
): Promise<TestApp> {
  const root = await mkdtemp(path.join(tmpdir(), "edchat-e2e-"));
  const home = path.join(root, "home");
  const appData = path.join(home, "AppData", "Roaming");
  const localAppData = path.join(home, "AppData", "Local");
  const journalDir = path.join(root, "journal");
  const dataDir = path.join(appData, "ed-chat");
  for (const d of [localAppData, journalDir, dataDir]) await mkdir(d, { recursive: true });

  // A .cmd shim, as npm installs the real CLI on Windows.
  const shim = path.join(root, "claude.cmd");
  const fake = path.join(ROOT, "e2e", "fake-claude.mjs");
  await writeFile(shim, `@"${process.execPath}" "${fake}" %*\r\n`);
  await writeFile(
    path.join(dataDir, "settings.json"),
    // permissionMode set: otherwise a first-run dialog asks for it and the session waits.
    JSON.stringify(
      { claude: { path: shim, permissionMode: "auto" }, journalDir, ...opts.settings },
      null,
      2,
    ),
  );
  if (opts.journal) {
    // Named from the first event's time, as the game names it (ed-mcp reads the name as UTC).
    const first = (opts.journal[0] as { timestamp?: string } | undefined)?.timestamp ?? "";
    const stamp = new Date(first).toISOString().slice(0, 19).replace(/:/g, "");
    await writeFile(
      path.join(journalDir, `Journal.${stamp}.01.log`),
      opts.journal.map((e) => JSON.stringify(e) + "\n").join(""),
    );
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // Variables the app reads that would point it at the player's own setup.
  for (const k of [
    "ELECTRON_RENDERER_URL",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "ED_MCP_SYNC_DIR",
    "ED_JOURNAL_DIR",
    // Set, Electron runs as plain Node and opens no window.
    "ELECTRON_RUN_AS_NODE",
  ])
    delete env[k];
  Object.assign(env, {
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    USERPROFILE: home,
    HOME: home,
    // Only Windows' own folders, so no installed Claude or Codex is found on PATH.
    PATH: [`${env.SystemRoot}\\System32`, env.SystemRoot].join(";"),
    FAKE_VERSION: TESTED_CLI_VERSION,
    FAKE_FIXTURE: path.join(
      ROOT,
      "test",
      "fixtures",
      "stream",
      opts.fixture ?? "recorded-text.jsonl",
    ),
  });

  const cleanUp = () => rm(root, { recursive: true, force: true, maxRetries: 5 });
  let app: ElectronApplication;
  try {
    app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  } catch (err) {
    await cleanUp();
    throw err;
  }
  try {
    // Electron finds the roaming AppData folder from the profile (USERPROFILE), not from
    // APPDATA, so this checks that the app's data really is in the temporary folder.
    const userData = await app.evaluate(({ app }) => app.getPath("userData"));
    if (!path.resolve(userData).toLowerCase().startsWith(path.resolve(root).toLowerCase()))
      throw new Error(`the app's data folder is not the test's: ${userData}`);
    // A window can still be on about:blank when it appears, so its URL is polled.
    const page = async (file: string) => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const found = app.windows().find((w) => w.url().endsWith(file));
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no window for ${file}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const chat = await page("/index.html");
    const hud = await page("/hud.html");
    await chat.waitForLoadState();
    await hud.waitForLoadState();
    return {
      app,
      chat,
      hud,
      journalDir,
      async close() {
        try {
          await app.close();
        } finally {
          // A folder Windows still holds must not fail a test that passed.
          await cleanUp().catch(() => {});
        }
      },
    };
  } catch (err) {
    // A failed start must not leave the app holding the global hotkeys for the next test.
    await app.close().catch(() => {});
    await cleanUp();
    throw err;
  }
}
