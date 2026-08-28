import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchSubagentAnnounceAgent,
  setSubagentAnnounceDeliveryDepsForTest,
  SpawnAdmissionDeclinedError,
} from "./subagent-announce-delivery.runtime.js";

afterEach(() => {
  setSubagentAnnounceDeliveryDepsForTest();
});

describe("dispatchSubagentAnnounceAgent control-plane admission gate", () => {
  it("flag off (real default gate): reaches dispatchGatewayMethodInProcess exactly as before this change", async () => {
    const dispatchGatewayMethodInProcess = vi.fn().mockResolvedValue({ ok: true });
    setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess });

    const result = await dispatchSubagentAnnounceAgent(
      { sessionKey: "agent:test-agent:main", idempotencyKey: "cmd-1" },
      { expectFinal: true },
    );

    expect(result).toEqual({ ok: true });
    expect(dispatchGatewayMethodInProcess).toHaveBeenCalledWith(
      "agent",
      { sessionKey: "agent:test-agent:main", idempotencyKey: "cmd-1" },
      { expectFinal: true },
    );
  });

  it("flag on + no-go: throws and skips dispatchGatewayMethodInProcess", async () => {
    const dispatchGatewayMethodInProcess = vi.fn().mockResolvedValue({ ok: true });
    const admitSpawnOrSkip = vi.fn().mockResolvedValue(false);
    setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess, admitSpawnOrSkip });

    await expect(
      dispatchSubagentAnnounceAgent(
        { sessionKey: "agent:test-agent:main", idempotencyKey: "cmd-2" },
        { expectFinal: true },
      ),
    ).rejects.toBeInstanceOf(SpawnAdmissionDeclinedError);
    expect(dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
    expect(admitSpawnOrSkip).toHaveBeenCalledWith({
      source: "completion",
      commandId: "cmd-2",
      worktree: expect.any(String),
      owner: "agent:test-agent:main",
    });
  });

  it("flag on + go: reaches dispatchGatewayMethodInProcess", async () => {
    const dispatchGatewayMethodInProcess = vi.fn().mockResolvedValue({ ok: true });
    const admitSpawnOrSkip = vi.fn().mockResolvedValue(true);
    setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess, admitSpawnOrSkip });

    const result = await dispatchSubagentAnnounceAgent(
      { sessionKey: "agent:test-agent:main", idempotencyKey: "cmd-3" },
      { expectFinal: true },
    );

    expect(result).toEqual({ ok: true });
    expect(dispatchGatewayMethodInProcess).toHaveBeenCalledTimes(1);
    expect(admitSpawnOrSkip).toHaveBeenCalledTimes(1);
  });
});
