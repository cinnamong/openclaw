import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROL_PLANE_ADMISSION_GATE_ENV } from "openclaw/plugin-sdk/control-plane-admission-gate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admitSlackIngressSpawnOrThrow,
  SlackIngressSpawnAdmissionDeclinedError,
} from "./dispatch-admission.js";

const SCRIPT_PATH = fileURLToPath(
  new URL("../../../../../test/fixtures/control-plane/test-admission-contract.sh", import.meta.url),
);
const route = { agentId: "test-agent", sessionKey: "slack:test-agent:C1:U1" };

describe.skipIf(process.platform === "win32")(
  "admitSlackIngressSpawnOrThrow (real execFile)",
  () => {
    let logDir: string;
    let callLogPath: string;

    beforeEach(() => {
      logDir = mkdtempSync(join(tmpdir(), "cp-slack-live-"));
      callLogPath = join(logDir, "calls.log");
    });

    afterEach(() => {
      rmSync(logDir, { recursive: true, force: true });
    });

    function env(decision: "go" | "no-go", enabled = true): NodeJS.ProcessEnv {
      return {
        [CONTROL_PLANE_ADMISSION_GATE_ENV]: enabled ? "true" : undefined,
        OPENCLAW_CONTROL_PLANE_SCRIPT: SCRIPT_PATH,
        CP_TEST_DECISION: decision,
        CP_TEST_CALL_LOG: callLogPath,
      };
    }

    function config() {
      return { agents: { list: [{ id: "test-agent", workspace: logDir }] } } as never;
    }

    it("flag ON + go invokes the real script and admits Slack ingress", async () => {
      await expect(
        admitSlackIngressSpawnOrThrow({ cfg: config(), route }, { env: env("go") }),
      ).resolves.toBeUndefined();

      const logged = readFileSync(callLogPath, "utf8");
      expect(logged).toContain(route.sessionKey);
      expect(logged).toContain("spawn request");
    });

    it("flag ON + no-go invokes the real script and rejects Slack ingress", async () => {
      await expect(
        admitSlackIngressSpawnOrThrow({ cfg: config(), route }, { env: env("no-go") }),
      ).rejects.toBeInstanceOf(SlackIngressSpawnAdmissionDeclinedError);

      expect(readFileSync(callLogPath, "utf8")).toContain(route.sessionKey);
    });

    it("flag OFF admits Slack ingress without touching the script", async () => {
      await expect(
        admitSlackIngressSpawnOrThrow({ cfg: config(), route }, { env: env("no-go", false) }),
      ).resolves.toBeUndefined();

      expect(existsSync(callLogPath)).toBe(false);
    });
  },
);
