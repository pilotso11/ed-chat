import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StreamParser, type SessionEvent } from "../src/core/streamJson.js";

const dir = path.join(import.meta.dirname, "fixtures", "stream");
const read = (name: string) => readFileSync(path.join(dir, name), "utf8");

describe("StreamParser", () => {
  it("maps the hand-written fixture", () => {
    const events = new StreamParser().feed(read("handwritten.jsonl"));
    expect(events).toEqual<SessionEvent[]>([
      {
        type: "ready",
        sessionId: "sess-1",
        tools: ["Bash", "mcp__ed-mcp__journal_status", "mcp__ed_chat__approve"],
        mcpServers: [
          { name: "ed-mcp", status: "connected" },
          { name: "ed_chat", status: "connected" },
        ],
        permissionMode: "auto",
      },
      { type: "text", delta: "Checking. " },
      { type: "toolStart", id: "toolu_1", name: "mcp__ed-mcp__journal_status" },
      { type: "toolEnd", id: "toolu_1", name: "mcp__ed-mcp__journal_status", isError: false },
      { type: "text", delta: "Docked at ⟦Jameson Memorial⟧." },
      {
        type: "result",
        isError: false,
        durationMs: 1200,
        text: "Checking. Docked at ⟦Jameson Memorial⟧.",
        sessionId: "sess-1",
        denials: ["Bash"],
      },
    ]);
  });

  it("joins lines split across chunks", () => {
    const p = new StreamParser();
    const line =
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}\n';
    expect(p.feed(line.slice(0, 20))).toEqual([]);
    expect(p.feed(line.slice(20))).toEqual([{ type: "text", delta: "hi" }]);
  });

  it("reports lines that are not JSON as unknown", () => {
    expect(new StreamParser().feed("oops\n")).toEqual([{ type: "unknown", raw: "oops" }]);
  });

  it("names a tool result whose start it never saw as unknown", () => {
    const line =
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","is_error":true}]}}\n';
    expect(new StreamParser().feed(line)).toEqual([
      { type: "toolEnd", id: "x", name: "unknown", isError: true },
    ]);
  });

  const recorded = readdirSync(dir).filter((f) => f.startsWith("recorded-"));

  it("has recorded fixtures", () => {
    expect(recorded.length).toBeGreaterThanOrEqual(3);
  });

  // Real output starts with hook events before init; those map to unknown.
  const known = (name: string) =>
    new StreamParser().feed(read(name)).filter((e) => e.type !== "unknown");

  it.each(recorded)("maps %s from ready to result", (name) => {
    const events = known(name);
    expect(events[0]?.type).toBe("ready");
    expect(events.at(-1)?.type).toBe("result");
    expect(events.some((e) => e.type === "text")).toBe(true);
  });

  it("finds the tool call and the denial in the recordings", () => {
    const tool = known("recorded-tool.jsonl");
    expect(tool.some((e) => e.type === "toolStart" && e.name === "Bash")).toBe(true);
    expect(tool.some((e) => e.type === "toolEnd" && e.name === "Bash")).toBe(true);
    const denied = known("recorded-denied.jsonl").at(-1);
    expect(denied?.type === "result" && denied.denials).toContain("Bash");
  });
});
