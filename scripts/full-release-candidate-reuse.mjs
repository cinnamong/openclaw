#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  buildFullReleaseCandidateBinding,
  buildFullReleaseCandidateRequest,
  canonicalFullReleaseCandidateRequestJson,
  candidateRequestSha256,
  fullReleaseCandidateArtifactName,
  validateFullReleaseCandidateBinding,
  validateFullReleaseCandidateRequest,
} from "./full-release-candidate-contract.mjs";
import { classifyReleaseGhTransportError } from "./full-release-validation-policy.mjs";
import {
  downloadExactActionsArtifactArchive,
  inspectActionsArtifactZip,
} from "./lib/actions-artifact-archive.mjs";
import { isRecord } from "./lib/record-shared.mjs";

const CANDIDATE_MANIFEST_FILE = "full-release-candidate.json";
const CANDIDATE_PRODUCER_WORKFLOW_PATH =
  ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const CANDIDATE_PUBLISHER_JOB_NAME =
  "Prepare shared release candidate / Bind full release candidate evidence";
const FULL_RELEASE_WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const MAX_CANDIDATE_ARCHIVE_BYTES = 1024 * 1024;
const MAX_CANDIDATES_TO_EVALUATE = 5;
const MAX_CANDIDATE_MANIFEST_BYTES = 32 * 1024;
const MAX_ARTIFACT_PAGES = 10;
const MIN_CANDIDATE_REMAINING_MS = 14 * 60 * 60 * 1000;
const CANDIDATE_DISCOVERY_BUDGET_MS = 8 * 60 * 1000;
const GH_TIMEOUT_MS = 60_000;
const CANDIDATE_GH_TIMEOUT_MS = 20_000;
const CANDIDATE_GH_RETRY_ATTEMPTS = 2;
const GH_RETRY_BASE_DELAY_MS = 1_000;
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(message);
}

class CandidateConstituentUnavailableError extends Error {}
class CandidateDiscoveryBudgetError extends Error {}

function requireDiscoveryBudget(deadlineMs) {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    throw new CandidateDiscoveryBudgetError("candidate discovery exceeded its time budget");
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function timestamp(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? { milliseconds, value } : undefined;
}

function exactRequest(left, right) {
  return (
    JSON.stringify(validateFullReleaseCandidateRequest(left)) ===
    JSON.stringify(validateFullReleaseCandidateRequest(right))
  );
}

function requestContract(input) {
  const request = validateFullReleaseCandidateRequest(input);
  const requestJson = canonicalFullReleaseCandidateRequestJson(request);
  return {
    request,
    requestJson: requestJson.trimEnd(),
    requestSha256: candidateRequestSha256(request),
  };
}

function bindingFromArchive(archiveBytes, artifactMetadata) {
  if (!(archiveBytes instanceof Uint8Array)) {
    fail("full release candidate archive omitted its manifest");
  }
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(archiveBytes).toString("utf8"));
  } catch (error) {
    fail(
      `manifest input is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return buildFullReleaseCandidateBinding({
    manifest,
    artifact: {
      name: artifactMetadata.name,
      id: artifactMetadata.id,
      digest: String(artifactMetadata.digest).replace(/^sha256:/u, ""),
      expiresAt: artifactMetadata.expires_at,
      runId: artifactMetadata.workflow_run?.id,
      runAttempt: manifest.producer?.runAttempt,
    },
  });
}

function artifactIdentityFromMetadata(metadata, runAttempt) {
  return {
    digest: String(metadata.digest ?? "").replace(/^sha256:/u, ""),
    expiresAt: String(metadata.expires_at ?? ""),
    id: String(metadata.id ?? ""),
    name: String(metadata.name ?? ""),
    runAttempt: String(runAttempt),
    runId: String(metadata.workflow_run?.id ?? ""),
  };
}

function candidateArtifactMetadata(value, expectedName, toolingSha, now) {
  if (!isRecord(value) || value.name !== expectedName || value.expired !== false) {
    return undefined;
  }
  const digest = typeof value.digest === "string" ? value.digest : "";
  const id = positiveInteger(value.id);
  const sizeInBytes = positiveInteger(value.size_in_bytes);
  const createdAt = timestamp(value.created_at);
  const expiresAt = timestamp(value.expires_at);
  const workflowRun = value.workflow_run;
  const runId = positiveInteger(workflowRun?.id);
  const repositoryId = positiveInteger(workflowRun?.repository_id);
  const headRepositoryId = positiveInteger(workflowRun?.head_repository_id);
  if (
    id === undefined ||
    sizeInBytes === undefined ||
    sizeInBytes > MAX_CANDIDATE_ARCHIVE_BYTES ||
    !createdAt ||
    !expiresAt ||
    expiresAt.milliseconds <= now + MIN_CANDIDATE_REMAINING_MS ||
    !SHA256_DIGEST_PATTERN.test(digest) ||
    !isRecord(workflowRun) ||
    runId === undefined ||
    repositoryId === undefined ||
    headRepositoryId !== repositoryId ||
    workflowRun.head_sha !== toolingSha
  ) {
    return undefined;
  }
  return { artifact: value, createdAt: createdAt.milliseconds, id, runId };
}

function workflowPath(value) {
  return typeof value === "string" ? value.split("@", 1)[0] : "";
}

function trustedWorkflowRun(value, candidate, request) {
  // A failed parent can still contribute a valid candidate when its producer
  // job succeeded; the exact producer job is verified after artifact selection.
  const active = ["in_progress", "waiting"].includes(value?.status) && value?.conclusion === null;
  const terminal =
    value?.status === "completed" &&
    typeof value?.conclusion === "string" &&
    value.conclusion.length > 0;
  if (
    !isRecord(value) ||
    value.id !== candidate.runId ||
    positiveInteger(value.run_attempt) === undefined ||
    value.head_sha !== request.toolingSha ||
    value.event !== "workflow_dispatch" ||
    workflowPath(value.path) !== FULL_RELEASE_WORKFLOW_PATH ||
    (!active && !terminal) ||
    value.repository?.full_name !== request.repository ||
    value.head_repository?.full_name !== request.repository ||
    value.repository?.id !== candidate.artifact.workflow_run.repository_id ||
    value.head_repository?.id !== candidate.artifact.workflow_run.head_repository_id ||
    typeof value.head_branch !== "string" ||
    value.head_branch.length === 0
  ) {
    return undefined;
  }
  return { artifact: candidate.artifact };
}

function newestCandidateFirst(left, right) {
  return left.createdAt !== right.createdAt ? right.createdAt - left.createdAt : right.id - left.id;
}

function isMissingMetadataError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\bHTTP (?:404|410)\b/u.test(message);
}

export async function selectTrustedFullReleaseCandidate({
  artifacts,
  deadlineMs,
  now = Date.now(),
  readWorkflowRun,
  readWorkflowJobs,
  request,
}) {
  const validatedRequest = validateFullReleaseCandidateRequest(request);
  if (
    !Array.isArray(artifacts) ||
    typeof readWorkflowRun !== "function" ||
    typeof readWorkflowJobs !== "function"
  ) {
    fail("full release candidate artifact inventory is invalid");
  }
  requireDiscoveryBudget(deadlineMs);
  const { requestSha256 } = requestContract(validatedRequest);
  const expectedName = fullReleaseCandidateArtifactName(requestSha256);
  const candidates = artifacts
    .map((artifact) =>
      candidateArtifactMetadata(artifact, expectedName, validatedRequest.toolingSha, now),
    )
    .filter(Boolean)
    .toSorted(newestCandidateFirst)
    .slice(0, MAX_CANDIDATES_TO_EVALUATE);
  for (const candidate of candidates) {
    requireDiscoveryBudget(deadlineMs);
    let run;
    try {
      run = await readWorkflowRun(candidate.runId);
    } catch (error) {
      if (isMissingMetadataError(error)) {
        continue;
      }
      throw error;
    }
    const selected = trustedWorkflowRun(run, candidate, validatedRequest);
    if (!selected) {
      continue;
    }
    // Artifact names are unique across all attempts in one run. A successful
    // non-overwriting trusted upload proves selected-target code did not reserve it.
    let workflowJobs;
    requireDiscoveryBudget(deadlineMs);
    try {
      workflowJobs = await readWorkflowJobs(candidate.runId);
    } catch (error) {
      if (isMissingMetadataError(error)) {
        continue;
      }
      throw error;
    }
    if (hasTrustedCandidatePublisher(workflowJobs, candidate, validatedRequest)) {
      return selected;
    }
  }
  return null;
}

function artifactExpiryIsFuture(binding, now, minimumRemainingMs) {
  return [
    binding.evidenceArtifact,
    binding.package.artifact,
    binding.prepublishPluginRegistry.artifact,
    binding.sharedImage.artifact,
  ].every((artifact) => {
    const expiresAt = timestamp(artifact.expiresAt);
    return expiresAt && expiresAt.milliseconds > now + minimumRemainingMs;
  });
}

function candidateConstituentArtifacts(binding) {
  return [
    ["package", binding.package.artifact],
    ["prepublish plugin registry", binding.prepublishPluginRegistry.artifact],
    ["shared image", binding.sharedImage.artifact],
  ];
}

async function validateCandidateConstituentArtifacts({
  binding,
  minimumRemainingMs,
  now,
  readArtifact,
  unavailableAsMiss,
}) {
  for (const [label, artifact] of candidateConstituentArtifacts(binding)) {
    let metadata;
    try {
      metadata = await readArtifact(artifact.id);
    } catch (error) {
      if (unavailableAsMiss && isMissingMetadataError(error)) {
        throw new CandidateConstituentUnavailableError(
          `full release candidate ${label} artifact is unavailable`,
          { cause: error },
        );
      }
      throw error;
    }
    if (
      !isRecord(metadata) ||
      JSON.stringify(artifactIdentityFromMetadata(metadata, artifact.runAttempt)) !==
        JSON.stringify(artifact) ||
      metadata.workflow_run?.head_sha !== binding.producer.workflowSha
    ) {
      fail(`full release candidate ${label} artifact identity changed`);
    }
    const expiresAt = timestamp(metadata.expires_at);
    if (
      metadata.expired !== false ||
      !expiresAt ||
      expiresAt.milliseconds <= now + minimumRemainingMs
    ) {
      if (unavailableAsMiss) {
        throw new CandidateConstituentUnavailableError(
          `full release candidate ${label} artifact is expired or near expiry`,
        );
      }
      fail(`full release candidate ${label} artifact is expired or near expiry`);
    }
  }
}

export function validateCandidateBinding(
  value,
  { minimumRemainingMs = 0, now = Date.now(), request } = {},
) {
  const binding = validateFullReleaseCandidateBinding(value);
  if (request !== undefined && !exactRequest(binding.request, request)) {
    fail("full release candidate binding request does not match the current request");
  }
  if (!artifactExpiryIsFuture(binding, now, minimumRemainingMs)) {
    fail("full release candidate binding contains expired or near-expiry artifact evidence");
  }
  return binding;
}

export function candidateArtifactJsonFromBinding(value) {
  const binding = validateFullReleaseCandidateBinding(value);
  return JSON.stringify({
    packageArtifactName: binding.package.artifact.name,
    packageArtifactId: binding.package.artifact.id,
    packageArtifactDigest: binding.package.artifact.digest,
    packageArtifactRunId: binding.package.artifact.runId,
    packageArtifactRunAttempt: binding.package.artifact.runAttempt,
    packageFileName: binding.package.fileName,
    packageSourceSha: binding.package.sourceSha,
    packageSha256: binding.package.packageSha256,
    packageVersion: binding.package.version,
    imageArtifactName: binding.sharedImage.artifact.name,
    imageArtifactId: binding.sharedImage.artifact.id,
    imageArtifactDigest: binding.sharedImage.artifact.digest,
    imageArtifactRunId: binding.sharedImage.artifact.runId,
    imageArtifactRunAttempt: binding.sharedImage.artifact.runAttempt,
    imageArchiveSha256: binding.sharedImage.archiveSha256,
    prepublishPluginRegistryArtifactName: binding.prepublishPluginRegistry.artifact.name,
    prepublishPluginRegistryArtifactId: binding.prepublishPluginRegistry.artifact.id,
    prepublishPluginRegistryArtifactDigest: binding.prepublishPluginRegistry.artifact.digest,
    prepublishPluginRegistryArtifactRunId: binding.prepublishPluginRegistry.artifact.runId,
    prepublishPluginRegistryArtifactRunAttempt:
      binding.prepublishPluginRegistry.artifact.runAttempt,
    prepublishPluginRegistryManifestSha256: binding.prepublishPluginRegistry.manifestSha256,
  });
}

function exactArchiveExpected(metadata, request) {
  return {
    artifactDigest: metadata.digest,
    artifactExpiresAt: metadata.expires_at,
    artifactId: positiveInteger(metadata.id),
    artifactName: metadata.name,
    artifactSizeBytes: positiveInteger(metadata.size_in_bytes),
    repository: request.repository,
    runId: positiveInteger(metadata.workflow_run?.id),
    workflowSha: request.toolingSha,
  };
}

function sealedArchiveExpected(binding, metadata) {
  return {
    artifactDigest: `sha256:${binding.evidenceArtifact.digest}`,
    artifactExpiresAt: binding.evidenceArtifact.expiresAt,
    artifactId: positiveInteger(binding.evidenceArtifact.id),
    artifactName: binding.evidenceArtifact.name,
    artifactSizeBytes: positiveInteger(metadata.size_in_bytes),
    repository: binding.request.repository,
    runId: positiveInteger(binding.evidenceArtifact.runId),
    workflowSha: binding.producer.workflowSha,
  };
}

function manifestFiles(archiveBytes) {
  return inspectActionsArtifactZip(archiveBytes, [CANDIDATE_MANIFEST_FILE], {
    maxArchiveBytes: MAX_CANDIDATE_ARCHIVE_BYTES,
    maxCompressedEntryBytes: MAX_CANDIDATE_ARCHIVE_BYTES,
    maxEntryBytes: MAX_CANDIDATE_MANIFEST_BYTES,
    maxExpandedBytes: MAX_CANDIDATE_MANIFEST_BYTES,
  });
}

function validateProducerWorkflowRun(run, binding, options = {}) {
  const runId = positiveInteger(binding.producer.runId);
  const runAttempt = positiveInteger(binding.producer.runAttempt);
  if (
    !isRecord(run) ||
    run.id !== runId ||
    run.run_attempt !== runAttempt ||
    run.head_sha !== binding.producer.workflowSha ||
    run.event !== "workflow_dispatch" ||
    binding.producer.workflowPath !== CANDIDATE_PRODUCER_WORKFLOW_PATH ||
    workflowPath(run.path) !== FULL_RELEASE_WORKFLOW_PATH ||
    run.repository?.full_name !== binding.producer.repository ||
    run.head_repository?.full_name !== binding.producer.repository
  ) {
    fail("full release candidate producer workflow attempt is invalid");
  }
  const active = ["in_progress", "waiting"].includes(run.status) && run.conclusion === null;
  const terminal =
    run.status === "completed" && typeof run.conclusion === "string" && run.conclusion.length > 0;
  if (!active && !terminal) {
    const current =
      runId === positiveInteger(options.consumerRunId) &&
      runAttempt === positiveInteger(options.consumerRunAttempt);
    fail(
      current
        ? "current full release candidate producer workflow attempt is not active"
        : "prior full release candidate producer workflow attempt is not active or terminal",
    );
  }
}

function validatedWorkflowJobs(workflowJobs) {
  if (
    !isRecord(workflowJobs) ||
    !Number.isSafeInteger(workflowJobs.total_count) ||
    workflowJobs.total_count < 0 ||
    !Array.isArray(workflowJobs.jobs) ||
    workflowJobs.total_count !== workflowJobs.jobs.length
  ) {
    fail("full release candidate workflow job inventory is incomplete");
  }
  return workflowJobs.jobs;
}

function hasTrustedCandidatePublisher(workflowJobs, candidate, request) {
  return validatedWorkflowJobs(workflowJobs).some(
    (job) =>
      isRecord(job) &&
      job.run_id === candidate.runId &&
      positiveInteger(job.run_attempt) !== undefined &&
      job.head_sha === request.toolingSha &&
      job.name === CANDIDATE_PUBLISHER_JOB_NAME &&
      job.status === "completed" &&
      job.conclusion === "success",
  );
}

function validateCandidateWorkflowJobs(workflowJobs, binding) {
  const jobs = validatedWorkflowJobs(workflowJobs);
  const expectedRunId = positiveInteger(binding.producer.runId);
  const expectedRunAttempt = positiveInteger(binding.producer.runAttempt);
  const matchesExpectedAttempt = (job) =>
    isRecord(job) &&
    job.run_id === expectedRunId &&
    job.run_attempt === expectedRunAttempt &&
    job.head_sha === binding.producer.workflowSha &&
    job.status === "completed" &&
    job.conclusion === "success";
  const producerJobs = jobs.filter(
    (job) =>
      matchesExpectedAttempt(job) &&
      String(job.id) === binding.producer.jobId &&
      job.name === binding.producer.jobName,
  );
  if (producerJobs.length !== 1) {
    fail("full release candidate producer job did not complete successfully");
  }
  const publisherJobs = jobs.filter(
    (job) => matchesExpectedAttempt(job) && job.name === CANDIDATE_PUBLISHER_JOB_NAME,
  );
  if (publisherJobs.length !== 1) {
    fail("full release candidate publisher job did not complete successfully");
  }
}

export async function loadSelectedFullReleaseCandidate({
  deadlineMs,
  downloadArchive = downloadExactActionsArtifactArchive,
  fetchImpl,
  now = Date.now(),
  readArtifact,
  readRunAttempt,
  readWorkflowJobs,
  request,
  selected,
  token,
}) {
  const validatedRequest = validateFullReleaseCandidateRequest(request);
  if (
    !isRecord(selected?.artifact) ||
    typeof readArtifact !== "function" ||
    typeof readRunAttempt !== "function" ||
    typeof readWorkflowJobs !== "function"
  ) {
    fail("selected full release candidate metadata is invalid");
  }
  requireDiscoveryBudget(deadlineMs);
  let downloaded;
  try {
    downloaded = await downloadArchive({
      deadlineMs,
      expected: exactArchiveExpected(selected.artifact, validatedRequest),
      fetchImpl,
      maxArchiveBytes: MAX_CANDIDATE_ARCHIVE_BYTES,
      token,
    });
  } catch (error) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      throw new CandidateDiscoveryBudgetError("candidate discovery exceeded its time budget", {
        cause: error,
      });
    }
    throw error;
  }
  const manifestBytes = manifestFiles(downloaded.archiveBytes).get(CANDIDATE_MANIFEST_FILE);
  const binding = validateCandidateBinding(
    bindingFromArchive(manifestBytes, downloaded.artifactMetadata),
    {
      minimumRemainingMs: MIN_CANDIDATE_REMAINING_MS,
      now,
      request: validatedRequest,
    },
  );
  requireDiscoveryBudget(deadlineMs);
  await validateCandidateConstituentArtifacts({
    binding,
    minimumRemainingMs: MIN_CANDIDATE_REMAINING_MS,
    now,
    readArtifact,
    unavailableAsMiss: true,
  });
  requireDiscoveryBudget(deadlineMs);
  const run = await readRunAttempt(binding.producer.runId, binding.producer.runAttempt);
  validateProducerWorkflowRun(run, binding);
  requireDiscoveryBudget(deadlineMs);
  validateCandidateWorkflowJobs(
    await readWorkflowJobs(binding.producer.runId, binding.producer.runAttempt),
    binding,
  );
  return binding;
}

export function resolveCandidateBinding({
  freshBinding,
  now = Date.now(),
  request,
  required,
  reusedBinding,
}) {
  const hasFresh = freshBinding !== null && freshBinding !== undefined;
  const hasReused = reusedBinding !== null && reusedBinding !== undefined;
  if (!required) {
    if (hasFresh || hasReused) {
      fail("full release candidate binding exists when candidate preparation is not required");
    }
    return null;
  }
  if (!request) {
    fail("full release candidate request is required");
  }
  if (hasFresh === hasReused) {
    fail("exactly one fresh or reused full release candidate binding is required");
  }
  return validateCandidateBinding(hasReused ? reusedBinding : freshBinding, {
    minimumRemainingMs: MIN_CANDIDATE_REMAINING_MS,
    now,
    request,
  });
}

export async function verifySealedFullReleaseCandidate({
  binding: bindingInput,
  consumerRunAttempt,
  consumerRunId,
  downloadArchive = downloadExactActionsArtifactArchive,
  fetchImpl,
  now = Date.now(),
  readArtifact,
  readRunAttempt,
  readWorkflowJobs,
  token,
}) {
  const binding = validateCandidateBinding(bindingInput, { now });
  const artifactMetadata = await readArtifact(binding.evidenceArtifact.id);
  await validateCandidateConstituentArtifacts({
    binding,
    minimumRemainingMs: 0,
    now,
    readArtifact,
    unavailableAsMiss: false,
  });
  const run = await readRunAttempt(binding.producer.runId, binding.producer.runAttempt);
  validateProducerWorkflowRun(run, binding, { consumerRunAttempt, consumerRunId });
  validateCandidateWorkflowJobs(
    await readWorkflowJobs(binding.producer.runId, binding.producer.runAttempt),
    binding,
  );
  const downloaded = await downloadArchive({
    expected: sealedArchiveExpected(binding, artifactMetadata),
    fetchImpl,
    maxArchiveBytes: MAX_CANDIDATE_ARCHIVE_BYTES,
    token,
  });
  const actualIdentity = artifactIdentityFromMetadata(
    downloaded.artifactMetadata,
    binding.producer.runAttempt,
  );
  if (JSON.stringify(actualIdentity) !== JSON.stringify(binding.evidenceArtifact)) {
    fail("sealed full release candidate artifact identity changed");
  }
  const manifestBytes = manifestFiles(downloaded.archiveBytes).get(CANDIDATE_MANIFEST_FILE);
  const verified = validateCandidateBinding(
    bindingFromArchive(manifestBytes, downloaded.artifactMetadata),
    { now, request: binding.request },
  );
  if (JSON.stringify(verified) !== JSON.stringify(binding)) {
    fail("sealed full release candidate binding differs from its manifest");
  }
  return verified;
}

function runGhJson(
  repository,
  path,
  label,
  { attempts = 3, deadlineMs, paginate = false, timeoutMs = GH_TIMEOUT_MS } = {},
) {
  let lastError = new Error(`${label} failed`);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    requireDiscoveryBudget(deadlineMs);
    const remainingMs = deadlineMs === undefined ? timeoutMs : deadlineMs - Date.now();
    const args = ["api"];
    if (paginate) {
      args.push("--paginate", "--slurp");
    }
    args.push(`repos/${repository}/${path}`);
    const result = spawnSync("gh", args, {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 2 * 1024 * 1024,
      timeout: Math.max(1, Math.min(timeoutMs, remainingMs)),
    });
    if (result.error) {
      lastError = result.error;
    } else if (result.status !== 0) {
      lastError = new Error(
        `${label} failed: ${result.stderr.trim() || `exit ${result.status ?? "unknown"}`}`,
      );
    } else {
      try {
        return JSON.parse(result.stdout);
      } catch (error) {
        fail(
          `${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (attempt === attempts || classifyReleaseGhTransportError(lastError) !== "transient") {
      throw lastError;
    }
    requireDiscoveryBudget(deadlineMs);
    const retryDelayMs =
      deadlineMs === undefined
        ? GH_RETRY_BASE_DELAY_MS * attempt
        : Math.min(GH_RETRY_BASE_DELAY_MS * attempt, Math.max(0, deadlineMs - Date.now()));
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
      0,
      0,
      retryDelayMs,
    );
  }
  throw lastError;
}

function readCandidateWorkflowJobs(repository, runId, runAttempt, options) {
  return readWorkflowJobPages(
    repository,
    `actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
    options,
  );
}

function readCandidateWorkflowHistory(repository, runId, options) {
  return readWorkflowJobPages(
    repository,
    `actions/runs/${runId}/jobs?filter=all&per_page=100`,
    options,
  );
}

function readWorkflowJobPages(repository, path, options) {
  const pages = runGhJson(repository, path, "full release candidate workflow jobs", {
    ...options,
    paginate: true,
  });
  if (
    !Array.isArray(pages) ||
    pages.length === 0 ||
    pages.some((page) => !isRecord(page) || !Array.isArray(page.jobs))
  ) {
    fail("full release candidate workflow job pages are invalid");
  }
  const jobs = pages.flatMap((page) => page.jobs);
  return { jobs, total_count: pages[0].total_count };
}

function readRepositoryArtifacts(repository, requestSha256, options) {
  const artifacts = [];
  const name = encodeURIComponent(fullReleaseCandidateArtifactName(requestSha256));
  for (let page = 1; page <= MAX_ARTIFACT_PAGES; page += 1) {
    const response = runGhJson(
      repository,
      `actions/artifacts?name=${name}&per_page=100&page=${page}`,
      "full release candidate artifact listing",
      options,
    );
    if (!Array.isArray(response.artifacts)) {
      fail("full release candidate artifact listing is invalid");
    }
    artifacts.push(...response.artifacts);
    if (response.artifacts.length < 100) {
      return artifacts;
    }
  }
  return null;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return fail(
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) {
    fail(`missing ${name}`);
  }
  return args[index + 1];
}

function output(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, line);
  } else {
    process.stdout.write(line);
  }
}

async function discover(args) {
  const contract = requestContract(
    buildFullReleaseCandidateRequest(
      readJson(option(args, "--request-input"), "candidate request input"),
    ),
  );
  const token = process.env.GH_TOKEN;
  if (!token) {
    fail("GH_TOKEN is required");
  }
  output("request_json", contract.requestJson);
  output("request_sha256", contract.requestSha256);
  let selected;
  const deadlineMs = Date.now() + CANDIDATE_DISCOVERY_BUDGET_MS;
  const ghOptions = {
    attempts: CANDIDATE_GH_RETRY_ATTEMPTS,
    deadlineMs,
    timeoutMs: CANDIDATE_GH_TIMEOUT_MS,
  };
  try {
    const artifacts = readRepositoryArtifacts(
      contract.request.repository,
      contract.requestSha256,
      ghOptions,
    );
    if (artifacts === null) {
      output("state", "unavailable");
      output("reused", "false");
      output("reuse_reason", "candidate artifact inventory exceeded the bounded scan");
      return;
    }
    selected = await selectTrustedFullReleaseCandidate({
      artifacts,
      deadlineMs,
      request: contract.request,
      readWorkflowRun: async (runId) =>
        runGhJson(
          contract.request.repository,
          `actions/runs/${runId}`,
          "full release candidate workflow run",
          ghOptions,
        ),
      readWorkflowJobs: async (runId) =>
        readCandidateWorkflowHistory(contract.request.repository, runId, ghOptions),
    });
  } catch (error) {
    if (error instanceof CandidateDiscoveryBudgetError) {
      output("state", "unavailable");
      output("reused", "false");
      output("reuse_reason", error.message);
      return;
    }
    if (classifyReleaseGhTransportError(error) !== "transient") {
      throw error;
    }
    output("state", "unavailable");
    output("reused", "false");
    output("reuse_reason", "candidate discovery unavailable after bounded retries");
    return;
  }
  if (!selected) {
    output("state", "miss");
    output("reused", "false");
    output("reuse_reason", "no trusted exact candidate artifact");
    return;
  }
  let binding;
  try {
    binding = await loadSelectedFullReleaseCandidate({
      deadlineMs,
      downloadArchive: (params) =>
        downloadExactActionsArtifactArchive({
          ...params,
          deadlineMs,
          retryAttempts: CANDIDATE_GH_RETRY_ATTEMPTS,
          timeoutMs: CANDIDATE_GH_TIMEOUT_MS,
        }),
      readArtifact: async (artifactId) =>
        runGhJson(
          contract.request.repository,
          `actions/artifacts/${artifactId}`,
          "full release candidate constituent artifact",
          ghOptions,
        ),
      readRunAttempt: async (runId, runAttempt) =>
        runGhJson(
          contract.request.repository,
          `actions/runs/${runId}/attempts/${runAttempt}`,
          "full release candidate workflow attempt",
          ghOptions,
        ),
      readWorkflowJobs: async (runId, runAttempt) =>
        readCandidateWorkflowJobs(contract.request.repository, runId, runAttempt, ghOptions),
      request: contract.request,
      selected,
      token,
    });
  } catch (error) {
    if (
      !(error instanceof CandidateConstituentUnavailableError) &&
      !(error instanceof CandidateDiscoveryBudgetError)
    ) {
      throw error;
    }
    output("state", "miss");
    output("reused", "false");
    output("reuse_reason", error.message);
    return;
  }
  output("state", "hit");
  output("reused", "true");
  output("reuse_reason", "trusted exact candidate artifact");
  output("binding_json", JSON.stringify(binding));
  output("candidate_artifact_json", candidateArtifactJsonFromBinding(binding));
}

function resolveBinding(args) {
  const input = readJson(option(args, "--input"), "candidate binding input");
  const binding = resolveCandidateBinding(input);
  process.stdout.write(
    `${JSON.stringify({
      binding,
      candidateArtifactJson: binding ? candidateArtifactJsonFromBinding(binding) : "",
    })}\n`,
  );
}

async function verify(args) {
  const plan = readJson(option(args, "--plan"), "release execution plan");
  if (plan.candidate === null) {
    return;
  }
  const token = process.env.GH_TOKEN;
  if (!token) {
    fail("GH_TOKEN is required");
  }
  const binding = validateCandidateBinding(plan.candidate);
  const ghOptions = {
    attempts: CANDIDATE_GH_RETRY_ATTEMPTS,
    timeoutMs: CANDIDATE_GH_TIMEOUT_MS,
  };
  await verifySealedFullReleaseCandidate({
    binding,
    consumerRunAttempt: option(args, "--consumer-run-attempt"),
    consumerRunId: option(args, "--consumer-run-id"),
    readArtifact: async (artifactId) =>
      runGhJson(
        binding.request.repository,
        `actions/artifacts/${artifactId}`,
        "sealed full release candidate artifact",
        ghOptions,
      ),
    readRunAttempt: async (runId, runAttempt) =>
      runGhJson(
        binding.request.repository,
        `actions/runs/${runId}/attempts/${runAttempt}`,
        "sealed full release candidate workflow attempt",
        ghOptions,
      ),
    readWorkflowJobs: async (runId, runAttempt) =>
      readCandidateWorkflowJobs(binding.request.repository, runId, runAttempt, ghOptions),
    downloadArchive: (params) =>
      downloadExactActionsArtifactArchive({
        ...params,
        retryAttempts: CANDIDATE_GH_RETRY_ATTEMPTS,
        timeoutMs: CANDIDATE_GH_TIMEOUT_MS,
      }),
    token,
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "discover") {
    await discover(args);
    return;
  }
  if (command === "resolve") {
    resolveBinding(args);
    return;
  }
  if (command === "verify") {
    await verify(args);
    return;
  }
  fail("usage: full-release-candidate-reuse.mjs <discover|resolve|verify> ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
