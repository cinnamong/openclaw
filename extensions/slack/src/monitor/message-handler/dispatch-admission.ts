import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { admitSpawnOrSkip } from "openclaw/plugin-sdk/control-plane-admission-gate";

/** Thrown when the control-plane admission gate declines a Slack-ingress spawn. */
export class SlackIngressSpawnAdmissionDeclinedError extends Error {
  readonly reasonCode: string;

  constructor(
    reasonCode = "denied",
    detail = "control-plane admission gate declined this spawn (no-go)",
  ) {
    super(detail);
    this.name = "SlackIngressSpawnAdmissionDeclinedError";
    this.reasonCode = reasonCode;
  }
}

/** Gates a Slack-ingress spawn behind the control-plane admission contract. */
export async function admitSlackIngressSpawnOrThrow(
  params: {
    cfg: Parameters<typeof resolveAgentWorkspaceDir>[0];
    route: { agentId?: string; sessionKey: string };
  },
  admissionOptions?: Parameters<typeof admitSpawnOrSkip>[1],
): Promise<void> {
  const admission = await admitSpawnOrSkip(
    {
      source: "slack_ingress",
      commandId: params.route.sessionKey,
      // No cwd fallback: unresolved identity must fail closed.
      worktree: params.route.agentId
        ? resolveAgentWorkspaceDir(params.cfg, params.route.agentId)
        : undefined,
      owner: params.route.sessionKey,
    },
    admissionOptions,
  );
  if (!admission.admitted) {
    throw new SlackIngressSpawnAdmissionDeclinedError(admission.reasonCode, admission.detail);
  }
}
