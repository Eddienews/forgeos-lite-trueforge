import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  applyCandidateArtifact,
  candidateArtifactSha256,
  createReviewedCandidatePatch,
  createReviewerVerdict,
  generateCandidateArtifact,
  originalProjectSnapshot,
  serializeCandidateArtifact,
  validateCandidateArtifact
} from "../../packages/candidate-patch/src/index.js";
import { sha256 } from "../../packages/contracts/src/index.js";

const execFileAsync = promisify(execFile);
const observedAt = "2026-08-26T12:00:00.000Z";

async function git(root, ...args) {
  return execFileAsync("git", args, { cwd: root, encoding: "utf8" });
}

async function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function fixture() {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "forgeos-phase3-")));
  const original = path.join(temporary, "original");
  const builder = path.join(temporary, "builder");
  await mkdir(original);
  await git(original, "init", "--quiet");
  await git(original, "config", "user.name", "Phase Three Test");
  await git(original, "config", "user.email", "phase-three@example.invalid");
  await write(original, "src/alpha.txt", "Alpha baseline.\n");
  await write(original, "src/remove.txt", "Remove this file.\n");
  await write(original, ".gitignore", "ignored/\n");
  await git(original, "add", ".");
  await git(original, "commit", "--quiet", "-m", "Fixture baseline");
  const { stdout } = await git(original, "rev-parse", "HEAD");
  const baseRevision = stdout.trim();
  await git(temporary, "clone", "--quiet", original, builder);
  return {
    temporary,
    original,
    builder,
    baseRevision,
    async cleanup() {
      await rm(temporary, { recursive: true, force: true });
    }
  };
}

async function standardArtifact(state) {
  await write(state.builder, "src/alpha.txt", "Alpha changed.\n");
  await write(state.builder, "src/new.txt", "A new file.\n");
  await unlink(path.join(state.builder, "src/remove.txt"));
  return generateCandidateArtifact({
    originalRoot: state.original,
    builderRoot: state.builder,
    baseRevision: state.baseRevision
  });
}

function reviewed(artifact, overrides = {}) {
  const testEvidence = [
    {
      kind: "test-run",
      summary: "Candidate fixture tests passed.",
      observedAt,
      artifactSha256: candidateArtifactSha256(artifact)
    }
  ];
  const reviewerVerdict = createReviewerVerdict({
    reviewId: "review-phase-3",
    decision: "approved",
    candidateSha256: candidateArtifactSha256(artifact),
    testEvidence,
    createdAt: observedAt
  });
  return createReviewedCandidatePatch({
    artifact,
    candidateId: "candidate-phase-3",
    missionId: "mission-phase-3",
    projectId: "project-phase-3",
    patchPath: "artifacts/candidate-phase-3.json",
    testEvidence,
    reviewerVerdict,
    createdAt: observedAt,
    ...overrides
  });
}

test("generates a deterministic add, modify, and delete artifact without touching the original", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const before = await originalProjectSnapshot(state.original);
  const first = await standardArtifact(state);
  const second = await generateCandidateArtifact({
    originalRoot: state.original,
    builderRoot: state.builder,
    baseRevision: state.baseRevision
  });
  assert.equal(serializeCandidateArtifact(first), serializeCandidateArtifact(second));
  assert.deepEqual(
    first.operations.map(({ operation, path: changedPath }) => [operation, changedPath]),
    [
      ["modify", "src/alpha.txt"],
      ["add", "src/new.txt"],
      ["delete", "src/remove.txt"]
    ]
  );
  assert.deepEqual(await originalProjectSnapshot(state.original), before);
});

test("normalizes Builder line endings before hashing", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  await write(state.builder, "src/alpha.txt", "Alpha changed.\r\nNext line.\r\n");
  const artifact = await generateCandidateArtifact({
    originalRoot: state.original,
    builderRoot: state.builder,
    baseRevision: state.baseRevision
  });
  assert.equal(artifact.operations[0].content, "Alpha changed.\nNext line.\n");
});

test("rejects binary candidate content", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  await writeFile(path.join(state.builder, "src/binary.dat"), Buffer.from([0, 1, 2]));
  await assert.rejects(
    generateCandidateArtifact({
      originalRoot: state.original,
      builderRoot: state.builder,
      baseRevision: state.baseRevision
    }),
    /binary content is unsupported/u
  );
});

test("rejects Builder symlinks and executable files", async (t) => {
  const symlinkState = await fixture();
  t.after(symlinkState.cleanup);
  await symlink("alpha.txt", path.join(symlinkState.builder, "src/link.txt"));
  await assert.rejects(
    generateCandidateArtifact({
      originalRoot: symlinkState.original,
      builderRoot: symlinkState.builder,
      baseRevision: symlinkState.baseRevision
    }),
    /ordinary file/u
  );

  const modeState = await fixture();
  t.after(modeState.cleanup);
  await write(modeState.builder, "src/alpha.txt", "Executable change.\n");
  await chmod(path.join(modeState.builder, "src/alpha.txt"), 0o755);
  await assert.rejects(
    generateCandidateArtifact({
      originalRoot: modeState.original,
      builderRoot: modeState.builder,
      baseRevision: modeState.baseRevision
    }),
    /file mode changes are unsupported/u
  );
});

test("rejects a changed Git submodule entry", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  await rm(state.builder, { recursive: true, force: true });
  await git(
    state.original,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${state.baseRevision},vendor`
  );
  await git(state.original, "commit", "--quiet", "-m", "Add fixture gitlink");
  await git(state.original, "update-index", "--skip-worktree", "vendor");
  const { stdout } = await git(state.original, "rev-parse", "HEAD");
  state.baseRevision = stdout.trim();
  await git(state.temporary, "clone", "--quiet", state.original, state.builder);
  await git(state.builder, "rm", "--quiet", "--cached", "vendor");
  await assert.rejects(
    generateCandidateArtifact({
      originalRoot: state.original,
      builderRoot: state.builder,
      baseRevision: state.baseRevision
    }),
    /submodule changes are unsupported/u
  );
});

test("rejects unsafe artifact paths, malformed operations, duplicate ordering, and unknown fields", () => {
  const baseOperation = {
    operation: "add",
    path: "src/file.txt",
    content: "Safe text.\n",
    contentSha256: sha256("Safe text.\n")
  };
  for (const unsafePath of [
    "../escape",
    "/absolute",
    ".git/config",
    "src/$(run).txt",
    "src/a b.txt",
    "src/\0file.txt"
  ]) {
    const artifact = {
      schemaVersion: "1",
      baseRevision: "a".repeat(40),
      operations: [{ ...baseOperation, path: unsafePath }]
    };
    assert.throws(() => validateCandidateArtifact(artifact), /safe|Git internals|metadata/u);
  }
  const duplicate = {
    schemaVersion: "1",
    baseRevision: "a".repeat(40),
    operations: [baseOperation, { ...baseOperation }]
  };
  assert.throws(() => validateCandidateArtifact(duplicate), /duplicate paths/u);
  const unknown = {
    schemaVersion: "1",
    baseRevision: "a".repeat(40),
    operations: [{ ...baseOperation, command: "write" }]
  };
  assert.throws(() => validateCandidateArtifact(unknown), /unknown field/u);
  const unknownOperation = {
    schemaVersion: "1",
    baseRevision: "a".repeat(40),
    operations: [{ ...baseOperation, operation: "execute" }]
  };
  assert.throws(() => validateCandidateArtifact(unknownOperation), /operation is unknown/u);
  const malformed = {
    schemaVersion: "1",
    baseRevision: "a".repeat(40),
    operations: [{ ...baseOperation, contentSha256: "short" }]
  };
  assert.throws(() => validateCandidateArtifact(malformed), /complete SHA-256/u);
});

test("derives the same canonical identity regardless of Builder write order", async (t) => {
  const left = await fixture();
  t.after(left.cleanup);
  const rightBuilder = path.join(left.temporary, "right-builder");
  await git(left.temporary, "clone", "--quiet", left.original, rightBuilder);
  await write(left.builder, "src/zulu.txt", "Zulu.\n");
  await write(left.builder, "src/alpha.txt", "Changed.\n");
  await write(rightBuilder, "src/alpha.txt", "Changed.\n");
  await write(rightBuilder, "src/zulu.txt", "Zulu.\n");
  const leftArtifact = await generateCandidateArtifact({
    originalRoot: left.original,
    builderRoot: left.builder,
    baseRevision: left.baseRevision
  });
  const rightArtifact = await generateCandidateArtifact({
    originalRoot: left.original,
    builderRoot: rightBuilder,
    baseRevision: left.baseRevision
  });
  assert.equal(candidateArtifactSha256(leftArtifact), candidateArtifactSha256(rightArtifact));
});

test("binds reviewer identity, evidence, candidate content, and public fields", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const artifact = await standardArtifact(state);
  const candidate = reviewed(artifact);
  const changed = structuredClone(candidate);
  changed.testEvidence[0].summary = "Evidence changed after review.";
  assert.throws(() => reviewed(artifact, { testEvidence: changed.testEvidence }), /canonical test evidence/u);
  const verdict = structuredClone(candidate.reviewerVerdict);
  verdict.reviewerRole = "builder";
  assert.throws(
    () =>
      createReviewedCandidatePatch({
        artifact,
        candidateId: candidate.candidateId,
        missionId: candidate.missionId,
        projectId: candidate.projectId,
        patchPath: candidate.patchPath,
        testEvidence: candidate.testEvidence,
        reviewerVerdict: verdict,
        createdAt: observedAt
      }),
    /reviewerRole/u
  );
  const privateVerdict = { ...candidate.reviewerVerdict, chainOfThought: "private" };
  assert.throws(() => createReviewedCandidatePatch({
    artifact,
    candidateId: candidate.candidateId,
    missionId: candidate.missionId,
    projectId: candidate.projectId,
    patchPath: candidate.patchPath,
    testEvidence: candidate.testEvidence,
    reviewerVerdict: privateVerdict,
    createdAt: observedAt
  }), /unknown field|forbidden/u);
});

test("applies the exact reviewed artifact without creating a commit", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const artifact = await standardArtifact(state);
  const candidate = reviewed(artifact);
  const evidence = await applyCandidateArtifact({
    candidate,
    artifact,
    projectRoot: state.original,
    clock: () => observedAt
  });
  assert.equal((await git(state.original, "rev-parse", "HEAD")).stdout.trim(), state.baseRevision);
  assert.equal(await readFile(path.join(state.original, "src/alpha.txt"), "utf8"), "Alpha changed.\n");
  assert.equal(await readFile(path.join(state.original, "src/new.txt"), "utf8"), "A new file.\n");
  await assert.rejects(readFile(path.join(state.original, "src/remove.txt")), /ENOENT/u);
  assert.deepEqual(evidence.changedFiles, candidate.affectedFiles);
  assert.equal(evidence.success, true);
});

test("rejects dirty targets and stale target revisions", async (t) => {
  const dirty = await fixture();
  t.after(dirty.cleanup);
  const dirtyArtifact = await standardArtifact(dirty);
  const dirtyCandidate = reviewed(dirtyArtifact);
  await write(dirty.original, "unrelated.txt", "Unrelated dirty file.\n");
  await assert.rejects(
    applyCandidateArtifact({
      candidate: dirtyCandidate,
      artifact: dirtyArtifact,
      projectRoot: dirty.original
    }),
    /clean, conflict-free/u
  );

  const stale = await fixture();
  t.after(stale.cleanup);
  const staleArtifact = await standardArtifact(stale);
  const staleCandidate = reviewed(staleArtifact);
  await write(stale.original, "later.txt", "Later commit.\n");
  await git(stale.original, "add", "later.txt");
  await git(stale.original, "commit", "--quiet", "-m", "Advance target");
  await assert.rejects(
    applyCandidateArtifact({
      candidate: staleCandidate,
      artifact: staleArtifact,
      projectRoot: stale.original
    }),
    /HEAD does not match/u
  );
});

test("detects a target mutation between preflight checks", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const artifact = await standardArtifact(state);
  const candidate = reviewed(artifact);
  await assert.rejects(
    applyCandidateArtifact({
      candidate,
      artifact,
      projectRoot: state.original,
      beforeFinalValidation: async () => {
        await write(state.original, "src/alpha.txt", "Race mutation.\n");
      }
    }),
    /clean, conflict-free|changed after review/u
  );
  assert.equal(await readFile(path.join(state.original, "src/new.txt")).catch(() => null), null);
});

test("rejects a symlink target escape introduced after initial preflight", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const artifact = await standardArtifact(state);
  const candidate = reviewed(artifact);
  const heldSource = path.join(state.temporary, "held-source");
  const escapeRoot = path.join(state.temporary, "escape-root");
  await mkdir(escapeRoot);
  await write(escapeRoot, "alpha.txt", "Outside target.\n");
  await assert.rejects(
    applyCandidateArtifact({
      candidate,
      artifact,
      projectRoot: state.original,
      beforeFinalValidation: async () => {
        await rename(path.join(state.original, "src"), heldSource);
        await symlink(escapeRoot, path.join(state.original, "src"));
      }
    }),
    /clean, conflict-free|real directories/u
  );
  assert.equal(await readFile(path.join(escapeRoot, "alpha.txt"), "utf8"), "Outside target.\n");
});

test("rejects a base commit created after initial preflight", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const artifact = await standardArtifact(state);
  const candidate = reviewed(artifact);
  await assert.rejects(
    applyCandidateArtifact({
      candidate,
      artifact,
      projectRoot: state.original,
      beforeFinalValidation: async () => {
        await write(state.original, "base-drift.txt", "Base drift.\n");
        await git(state.original, "add", "base-drift.txt");
        await git(state.original, "commit", "--quiet", "-m", "Advance base during preflight");
      }
    }),
    /HEAD does not match/u
  );
  assert.equal(await readFile(path.join(state.original, "src/alpha.txt"), "utf8"), "Alpha baseline.\n");
});

test("rejects ignored additions before writing", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const content = "Ignored candidate.\n";
  const artifact = {
    schemaVersion: "1",
    baseRevision: state.baseRevision,
    operations: [
      {
        operation: "add",
        path: "ignored/new.txt",
        content,
        contentSha256: sha256(content)
      }
    ]
  };
  const candidate = reviewed(artifact);
  await assert.rejects(
    applyCandidateArtifact({ candidate, artifact, projectRoot: state.original }),
    /ignored path/u
  );
});

test("rolls back every write when final evidence validation fails", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const artifact = await standardArtifact(state);
  const candidate = reviewed(artifact);
  const before = await originalProjectSnapshot(state.original);
  await assert.rejects(
    applyCandidateArtifact({
      candidate,
      artifact,
      projectRoot: state.original,
      clock: () => "not-a-timestamp"
    }),
    /application failed/u
  );
  assert.deepEqual(await originalProjectSnapshot(state.original), before);
  assert.equal(await readFile(path.join(state.original, "src/alpha.txt"), "utf8"), "Alpha baseline.\n");
  assert.equal(await readFile(path.join(state.original, "src/remove.txt"), "utf8"), "Remove this file.\n");
});
