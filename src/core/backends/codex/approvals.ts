import type { ApprovalBroker } from "../../approvals.js";
import type { Approver } from "./session.js";

/**
 * Codex's approval requests on the overlay's approval card. "Allow until /new" answers
 * acceptForSession: main answers allow and then calls allowTool() in the same tick, before
 * this continuation runs, so the tool is already allowed when the answer is read.
 */
export function brokerApprover(broker: ApprovalBroker): Approver {
  return async (r) => {
    const outcome = await broker.ask(
      r.toolName,
      {},
      { summary: r.summary, shell: r.shell, signal: r.signal },
    );
    if (outcome !== "allow") return "decline";
    return broker.isAllowed(r.toolName) ? "acceptForSession" : "accept";
  };
}
