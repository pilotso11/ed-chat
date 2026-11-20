import type { ApprovalBroker } from "../../approvals.js";
import type { Approver } from "./session.js";

/** Codex's approval requests on the overlay's approval card. "Allow until /new" answers acceptForSession. */
export function brokerApprover(broker: ApprovalBroker): Approver {
  return async (r) => {
    const outcome = await broker.ask(
      r.toolName,
      {},
      { summary: r.summary, shell: r.shell, signal: r.signal },
    );
    if (outcome === "allowSession") return "acceptForSession";
    return outcome === "allow" ? "accept" : "decline";
  };
}
