import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admitHeartbeatSpawn } from "./heartbeat-runner-execution.js";

const SCRIPT_PATH = resolve("test/fixtures/control-plane/test-admission-contract.sh");
const originalEnv = { ...process.env };
let tempDir = "";

describe("admitHeartbeatSpawn with the real control-plane script", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cp-heartbeat-live-"));
    chmodSync(SCRIPT_PATH, 0o755);
    process.env.OPENCLAW_CONTROL_PLANE_ADMISSION_GATE_HEARTBEAT = "true";
    process.env.OPENCLAW_CONTROL_PLANE_SCRIPT = SCRIPT_PATH;
    process.env.CP_TEST_CALL_LOG = join(tempDir, "calls.log");
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("admits when the real script returns go", async () => {
    process.env.CP_TEST_DECISION = "go";
    const result = await admitHeartbeatSpawn(
      {},
      { cfg: { agents: { defaults: { workspace: tempDir } } }, agentId: "main" } as never,
      { runSessionKey: "agent:main:heartbeat" } as never,
    );
    expect(result.admitted).toBe(true);
    expect(readFileSync(process.env.CP_TEST_CALL_LOG!, "utf8")).toContain("agent:main:heartbeat");
  });

  it("fails closed when the real script returns no-go", async () => {
    process.env.CP_TEST_DECISION = "no-go";
    const result = await admitHeartbeatSpawn(
      {},
      { cfg: { agents: { defaults: { workspace: tempDir } } }, agentId: "main" } as never,
      { runSessionKey: "agent:main:heartbeat" } as never,
    );
    expect(result).toMatchObject({ admitted: false, reasonCode: "denied" });
  });

  it("does not touch the script when the heartbeat flag is off", async () => {
    process.env.OPENCLAW_CONTROL_PLANE_ADMISSION_GATE_HEARTBEAT = "false";
    process.env.OPENCLAW_CONTROL_PLANE_SCRIPT = join(tempDir, "missing.sh");
    const result = await admitHeartbeatSpawn(
      {},
      { cfg: {}, agentId: "main" } as never,
      { runSessionKey: "agent:main:heartbeat" } as never,
    );
    expect(result).toMatchObject({ admitted: true, reasonCode: "flag_off" });
  });
});
