// Replays FAKE_FIXTURE like the real CLI: the init line comes only after the first stdin message.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const lines = readFileSync(process.env.FAKE_FIXTURE, "utf8").split("\n").filter(Boolean);
if (process.env.FAKE_ARGS_FILE) {
  appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(process.argv.slice(2)) + "\n");
}
const mode = process.env.FAKE_MODE ?? "ok";
if (mode === "exit-now") {
  process.stderr.write("boom\n");
  process.exit(1);
}
if (process.env.FAKE_STDERR_ON_KILL) {
  process.on("SIGTERM", () => {
    process.stderr.write("killed\n", () => process.exit(0));
  });
}
let initSent = false;
const rl = createInterface({ input: process.stdin });
rl.on("line", () => {
  if (!initSent) {
    initSent = true;
    process.stdout.write(lines[0] + "\n");
  }
  if (mode === "crash") {
    process.stderr.write("boom\n");
    process.exit(1);
  }
  if (mode === "hang") return;
  for (const l of lines.slice(1)) process.stdout.write(l + "\n");
});
rl.on("close", () => process.exit(0));
