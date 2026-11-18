import { afterEach, describe, expect, it } from "vitest";
import { ApprovalBroker, type ApprovalRequest, type Outcome } from "../src/core/approvals.js";

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

  it("uses the summary and shell that the backend gives", () => {
    const { b, requests } = broker();
    void b.ask("Custom", { x: 1 }, { summary: "cmd /c dir", shell: true });
    void b.ask("Bash", { command: "ls" }, { shell: false });
    expect(requests[0]).toMatchObject({ toolName: "Custom", summary: "cmd /c dir", shell: true });
    expect(requests[1]).toMatchObject({ summary: "ls", shell: false });
    expect(requests[0]!.deadline).toBe(6_000);
  });
});
