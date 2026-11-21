// The Claude CLI for the Playwright tests: answers --version like the real one, else replays
// FAKE_FIXTURE as test/fake-claude.mjs does.
if (process.argv.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_VERSION} (Claude Code)\n`);
} else {
  await import("../test/fake-claude.mjs");
}
