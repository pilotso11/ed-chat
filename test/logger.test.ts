import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Logger } from "../src/core/logger.js";

describe("Logger", () => {
  it("rotates and keeps 3 files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ed-chat-"));
    const file = path.join(dir, "logs", "overlay.log");
    const log = new Logger(file, 100, 3);
    for (let i = 0; i < 20; i++) log.log("info", `line ${i} ${"x".repeat(30)}`);
    expect((await readdir(path.dirname(file))).sort()).toEqual([
      "overlay.log",
      "overlay.log.1",
      "overlay.log.2",
    ]);
    expect(await readFile(file, "utf8")).toContain("line 19");
    expect(await readFile(file, "utf8")).toMatch(/^\d{4}-\d\d-\d\dT.* info line/);
  });
});
