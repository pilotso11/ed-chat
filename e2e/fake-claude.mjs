// The Claude CLI for the Playwright tests: answers --version like the real one, after
// FAKE_VERSION_DELAY_MS when set, else replays FAKE_FIXTURE as test/fake-claude.mjs does.
if (process.argv.includes("--version")) {
  setTimeout(
    () => process.stdout.write(`${process.env.FAKE_VERSION} (Claude Code)\n`),
    Number(process.env.FAKE_VERSION_DELAY_MS ?? 0),
  );
} else {
  await import("../test/fake-claude.mjs");
}
