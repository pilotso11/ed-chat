import { execFileSync } from "node:child_process";

// The tests start ED Chat's always-on-top windows, which show over whatever is in front, and
// take its hotkeys while Elite is in front. So they do not run while the game is running, unless
// E2E_FORCE=1 is set. CI runs them on a machine with no game.
const GAME = /^EliteDangerous(64)?\.exe$/i;

export default function globalSetup(): void {
  if (process.platform !== "win32" || process.env.E2E_FORCE === "1") return;
  const list = execFileSync("tasklist", ["/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const names = list.split(/\r?\n/).map((l) => l.split('","')[0]!.replace(/^"/, ""));
  const running = names.find((n) => GAME.test(n));
  if (running)
    throw new Error(
      `${running} is running: the e2e tests would show ED Chat windows over the game. ` +
        "Quit the game, or set E2E_FORCE=1 to run them anyway.",
    );
}
