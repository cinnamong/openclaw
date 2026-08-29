// Activation-prep proof: exercises the heartbeat call site with the REAL
// (non-injected) admitSpawnOrSkip -> runControlPlaneAdmissionCheck path,
// shelling out to a real on-disk test script via execFile, exactly as
// production would with OPENCLAW_CONTROL_PLANE_SCRIPT pointed at a real
// control-plane.sh. Every other test for this call site injects
// admitSpawnOrSkip directly (see heartbeat-runner-execution.control-plane-admission.test.ts);
// this file is the one place that proves the real wiring end-to-end.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CONTROL_PLANE_ADMISSION_GATE_ENV } from "../plugin-sdk/control-plane-admission-gate.js";
import { invokeHeartbeatAgentRun } from "./heartbeat-runner-execution.js";

const SENTINEL_ERROR = new Error("getReplyFromConfig reached (test sentinel)");
const SCRIPT_PATH = join(
  new URL("../../test/fixtures/control-plane/test-admission-contract.sh", import.meta.url).pathname,
);

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
    runSessionKey: "session-live-1",
    sender: "sender-1",
    suppressOriginatingContext: false,
    usesHeartbeatResponseTool: false,
  } as unknown as Parameters<typeof invokeHeartbeatAgentRun>[2];
  return { cfg, wake, prepared };
}

describe("invokeHeartbeatAgentRun control-plane admission gate (real execFile, not injected)", () => {
  let originalGateEnv: string | undefined;
  let originalScriptEnv: string | undefined;
  let logDir: string;
  let callLogPath: string;

  beforeEach(() => {
    originalGateEnv = process.env[CONTROL_PLANE_ADMISSION_GATE_ENV];
    originalScriptEnv = process.env.OPENCLAW_CONTROL_PLANE_SCRIPT;
    logDir = mkdtempSync(join(tmpdir(), "cp-admission-live-"));
    callLogPath = join(logDir, "calls.log");
    process.env.OPENCLAW_CONTROL_PLANE_SCRIPT = SCRIPT_PATH;
    process.env.CP_TEST_CALL_LOG = callLogPath;
  });

  afterEach(() => {
    if (originalGateEnv === undefined) {
      delete process.env[CONTROL_PLANE_ADMISSION_GATE_ENV];
    } else {
      process.env[CONTROL_PLANE_ADMISSION_GATE_ENV] = originalGateEnv;
    }
    if (originalScriptEnv === undefined) {
      delete process.env.OPENCLAW_CONTROL_PLANE_SCRIPT;
    } else {
      process.env.OPENCLAW_CONTROL_PLANE_SCRIPT = originalScriptEnv;
    }
    delete process.env.CP_TEST_DECISION;
    delete process.env.CP_TEST_CALL_LOG;
    rmSync(logDir, { recursive: true, force: true });
  });

  it("sanity: the fixture script itself honors the go/no-go contract via execFileSync", () => {
    expect(() =>
      execFileSync(SCRIPT_PATH, ["spawn", "request"], {
        env: { ...process.env, CP_TEST_DECISION: "go" },
      }),
    ).not.toThrow();
    expect(() =>
      execFileSync(SCRIPT_PATH, ["spawn", "request"], {
        env: { ...process.env, CP_TEST_DECISION: "no-go" },
      }),
    ).toThrow();
  });

  it("flag ON + real script exits 0 (go): the real admission check is invoked and the spawn proceeds", async () => {
    process.env[CONTROL_PLANE_ADMISSION_GATE_ENV] = "true";
    process.env.CP_TEST_DECISION = "go";
    const { wake, prepared } = buildFixtures();
    const getReplyFromConfig = () => Promise.reject(SENTINEL_ERROR);

    await expect(
      invokeHeartbeatAgentRun({ deps: { getReplyFromConfig } }, wake, prepared),
    ).rejects.toBe(SENTINEL_ERROR);

    const { readFileSync } = await import("node:fs");
    const logged = readFileSync(callLogPath, "utf8");
    expect(logged).toContain("session-live-1");
    expect(logged).toContain("spawn");
    expect(logged).toContain("request");
  });

  it("flag ON + real script exits non-zero (no-go): the real admission check is invoked and the spawn is skipped", async () => {
    process.env[CONTROL_PLANE_ADMISSION_GATE_ENV] = "true";
    process.env.CP_TEST_DECISION = "no-go";
    const { wake, prepared } = buildFixtures();
    let getReplyCalled = false;
    const getReplyFromConfig = () => {
      getReplyCalled = true;
      return Promise.reject(SENTINEL_ERROR);
    };

    const result = await invokeHeartbeatAgentRun({ deps: { getReplyFromConfig } }, wake, prepared);

    expect(result).toEqual({ kind: "cancelled" });
    expect(getReplyCalled).toBe(false);

    const { readFileSync } = await import("node:fs");
    const logged = readFileSync(callLogPath, "utf8");
    expect(logged).toContain("session-live-1");
  });

  it("flag OFF: the real admission module short-circuits before ever touching the script (call log stays empty)", async () => {
    delete process.env[CONTROL_PLANE_ADMISSION_GATE_ENV];
    const { wake, prepared } = buildFixtures();
    const getReplyFromConfig = () => Promise.reject(SENTINEL_ERROR);

    await expect(
      invokeHeartbeatAgentRun({ deps: { getReplyFromConfig } }, wake, prepared),
    ).rejects.toBe(SENTINEL_ERROR);

    const { existsSync, readFileSync } = await import("node:fs");
    if (existsSync(callLogPath)) {
      expect(readFileSync(callLogPath, "utf8")).toBe("");
    }
  });
});
