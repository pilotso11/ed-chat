import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalBroker,
  approvalAnswers,
  type ApprovalRequest,
  type Outcome,
} from "../src/core/approvals.js";

const brokers: ApprovalBroker[] = [];
// Settles what a failed test left open, so no 5-second timer outlives it.
afterEach(() => {
  for (const b of brokers.splice(0)) b.denyAll();
});

function broker() {
  const requests: ApprovalRequest[] = [];
  const settled: [string, Outcome][] = [];
  const b = new ApprovalBroker({
    timeoutMs: 5_000,
    onRequest: (r) => requests.push(r),
    onSettled: (id, o) => settled.push([id, o]),
    now: () => 1_000,
  });
  brokers.push(b);
  return { b, requests, settled };
}

describe("ApprovalBroker", () => {
  it("denies every open request at denyAll, and settles each once", async () => {
    const { b, requests, settled } = broker();
    const one = b.ask("Bash", { command: "ls" });
    const two = b.ask("Write", { file_path: "a" });
    b.denyAll();
    expect(await one).toBe("deny");
    expect(await two).toBe("deny");
    expect(settled).toEqual([
      [requests[0]!.id, "deny"],
      [requests[1]!.id, "deny"],
    ]);
    b.denyAll();
    expect(settled).toHaveLength(2);
    expect(b.answer(requests[0]!.id, "allow")).toBe(false);
  });

  it("uses the summary and shell that the backend gives", async () => {
    const { b, requests } = broker();
    const one = b.ask("Custom", { x: 1 }, { summary: "cmd /c dir", shell: true });
    const two = b.ask("Bash", { command: "ls" }, { shell: false });
    expect(requests[0]).toMatchObject({ toolName: "Custom", summary: "cmd /c dir", shell: true });
    expect(requests[1]).toMatchObject({ summary: "ls", shell: false });
    expect(requests[0]!.deadline).toBe(6_000);
    b.answer(requests[0]!.id, "allow");
    b.answer(requests[1]!.id, "deny");
    expect(await one).toBe("allow");
    expect(await two).toBe("deny");
  });
});

describe("approvalAnswers", () => {
  const req = (id: string, toolName: string): ApprovalRequest => ({
    id,
    toolName,
    summary: "",
    shell: false,
    deadline: 0,
  });
  const a = req("a", "Bash");
  const queue = [a, req("b", "Read"), req("c", "Bash")];

  it("allows or denies the one request", () => {
    expect(approvalAnswers(a, queue, "approve")).toEqual({
      allowTool: null,
      answers: [["a", "allow"]],
    });
    expect(approvalAnswers(a, queue, "deny")).toEqual({
      allowTool: null,
      answers: [["a", "deny"]],
    });
  });

  it("always: allows the tool, and the same tool's requests already waiting", () => {
    expect(approvalAnswers(a, queue, "alwaysAllow")).toEqual({
      allowTool: "Bash",
      answers: [
        ["a", "allowSession"],
        ["c", "allowSession"],
      ],
    });
  });
});
