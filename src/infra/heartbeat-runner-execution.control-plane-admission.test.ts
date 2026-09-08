import { describe, expect, it, vi } from "vitest";
import { admitHeartbeatSpawn } from "./heartbeat-runner-execution.js";

describe("admitHeartbeatSpawn", () => {
  it("passes the resolved heartbeat identity to the admission gate", async () => {
    const admitSpawnOrSkip = vi.fn().mockResolvedValue({
      admitted: true,
      reasonCode: "admitted",
      detail: "ok",
    });
    const result = await admitHeartbeatSpawn(
      { deps: { admitSpawnOrSkip } },
      {
        cfg: { agents: { defaults: { workspace: "/tmp/heartbeat-worktree" } } },
        agentId: "main",
      } as never,
      { runSessionKey: "agent:main:heartbeat" } as never,
    );
    expect(result.admitted).toBe(true);
    expect(admitSpawnOrSkip).toHaveBeenCalledWith({
      source: "heartbeat",
      commandId: "agent:main:heartbeat",
      worktree: "/tmp/heartbeat-worktree",
      owner: "agent:main:heartbeat",
    });
  });

  it("propagates a no-go result without changing it", async () => {
    const denied = { admitted: false, reasonCode: "denied", detail: "held" } as const;
    const result = await admitHeartbeatSpawn(
      { deps: { admitSpawnOrSkip: vi.fn().mockResolvedValue(denied) } },
      { cfg: {}, agentId: "main" } as never,
      { runSessionKey: "agent:main:heartbeat" } as never,
    );
    expect(result).toEqual(denied);
  });
});
