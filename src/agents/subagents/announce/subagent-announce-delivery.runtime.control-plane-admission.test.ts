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
    const admitSpawnOrSkip = vi
      .fn()
      .mockResolvedValue({ admitted: false, reasonCode: "denied", detail: "no-go" });
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
    const admitSpawnOrSkip = vi
      .fn()
      .mockResolvedValue({ admitted: true, reasonCode: "admitted", detail: "ok" });
    setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess, admitSpawnOrSkip });

    const result = await dispatchSubagentAnnounceAgent(
      { sessionKey: "agent:test-agent:main", idempotencyKey: "cmd-3" },
      { expectFinal: true },
    );

    expect(result).toEqual({ ok: true });
    expect(dispatchGatewayMethodInProcess).toHaveBeenCalledTimes(1);
    expect(admitSpawnOrSkip).toHaveBeenCalledTimes(1);
  });

  // Fix #3: no sessionKey means no real owner identity — the call site must
  // not substitute the "unknown" placeholder, and the request handed to the
  // gate must carry an undefined owner so the gate itself fails closed.
  it("no sessionKey: passes owner: undefined to the gate (no 'unknown' placeholder)", async () => {
    const dispatchGatewayMethodInProcess = vi.fn().mockResolvedValue({ ok: true });
    const admitSpawnOrSkip = vi
      .fn()
      .mockResolvedValue({ admitted: false, reasonCode: "owner_unresolved", detail: "no owner" });
    setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess, admitSpawnOrSkip });

    await expect(
      dispatchSubagentAnnounceAgent({ idempotencyKey: "cmd-4" }, { expectFinal: true }),
    ).rejects.toBeInstanceOf(SpawnAdmissionDeclinedError);
    expect(dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
    expect(admitSpawnOrSkip).toHaveBeenCalledWith(
      expect.objectContaining({ owner: undefined, worktree: undefined }),
    );
  });

  // Fix #2: an unparseable sessionKey means no resolvable worktree identity
  // — the call site must not substitute process.cwd().
  it("unparseable sessionKey: passes worktree: undefined to the gate (no cwd fallback)", async () => {
    const dispatchGatewayMethodInProcess = vi.fn().mockResolvedValue({ ok: true });
    const admitSpawnOrSkip = vi.fn().mockResolvedValue({
      admitted: false,
      reasonCode: "identity_unresolved",
      detail: "no worktree",
    });
    setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess, admitSpawnOrSkip });

    await expect(
      dispatchSubagentAnnounceAgent(
        { sessionKey: "not-a-parseable-session-key", idempotencyKey: "cmd-5" },
        { expectFinal: true },
      ),
    ).rejects.toBeInstanceOf(SpawnAdmissionDeclinedError);
    expect(dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
    expect(admitSpawnOrSkip).toHaveBeenCalledWith(expect.objectContaining({ worktree: undefined }));
  });

  // Fix #5: the thrown error should surface the gate's reason code/detail
  // for debugging, without the call site inventing its own generic message.
  it("propagates the gate's reasonCode and detail onto the thrown error", async () => {
    const dispatchGatewayMethodInProcess = vi.fn().mockResolvedValue({ ok: true });
    const admitSpawnOrSkip = vi.fn().mockResolvedValue({
      admitted: false,
      reasonCode: "timeout",
      detail: "control-plane admission check (completion) timed out after 5000ms; failing closed",
    });
    setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess, admitSpawnOrSkip });

    await expect(
      dispatchSubagentAnnounceAgent(
        { sessionKey: "agent:test-agent:main", idempotencyKey: "cmd-6" },
        { expectFinal: true },
      ),
    ).rejects.toMatchObject({
      reasonCode: "timeout",
      message: expect.stringContaining("timed out"),
    });
  });
});
