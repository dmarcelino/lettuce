import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { notify as defaultNotify, unwatchedConversationUrl } from "./notify.ts";
import type { PushSubscriptionStore } from "./store.ts";

/**
 * Fires a push when the agent is blocked on a tool-approval prompt and
 * nobody is watching that conversation — the one case where a background
 * turn cannot proceed at all until the user responds. `control_request`
 * (subtype `can_use_tool`) is the actual approval prompt that drives
 * `ApprovalSheet` in the browser; `approval_request_message` is only an
 * informational record of the call and is not a trigger (see CLAUDE.md).
 */
export class ApprovalWatcher {
  constructor(
    private readonly store: PushSubscriptionStore,
    private readonly log: (message: string) => void,
    /** Injectable for tests; defaults to the real push funnel. */
    private readonly notify: typeof defaultNotify = defaultNotify,
  ) {}

  observe(frame: WsProtocolMessage, isWatched: (scopeKey: string) => boolean): void {
    if (frame.type !== "control_request" || frame.request.subtype !== "can_use_tool") return;

    const url = unwatchedConversationUrl(frame, isWatched, this.log);
    if (!url) return;

    void this.notify(
      this.store,
      {
        title: "Letta",
        body: `Approval needed: run ${frame.request.tool_name}?`,
        url,
      },
      "approval",
      this.log,
    );
  }
}
