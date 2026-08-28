import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitSpawnOrSkip,
  CONTROL_PLANE_ADMISSION_GATE_ENV,
  isControlPlaneAdmissionGateEnabled,
  runControlPlaneAdmissionCheck,
} from "./control-plane-admission-gate.js";

describe("control-plane admission gate flag resolution", () => {
  it("defaults OFF when the env var is unset", () => {
    expect(isControlPlaneAdmissionGateEnabled({})).toBe(false);
  });

  it("defaults OFF for falsy env values", () => {
    for (const value of ["0", "false", "off", "", "no"]) {
      expect(
        isControlPlaneAdmissionGateEnabled({ [CONTROL_PLANE_ADMISSION_GATE_ENV]: value }),
      ).toBe(false);
    }
  });

  it("turns on only for truthy env values", () => {
    for (const value of ["1", "true", "on", "yes"]) {
      expect(
        isControlPlaneAdmissionGateEnabled({ [CONTROL_PLANE_ADMISSION_GATE_ENV]: value }),
      ).toBe(true);
    }
  });
});

describe("admitSpawnOrSkip", () => {
  const request = {
    source: "heartbeat" as const,
    commandId: "cmd-1",
    worktree: "/tmp/tree",
    owner: "session-1",
  };

  it("flag OFF: always allows and never calls the injected admission check", async () => {
    const runAdmissionCheck = vi
      .fn()
      .mockResolvedValue({ admitted: false, reasonCode: "denied", detail: "no" });
    const admission = await admitSpawnOrSkip(request, {
      env: {},
      runAdmissionCheck,
    });
    expect(admission).toEqual({
      admitted: true,
      reasonCode: "flag_off",
      detail: expect.any(String),
    });
    expect(runAdmissionCheck).not.toHaveBeenCalled();
  });

  it("flag ON: delegates to the injected admission check and allows on go", async () => {
    const runAdmissionCheck = vi
      .fn()
      .mockResolvedValue({ admitted: true, reasonCode: "admitted", detail: "ok" });
    const admission = await admitSpawnOrSkip(request, {
      env: { [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1" },
      runAdmissionCheck,
    });
    expect(admission.admitted).toBe(true);
    expect(runAdmissionCheck).toHaveBeenCalledWith(request);
  });

  it("flag ON: delegates to the injected admission check and denies on no-go", async () => {
    const runAdmissionCheck = vi
      .fn()
      .mockResolvedValue({ admitted: false, reasonCode: "denied", detail: "no" });
    const admission = await admitSpawnOrSkip(request, {
      env: { [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1" },
      runAdmissionCheck,
    });
    expect(admission.admitted).toBe(false);
    expect(runAdmissionCheck).toHaveBeenCalledWith(request);
  });

  it("flag ON with no injected check: falls back to runControlPlaneAdmissionCheck", async () => {
    // Point the script at a path guaranteed not to exist, proving the
    // fallback wiring is live (not silently skipped) while staying fully
    // offline.
    const admission = await admitSpawnOrSkip(request, {
      env: {
        [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1",
        OPENCLAW_CONTROL_PLANE_SCRIPT: "/path/does/not/exist/control-plane.sh",
      },
    });
    expect(admission).toEqual({
      admitted: false,
      reasonCode: "script_not_found",
      detail: expect.any(String),
    });
  });

  // Fix #2: missing/unresolvable worktree identity must fail closed, never
  // fall back to a substitute value like process.cwd().
  it("flag ON: fails closed when worktree identity is unresolved, without invoking the check", async () => {
    const runAdmissionCheck = vi
      .fn()
      .mockResolvedValue({ admitted: true, reasonCode: "admitted", detail: "ok" });
    const admission = await admitSpawnOrSkip(
      { ...request, worktree: undefined },
      { env: { [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1" }, runAdmissionCheck },
    );
    expect(admission).toEqual({
      admitted: false,
      reasonCode: "identity_unresolved",
      detail: expect.any(String),
    });
    expect(runAdmissionCheck).not.toHaveBeenCalled();
  });

  // Fix #3: missing/empty owner must fail closed, never fall back to a
  // placeholder like "unknown".
  it("flag ON: fails closed when owner identity is absent, without invoking the check", async () => {
    const runAdmissionCheck = vi
      .fn()
      .mockResolvedValue({ admitted: true, reasonCode: "admitted", detail: "ok" });
    const admission = await admitSpawnOrSkip(
      { ...request, owner: undefined },
      { env: { [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1" }, runAdmissionCheck },
    );
    expect(admission).toEqual({
      admitted: false,
      reasonCode: "owner_unresolved",
      detail: expect.any(String),
    });
    expect(runAdmissionCheck).not.toHaveBeenCalled();
  });

  it("flag ON: fails closed when owner identity is an empty string", async () => {
    const runAdmissionCheck = vi.fn();
    const admission = await admitSpawnOrSkip(
      { ...request, owner: "" },
      { env: { [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1" }, runAdmissionCheck },
    );
    expect(admission.admitted).toBe(false);
    expect(admission.reasonCode).toBe("owner_unresolved");
    expect(runAdmissionCheck).not.toHaveBeenCalled();
  });

  // Fix #5: diagnostics must never leak secrets/env values/tokens.
  it("diagnostic detail never echoes back injected env values", async () => {
    const secretValue = "sk-super-secret-token-should-never-appear";
    const admission = await admitSpawnOrSkip(request, {
      env: {
        [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1",
        OPENCLAW_CONTROL_PLANE_SCRIPT: "/path/does/not/exist/control-plane.sh",
        SOME_SECRET_TOKEN: secretValue,
      },
    });
    expect(admission.detail).not.toContain(secretValue);
    expect(JSON.stringify(admission)).not.toContain(secretValue);
  });
});

describe("runControlPlaneAdmissionCheck", () => {
  const request = {
    source: "slack_ingress" as const,
    commandId: "cmd-2",
    worktree: "/tmp/tree",
    owner: "session-2",
  };

  // Fix #4: no bundled default script path exists in this repo. An unset
  // script env var must fail closed with a distinct reason code, not
  // silently try a nonexistent default.
  it("fails closed with script_not_configured when the script env var is unset", async () => {
    const admission = await runControlPlaneAdmissionCheck(request, {});
    expect(admission).toEqual({
      admitted: false,
      reasonCode: "script_not_configured",
      detail: expect.any(String),
    });
  });

  it("fails closed with script_not_configured when the path is not absolute", async () => {
    const admission = await runControlPlaneAdmissionCheck(request, {
      OPENCLAW_CONTROL_PLANE_SCRIPT: "scripts/control-plane.sh",
    });
    expect(admission.admitted).toBe(false);
    expect(admission.reasonCode).toBe("script_not_configured");
  });

  it("fails closed with script_not_found when the configured path does not exist", async () => {
    const admission = await runControlPlaneAdmissionCheck(request, {
      OPENCLAW_CONTROL_PLANE_SCRIPT: "/path/does/not/exist/control-plane.sh",
    });
    expect(admission).toEqual({
      admitted: false,
      reasonCode: "script_not_found",
      detail: expect.any(String),
    });
  });

  describe("with a real temp script", () => {
    let dir: string;

    afterEach(() => {
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails closed with script_not_executable when the path exists but lacks the exec bit", async () => {
      dir = mkdtempSync(join(tmpdir(), "cp-admission-"));
      const scriptPath = join(dir, "control-plane.sh");
      writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n");
      chmodSync(scriptPath, 0o644);

      const admission = await runControlPlaneAdmissionCheck(request, {
        OPENCLAW_CONTROL_PLANE_SCRIPT: scriptPath,
      });
      expect(admission).toEqual({
        admitted: false,
        reasonCode: "script_not_executable",
        detail: expect.any(String),
      });
    });

    it("admits when the script exits 0", async () => {
      dir = mkdtempSync(join(tmpdir(), "cp-admission-"));
      const scriptPath = join(dir, "control-plane.sh");
      writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n");
      chmodSync(scriptPath, 0o755);

      const admission = await runControlPlaneAdmissionCheck(request, {
        OPENCLAW_CONTROL_PLANE_SCRIPT: scriptPath,
      });
      expect(admission).toEqual({
        admitted: true,
        reasonCode: "admitted",
        detail: expect.any(String),
      });
    });

    it("denies (fails closed) when the script exits non-zero", async () => {
      dir = mkdtempSync(join(tmpdir(), "cp-admission-"));
      const scriptPath = join(dir, "control-plane.sh");
      writeFileSync(scriptPath, "#!/bin/sh\nexit 3\n");
      chmodSync(scriptPath, 0o755);

      const admission = await runControlPlaneAdmissionCheck(request, {
        OPENCLAW_CONTROL_PLANE_SCRIPT: scriptPath,
      });
      expect(admission).toEqual({
        admitted: false,
        reasonCode: "denied",
        detail: expect.any(String),
      });
    });

    // Fix #1: a wedged adapter must never hang the caller — it must be
    // bounded by a timeout and treated as no-go (fail closed), never go.
    it("times out and fails closed (never fails open) when the script hangs", async () => {
      dir = mkdtempSync(join(tmpdir(), "cp-admission-"));
      const scriptPath = join(dir, "control-plane.sh");
      writeFileSync(scriptPath, "#!/bin/sh\nsleep 30\nexit 0\n");
      chmodSync(scriptPath, 0o755);

      const startedAt = Date.now();
      const admission = await runControlPlaneAdmissionCheck(request, {
        OPENCLAW_CONTROL_PLANE_SCRIPT: scriptPath,
        OPENCLAW_CONTROL_PLANE_TIMEOUT_MS: "300",
      });
      const elapsedMs = Date.now() - startedAt;

      expect(admission).toEqual({
        admitted: false,
        reasonCode: "timeout",
        detail: expect.any(String),
      });
      // Bounded well under the script's 30s sleep — proves we didn't wait it out.
      expect(elapsedMs).toBeLessThan(5_000);
    }, 10_000);

    it("respects a configured timeout override (short-circuits a longer default wait)", async () => {
      dir = mkdtempSync(join(tmpdir(), "cp-admission-"));
      const scriptPath = join(dir, "control-plane.sh");
      writeFileSync(scriptPath, "#!/bin/sh\nsleep 30\nexit 0\n");
      chmodSync(scriptPath, 0o755);

      const startedAt = Date.now();
      const admission = await runControlPlaneAdmissionCheck(request, {
        OPENCLAW_CONTROL_PLANE_SCRIPT: scriptPath,
        OPENCLAW_CONTROL_PLANE_TIMEOUT_MS: "200",
      });
      const elapsedMs = Date.now() - startedAt;

      expect(admission.reasonCode).toBe("timeout");
      expect(elapsedMs).toBeLessThan(3_000);
    }, 10_000);
  });

  it("diagnostic detail never leaks env values on execution failure", async () => {
    const secretValue = "sk-super-secret-token-should-never-appear";
    const admission = await runControlPlaneAdmissionCheck(request, {
      OPENCLAW_CONTROL_PLANE_SCRIPT: "/path/does/not/exist/control-plane.sh",
      SOME_SECRET_TOKEN: secretValue,
    });
    expect(admission.detail).not.toContain(secretValue);
  });
});
