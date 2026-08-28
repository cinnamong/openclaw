import { describe, expect, it, vi } from "vitest";
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
    const runAdmissionCheck = vi.fn().mockResolvedValue(false);
    const admitted = await admitSpawnOrSkip(request, {
      env: {},
      runAdmissionCheck,
    });
    expect(admitted).toBe(true);
    expect(runAdmissionCheck).not.toHaveBeenCalled();
  });

  it("flag ON: delegates to the injected admission check and allows on go", async () => {
    const runAdmissionCheck = vi.fn().mockResolvedValue(true);
    const admitted = await admitSpawnOrSkip(request, {
      env: { [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1" },
      runAdmissionCheck,
    });
    expect(admitted).toBe(true);
    expect(runAdmissionCheck).toHaveBeenCalledWith(request);
  });

  it("flag ON: delegates to the injected admission check and denies on no-go", async () => {
    const runAdmissionCheck = vi.fn().mockResolvedValue(false);
    const admitted = await admitSpawnOrSkip(request, {
      env: { [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1" },
      runAdmissionCheck,
    });
    expect(admitted).toBe(false);
    expect(runAdmissionCheck).toHaveBeenCalledWith(request);
  });

  it("flag ON with no injected check: falls back to runControlPlaneAdmissionCheck", async () => {
    // Point the default script at a command guaranteed to fail without a real
    // control-plane.sh present, proving the fallback wiring is live (not
    // silently skipped) while staying fully offline.
    const admitted = await admitSpawnOrSkip(request, {
      env: {
        [CONTROL_PLANE_ADMISSION_GATE_ENV]: "1",
        OPENCLAW_CONTROL_PLANE_SCRIPT: "/path/does/not/exist/control-plane.sh",
      },
    });
    expect(admitted).toBe(false);
  });
});

describe("runControlPlaneAdmissionCheck", () => {
  it("treats a missing/failing script as no-go (fails closed)", async () => {
    const admitted = await runControlPlaneAdmissionCheck(
      {
        source: "slack_ingress",
        commandId: "cmd-2",
        worktree: "/tmp/tree",
        owner: "session-2",
      },
      { OPENCLAW_CONTROL_PLANE_SCRIPT: "/path/does/not/exist/control-plane.sh" },
    );
    expect(admitted).toBe(false);
  });
});
