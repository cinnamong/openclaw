// Gates a spawn attempt behind the external control-plane admission contract.
//
// Phase 2 wiring (control-plane-contract.md, "Phase 2 — live OpenClaw runtime
// wiring"): each of the three independent spawn triggers (heartbeat,
// completion callback, Slack ingress) calls `admitSpawnOrSkip` immediately
// before its existing spawn call. Defaults OFF everywhere
// (`OPENCLAW_CONTROL_PLANE_ADMISSION_GATE` unset/falsy): `admitSpawnOrSkip`
// then returns `true` before doing anything else, so the caller's existing
// spawn call runs exactly as it did before this module existed.
import { execFile } from "node:child_process";
import { isTruthyEnvValue } from "../infra/env.js";

/** Env var that turns the admission gate on. Unset/falsy = OFF (the default). */
export const CONTROL_PLANE_ADMISSION_GATE_ENV = "OPENCLAW_CONTROL_PLANE_ADMISSION_GATE";
/** Optional override for the control-plane entrypoint path used when the gate is on. */
const CONTROL_PLANE_SCRIPT_ENV = "OPENCLAW_CONTROL_PLANE_SCRIPT";
const DEFAULT_CONTROL_PLANE_SCRIPT = "scripts/control-plane.sh";

export type SpawnAdmissionSource = "heartbeat" | "completion" | "slack_ingress";

export type SpawnAdmissionRequest = {
  source: SpawnAdmissionSource;
  commandId: string;
  worktree: string;
  owner: string;
};

export type RunAdmissionCheck = (request: SpawnAdmissionRequest) => Promise<boolean>;

/** Resolves whether the control-plane admission gate is enabled. Defaults OFF. */
export function isControlPlaneAdmissionGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env[CONTROL_PLANE_ADMISSION_GATE_ENV]);
}

/**
 * Default admission check: shells out to `control-plane.sh spawn request ...`
 * per the contract. Exit 0 is ok-to-spawn; any non-zero exit (including the
 * documented exit 3 "no-go: another live owner holds this tree") is treated
 * as no-go.
 */
export function runControlPlaneAdmissionCheck(
  request: SpawnAdmissionRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const script = env[CONTROL_PLANE_SCRIPT_ENV]?.trim() || DEFAULT_CONTROL_PLANE_SCRIPT;
  return new Promise((resolve) => {
    execFile(
      script,
      [
        "spawn",
        "request",
        "--command-id",
        request.commandId,
        "--worktree",
        request.worktree,
        "--owner",
        request.owner,
      ],
      { env },
      (error) => {
        resolve(!error);
      },
    );
  });
}

/**
 * Gates a spawn attempt. When the flag is off (the default), this is a no-op
 * that always allows the caller to proceed, before touching admission logic,
 * env parsing beyond the flag check, or the injected check at all — so the
 * flag-off path is behaviorally identical to code that never called this
 * function. When on, delegates to `runAdmissionCheck` (or the real
 * control-plane.sh) and only allows the spawn on a go decision.
 */
export async function admitSpawnOrSkip(
  request: SpawnAdmissionRequest,
  options: {
    env?: NodeJS.ProcessEnv;
    runAdmissionCheck?: RunAdmissionCheck;
  } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (!isControlPlaneAdmissionGateEnabled(env)) {
    return true;
  }
  const runAdmissionCheck =
    options.runAdmissionCheck ??
    ((req: SpawnAdmissionRequest) => runControlPlaneAdmissionCheck(req, env));
  return await runAdmissionCheck(request);
}
