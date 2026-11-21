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
  delete env.ELECTRON_RENDERER_URL;
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

  const app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  const page = async (file: string) => {
    for (;;) {
      const found = app.windows().find((w) => w.url().endsWith(file));
      if (found) return found;
      await app.waitForEvent("window");
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
      await app.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
