import { CONTROL_PLANE_ADMISSION_GATE_ENV } from "openclaw/plugin-sdk/control-plane-admission-gate";
import { describe, expect, it, vi } from "vitest";
import {
  admitSlackIngressSpawnOrThrow,
  SlackIngressSpawnAdmissionDeclinedError,
} from "./dispatch.js";

describe("admitSlackIngressSpawnOrThrow (Slack-ingress spawn call site)", () => {
  const route = { agentId: "test-agent", sessionKey: "slack:test-agent:C1:U1" };

  it("flag off (real default gate): resolves without invoking the injected admission check", async () => {
    const runAdmissionCheck = vi.fn().mockResolvedValue(false);

    await expect(
      admitSlackIngressSpawnOrThrow({ cfg: {} as never, route }, { env: {}, runAdmissionCheck }),
    ).resolves.toBeUndefined();
    expect(runAdmissionCheck).not.toHaveBeenCalled();
  });

  it("flag on + go: resolves and calls the admission check with derived identity", async () => {
    const runAdmissionCheck = vi.fn().mockResolvedValue(true);

    await expect(
      admitSlackIngressSpawnOrThrow(
        { cfg: {} as never, route },
        { env: { [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1" }, runAdmissionCheck },
      ),
    ).resolves.toBeUndefined();
    expect(runAdmissionCheck).toHaveBeenCalledWith({
      source: "slack_ingress",
      commandId: route.sessionKey,
      worktree: expect.any(String),
      owner: route.sessionKey,
    });
  });

  it("flag on + no-go: throws SlackIngressSpawnAdmissionDeclinedError", async () => {
    const runAdmissionCheck = vi.fn().mockResolvedValue(false);

    await expect(
      admitSlackIngressSpawnOrThrow(
        { cfg: {} as never, route },
        { env: { [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1" }, runAdmissionCheck },
      ),
    ).rejects.toBeInstanceOf(SlackIngressSpawnAdmissionDeclinedError);
  });
});
