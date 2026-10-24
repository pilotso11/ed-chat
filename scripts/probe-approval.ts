// Manual probe: runs the real claude CLI against ApprovalServer and records the output.
// Usage: npx tsx scripts/probe-approval.ts <auto|default> "<prompt>" <out.jsonl>
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { ApprovalServer } from "../src/core/approvalServer.js";
import { buildClaudeArgs } from "../src/core/claudeCommand.js";

const [mode, prompt, out] = process.argv.slice(2);
if ((mode !== "auto" && mode !== "default") || !prompt || !out) {
  console.error('Usage: npx tsx scripts/probe-approval.ts <auto|default> "<prompt>" <out.jsonl>');
  process.exit(2);
}
const rl = createInterface({ input: process.stdin, output: process.stderr });
const server = new ApprovalServer({
  timeoutMs: 120_000,
  onRequest: async (r) => {
    const a = await rl.question(`\nApprove ${r.toolName} ${r.summary}? [y/N] `);
    server.answer(r.id, a.trim().toLowerCase() === "y" ? "allow" : "deny");
  },
  onSettled: () => {},
});
await server.start();
const dir = await mkdtemp(path.join(os.tmpdir(), "ed-chat-probe-"));
const cfg = path.join(dir, "approval-mcp.json");
await writeFile(cfg, JSON.stringify(server.mcpConfig()));
const child = spawn(
  "claude",
  buildClaudeArgs({ permissionMode: mode, mcpConfigFile: cfg, extraArgs: [] }),
  {
    cwd: dir,
    stdio: ["pipe", "pipe", "inherit"],
  },
);
child.stdout.pipe(createWriteStream(out));
child.stdin.end(
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  }) + "\n",
);
child.on("exit", async (code) => {
  console.error(`claude exited ${code}; output in ${out}`);
  rl.close();
  await server.stop();
});
