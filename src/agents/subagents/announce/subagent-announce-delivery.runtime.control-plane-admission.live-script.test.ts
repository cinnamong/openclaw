import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_PLANE_ADMISSION_GATE_ENV } from "../../../plugin-sdk/control-plane-admission-gate.js";
import {
  dispatchSubagentAnnounceAgent,
  setSubagentAnnounceDeliveryDepsForTest,
  SpawnAdmissionDeclinedError,
} from "./subagent-announce-delivery.runtime.js";

const SCRIPT_PATH = fileURLToPath(
  new URL("../../../../test/fixtures/control-plane/test-admission-contract.sh", import.meta.url),
);

describe.skipIf(process.platform === "win32")(
  "dispatchSubagentAnnounceAgent control-plane admission gate (real execFile)",
  () => {
    let originalGateEnv: string | undefined;
    let originalScriptEnv: string | undefined;
    let originalDecisionEnv: string | undefined;
    let originalCallLogEnv: string | undefined;
    let logDir: string;
    let callLogPath: string;

    beforeEach(() => {
      originalGateEnv = process.env[CONTROL_PLANE_ADMISSION_GATE_ENV];
      originalScriptEnv = process.env.OPENCLAW_CONTROL_PLANE_SCRIPT;
      originalDecisionEnv = process.env.CP_TEST_DECISION;
      originalCallLogEnv = process.env.CP_TEST_CALL_LOG;
      logDir = mkdtempSync(join(tmpdir(), "cp-completion-live-"));
      callLogPath = join(logDir, "calls.log");
      process.env.OPENCLAW_CONTROL_PLANE_SCRIPT = SCRIPT_PATH;
      process.env.CP_TEST_CALL_LOG = callLogPath;
    });

    afterEach(() => {
      setSubagentAnnounceDeliveryDepsForTest();
      for (const [key, value] of [
        [CONTROL_PLANE_ADMISSION_GATE_ENV, originalGateEnv],
        ["OPENCLAW_CONTROL_PLANE_SCRIPT", originalScriptEnv],
        ["CP_TEST_DECISION", originalDecisionEnv],
        ["CP_TEST_CALL_LOG", originalCallLogEnv],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      rmSync(logDir, { recursive: true, force: true });
    });

    it("flag ON + go invokes the real script before dispatching the completion callback", async () => {
      process.env[CONTROL_PLANE_ADMISSION_GATE_ENV] = "true";
      process.env.CP_TEST_DECISION = "go";
      const dispatchGatewayMethodInProcess = vi.fn().mockResolvedValue({ ok: true });
      setSubagentAnnounceDeliveryDepsForTest({
        dispatchGatewayMethodInProcess,
        getRuntimeConfig: () => ({ agents: { list: [{ id: "test-agent", workspace: logDir }] } }),
      });

      await expect(
        dispatchSubagentAnnounceAgent(
          { sessionKey: "agent:test-agent:main", idempotencyKey: "completion-live-go" },
          { expectFinal: true },
        ),
      ).resolves.toEqual({ ok: true });

      expect(dispatchGatewayMethodInProcess).toHaveBeenCalledTimes(1);
      expect(readFileSync(callLogPath, "utf8")).toContain("completion-live-go");
    });

    it("flag ON + no-go invokes the real script and skips completion dispatch", async () => {
      process.env[CONTROL_PLANE_ADMISSION_GATE_ENV] = "true";
      process.env.CP_TEST_DECISION = "no-go";
      const dispatchGatewayMethodInProcess = vi.fn().mockResolvedValue({ ok: true });
      setSubagentAnnounceDeliveryDepsForTest({
        dispatchGatewayMethodInProcess,
        getRuntimeConfig: () => ({ agents: { list: [{ id: "test-agent", workspace: logDir }] } }),
      });

      await expect(
        dispatchSubagentAnnounceAgent(
          { sessionKey: "agent:test-agent:main", idempotencyKey: "completion-live-no-go" },
          { expectFinal: true },
        ),
      ).rejects.toBeInstanceOf(SpawnAdmissionDeclinedError);

      expect(dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
      expect(readFileSync(callLogPath, "utf8")).toContain("completion-live-no-go");
    });

    it("flag OFF dispatches without touching the script", async () => {
      delete process.env[CONTROL_PLANE_ADMISSION_GATE_ENV];
      const dispatchGatewayMethodInProcess = vi.fn().mockResolvedValue({ ok: true });
      setSubagentAnnounceDeliveryDepsForTest({
        dispatchGatewayMethodInProcess,
        getRuntimeConfig: () => ({}),
      });

      await dispatchSubagentAnnounceAgent(
        { sessionKey: "agent:test-agent:main", idempotencyKey: "completion-live-off" },
        { expectFinal: true },
      );

      expect(dispatchGatewayMethodInProcess).toHaveBeenCalledTimes(1);
      expect(existsSync(callLogPath)).toBe(false);
    });
  },
);
