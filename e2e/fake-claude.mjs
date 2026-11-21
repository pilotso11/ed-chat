// The Claude CLI for the Playwright tests: answers --version like the real one, else replays
// FAKE_FIXTURE as test/fake-claude.mjs does. With FAKE_VERSION_GATE set, the version answer
// waits until that file exists, then the fake writes `<gate>.done` once it has answered.
import { existsSync, writeFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  const gate = process.env.FAKE_VERSION_GATE;
  const answer = () =>
    process.stdout.write(`${process.env.FAKE_VERSION} (Claude Code)\n`, () => {
      if (gate) writeFileSync(`${gate}.done`, "");
    });
  if (!gate) answer();
  else {
    // Gives up after 30 s, so a test that failed before releasing it leaves nothing running.
    const deadline = Date.now() + 30_000;
    const t = setInterval(() => {
      if (Date.now() > deadline) process.exit(1);
      if (!existsSync(gate)) return;
      clearInterval(t);
      answer();
    }, 50);
  }
} else {
  await import("../test/fake-claude.mjs");
}
