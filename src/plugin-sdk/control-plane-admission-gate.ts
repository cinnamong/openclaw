// Gates a spawn attempt behind the external control-plane admission contract.
//
// Phase 2 wiring (control-plane-contract.md, "Phase 2 — live OpenClaw runtime
// wiring"): each of the three independent spawn triggers (heartbeat,
// completion callback, Slack ingress) calls `admitSpawnOrSkip` immediately
// before its existing spawn call. Defaults OFF everywhere
// (`OPENCLAW_CONTROL_PLANE_ADMISSION_GATE` unset/falsy): `admitSpawnOrSkip`
// then returns `{ admitted: true, reasonCode: "flag_off" }` before doing
// anything else, so the caller's existing spawn call runs exactly as it did
// before this module existed.
//
// Activation prerequisite: turning the gate on additionally requires setting
// `OPENCLAW_CONTROL_PLANE_SCRIPT` to an absolute, executable path to a real
// control-plane.sh. There is no bundled default script — an unset or invalid
// path fails closed (no-go) rather than silently no-op'ing or throwing.
import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  parseStrictPositiveInteger,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { isTruthyEnvValue } from "../infra/env.js";

/** Env var that turns the admission gate on. Unset/falsy = OFF (the default). */
export const CONTROL_PLANE_ADMISSION_GATE_ENV = "OPENCLAW_CONTROL_PLANE_ADMISSION_GATE";
/**
 * Required when the gate is on: absolute path to the control-plane
 * entrypoint. There is no default — see the activation prerequisite above.
 */
const CONTROL_PLANE_SCRIPT_ENV = "OPENCLAW_CONTROL_PLANE_SCRIPT";
/** Optional override for the admission check's execution timeout. */
const CONTROL_PLANE_TIMEOUT_MS_ENV = "OPENCLAW_CONTROL_PLANE_TIMEOUT_MS";
const DEFAULT_CONTROL_PLANE_TIMEOUT_MS = 5_000;
const MIN_CONTROL_PLANE_TIMEOUT_MS = 100;

export type SpawnAdmissionSource = "heartbeat" | "completion" | "slack_ingress";

export type SpawnAdmissionRequest = {
  source: SpawnAdmissionSource;
  commandId: string;
  /**
   * Resolved worktree identity. `undefined` means the caller could not
   * resolve it — the gate fails closed (no-go) in that case rather than
   * substituting a fallback like `process.cwd()`.
   */
  worktree: string | undefined;
  /**
   * Real owner session/identity. `undefined`/empty fails closed rather than
   * substituting a placeholder like `"unknown"`.
   */
  owner: string | undefined;
};

/** Machine-readable cause for an admission decision. Never carries secrets. */
export type AdmissionReasonCode =
  | "flag_off"
  | "admitted"
  | "denied"
  | "timeout"
  | "identity_unresolved"
  | "owner_unresolved"
  | "script_not_configured"
  | "script_not_found"
  | "script_not_executable"
  | "execution_error";

export type AdmissionOutcome = {
  admitted: boolean;
  reasonCode: AdmissionReasonCode;
  /**
   * Actionable, human-readable diagnostic. Must never include secrets, env
   * values, or tokens — only which call site/category failed.
   */
  detail: string;
};

export type RunAdmissionCheck = (request: SpawnAdmissionRequest) => Promise<AdmissionOutcome>;

/** Resolves whether the control-plane admission gate is enabled. Defaults OFF. */
export function isControlPlaneAdmissionGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env[CONTROL_PLANE_ADMISSION_GATE_ENV]);
}

function resolveAdmissionTimeoutMs(env: NodeJS.ProcessEnv): number {
  const parsed = parseStrictPositiveInteger(env[CONTROL_PLANE_TIMEOUT_MS_ENV]);
  return resolveTimerTimeoutMs(
    parsed,
    DEFAULT_CONTROL_PLANE_TIMEOUT_MS,
    MIN_CONTROL_PLANE_TIMEOUT_MS,
  );
}

type ScriptResolution =
  | { ok: true; script: string }
  | {
      ok: false;
      reasonCode: "script_not_configured" | "script_not_found" | "script_not_executable";
      detail: string;
    };

/**
 * Resolves and validates the configured control-plane script path. There is
 * no default script: an unset, relative, missing, or non-executable path
 * fails closed rather than falling back to a nonexistent bundled default.
 */
function resolveControlPlaneScript(env: NodeJS.ProcessEnv): ScriptResolution {
  const script = env[CONTROL_PLANE_SCRIPT_ENV]?.trim();
  if (!script) {
    return {
      ok: false,
      reasonCode: "script_not_configured",
      detail: `${CONTROL_PLANE_SCRIPT_ENV} is not set; the control-plane admission gate requires an explicit absolute path to control-plane.sh`,
    };
  }
  if (!isAbsolute(script)) {
    return {
      ok: false,
      reasonCode: "script_not_configured",
      detail: `${CONTROL_PLANE_SCRIPT_ENV} must be an absolute path`,
    };
  }
  if (!existsSync(script)) {
    return {
      ok: false,
      reasonCode: "script_not_found",
      detail: `${CONTROL_PLANE_SCRIPT_ENV} path does not exist`,
    };
  }
  try {
    accessSync(script, fsConstants.X_OK);
  } catch {
    return {
      ok: false,
      reasonCode: "script_not_executable",
      detail: `${CONTROL_PLANE_SCRIPT_ENV} path is not executable`,
    };
  }
  return { ok: true, script };
}

/**
 * Default admission check: shells out to `control-plane.sh spawn request ...`
 * per the contract. Exit 0 is ok-to-spawn; any non-zero exit (including the
 * documented exit 3 "no-go: another live owner holds this tree") is treated
 * as no-go. Bounded by a timeout so a wedged adapter can never hang the
 * caller (heartbeat/Slack-ingress/completion) indefinitely — a timeout is
 * itself treated as no-go (fail closed, never fail open).
 */
export function runControlPlaneAdmissionCheck(
  request: SpawnAdmissionRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdmissionOutcome> {
  const resolvedScript = resolveControlPlaneScript(env);
  if (!resolvedScript.ok) {
    return Promise.resolve({
      admitted: false,
      reasonCode: resolvedScript.reasonCode,
      detail: `control-plane admission check (${request.source}): ${resolvedScript.detail}`,
    });
  }
  const timeoutMs = resolveAdmissionTimeoutMs(env);
  return new Promise((resolve) => {
    execFile(
      resolvedScript.script,
      [
        "spawn",
        "request",
        "--command-id",
        request.commandId,
        "--worktree",
        request.worktree ?? "",
        "--owner",
        request.owner ?? "",
      ],
      { env, timeout: timeoutMs, killSignal: "SIGKILL" },
      (error) => {
        if (!error) {
          resolve({
            admitted: true,
            reasonCode: "admitted",
            detail: `control-plane admission check (${request.source}) returned ok-to-spawn`,
          });
          return;
        }
        if ((error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          resolve({
            admitted: false,
            reasonCode: "timeout",
            detail: `control-plane admission check (${request.source}) timed out after ${timeoutMs}ms; failing closed`,
          });
          return;
        }
        if (typeof (error as { code?: unknown }).code === "number") {
          resolve({
            admitted: false,
            reasonCode: "denied",
            detail: `control-plane admission check (${request.source}) denied the spawn (exit ${
              (error as { code: number }).code
            })`,
          });
          return;
        }
        resolve({
          admitted: false,
          reasonCode: "execution_error",
          detail: `control-plane admission check (${request.source}) failed to execute the control-plane script`,
        });
      },
    );
  });
}

/**
 * Gates a spawn attempt. When the flag is off (the default), this is a no-op
 * that always allows the caller to proceed, before touching admission logic,
 * identity validation, env parsing beyond the flag check, or the injected
 * check at all — so the flag-off path is behaviorally identical to code that
 * never called this function.
 *
 * When on: identity is validated first (fail closed on missing worktree or
 * owner, never substituting a fallback), then delegates to
 * `runAdmissionCheck` (or the real control-plane.sh) and only allows the
 * spawn on a go decision.
 */
export async function admitSpawnOrSkip(
  request: SpawnAdmissionRequest,
  options: {
    env?: NodeJS.ProcessEnv;
    runAdmissionCheck?: RunAdmissionCheck;
  } = {},
): Promise<AdmissionOutcome> {
  const env = options.env ?? process.env;
  if (!isControlPlaneAdmissionGateEnabled(env)) {
    return {
      admitted: true,
      reasonCode: "flag_off",
      detail: "control-plane admission gate is disabled",
    };
  }
  if (!request.worktree) {
    return {
      admitted: false,
      reasonCode: "identity_unresolved",
      detail: `control-plane admission gate (${request.source}) could not resolve worktree identity; failing closed`,
    };
  }
  if (!request.owner) {
    return {
      admitted: false,
      reasonCode: "owner_unresolved",
      detail: `control-plane admission gate (${request.source}) has no real owner identity; failing closed`,
    };
  }
  const runAdmissionCheck =
    options.runAdmissionCheck ??
    ((req: SpawnAdmissionRequest) => runControlPlaneAdmissionCheck(req, env));
  return await runAdmissionCheck(request);
}
