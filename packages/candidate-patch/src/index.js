import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  SCHEMA_VERSION,
  assertExactKeys,
  assertIsoTimestamp,
  assertNoForbiddenFields,
  assertPlainObject,
  assertSafeRelativePath,
  assertSha256,
  canonicalJson,
  hashesEqual,
  reviewerEvidenceHash,
  sha256,
  validateApplicationEvidence,
  validateCandidatePatch,
  validateReviewerVerdict
} from "@forgeos-lite/contracts";

const execFileAsync = promisify(execFile);
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const pathSegmentPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const operationNames = new Set(["add", "modify", "delete"]);
const maximumFileBytes = 1_000_000;
const maximumOperations = 1000;

function fail(message) {
  throw new TypeError(message);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail(`${label} must be a stable identifier.`);
  }
}

export function assertCandidatePath(value, label = "candidate path") {
  assertSafeRelativePath(value, label);
  const segments = value.split("/");
  if (segments.some((segment) => segment === ".git")) {
    fail(`${label} cannot target Git internals.`);
  }
  if (segments.some((segment) => !pathSegmentPattern.test(segment))) {
    fail(`${label} contains unsupported or executable metadata characters.`);
  }
  return value;
}

function assertCanonicalOrder(paths, label) {
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  if (new Set(paths).size !== paths.length) {
    fail(`${label} contains duplicate paths.`);
  }
  if (canonicalJson(paths) !== canonicalJson(sorted)) {
    fail(`${label} must use canonical path ordering.`);
  }
}

function canonicalText(buffer, label) {
  if (!Buffer.isBuffer(buffer) || buffer.length > maximumFileBytes || buffer.includes(0)) {
    fail(`${label} must be a bounded text file; binary content is unsupported.`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail(`${label} must contain valid UTF-8 text; binary content is unsupported.`);
  }
  return text.replace(/\r\n?/gu, "\n");
}

function validateOperation(operation, index) {
  const label = `CandidateArtifact.operations[${index}]`;
  assertPlainObject(operation, label);
  if (!operationNames.has(operation.operation)) {
    fail(`${label}.operation is unknown.`);
  }
  const contentFields = operation.operation === "delete" ? [] : ["content", "contentSha256"];
  const baseFields = operation.operation === "add" ? [] : ["baseContentSha256"];
  assertExactKeys(
    operation,
    ["operation", "path", ...contentFields, ...baseFields],
    [],
    label
  );
  assertCandidatePath(operation.path, `${label}.path`);
  if (operation.operation !== "add") {
    assertSha256(operation.baseContentSha256, `${label}.baseContentSha256`);
  }
  if (operation.operation !== "delete") {
    if (
      typeof operation.content !== "string" ||
      Buffer.byteLength(operation.content, "utf8") > maximumFileBytes ||
      operation.content.includes("\0") ||
      operation.content.includes("\r")
    ) {
      fail(`${label}.content must be bounded canonical UTF-8 text.`);
    }
    assertSha256(operation.contentSha256, `${label}.contentSha256`);
    if (!hashesEqual(sha256(operation.content), operation.contentSha256)) {
      fail(`${label}.contentSha256 does not match its canonical content.`);
    }
  }
}

export function validateCandidateArtifact(value) {
  assertExactKeys(value, ["schemaVersion", "baseRevision", "operations"], [], "CandidateArtifact");
  if (value.schemaVersion !== SCHEMA_VERSION) {
    fail(`CandidateArtifact.schemaVersion must equal ${SCHEMA_VERSION}.`);
  }
  if (typeof value.baseRevision !== "string" || !revisionPattern.test(value.baseRevision)) {
    fail("CandidateArtifact.baseRevision must be a complete Git revision hash.");
  }
  if (
    !Array.isArray(value.operations) ||
    value.operations.length === 0 ||
    value.operations.length > maximumOperations
  ) {
    fail(`CandidateArtifact.operations must contain 1 through ${maximumOperations} entries.`);
  }
  value.operations.forEach(validateOperation);
  assertCanonicalOrder(
    value.operations.map((operation) => operation.path),
    "CandidateArtifact.operations"
  );
  assertNoForbiddenFields(value, "CandidateArtifact");
  return value;
}

export function serializeCandidateArtifact(value) {
  validateCandidateArtifact(value);
  return canonicalJson(value);
}

export function candidateArtifactSha256(value) {
  return sha256(serializeCandidateArtifact(value));
}

async function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    fail(`${label} must be an absolute host path.`);
  }
  const normalized = path.normalize(value);
  if (normalized !== value || normalized === path.parse(normalized).root) {
    fail(`${label} must be a normalized, non-root absolute host path.`);
  }
  const details = await lstat(value);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    fail(`${label} must be a real directory, not a symlink.`);
  }
  const resolved = await realpath(value);
  if (resolved !== value) {
    fail(`${label} must already use its canonical real path.`);
  }
  return resolved;
}

async function gitText(root, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
}

async function gitBuffer(root, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
}

async function isIgnoredPath(root, relativePath) {
  try {
    await execFileAsync("git", ["check-ignore", "--quiet", "--", relativePath], { cwd: root });
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
}

async function assertRepositoryAt(root, revision, label) {
  const top = (await gitText(root, ["rev-parse", "--show-toplevel"])).trim();
  if (top !== root) {
    fail(`${label} must be the canonical Git repository root.`);
  }
  const head = (await gitText(root, ["rev-parse", "HEAD"])).trim();
  if (head !== revision) {
    fail(`${label} HEAD does not match the candidate base revision.`);
  }
  const objectType = (await gitText(root, ["cat-file", "-t", revision])).trim();
  if (objectType !== "commit") {
    fail(`${label} base revision must identify a Git commit.`);
  }
}

function parseNullList(value) {
  return value.split("\0").filter((entry) => entry !== "");
}

async function baselineEntries(root, revision) {
  const output = await gitText(root, ["ls-tree", "-r", "-z", "--full-tree", revision]);
  const entries = new Map();
  for (const record of parseNullList(output)) {
    const match = /^(?<mode>[0-9]{6}) (?<type>[^ ]+) (?<object>[a-f0-9]+)\t(?<path>.+)$/u.exec(record);
    if (!match?.groups) {
      fail("Git returned an unsupported tree entry.");
    }
    entries.set(match.groups.path, {
      mode: match.groups.mode,
      object: match.groups.object,
      type: match.groups.type
    });
  }
  return entries;
}

async function pathDetails(root, relativePath) {
  const target = path.join(root, ...relativePath.split("/"));
  let details;
  try {
    details = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    fail(`Candidate path must resolve to an ordinary file: ${relativePath}.`);
  }
  if ((details.mode & 0o111) !== 0) {
    fail(`Candidate file mode changes are unsupported: ${relativePath}.`);
  }
  const resolved = await realpath(target);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    fail(`Candidate path escapes its workspace through a symlink: ${relativePath}.`);
  }
  return { details, target };
}

async function baselineText(root, revision, relativePath) {
  const content = await gitBuffer(root, ["cat-file", "blob", `${revision}:${relativePath}`]);
  return canonicalText(content, `Baseline file ${relativePath}`);
}

function assertSupportedBaseline(entry, relativePath) {
  if (entry.type === "commit" || entry.mode === "160000") {
    fail(`Candidate submodule changes are unsupported: ${relativePath}.`);
  }
  if (entry.mode === "120000") {
    fail(`Candidate symlink changes are unsupported: ${relativePath}.`);
  }
  if (entry.type !== "blob" || entry.mode !== "100644") {
    fail(`Candidate Git object or file mode is unsupported: ${relativePath}.`);
  }
}

export async function generateCandidateArtifact(options) {
  assertExactKeys(
    options,
    ["originalRoot", "builderRoot", "baseRevision"],
    [],
    "CandidateGenerationOptions"
  );
  if (typeof options.baseRevision !== "string" || !revisionPattern.test(options.baseRevision)) {
    fail("CandidateGenerationOptions.baseRevision must be a complete Git revision hash.");
  }
  const originalRoot = await canonicalDirectory(options.originalRoot, "originalRoot");
  const builderRoot = await canonicalDirectory(options.builderRoot, "builderRoot");
  if (originalRoot === builderRoot) {
    fail("Candidate generation requires a separate isolated Builder workspace.");
  }
  await assertRepositoryAt(originalRoot, options.baseRevision, "originalRoot");
  await assertRepositoryAt(builderRoot, options.baseRevision, "builderRoot");
  const originalStatus = await gitText(originalRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all"
  ]);
  if (originalStatus !== "") {
    fail("Candidate generation requires an unchanged original working tree.");
  }
  const changed = parseNullList(
    await gitText(builderRoot, ["diff", "--name-only", "-z", "--no-renames", options.baseRevision])
  );
  const untracked = parseNullList(
    await gitText(builderRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
  );
  const paths = [...new Set([...changed, ...untracked])].sort((left, right) =>
    left.localeCompare(right)
  );
  if (paths.length === 0 || paths.length > maximumOperations) {
    fail(`Candidate generation requires 1 through ${maximumOperations} changed files.`);
  }
  const baseline = await baselineEntries(originalRoot, options.baseRevision);
  const operations = [];
  for (const relativePath of paths) {
    assertCandidatePath(relativePath, "Candidate changed path");
    const baseEntry = baseline.get(relativePath);
    if (baseEntry !== undefined) {
      assertSupportedBaseline(baseEntry, relativePath);
    }
    const current = await pathDetails(builderRoot, relativePath);
    if (baseEntry === undefined && current === null) {
      fail(`Candidate path has no baseline or Builder file: ${relativePath}.`);
    }
    const baseContent =
      baseEntry === undefined ? null : await baselineText(originalRoot, options.baseRevision, relativePath);
    const currentContent =
      current === null
        ? null
        : canonicalText(await readFile(current.target), `Builder file ${relativePath}`);
    if (baseContent === null) {
      operations.push({
        operation: "add",
        path: relativePath,
        content: currentContent,
        contentSha256: sha256(currentContent)
      });
    } else if (currentContent === null) {
      operations.push({
        operation: "delete",
        path: relativePath,
        baseContentSha256: sha256(baseContent)
      });
    } else if (baseContent !== currentContent) {
      operations.push({
        operation: "modify",
        path: relativePath,
        baseContentSha256: sha256(baseContent),
        content: currentContent,
        contentSha256: sha256(currentContent)
      });
    }
  }
  if (operations.length === 0) {
    fail("Candidate changes normalize to the original target state.");
  }
  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    baseRevision: options.baseRevision,
    operations
  };
  validateCandidateArtifact(artifact);
  return deepFreeze(structuredClone(artifact));
}

export function createReviewerVerdict(options) {
  assertExactKeys(
    options,
    ["reviewId", "decision", "candidateSha256", "testEvidence", "createdAt"],
    [],
    "ReviewerVerdictOptions"
  );
  assertIdentifier(options.reviewId, "ReviewerVerdictOptions.reviewId");
  assertSha256(options.candidateSha256, "ReviewerVerdictOptions.candidateSha256");
  if (!Array.isArray(options.testEvidence)) {
    fail("ReviewerVerdictOptions.testEvidence must be an array.");
  }
  assertNoForbiddenFields(options.testEvidence, "ReviewerVerdictOptions.testEvidence");
  assertIsoTimestamp(options.createdAt, "ReviewerVerdictOptions.createdAt");
  const verdict = {
    reviewId: options.reviewId,
    reviewerRole: "reviewer",
    decision: options.decision,
    candidateSha256: options.candidateSha256,
    evidenceSha256: sha256(options.testEvidence),
    createdAt: options.createdAt
  };
  validateReviewerVerdict(verdict);
  return deepFreeze(verdict);
}

export function createReviewedCandidatePatch(options) {
  assertExactKeys(
    options,
    [
      "artifact",
      "candidateId",
      "missionId",
      "projectId",
      "patchPath",
      "testEvidence",
      "reviewerVerdict",
      "createdAt"
    ],
    [],
    "ReviewedCandidateOptions"
  );
  validateCandidateArtifact(options.artifact);
  assertCandidatePath(options.patchPath, "ReviewedCandidateOptions.patchPath");
  const candidate = {
    schemaVersion: SCHEMA_VERSION,
    candidateId: options.candidateId,
    missionId: options.missionId,
    projectId: options.projectId,
    baseRevision: options.artifact.baseRevision,
    patchPath: options.patchPath,
    patchSha256: candidateArtifactSha256(options.artifact),
    affectedFiles: options.artifact.operations.map((operation) => operation.path),
    testEvidence: structuredClone(options.testEvidence),
    reviewerVerdict: structuredClone(options.reviewerVerdict),
    createdAt: options.createdAt
  };
  validateCandidatePatch(candidate);
  return deepFreeze(candidate);
}

async function assertNoSymlinkComponents(root, relativePath) {
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      fail(`Candidate parent path must contain only real directories: ${relativePath}.`);
    }
    const resolved = await realpath(current);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      fail(`Candidate parent path escapes the configured project root: ${relativePath}.`);
    }
  }
}

async function preflightApplication({ candidate, artifact, projectRoot }) {
  validateCandidatePatch(candidate);
  validateCandidateArtifact(artifact);
  if (!hashesEqual(candidate.patchSha256, candidateArtifactSha256(artifact))) {
    fail("Candidate artifact identity changed after review.");
  }
  if (artifact.baseRevision !== candidate.baseRevision) {
    fail("Candidate artifact base revision does not match its contract.");
  }
  const artifactPaths = artifact.operations.map((operation) => operation.path);
  if (canonicalJson(artifactPaths) !== canonicalJson(candidate.affectedFiles)) {
    fail("Candidate affected-file inventory does not match its artifact.");
  }
  const root = await canonicalDirectory(projectRoot, "projectRoot");
  await assertRepositoryAt(root, candidate.baseRevision, "projectRoot");
  const status = await gitText(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status !== "") {
    fail("Candidate application requires a clean, conflict-free target working tree.");
  }
  const baseline = await baselineEntries(root, candidate.baseRevision);
  const plan = [];
  for (const operation of artifact.operations) {
    assertCandidatePath(operation.path, "Candidate application path");
    if (operation.operation === "add" && (await isIgnoredPath(root, operation.path))) {
      fail(`Candidate addition cannot target an ignored path: ${operation.path}.`);
    }
    await assertNoSymlinkComponents(root, operation.path);
    const target = path.join(root, ...operation.path.split("/"));
    const baseEntry = baseline.get(operation.path);
    const current = await pathDetails(root, operation.path);
    if (operation.operation === "add") {
      if (baseEntry !== undefined || current !== null) {
        fail(`Candidate addition would overwrite an existing path: ${operation.path}.`);
      }
      const parent = path.dirname(target);
      const parentDetails = await lstat(parent);
      if (!parentDetails.isDirectory() || parentDetails.isSymbolicLink()) {
        fail(`Candidate addition requires an existing real parent directory: ${operation.path}.`);
      }
      plan.push({ operation, target, original: null, mode: 0o644 });
      continue;
    }
    if (baseEntry === undefined) {
      fail(`Candidate ${operation.operation} has no baseline file: ${operation.path}.`);
    }
    assertSupportedBaseline(baseEntry, operation.path);
    if (current === null) {
      fail(`Candidate ${operation.operation} target is missing: ${operation.path}.`);
    }
    const original = await readFile(target);
    const originalText = canonicalText(original, `Target file ${operation.path}`);
    if (!hashesEqual(sha256(originalText), operation.baseContentSha256)) {
      fail(`Candidate target changed after review: ${operation.path}.`);
    }
    plan.push({ operation, target, original, mode: current.details.mode & 0o777 });
  }
  return { plan, root };
}

async function rollback(applied) {
  const errors = [];
  for (const entry of [...applied].reverse()) {
    try {
      if (entry.operation.operation === "add") {
        await unlink(entry.target);
      } else {
        await writeFile(entry.target, entry.original, { mode: entry.mode });
        await chmod(entry.target, entry.mode);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unknown rollback error");
    }
  }
  return errors;
}

async function writeCandidateFile(entry, onMutationStarted, afterFileOpen) {
  const flags =
    entry.operation.operation === "add"
      ? fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW
      : fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
  const handle = await open(entry.target, flags, entry.mode);
  try {
    onMutationStarted();
    if (afterFileOpen !== undefined) {
      await afterFileOpen(entry.operation.path);
    }
    await handle.writeFile(entry.operation.content, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function verifyAppliedPlan(plan) {
  for (const entry of plan) {
    if (entry.operation.operation === "delete") {
      if (await pathExists(entry.target)) {
        fail(`Candidate deletion did not remove its target: ${entry.operation.path}.`);
      }
      continue;
    }
    const details = await pathDetails(path.dirname(entry.target), path.basename(entry.target));
    const content = canonicalText(
      await readFile(details.target),
      `Applied file ${entry.operation.path}`
    );
    if (!hashesEqual(sha256(content), entry.operation.contentSha256)) {
      fail(`Candidate application content verification failed: ${entry.operation.path}.`);
    }
  }
}

export async function applyCandidateArtifact(options) {
  assertExactKeys(
    options,
    ["candidate", "artifact", "projectRoot"],
    ["clock", "beforeFinalValidation", "afterFileOpen"],
    "CandidateApplicationOptions"
  );
  const clock = options.clock ?? (() => new Date().toISOString());
  if (typeof clock !== "function") {
    fail("CandidateApplicationOptions.clock must be a function.");
  }
  if (
    options.beforeFinalValidation !== undefined &&
    typeof options.beforeFinalValidation !== "function"
  ) {
    fail("CandidateApplicationOptions.beforeFinalValidation must be a trusted function.");
  }
  if (options.afterFileOpen !== undefined && typeof options.afterFileOpen !== "function") {
    fail("CandidateApplicationOptions.afterFileOpen must be a trusted function.");
  }
  await preflightApplication(options);
  if (options.beforeFinalValidation !== undefined) {
    await options.beforeFinalValidation();
  }
  const { plan, root } = await preflightApplication(options);
  const applied = [];
  try {
    for (const entry of plan) {
      if (entry.operation.operation === "delete") {
        await unlink(entry.target);
        applied.push(entry);
      } else {
        await writeCandidateFile(
          entry,
          () => applied.push(entry),
          options.afterFileOpen
        );
      }
    }
    await verifyAppliedPlan(plan);
    const head = (await gitText(root, ["rev-parse", "HEAD"])).trim();
    if (head !== options.candidate.baseRevision) {
      fail("Candidate application unexpectedly changed the target Git revision.");
    }
    const changedFiles = [
      ...new Set([
        ...parseNullList(
          await gitText(root, [
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            options.candidate.baseRevision
          ])
        ),
        ...parseNullList(
          await gitText(root, ["ls-files", "--others", "--exclude-standard", "-z"])
        )
      ])
    ].sort((left, right) => left.localeCompare(right));
    if (canonicalJson(changedFiles) !== canonicalJson(options.candidate.affectedFiles)) {
      fail("Candidate application produced an unexpected changed-file inventory.");
    }
    const appliedAt = clock();
    assertIsoTimestamp(appliedAt, "ApplicationEvidence.appliedAt");
    const evidence = {
      schemaVersion: SCHEMA_VERSION,
      missionId: options.candidate.missionId,
      candidateId: options.candidate.candidateId,
      candidateSha256: options.candidate.patchSha256,
      projectId: options.candidate.projectId,
      baseRevision: options.candidate.baseRevision,
      workingTreeStatus: options.artifact.operations.map(({ operation, path: changedPath }) => ({
        operation,
        path: changedPath
      })),
      changedFiles,
      appliedAt,
      success: true
    };
    validateApplicationEvidence(evidence);
    return deepFreeze(evidence);
  } catch (error) {
    const rollbackErrors = await rollback(applied);
    const suffix = rollbackErrors.length === 0 ? "" : ` Rollback failed: ${rollbackErrors.join("; ")}`;
    throw new Error(
      `Candidate application failed: ${error instanceof Error ? error.message : "unknown error"}.${suffix}`,
      { cause: error }
    );
  }
}

export async function originalProjectSnapshot(root) {
  const projectRoot = await canonicalDirectory(root, "projectRoot");
  const revision = (await gitText(projectRoot, ["rev-parse", "HEAD"])).trim();
  const status = await gitText(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return deepFreeze({ projectRoot, revision, clean: status === "" });
}

export async function pathExists(value) {
  try {
    await access(value, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function reviewedCandidateIdentity(candidate) {
  validateCandidatePatch(candidate);
  return deepFreeze({
    candidateSha256: candidate.patchSha256,
    reviewerEvidenceSha256: reviewerEvidenceHash(candidate.reviewerVerdict)
  });
}
