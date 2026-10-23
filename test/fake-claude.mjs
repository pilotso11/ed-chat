// Replays FAKE_FIXTURE: the first line at start, the rest after each stdin message.
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
process.stdout.write(lines[0] + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", () => {
  if (mode === "crash") {
    process.stderr.write("boom\n");
    process.exit(1);
  }
  if (mode === "hang") return;
  for (const l of lines.slice(1)) process.stdout.write(l + "\n");
});
rl.on("close", () => process.exit(0));
