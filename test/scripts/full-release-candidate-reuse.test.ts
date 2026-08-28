import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  candidateArtifactJsonFromBinding,
  loadSelectedFullReleaseCandidate,
  resolveCandidateBinding,
  selectTrustedFullReleaseCandidate,
  verifySealedFullReleaseCandidate,
} from "../../scripts/full-release-candidate-reuse.mjs";
import {
  canonicalTestJson,
  fullReleaseCandidateBindingFixture,
  fullReleaseCandidateManifestFixture,
  fullReleaseCandidateRequestInput,
} from "../helpers/full-release-candidate.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const NOW = Date.parse("2026-08-28T12:00:00Z");
const EXPIRES_AT = "2026-09-04T12:00:00Z";
const REPOSITORY = "openclaw/openclaw";
const SCRIPT = resolve("scripts/full-release-candidate-reuse.mjs");
const WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function archiveWithManifest(value: unknown): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "full-release-candidate.json",
    typeof value === "string" ? value : canonicalTestJson(value),
    { date: new Date("2026-08-28T00:00:00Z") },
  );
  return zip.generateAsync({
    compression: "STORE",
    platform: "UNIX",
    type: "nodebuffer",
  });
}

function workflowRun(runId = 77, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conclusion: "failure",
    event: "workflow_dispatch",
    head_branch: "release-ci/tooling",
    head_repository: { full_name: REPOSITORY, id: 1 },
    head_sha: "b".repeat(40),
    id: runId,
    path: `${WORKFLOW_PATH}@refs/heads/release-ci/tooling`,
    repository: { full_name: REPOSITORY, id: 1 },
    run_attempt: 1,
    status: "completed",
    ...overrides,
  };
}

function workflowJobs(
  manifest = fullReleaseCandidateManifestFixture(),
  overrides: { runAttempt?: number; runId?: number } = {},
) {
  const runAttempt = overrides.runAttempt ?? Number(manifest.producer.runAttempt);
  const runId = overrides.runId ?? Number(manifest.producer.runId);
  return {
    jobs: [
      {
        conclusion: "success",
        head_sha: manifest.producer.workflowSha,
        id: Number(manifest.producer.jobId),
        name: manifest.producer.jobName,
        run_attempt: runAttempt,
        run_id: runId,
        status: "completed",
      },
      {
        conclusion: "success",
        head_sha: manifest.producer.workflowSha,
        id: 202,
        name: "Prepare shared release candidate / Bind full release candidate evidence",
        run_attempt: runAttempt,
        run_id: runId,
        status: "completed",
      },
    ],
    total_count: 2,
  };
}

function artifactMetadata(
  archive: Buffer,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const manifest = fullReleaseCandidateManifestFixture();
  return {
    created_at: "2026-08-28T10:00:00Z",
    digest: `sha256:${sha256(archive)}`,
    expired: false,
    expires_at: EXPIRES_AT,
    id: 301,
    name: `full-release-candidate-v1-${manifest.requestSha256}`,
    size_in_bytes: archive.length,
    workflow_run: {
      head_repository_id: 1,
      head_sha: manifest.request.toolingSha,
      id: 77,
      repository_id: 1,
    },
    ...overrides,
  };
}

type CandidateManifestFixture = ReturnType<typeof fullReleaseCandidateManifestFixture>;
type CandidateArtifactFixture = CandidateManifestFixture["package"]["artifact"];
type CandidateConstituentSource = Pick<
  CandidateManifestFixture,
  "package" | "prepublishPluginRegistry" | "producer" | "sharedImage"
>;

function constituentArtifactMetadata(
  artifact: CandidateArtifactFixture,
  workflowSha: string,
): Record<string, unknown> {
  return {
    digest: `sha256:${artifact.digest}`,
    expired: false,
    expires_at: artifact.expiresAt,
    id: Number(artifact.id),
    name: artifact.name,
    workflow_run: {
      head_sha: workflowSha,
      id: Number(artifact.runId),
    },
  };
}

function constituentArtifactReader(manifest: CandidateConstituentSource) {
  const artifacts = [
    manifest.package.artifact,
    manifest.prepublishPluginRegistry.artifact,
    manifest.sharedImage.artifact,
  ];
  return async (artifactId: string) => {
    const artifact = artifacts.find((entry) => entry.id === artifactId);
    if (!artifact) {
      throw new Error("GitHub Actions artifact metadata returned HTTP 404.");
    }
    return constituentArtifactMetadata(artifact, manifest.producer.workflowSha);
  };
}

async function fixture() {
  const manifest = fullReleaseCandidateManifestFixture();
  const archive = await archiveWithManifest(manifest);
  return {
    archive,
    manifest,
    metadata: artifactMetadata(archive),
  };
}

describe("trusted full release candidate selection", () => {
  it("treats malformed metadata and workflow provenance as misses before selection", async () => {
    const { archive, manifest, metadata } = await fixture();
    let runReads = 0;
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [
        { ...metadata, name: "wrong" },
        { ...metadata, digest: "" },
        { ...metadata, expired: true },
        { ...metadata, expires_at: "2026-08-28T11:59:59Z" },
        { ...metadata, expires_at: "2026-08-28T13:59:59Z" },
        {
          ...artifactMetadata(archive, { id: 302 }),
          workflow_run: {
            head_repository_id: 2,
            head_sha: manifest.request.toolingSha,
            id: 78,
            repository_id: 1,
          },
        },
        {
          ...artifactMetadata(archive, { id: 303 }),
          workflow_run: {
            head_repository_id: 1,
            head_sha: "9".repeat(40),
            id: 79,
            repository_id: 1,
          },
        },
      ],
      now: NOW,
      readWorkflowRun: async () => {
        runReads += 1;
        return workflowRun();
      },
      readWorkflowJobs: async () => {
        throw new Error("workflow jobs must not be read");
      },
      request: manifest.request,
    });
    expect(selected).toBeNull();
    expect(runReads).toBe(0);
  });

  it("orders candidates by newest creation time then descending numeric artifact ID", async () => {
    const { archive, manifest } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [
        artifactMetadata(archive, { id: 9 }),
        artifactMetadata(archive, { id: 10 }),
        artifactMetadata(archive, { created_at: "2026-08-28T09:00:00Z", id: 99 }),
      ],
      now: NOW,
      readWorkflowRun: async (runId) => workflowRun(runId),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    expect(selected?.artifact.id).toBe(10);
  });

  it("accepts an active trusted parent after its publisher job succeeds", async () => {
    const { manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(77, { conclusion: null, status: "in_progress" }),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    expect(selected?.artifact.id).toBe(301);
  });

  it("requires enough remaining lifetime for the longest release-validation drain", async () => {
    const { archive, manifest } = await fixture();
    const tooShort = artifactMetadata(archive, {
      expires_at: new Date(NOW + 13 * 60 * 60 * 1000).toISOString(),
    });
    const longEnough = artifactMetadata(archive, {
      expires_at: new Date(NOW + 15 * 60 * 60 * 1000).toISOString(),
      id: 302,
    });
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [tooShort, longEnough],
      now: NOW,
      readWorkflowRun: async (runId) => workflowRun(runId),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    expect(selected?.artifact.id).toBe(302);
  });

  it("bounds provenance reads to the newest candidate set", async () => {
    const { archive, manifest } = await fixture();
    const artifacts = Array.from({ length: 6 }, (_, index) => {
      const runId = 80 + index;
      return artifactMetadata(archive, {
        created_at: new Date(NOW - index * 1000).toISOString(),
        id: 400 + index,
        workflow_run: {
          head_repository_id: 1,
          head_sha: manifest.request.toolingSha,
          id: runId,
          repository_id: 1,
        },
      });
    });
    const runReads: number[] = [];
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts,
      now: NOW,
      readWorkflowRun: async (runId) => {
        runReads.push(runId);
        return workflowRun(runId);
      },
      readWorkflowJobs: async (runId) => {
        const jobs = workflowJobs(manifest, { runId });
        jobs.jobs[1]!.conclusion = runId === 85 ? "success" : "failure";
        return jobs;
      },
      request: manifest.request,
    });
    expect(selected).toBeNull();
    expect(runReads).toEqual([80, 81, 82, 83, 84]);
  });

  it("skips an artifact whose trusted publisher job did not succeed", async () => {
    const { archive, manifest, metadata } = await fixture();
    const newest = artifactMetadata(archive, {
      created_at: "2026-08-28T11:00:00Z",
      id: 302,
      workflow_run: {
        head_repository_id: 1,
        head_sha: manifest.request.toolingSha,
        id: 78,
        repository_id: 1,
      },
    });
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata, newest],
      now: NOW,
      readWorkflowRun: async (runId) => workflowRun(runId),
      readWorkflowJobs: async (runId) => {
        const jobs = workflowJobs(manifest, { runId });
        if (runId === 78) {
          jobs.jobs[1]!.conclusion = "failure";
        }
        return jobs;
      },
      request: manifest.request,
    });
    expect(selected?.artifact.id).toBe(301);
  });

  it("skips a trust miss but never falls back after selecting malformed evidence", async () => {
    const { manifest, metadata } = await fixture();
    const malformedArchive = await archiveWithManifest("{");
    const newest = artifactMetadata(malformedArchive, {
      created_at: "2026-08-28T11:00:00Z",
      id: 302,
      workflow_run: {
        head_repository_id: 1,
        head_sha: manifest.request.toolingSha,
        id: 78,
        repository_id: 1,
      },
    });
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata, newest],
      now: NOW,
      readWorkflowRun: async (runId) => workflowRun(runId),
      readWorkflowJobs: async (runId) => workflowJobs(manifest, { runId }),
      request: manifest.request,
    });
    const downloads: number[] = [];
    await expect(
      loadSelectedFullReleaseCandidate({
        downloadArchive: async ({ expected }) => {
          downloads.push((expected as { artifactId: number }).artifactId);
          return { archiveBytes: malformedArchive, artifactMetadata: newest };
        },
        now: NOW,
        readArtifact: constituentArtifactReader(manifest),
        readRunAttempt: async () => workflowRun(78),
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).rejects.toThrow("manifest input is invalid JSON");
    expect(downloads).toEqual([302]);
  });
});

describe("full release candidate discovery CLI", () => {
  it("turns exhausted transient reads into a fresh-preparation miss", () => {
    const root = tempDirs.make("full-release-candidate-discovery-");
    const bin = join(root, "bin");
    const countPath = join(root, "gh-count");
    const inputPath = join(root, "request-input.json");
    const outputPath = join(root, "github-output");
    mkdirSync(bin);
    const ghPath = join(bin, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
count=0
if [ -f "$FAKE_GH_COUNT" ]; then count="$(cat "$FAKE_GH_COUNT")"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$FAKE_GH_COUNT"
echo "HTTP 502: transient candidate lookup failure" >&2
exit 1
`,
    );
    chmodSync(ghPath, 0o755);
    writeFileSync(inputPath, JSON.stringify(fullReleaseCandidateRequestInput()));
    const result = spawnSync(process.execPath, [SCRIPT, "discover", "--request-input", inputPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GH_COUNT: countPath,
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: outputPath,
        PATH: `${bin}:${process.env.PATH}`,
      },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(countPath, "utf8").trim()).toBe("2");
    expect(readFileSync(outputPath, "utf8")).toContain(
      "reuse_reason=candidate discovery unavailable after bounded retries",
    );
    expect(readFileSync(outputPath, "utf8")).toContain("reused=false");
  });

  it("turns bounded artifact inventory exhaustion into a fresh-preparation miss", () => {
    const root = tempDirs.make("full-release-candidate-inventory-");
    const bin = join(root, "bin");
    const countPath = join(root, "gh-count");
    const inputPath = join(root, "request-input.json");
    const outputPath = join(root, "github-output");
    const payloadPath = join(root, "artifacts.json");
    mkdirSync(bin);
    const ghPath = join(bin, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
count=0
if [ -f "$FAKE_GH_COUNT" ]; then count="$(cat "$FAKE_GH_COUNT")"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$FAKE_GH_COUNT"
cat "$FAKE_GH_PAYLOAD"
`,
    );
    chmodSync(ghPath, 0o755);
    writeFileSync(inputPath, JSON.stringify(fullReleaseCandidateRequestInput()));
    writeFileSync(
      payloadPath,
      JSON.stringify({ artifacts: Array.from({ length: 100 }, () => ({})) }),
    );
    const result = spawnSync(process.execPath, [SCRIPT, "discover", "--request-input", inputPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GH_COUNT: countPath,
        FAKE_GH_PAYLOAD: payloadPath,
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: outputPath,
        PATH: `${bin}:${process.env.PATH}`,
      },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(countPath, "utf8").trim()).toBe("10");
    expect(readFileSync(outputPath, "utf8")).toContain(
      "reuse_reason=candidate artifact inventory exceeded the bounded scan",
    );
    expect(readFileSync(outputPath, "utf8")).toContain("reused=false");
  });
});

describe("full release candidate loading", () => {
  it("binds the exact archive, producer attempt, and producer job", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(77, { run_attempt: 2 }),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    const binding = await loadSelectedFullReleaseCandidate({
      downloadArchive: async ({ expected }) => {
        expect(expected).toMatchObject({
          artifactId: 301,
          artifactName: metadata.name,
          runId: 77,
          workflowSha: manifest.request.toolingSha,
        });
        return { archiveBytes: archive, artifactMetadata: metadata };
      },
      now: NOW,
      readArtifact: constituentArtifactReader(manifest),
      readRunAttempt: async (runId, runAttempt) => {
        expect([runId, runAttempt]).toEqual(["77", "1"]);
        return workflowRun(77, { run_attempt: 1 });
      },
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
      selected: selected!,
      token: "test-token",
    });
    expect(binding).toMatchObject({
      evidenceArtifact: {
        digest: sha256(archive),
        id: "301",
        runAttempt: "1",
        runId: "77",
      },
      producer: manifest.producer,
      request: manifest.request,
    });
  });

  it("accepts an active producer run after the exact producer jobs complete", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(77, { conclusion: null, status: "in_progress" }),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    await expect(
      loadSelectedFullReleaseCandidate({
        downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
        now: NOW,
        readArtifact: constituentArtifactReader(manifest),
        readRunAttempt: async () => workflowRun(77, { conclusion: null, status: "in_progress" }),
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).resolves.toMatchObject({ producer: manifest.producer });
  });

  it("rejects unavailable, expired, or changed constituent artifacts before reuse", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    const packageId = manifest.package.artifact.id;
    const cases = [
      {
        expected: "package artifact is unavailable",
        readArtifact: async (artifactId: string) => {
          if (artifactId === packageId) {
            throw new Error("GitHub Actions artifact metadata returned HTTP 404.");
          }
          return constituentArtifactReader(manifest)(artifactId);
        },
      },
      {
        expected: "package artifact is expired or near expiry",
        readArtifact: async (artifactId: string) => {
          const value = await constituentArtifactReader(manifest)(artifactId);
          return artifactId === packageId ? { ...value, expired: true } : value;
        },
      },
      {
        expected: "package artifact identity changed",
        readArtifact: async (artifactId: string) => {
          const value = await constituentArtifactReader(manifest)(artifactId);
          return artifactId === packageId
            ? { ...value, digest: `sha256:${"9".repeat(64)}` }
            : value;
        },
      },
    ];
    for (const testCase of cases) {
      await expect(
        loadSelectedFullReleaseCandidate({
          downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
          now: NOW,
          readArtifact: testCase.readArtifact,
          readRunAttempt: async () => workflowRun(),
          readWorkflowJobs: async () => workflowJobs(manifest),
          request: manifest.request,
          selected: selected!,
          token: "test-token",
        }),
      ).rejects.toThrow(testCase.expected);
    }
  });

  it("rejects a manifest producer workflow that differs from the selected run", async () => {
    const { manifest } = await fixture();
    const changedManifest = structuredClone(manifest);
    changedManifest.producer.workflowPath = ".github/workflows/candidate-evidence-test.yml";
    const archive = await archiveWithManifest(changedManifest);
    const metadata = artifactMetadata(archive);
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    await expect(
      loadSelectedFullReleaseCandidate({
        downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
        now: NOW,
        readArtifact: constituentArtifactReader(changedManifest),
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(changedManifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).rejects.toThrow("producer workflow attempt is invalid");
  });

  it("hard-fails an unavailable, changed, or expired selected artifact", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    for (const error of [
      new Error("GitHub Actions artifact metadata returned HTTP 404."),
      new Error("Actions artifact metadata does not match the exact artifact tuple."),
      new Error("full release candidate binding contains expired artifact evidence"),
    ]) {
      await expect(
        loadSelectedFullReleaseCandidate({
          downloadArchive: async () => {
            throw error;
          },
          now: NOW,
          readArtifact: constituentArtifactReader(manifest),
          readRunAttempt: async () => workflowRun(),
          readWorkflowJobs: async () => workflowJobs(manifest),
          request: manifest.request,
          selected: selected!,
          token: "test-token",
        }),
      ).rejects.toThrow(error.message);
    }
    expect(archive.length).toBeGreaterThan(0);
  });

  it("rejects evidence when the trusted publisher job did not succeed", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    const jobs = workflowJobs(manifest);
    jobs.jobs[1]!.conclusion = "failure";
    await expect(
      loadSelectedFullReleaseCandidate({
        downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
        now: NOW,
        readArtifact: constituentArtifactReader(manifest),
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => jobs,
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).rejects.toThrow("publisher job did not complete successfully");
  });
});

describe("full release candidate binding authority", () => {
  it("normalizes fresh and reused evidence to the same downstream tuple", () => {
    const binding = fullReleaseCandidateBindingFixture();
    const fresh = resolveCandidateBinding({
      freshBinding: binding,
      now: NOW,
      request: binding.request,
      required: true,
    });
    const reused = resolveCandidateBinding({
      now: NOW,
      request: binding.request,
      required: true,
      reusedBinding: binding,
    });
    expect(fresh).toEqual(binding);
    expect(reused).toEqual(binding);
    expect(candidateArtifactJsonFromBinding(fresh)).toBe(candidateArtifactJsonFromBinding(reused));
  });

  it("rejects missing, ambiguous, expired, and wrong-request evidence", () => {
    const binding = fullReleaseCandidateBindingFixture();
    expect(() =>
      resolveCandidateBinding({ now: NOW, request: binding.request, required: true }),
    ).toThrow("exactly one");
    expect(() =>
      resolveCandidateBinding({
        freshBinding: binding,
        now: NOW,
        request: binding.request,
        required: true,
        reusedBinding: binding,
      }),
    ).toThrow("exactly one");
    expect(() =>
      resolveCandidateBinding({
        freshBinding: binding,
        now: Date.parse(EXPIRES_AT),
        request: binding.request,
        required: true,
      }),
    ).toThrow("expired or near-expiry");
    expect(() =>
      resolveCandidateBinding({
        freshBinding: binding,
        now: Date.parse(EXPIRES_AT) - 90 * 60 * 1000,
        request: binding.request,
        required: true,
      }),
    ).toThrow("expired or near-expiry");
    expect(() =>
      resolveCandidateBinding({
        freshBinding: binding,
        now: NOW,
        request: { ...binding.request, releaseProfile: "beta" },
        required: true,
      }),
    ).toThrow("does not match");
  });
});

describe("sealed full release candidate verification", () => {
  it("rechecks the exact evidence archive and producer tuple", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    const binding = await loadSelectedFullReleaseCandidate({
      downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
      now: NOW,
      readArtifact: constituentArtifactReader(manifest),
      readRunAttempt: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
      selected: selected!,
      token: "test-token",
    });
    await expect(
      verifySealedFullReleaseCandidate({
        binding,
        consumerRunAttempt: 1,
        consumerRunId: 88,
        downloadArchive: async ({ expected }) => {
          expect(expected).toMatchObject({
            artifactDigest: `sha256:${binding.evidenceArtifact.digest}`,
            artifactExpiresAt: binding.evidenceArtifact.expiresAt,
            artifactId: Number(binding.evidenceArtifact.id),
            artifactName: binding.evidenceArtifact.name,
            runId: Number(binding.evidenceArtifact.runId),
          });
          return { archiveBytes: archive, artifactMetadata: metadata };
        },
        now: NOW,
        readArtifact: async (artifactId) => {
          if (artifactId === binding.evidenceArtifact.id) {
            return metadata;
          }
          return constituentArtifactReader(binding)(artifactId);
        },
        readRunAttempt: async (runId, runAttempt) => {
          expect([runId, runAttempt]).toEqual(["77", "1"]);
          return workflowRun();
        },
        readWorkflowJobs: async () => workflowJobs(manifest),
        token: "test-token",
      }),
    ).resolves.toEqual(binding);
  });

  it("fails final verification when a sealed constituent artifact disappears", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    const binding = await loadSelectedFullReleaseCandidate({
      downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
      now: NOW,
      readArtifact: constituentArtifactReader(manifest),
      readRunAttempt: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
      selected: selected!,
      token: "test-token",
    });
    await expect(
      verifySealedFullReleaseCandidate({
        binding,
        consumerRunAttempt: 1,
        consumerRunId: 88,
        downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
        now: NOW,
        readArtifact: async (artifactId) => {
          if (artifactId === binding.evidenceArtifact.id) {
            return metadata;
          }
          if (artifactId === binding.package.artifact.id) {
            throw new Error("GitHub Actions artifact metadata returned HTTP 404.");
          }
          return constituentArtifactReader(binding)(artifactId);
        },
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(manifest),
        token: "test-token",
      }),
    ).rejects.toThrow("HTTP 404");
  });

  it("rejects an evidence artifact identity change before accepting the archive", async () => {
    const binding = fullReleaseCandidateBindingFixture();
    const metadata = {
      created_at: "2026-08-28T10:00:00Z",
      digest: `sha256:${binding.evidenceArtifact.digest}`,
      expired: false,
      expires_at: binding.evidenceArtifact.expiresAt,
      id: Number(binding.evidenceArtifact.id) + 1,
      name: binding.evidenceArtifact.name,
      size_in_bytes: 100,
      workflow_run: {
        head_repository_id: 1,
        head_sha: binding.producer.workflowSha,
        id: Number(binding.producer.runId),
        repository_id: 1,
      },
    };
    await expect(
      verifySealedFullReleaseCandidate({
        binding,
        consumerRunAttempt: 1,
        consumerRunId: 88,
        downloadArchive: async ({ expected }) => {
          expect(expected).toMatchObject({ artifactId: Number(binding.evidenceArtifact.id) });
          throw new Error("Actions artifact metadata does not match the exact artifact tuple.");
        },
        now: NOW,
        readArtifact: async (artifactId) => {
          if (artifactId === binding.evidenceArtifact.id) {
            return metadata;
          }
          return constituentArtifactReader(binding)(artifactId);
        },
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(),
        token: "test-token",
      }),
    ).rejects.toThrow("does not match the exact artifact tuple");
  });
});
