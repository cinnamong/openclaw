import { CONTROL_PLANE_ADMISSION_GATE_ENV } from "openclaw/plugin-sdk/control-plane-admission-gate";
import { describe, expect, it, vi } from "vitest";
import {
  admitSlackIngressSpawnOrThrow,
  SlackIngressSpawnAdmissionDeclinedError,
} from "./dispatch.js";

describe("admitSlackIngressSpawnOrThrow (Slack-ingress spawn call site)", () => {
  const route = { agentId: "test-agent", sessionKey: "slack:test-agent:C1:U1" };

  it("flag off (real default gate): resolves without invoking the injected admission check", async () => {
    const runAdmissionCheck = vi
      .fn()
      .mockResolvedValue({ admitted: false, reasonCode: "denied", detail: "no-go" });

    await expect(
      admitSlackIngressSpawnOrThrow({ cfg: {} as never, route }, { env: {}, runAdmissionCheck }),
    ).resolves.toBeUndefined();
    expect(runAdmissionCheck).not.toHaveBeenCalled();
  });

  it("flag on + go: resolves and calls the admission check with derived identity", async () => {
    const runAdmissionCheck = vi
      .fn()
      .mockResolvedValue({ admitted: true, reasonCode: "admitted", detail: "ok" });

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
    const runAdmissionCheck = vi
      .fn()
      .mockResolvedValue({ admitted: false, reasonCode: "denied", detail: "no-go" });

    await expect(
      admitSlackIngressSpawnOrThrow(
        { cfg: {} as never, route },
        { env: { [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1" }, runAdmissionCheck },
      ),
    ).rejects.toBeInstanceOf(SlackIngressSpawnAdmissionDeclinedError);
  });

  // Fix #2: no agentId means no resolvable worktree identity — the call
  // site must not substitute process.cwd(), and the gate must fail closed.
  it("flag on + no agentId: passes worktree: undefined (no cwd fallback) and fails closed", async () => {
    const runAdmissionCheck = vi.fn();

    await expect(
      admitSlackIngressSpawnOrThrow(
        { cfg: {} as never, route: { sessionKey: route.sessionKey } },
        { env: { [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1" }, runAdmissionCheck },
      ),
    ).rejects.toBeInstanceOf(SlackIngressSpawnAdmissionDeclinedError);
    // The real gate fails closed on unresolved identity before ever
    // reaching the injected check.
    expect(runAdmissionCheck).not.toHaveBeenCalled();
  });

  // Fix #5: the thrown error should surface the gate's reason code/detail.
  it("propagates the gate's reasonCode and detail onto the thrown error", async () => {
    const runAdmissionCheck = vi.fn().mockResolvedValue({
      admitted: false,
      reasonCode: "timeout",
      detail:
        "control-plane admission check (slack_ingress) timed out after 5000ms; failing closed",
    });

    await expect(
      admitSlackIngressSpawnOrThrow(
        { cfg: {} as never, route },
        { env: { [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1" }, runAdmissionCheck },
      ),
    ).rejects.toMatchObject({
      reasonCode: "timeout",
      message: expect.stringContaining("timed out"),
    });
  });
});
