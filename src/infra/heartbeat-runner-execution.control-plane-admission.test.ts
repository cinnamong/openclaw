import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { invokeHeartbeatAgentRun } from "./heartbeat-runner-execution.js";

const SENTINEL_ERROR = new Error("getReplyFromConfig reached (test sentinel)");

function buildFixtures() {
  const cfg = {} as OpenClawConfig;
  const wake = {
    kind: "ready",
    cfg,
    agentId: "test-agent",
    heartbeat: undefined,
    startedAt: 0,
    preflight: {},
  } as unknown as Parameters<typeof invokeHeartbeatAgentRun>[1];
  const prepared = {
    kind: "ready",
    delivery: { channel: "none", to: undefined, accountId: undefined, threadId: undefined },
    hasExecCompletion: false,
    hasCronEvents: false,
    prompt: "hello",
    replyPrefix: { onModelSelected: undefined },
    runSessionKey: "session-1",
    sender: "sender-1",
    suppressOriginatingContext: false,
    usesHeartbeatResponseTool: false,
  } as unknown as Parameters<typeof invokeHeartbeatAgentRun>[2];
  return { cfg, wake, prepared };
}

describe("invokeHeartbeatAgentRun control-plane admission gate", () => {
  it("flag off (no override): reaches getReplyFromConfig exactly as before this change", async () => {
    const { wake, prepared } = buildFixtures();
    const getReplyFromConfig = vi.fn().mockRejectedValue(SENTINEL_ERROR);

    await expect(
      invokeHeartbeatAgentRun({ deps: { getReplyFromConfig } }, wake, prepared),
    ).rejects.toBe(SENTINEL_ERROR);
    expect(getReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("flag on + no-go: skips getReplyFromConfig and returns a cancelled result", async () => {
    const { wake, prepared } = buildFixtures();
    const getReplyFromConfig = vi.fn().mockRejectedValue(SENTINEL_ERROR);
    const admitSpawnOrSkip = vi.fn().mockResolvedValue(false);

    const result = await invokeHeartbeatAgentRun(
      { deps: { getReplyFromConfig, admitSpawnOrSkip } },
      wake,
      prepared,
    );

    expect(result).toEqual({ kind: "cancelled" });
    expect(getReplyFromConfig).not.toHaveBeenCalled();
    expect(admitSpawnOrSkip).toHaveBeenCalledWith({
      source: "heartbeat",
      commandId: "session-1",
      worktree: expect.any(String),
      owner: "session-1",
    });
  });

  it("flag on + go: proceeds to getReplyFromConfig", async () => {
    const { wake, prepared } = buildFixtures();
    const getReplyFromConfig = vi.fn().mockRejectedValue(SENTINEL_ERROR);
    const admitSpawnOrSkip = vi.fn().mockResolvedValue(true);

    await expect(
      invokeHeartbeatAgentRun({ deps: { getReplyFromConfig, admitSpawnOrSkip } }, wake, prepared),
    ).rejects.toBe(SENTINEL_ERROR);
    expect(getReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(admitSpawnOrSkip).toHaveBeenCalledTimes(1);
  });
});
