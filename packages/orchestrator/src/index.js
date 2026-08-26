import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  assertCandidatePath,
  candidateArtifactSha256,
  createReviewedCandidatePatch,
  createReviewerVerdict,
  generateCandidateArtifact,
  originalProjectSnapshot,
  validateCandidateArtifact
} from "@forgeos-lite/candidate-patch";
import {
  SCHEMA_VERSION,
  assertAuthoritySubset,
  assertExactKeys,
  assertIsoTimestamp,
  assertNoForbiddenFields,
  assertNonEmptyString,
  assertSafeRelativePath,
  assertSha256,
  assertStringArray,
  canonicalJson,
  getAgentProfile,
  hashesEqual,
  sha256,
  validateHandoff,
  validateMission,
  validateProjectManifest,
  validateReviewerVerdict
} from "@forgeos-lite/contracts";
import { InMemoryMissionJournal } from "@forgeos-lite/core";
import {
  createTrueForgeSession,
  validateRuntimeEvidence
} from "@forgeos-lite/runtime-trueforge";

const execFileAsync = promisify(execFile);
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const policyIds = new Set(["npm-ci", "npm-run-build", "npm-test"]);
const planActions = new Set([
  "prepare_sandbox",
  "run_install",
  "run_build",
  "run_tests",
  "create_candidate",
  "review_candidate",
  "request_application"
]);
const actorActions = Object.freeze({
  coordinator: new Set(["prepare_sandbox"]),
  builder: new Set(["run_install", "run_build", "run_tests", "create_candidate"]),
  reviewer: new Set(["review_candidate"]),
  human: new Set(["request_application"])
});
const failureStates = new Set([
  "none",
  "runtime_failed",
  "timed_out",
  "unexpected_change",
  "validation_failed"
]);

function fail(message) {
  throw new TypeError(message);
}

class OrchestrationFailure extends Error {
  constructor(code, stage, message) {
    super(message);
    this.code = code;
    this.stage = stage;
  }
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

function assertInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
}

function assertCanonicalStrings(value, label, maximumItems = 100) {
  assertStringArray(value, label, { maximumItems });
  const sorted = [...value].sort((left, right) => left.localeCompare(right));
  if (canonicalJson(value) !== canonicalJson(sorted)) {
    fail(`${label} must use canonical ordering.`);
  }
}

function commandSpec(policyId) {
  return policyId === null
    ? { kind: "not_applicable" }
    : { kind: "policy", policyId, arguments: [] };
}

async function gitText(root, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
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

function validateProjectInput(value) {
  assertExactKeys(
    value,
    [
      "projectId",
      "projectRoot",
      "projectName",
      "projectType",
      "commandPolicies",
      "allowedEnvironmentKeys"
    ],
    [],
    "ProjectIntakeInput"
  );
  assertIdentifier(value.projectId, "ProjectIntakeInput.projectId");
  assertNonEmptyString(value.projectName, "ProjectIntakeInput.projectName", 200);
  if (value.projectType !== "node") {
    fail("ProjectIntakeInput.projectType must be node in Phase 4.");
  }
  assertExactKeys(
    value.commandPolicies,
    ["install", "build", "test"],
    [],
    "ProjectIntakeInput.commandPolicies"
  );
  const allowedPolicyByField = {
    install: new Set([null, "npm-ci"]),
    build: new Set([null, "npm-run-build"]),
    test: new Set(["npm-test"])
  };
  for (const field of ["install", "build", "test"]) {
    if (!allowedPolicyByField[field].has(value.commandPolicies[field])) {
      fail(`ProjectIntakeInput.commandPolicies.${field} is unsupported.`);
    }
  }
  if (value.commandPolicies.build !== "npm-run-build") {
    fail("Phase 4 requires npm-run-build for the controlled Builder transformation.");
  }
  assertCanonicalStrings(
    value.allowedEnvironmentKeys,
    "ProjectIntakeInput.allowedEnvironmentKeys",
    16
  );
  assertNoForbiddenFields(value, "ProjectIntakeInput");
}

function projectAuthority(manifest, authorizedPaths) {
  const capabilities = [
    "candidate:create",
    "candidate:request-application",
    "candidate:review",
    "project:inspect",
    "sandbox:prepare",
    "sandbox:write"
  ];
  if (manifest.installCommand.kind === "policy") capabilities.push("sandbox:install");
  if (manifest.testCommand.kind === "policy") capabilities.push("sandbox:test");
  if (manifest.buildCommand.kind === "policy") capabilities.push("sandbox:build");
  capabilities.sort((left, right) => left.localeCompare(right));
  return { capabilities, projectPaths: [...authorizedPaths] };
}

export async function intakeNodeProject(input) {
  validateProjectInput(input);
  const projectRoot = await canonicalDirectory(input.projectRoot, "ProjectIntakeInput.projectRoot");
  let gitDetails;
  try {
    gitDetails = await lstat(path.join(projectRoot, ".git"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("Project intake requires a Git repository with a .git directory.");
    }
    throw error;
  }
  if (!gitDetails.isDirectory() || gitDetails.isSymbolicLink()) {
    fail("Project intake requires a real .git directory.");
  }
  const topLevel = (await gitText(projectRoot, ["rev-parse", "--show-toplevel"])).trim();
  if (topLevel !== projectRoot) {
    fail("Project intake root must be the canonical Git repository root.");
  }
  const sourceRevision = (await gitText(projectRoot, ["rev-parse", "HEAD"])).trim();
  if (!revisionPattern.test(sourceRevision)) {
    fail("Project intake could not resolve a complete Git HEAD revision.");
  }
  const status = await gitText(projectRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all"
  ]);
  if (status !== "") {
    fail("Project intake requires a clean initial Git working tree.");
  }
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    projectId: input.projectId,
    name: input.projectName,
    runtime: "node",
    installCommand: commandSpec(input.commandPolicies.install),
    testCommand: commandSpec(input.commandPolicies.test),
    buildCommand: commandSpec(input.commandPolicies.build),
    allowedEnvironmentKeys: [...input.allowedEnvironmentKeys],
    sourceRevision
  };
  validateProjectManifest(manifest);
  return deepFreeze({ manifest, projectRoot });
}

function validateMissionInput(value) {
  assertExactKeys(
    value,
    [
      "missionId",
      "title",
      "brief",
      "successCriteria",
      "authority",
      "expectedScope",
      "maximumChangedFiles"
    ],
    [],
    "MissionIntakeInput"
  );
  assertIdentifier(value.missionId, "MissionIntakeInput.missionId");
  assertNonEmptyString(value.title, "MissionIntakeInput.title", 200);
  assertNonEmptyString(value.brief, "MissionIntakeInput.brief", 10_000);
  assertStringArray(value.successCriteria, "MissionIntakeInput.successCriteria", {
    maximumItems: 50
  });
  if (value.successCriteria.length === 0) {
    fail("MissionIntakeInput.successCriteria cannot be empty.");
  }
  assertCanonicalStrings(value.expectedScope, "MissionIntakeInput.expectedScope", 64);
  if (value.expectedScope.length === 0) {
    fail("MissionIntakeInput.expectedScope cannot be empty.");
  }
  value.expectedScope.forEach((entry, index) =>
    assertCandidatePath(entry, `MissionIntakeInput.expectedScope[${index}]`)
  );
  assertInteger(value.maximumChangedFiles, "MissionIntakeInput.maximumChangedFiles", 1, 100);
  if (value.maximumChangedFiles > value.expectedScope.length) {
    fail("MissionIntakeInput.maximumChangedFiles cannot exceed expectedScope length.");
  }
  assertNoForbiddenFields(value, "MissionIntakeInput");
}

function createMissionContract(input, projectId, authorityBoundary, timestamp) {
  validateMissionInput(input);
  assertAuthoritySubset(input.authority, authorityBoundary, "Mission authority");
  const expectedPaths = new Set(input.expectedScope);
  if (input.authority.projectPaths.some((entry) => !expectedPaths.has(entry))) {
    fail("Mission authority project paths must remain inside the declared expected scope.");
  }
  if (canonicalJson(input.authority.projectPaths) !== canonicalJson(input.expectedScope)) {
    fail("Phase 4 mission authority must identify the exact expected file scope.");
  }
  const mission = {
    schemaVersion: SCHEMA_VERSION,
    missionId: input.missionId,
    projectId,
    title: input.title,
    brief: input.brief,
    successCriteria: [...input.successCriteria],
    state: "draft",
    authority: structuredClone(input.authority),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  validateMission(mission);
  return deepFreeze(mission);
}

export function validateCoordinatorPlan(value, context) {
  assertExactKeys(
    context,
    ["manifest", "mission"],
    [],
    "CoordinatorPlanValidationContext"
  );
  validateProjectManifest(context.manifest);
  validateMission(context.mission);
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "missionId",
      "objective",
      "steps",
      "allowedCommandPolicyIds",
      "validationPolicyIds",
      "expectedScope",
      "maximumChangedFiles",
      "riskNotes",
      "createdAt"
    ],
    [],
    "CoordinatorPlan"
  );
  if (value.schemaVersion !== SCHEMA_VERSION || value.missionId !== context.mission.missionId) {
    fail("CoordinatorPlan identity does not match the mission.");
  }
  assertNonEmptyString(value.objective, "CoordinatorPlan.objective", 10_000);
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 32) {
    fail("CoordinatorPlan.steps must contain 1 through 32 ordered steps.");
  }
  value.steps.forEach((step, index) => {
    assertExactKeys(step, ["stepId", "actor", "action", "summary"], [], `CoordinatorPlan.steps[${index}]`);
    if (step.stepId !== `step-${String(index + 1).padStart(2, "0")}`) {
      fail("CoordinatorPlan.steps must use canonical ordered step identifiers.");
    }
    if (!Object.hasOwn(actorActions, step.actor) || !planActions.has(step.action)) {
      fail("CoordinatorPlan contains an unknown actor or action.");
    }
    if (!actorActions[step.actor].has(step.action)) {
      fail(`CoordinatorPlan actor ${step.actor} cannot perform ${step.action}.`);
    }
    assertNonEmptyString(step.summary, `CoordinatorPlan.steps[${index}].summary`, 1000);
  });
  assertCanonicalStrings(value.allowedCommandPolicyIds, "CoordinatorPlan.allowedCommandPolicyIds", 8);
  assertCanonicalStrings(value.validationPolicyIds, "CoordinatorPlan.validationPolicyIds", 8);
  const declaredPolicies = [
    context.manifest.installCommand,
    context.manifest.buildCommand,
    context.manifest.testCommand
  ]
    .filter((entry) => entry.kind === "policy")
    .map((entry) => entry.policyId)
    .sort((left, right) => left.localeCompare(right));
  for (const entry of value.allowedCommandPolicyIds) {
    if (!policyIds.has(entry) || !declaredPolicies.includes(entry)) {
      fail(`CoordinatorPlan selects an undeclared command policy: ${entry}.`);
    }
  }
  if (canonicalJson(value.allowedCommandPolicyIds) !== canonicalJson(declaredPolicies)) {
    fail("CoordinatorPlan must select exactly the declared command policies.");
  }
  const requiredValidation = [context.manifest.buildCommand, context.manifest.testCommand]
    .filter((entry) => entry.kind === "policy")
    .map((entry) => entry.policyId)
    .sort((left, right) => left.localeCompare(right));
  if (canonicalJson(value.validationPolicyIds) !== canonicalJson(requiredValidation)) {
    fail("CoordinatorPlan validation policies do not match the manifest.");
  }
  assertCanonicalStrings(value.expectedScope, "CoordinatorPlan.expectedScope", 64);
  value.expectedScope.forEach((entry, index) =>
    assertCandidatePath(entry, `CoordinatorPlan.expectedScope[${index}]`)
  );
  if (canonicalJson(value.expectedScope) !== canonicalJson(context.mission.authority.projectPaths)) {
    fail("CoordinatorPlan expected scope expands or changes mission authority.");
  }
  assertInteger(value.maximumChangedFiles, "CoordinatorPlan.maximumChangedFiles", 1, 100);
  assertStringArray(value.riskNotes, "CoordinatorPlan.riskNotes", { maximumItems: 16 });
  assertIsoTimestamp(value.createdAt, "CoordinatorPlan.createdAt");
  assertNoForbiddenFields(value, "CoordinatorPlan");
  return value;
}

export function createCoordinatorPlan(options) {
  assertExactKeys(
    options,
    ["manifest", "mission", "maximumChangedFiles", "createdAt"],
    [],
    "CreateCoordinatorPlanOptions"
  );
  validateProjectManifest(options.manifest);
  validateMission(options.mission);
  const policies = [
    options.manifest.installCommand,
    options.manifest.buildCommand,
    options.manifest.testCommand
  ]
    .filter((entry) => entry.kind === "policy")
    .map((entry) => entry.policyId)
    .sort((left, right) => left.localeCompare(right));
  const validationPolicies = [options.manifest.buildCommand, options.manifest.testCommand]
    .filter((entry) => entry.kind === "policy")
    .map((entry) => entry.policyId)
    .sort((left, right) => left.localeCompare(right));
  const steps = [
    ["coordinator", "prepare_sandbox", "Prepare one isolated Builder Git workspace."],
    ...(options.manifest.installCommand.kind === "policy"
      ? [["builder", "run_install", "Install dependencies through the declared fixed policy."]]
      : []),
    ["builder", "run_build", "Run the declared controlled Builder transformation."],
    ["builder", "run_build", "Validate the declared build policy after the change."],
    ["builder", "run_tests", "Run the required declared test policy."],
    ["builder", "create_candidate", "Create the deterministic candidate artifact."],
    ["reviewer", "review_candidate", "Evaluate the candidate and public execution evidence."],
    ["human", "request_application", "Continue only through explicit human MCP approval."]
  ].map(([actor, action, summary], index) => ({
    stepId: `step-${String(index + 1).padStart(2, "0")}`,
    actor,
    action,
    summary
  }));
  const plan = {
    schemaVersion: SCHEMA_VERSION,
    missionId: options.mission.missionId,
    objective: options.mission.brief,
    steps,
    allowedCommandPolicyIds: policies,
    validationPolicyIds: validationPolicies,
    expectedScope: [...options.mission.authority.projectPaths],
    maximumChangedFiles: options.maximumChangedFiles,
    riskNotes: [
      "The original project remains read-only during orchestration.",
      "Only declared Node.js command policies may execute.",
      "Candidate application remains behind explicit human approval."
    ],
    createdAt: options.createdAt
  };
  validateCoordinatorPlan(plan, { manifest: options.manifest, mission: options.mission });
  return deepFreeze(plan);
}

export function validateBuilderResult(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "missionId",
      "builderAgentId",
      "workspaceId",
      "baseRevision",
      "executedPolicyIds",
      "executionEvidenceIds",
      "changedFiles",
      "completionState",
      "failureState",
      "startedAt",
      "completedAt"
    ],
    [],
    "BuilderResult"
  );
  if (value.schemaVersion !== SCHEMA_VERSION) fail("BuilderResult.schemaVersion is invalid.");
  for (const field of ["missionId", "builderAgentId", "workspaceId"]) {
    assertIdentifier(value[field], `BuilderResult.${field}`);
  }
  if (!revisionPattern.test(value.baseRevision)) {
    fail("BuilderResult.baseRevision must be a complete Git revision.");
  }
  assertCanonicalStrings(value.executedPolicyIds, "BuilderResult.executedPolicyIds", 8);
  value.executedPolicyIds.forEach((entry) => {
    if (!policyIds.has(entry)) fail(`BuilderResult contains an unknown policy: ${entry}.`);
  });
  assertCanonicalStrings(value.executionEvidenceIds, "BuilderResult.executionEvidenceIds", 32);
  if (value.completionState === "completed" && value.executionEvidenceIds.length === 0) {
    fail("BuilderResult.executionEvidenceIds cannot be empty after completion.");
  }
  if (
    value.completionState === "completed" &&
    value.executionEvidenceIds.length !== value.executedPolicyIds.length
  ) {
    fail("BuilderResult must bind exactly one execution evidence identifier to each policy.");
  }
  assertCanonicalStrings(value.changedFiles, "BuilderResult.changedFiles", 1000);
  value.changedFiles.forEach((entry, index) =>
    assertCandidatePath(entry, `BuilderResult.changedFiles[${index}]`)
  );
  if (!new Set(["completed", "failed"]).has(value.completionState)) {
    fail("BuilderResult.completionState is invalid.");
  }
  if (!failureStates.has(value.failureState)) fail("BuilderResult.failureState is invalid.");
  if (
    (value.completionState === "completed" && value.failureState !== "none") ||
    (value.completionState === "failed" && value.failureState === "none")
  ) {
    fail("BuilderResult completion and failure states disagree.");
  }
  assertIsoTimestamp(value.startedAt, "BuilderResult.startedAt");
  assertIsoTimestamp(value.completedAt, "BuilderResult.completedAt");
  if (value.completedAt < value.startedAt) fail("BuilderResult timestamps are reversed.");
  assertNoForbiddenFields(value, "BuilderResult");
  return value;
}

function validationSucceeded(evidence) {
  return (
    evidence.exitStatus === 0 &&
    evidence.runtimeError === null &&
    evidence.timedOut === false
  );
}

export function reviewCandidateEvidence(input) {
  assertExactKeys(
    input,
    [
      "mission",
      "manifest",
      "artifact",
      "builderResult",
      "validationEvidence",
      "expectedScope",
      "maximumChangedFiles"
    ],
    [],
    "CandidateReviewInput"
  );
  assertNoForbiddenFields(input, "CandidateReviewInput");
  try {
    validateMission(input.mission);
    validateProjectManifest(input.manifest);
    validateCandidateArtifact(input.artifact);
    validateBuilderResult(input.builderResult);
    assertCanonicalStrings(input.expectedScope, "CandidateReviewInput.expectedScope", 64);
    assertInteger(input.maximumChangedFiles, "CandidateReviewInput.maximumChangedFiles", 1, 100);
    if (input.manifest.projectId !== input.mission.projectId) {
      throw new Error("The project manifest belongs to another mission project.");
    }
    if (
      canonicalJson(input.expectedScope) !==
      canonicalJson(input.mission.authority.projectPaths)
    ) {
      throw new Error("Reviewer expected scope does not match mission authority.");
    }
    if (input.builderResult.completionState !== "completed") {
      throw new Error("Builder evidence does not report completion.");
    }
    if (input.builderResult.missionId !== input.mission.missionId) {
      throw new Error("Builder evidence belongs to another mission.");
    }
    if (
      input.builderResult.baseRevision !== input.manifest.sourceRevision ||
      input.artifact.baseRevision !== input.manifest.sourceRevision
    ) {
      throw new Error("Candidate or Builder evidence base does not match the mission project base.");
    }
    const affectedFiles = input.artifact.operations.map((entry) => entry.path);
    if (affectedFiles.length > input.maximumChangedFiles) {
      throw new Error("Candidate exceeds the configured file-count limit.");
    }
    if (affectedFiles.some((entry) => !input.expectedScope.includes(entry))) {
      throw new Error("Candidate contains an unexpected or forbidden file change.");
    }
    if (canonicalJson(affectedFiles) !== canonicalJson(input.builderResult.changedFiles)) {
      throw new Error("Builder changed-file evidence is incomplete or does not match the candidate.");
    }
    const requiredBuilderPolicies = [
      input.manifest.installCommand,
      input.manifest.buildCommand
    ]
      .filter((entry) => entry.kind === "policy")
      .map((entry) => entry.policyId)
      .sort((left, right) => left.localeCompare(right));
    if (
      canonicalJson(input.builderResult.executedPolicyIds) !==
      canonicalJson(requiredBuilderPolicies)
    ) {
      throw new Error("Builder evidence does not prove every declared transformation policy.");
    }
    const requiredPolicies = [input.manifest.buildCommand, input.manifest.testCommand]
      .filter((entry) => entry.kind === "policy")
      .map((entry) => entry.policyId)
      .sort((left, right) => left.localeCompare(right));
    if (
      !Array.isArray(input.validationEvidence) ||
      input.validationEvidence.length !== requiredPolicies.length
    ) {
      throw new Error(
        "Required validation evidence is missing or does not exactly match the declared policy inventory."
      );
    }
    const validationPolicies = [];
    const validationExecutionIds = new Set();
    for (const evidence of input.validationEvidence) {
      validateRuntimeEvidence(evidence);
      if (evidence.missionId !== input.mission.missionId) {
        throw new Error("Validation evidence belongs to another mission.");
      }
      if (evidence.workingDirectory !== input.builderResult.workspaceId) {
        throw new Error("Validation evidence belongs to another Builder workspace.");
      }
      if (!requiredPolicies.includes(evidence.command.policyId)) {
        throw new Error(`Validation evidence uses an undeclared policy: ${evidence.command.policyId}.`);
      }
      if (validationExecutionIds.has(evidence.executionId)) {
        throw new Error("Validation evidence contains a duplicate execution identifier.");
      }
      if (input.builderResult.executionEvidenceIds.includes(evidence.executionId)) {
        throw new Error("Validation evidence cannot reuse Builder execution evidence.");
      }
      validationExecutionIds.add(evidence.executionId);
      validationPolicies.push(evidence.command.policyId);
      if (!validationSucceeded(evidence)) {
        throw new Error(`Required validation policy failed: ${evidence.command.policyId}.`);
      }
    }
    validationPolicies.sort((left, right) => left.localeCompare(right));
    if (canonicalJson(validationPolicies) !== canonicalJson(requiredPolicies)) {
      throw new Error("Validation evidence is missing or duplicates a declared policy.");
    }
    const reviewer = getAgentProfile("reviewer");
    if (
      reviewer.allowedActions.includes("write_sandbox") ||
      reviewer.allowedActions.includes("request_application") ||
      !reviewer.deniedActions.includes("edit_project") ||
      !reviewer.deniedActions.includes("apply_candidate")
    ) {
      throw new Error("Reviewer profile authority is unsafe.");
    }
    return deepFreeze({
      decision: "approved",
      code: "criteria_passed",
      summary: "Required evidence, scope, base identity, and validation criteria passed."
    });
  } catch (error) {
    return deepFreeze({
      decision: "rejected",
      code: "criteria_failed",
      summary: (error instanceof Error ? error.message : "Reviewer criteria failed.").slice(0, 4096)
    });
  }
}

async function listChangedFiles(root) {
  const changed = (await gitText(root, ["diff", "--name-only", "-z", "--no-renames", "HEAD"]))
    .split("\0")
    .filter(Boolean);
  const untracked = (await gitText(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  const result = [...new Set([...changed, ...untracked])].sort((left, right) =>
    left.localeCompare(right)
  );
  result.forEach((entry, index) => assertCandidatePath(entry, `Builder changed path[${index}]`));
  return result;
}

async function fingerprintTree(root, excludedTopLevel = new Set()) {
  const entries = [];
  let totalEntries = 0;
  let totalBytes = 0;
  async function visit(current, relative) {
    const names = await readdir(current);
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (relative === "" && excludedTopLevel.has(name)) continue;
      const target = path.join(current, name);
      const relativePath = relative === "" ? name : `${relative}/${name}`;
      const details = await lstat(target);
      totalEntries += 1;
      if (totalEntries > 20_000) {
        fail("Workspace fingerprint exceeds the Phase 4 safety bound.");
      }
      if (details.isDirectory() && !details.isSymbolicLink()) {
        await visit(target, relativePath);
      } else if (details.isSymbolicLink()) {
        entries.push({ path: relativePath, type: "symlink", target: await readlink(target) });
      } else if (details.isFile()) {
        totalBytes += details.size;
        if (totalBytes > 100_000_000) {
          fail("Workspace fingerprint exceeds the Phase 4 safety bound.");
        }
        entries.push({
          path: relativePath,
          type: "file",
          sha256: sha256((await readFile(target)).toString("base64"))
        });
      } else {
        fail(`Workspace contains an unsupported filesystem entry: ${relativePath}.`);
      }
    }
  }
  await visit(root, "");
  return sha256(entries);
}

async function assertSafeChangedFiles(root, changedFiles, expectedScope, maximumChangedFiles) {
  if (changedFiles.length === 0) {
    throw new OrchestrationFailure(
      "builder_no_change",
      "builder",
      "The controlled Builder transformation produced no candidate change."
    );
  }
  for (const relativePath of changedFiles) {
    if (!expectedScope.includes(relativePath)) {
      throw new OrchestrationFailure(
        "builder_unexpected_file",
        "builder",
        `Builder changed an unexpected file: ${relativePath}.`
      );
    }
    const target = path.join(root, ...relativePath.split("/"));
    let details;
    try {
      details = await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new OrchestrationFailure(
        "builder_unsafe_file",
        "builder",
        `Builder produced an unsupported file entry: ${relativePath}.`
      );
    }
    const resolved = await realpath(target);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new OrchestrationFailure(
        "builder_symlink_escape",
        "builder",
        `Builder file escapes its isolated workspace: ${relativePath}.`
      );
    }
  }
  if (changedFiles.length > maximumChangedFiles) {
    throw new OrchestrationFailure(
      "builder_file_limit",
      "builder",
      "Builder changed more files than the configured limit."
    );
  }
}

function publicRuntimeSummary(evidence) {
  return deepFreeze({
    executionId: evidence.executionId,
    policyId: evidence.command.policyId,
    exitStatus: evidence.exitStatus,
    timedOut: evidence.timedOut,
    runtimeError: evidence.runtimeError,
    success: validationSucceeded(evidence),
    startedAt: evidence.startedAt,
    completedAt: evidence.completedAt
  });
}

function createTestEvidence(validationEvidence, artifactSha256) {
  return validationEvidence.map((evidence) => ({
    kind: "runtime-validation",
    summary: `${evidence.command.policyId} ${validationSucceeded(evidence) ? "passed" : "failed"}.`,
    observedAt: evidence.completedAt,
    artifactSha256
  }));
}

function timeline(events) {
  return events.map((event) => ({
    sequence: event.sequence,
    eventType: event.eventType,
    actor: event.actor,
    timestamp: event.timestamp,
    ...(event.eventType === "mission.milestone"
      ? { milestone: event.payload.milestone, summary: event.payload.summary }
      : {}),
    ...(event.eventType === "mission.transitioned"
      ? { fromState: event.payload.fromState, toState: event.payload.toState }
      : {})
  }));
}

function safeError(error) {
  return (error instanceof Error ? error.message : "Unknown orchestration failure.").slice(0, 4096);
}

function validateOrchestratorOptions(options) {
  assertExactKeys(
    options,
    ["driver", "trustedWorkspaceRoot"],
    ["clock", "idFactory", "cleanupWorkspace", "executionTimeoutMs"],
    "MissionOrchestratorOptions"
  );
  if (options.driver === null || typeof options.driver !== "object") {
    fail("MissionOrchestratorOptions.driver must be a TrueForge driver.");
  }
  const clock = options.clock ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? ((label) => `${label}-${randomUUID()}`);
  const cleanupWorkspace = options.cleanupWorkspace ?? ((target) => rm(target, { recursive: true }));
  for (const [label, value] of Object.entries({ clock, idFactory, cleanupWorkspace })) {
    if (typeof value !== "function") fail(`MissionOrchestratorOptions.${label} must be a function.`);
  }
  const executionTimeoutMs = options.executionTimeoutMs ?? 120_000;
  assertInteger(executionTimeoutMs, "MissionOrchestratorOptions.executionTimeoutMs", 1, 300_000);
  return { clock, idFactory, cleanupWorkspace, executionTimeoutMs };
}

export async function createMissionOrchestrator(options) {
  const configured = validateOrchestratorOptions(options);
  const trustedWorkspaceRoot = await canonicalDirectory(
    options.trustedWorkspaceRoot,
    "MissionOrchestratorOptions.trustedWorkspaceRoot"
  );
  const runs = new Map();
  let active = false;

  function nextId(label) {
    const value = configured.idFactory(label);
    assertIdentifier(value, `Generated ${label} identifier`);
    return value;
  }

  function now() {
    const value = configured.clock();
    assertIsoTimestamp(value, "Orchestrator clock value");
    return value;
  }

  function appendCreated(record) {
    record.journal.append({
      eventId: nextId("event"),
      missionId: record.mission.missionId,
      eventType: "mission.created",
      actor: "system",
      timestamp: now(),
      payload: { state: "draft" }
    });
  }

  function appendMilestone(record, actor, milestone, summary, optionsValue = {}) {
    record.journal.append({
      eventId: nextId("event"),
      missionId: record.mission.missionId,
      eventType: "mission.milestone",
      actor,
      timestamp: now(),
      payload: {
        milestone,
        summary,
        ...(optionsValue.evidenceIds === undefined
          ? {}
          : { evidenceIds: [...optionsValue.evidenceIds] }),
        ...(optionsValue.artifactSha256 === undefined
          ? {}
          : { artifactSha256: optionsValue.artifactSha256 })
      }
    });
  }

  function transition(record, actor, toState, evidence = {}) {
    const fromState = record.journal.replay().state;
    record.journal.append({
      eventId: nextId("event"),
      missionId: record.mission.missionId,
      eventType: "mission.transitioned",
      actor,
      timestamp: now(),
      payload: { fromState, toState, ...evidence }
    });
  }

  function summarize(record, status, failure = null) {
    const currentState = record.journal?.events().length > 0
      ? record.journal.replay().state
      : "not_started";
    const summary = {
      schemaVersion: SCHEMA_VERSION,
      missionId: record.missionId,
      projectId: record.projectId,
      status,
      currentState,
      baseRevision: record.manifest?.sourceRevision ?? null,
      plan: record.plan ?? null,
      builderResult: record.builderResult ?? null,
      validationSummary: record.validationEvidence.map(publicRuntimeSummary),
      candidateId: record.candidate?.candidateId ?? null,
      candidateSha256: record.candidate?.patchSha256 ?? null,
      affectedFiles: record.candidate?.affectedFiles ?? [],
      reviewerVerdict: record.candidate?.reviewerVerdict ?? record.reviewerVerdict ?? null,
      approvalState: status === "awaiting_approval" ? "pending_human" : "not_available",
      nextAction:
        status === "awaiting_approval"
          ? "Human approval is required through the Phase 3 MCP gate."
          : "Resolve the reported failure and start a new mission run.",
      originalUnchanged: record.originalUnchanged,
      workspaceCleanup: record.workspaceCleanup,
      timeline: record.journal === null ? [] : timeline(record.journal.events()),
      failure
    };
    assertNoForbiddenFields(summary, "MissionSummary");
    return deepFreeze(summary);
  }

  async function cleanup(record) {
    const errors = [];
    if (record.builderRoot !== null) {
      try {
        await configured.cleanupWorkspace(record.builderRoot);
        record.builderRoot = null;
      } catch (error) {
        if (error?.code === "ENOENT") {
          record.builderRoot = null;
        } else {
          errors.push(`Builder workspace cleanup failed: ${safeError(error)}`);
        }
      }
    }
    if (record.session !== null) {
      try {
        await record.session.close();
        record.session = null;
      } catch (error) {
        errors.push(safeError(error));
      }
    }
    record.workspaceCleanup = errors.length === 0 ? "completed" : "failed";
    if (errors.length > 0) {
      throw new OrchestrationFailure("cleanup_failed", "cleanup", errors.join(" "));
    }
  }

  async function executePolicy(record, action, purpose) {
    const evidence = await record.session.execute({
      action,
      executionId: nextId("execution"),
      missionId: record.mission.missionId,
      workingDirectory: record.builderDirectoryName,
      environment: Object.fromEntries(
        [
          ["CI", "true"],
          ["TZ", "UTC"]
        ].filter(([key]) => record.manifest.allowedEnvironmentKeys.includes(key))
      ),
      timeoutMs: configured.executionTimeoutMs
    });
    validateRuntimeEvidence(evidence);
    if (purpose === "validation") record.validationEvidence.push(evidence);
    else record.builderEvidence.push(evidence);
    return evidence;
  }

  async function blockRecord(record, error) {
    const state = record.journal.replay().state;
    if (["draft", "planned", "approved", "building", "reviewing", "awaiting_approval"].includes(state)) {
      transition(record, "system", "blocked", {
        blocked: {
          code: error instanceof OrchestrationFailure ? error.code : "orchestration_failed",
          summary: safeError(error),
          nextActor: "human"
        }
      });
    }
  }

  async function runMission(input) {
    if (active) fail("MissionOrchestrator supports one active project mission at a time.");
    active = true;
    let record = {
      missionId: input?.mission?.missionId ?? "unknown-mission",
      projectId: input?.project?.projectId ?? "unknown-project",
      mission: null,
      manifest: null,
      projectRoot: null,
      journal: null,
      plan: null,
      session: null,
      builderRoot: null,
      builderDirectoryName: null,
      builderResult: null,
      builderEvidence: [],
      validationEvidence: [],
      artifact: null,
      candidate: null,
      reviewerVerdict: null,
      originalUnchanged: false,
      workspaceCleanup: "not_started"
    };
    let stage = "input";
    try {
      assertExactKeys(input, ["project", "mission"], [], "MissionRunInput");
      validateMissionInput(input.mission);
      stage = "project_intake";
      const admitted = await intakeNodeProject(input.project);
      record.projectRoot = admitted.projectRoot;
      record.manifest = admitted.manifest;
      record.projectId = admitted.manifest.projectId;
      const authorityBoundary = projectAuthority(admitted.manifest, input.mission.expectedScope);
      const missionTimestamp = now();
      record.mission = createMissionContract(
        input.mission,
        admitted.manifest.projectId,
        authorityBoundary,
        missionTimestamp
      );
      record.missionId = record.mission.missionId;
      record.journal = new InMemoryMissionJournal();
      appendCreated(record);
      const beforeOriginal = await originalProjectSnapshot(record.projectRoot);

      stage = "planning";
      record.plan = createCoordinatorPlan({
        manifest: record.manifest,
        mission: record.mission,
        maximumChangedFiles: input.mission.maximumChangedFiles,
        createdAt: now()
      });
      appendMilestone(record, "coordinator", "plan.ready", "Coordinator plan is ready.", {
        artifactSha256: sha256(record.plan)
      });
      transition(record, "coordinator", "planned");
      transition(record, "system", "approved");

      stage = "workspace";
      record.session = await createTrueForgeSession({
        driver: options.driver,
        manifest: record.manifest,
        missionId: record.mission.missionId,
        workspaceRoot: trustedWorkspaceRoot,
        clock: now
      });
      record.builderDirectoryName = nextId("builder-workspace");
      assertSafeRelativePath(record.builderDirectoryName, "Builder workspace directory");
      record.builderRoot = path.join(record.session.workspaceRoot, record.builderDirectoryName);
      try {
        await lstat(record.builderRoot);
        throw new OrchestrationFailure(
          "stale_builder_workspace",
          "workspace",
          "Builder workspace already exists and cannot be reused."
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await execFileAsync(
        "git",
        ["clone", "--quiet", "--no-hardlinks", record.projectRoot, record.builderRoot],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
      );
      record.builderRoot = await canonicalDirectory(record.builderRoot, "Builder workspace");
      const builderHead = (await gitText(record.builderRoot, ["rev-parse", "HEAD"])).trim();
      if (builderHead !== record.manifest.sourceRevision) {
        throw new OrchestrationFailure(
          "builder_base_mismatch",
          "workspace",
          "Builder workspace does not match the admitted project base revision."
        );
      }
      const workspaceId = record.builderDirectoryName;
      appendMilestone(
        record,
        "coordinator",
        "builder.workspace_ready",
        "An isolated Builder workspace is ready."
      );

      const builderActions = [
        ...(record.manifest.installCommand.kind === "policy" ? ["run_install"] : []),
        "run_build",
        "run_tests",
        "create_candidate"
      ];
      validateHandoff(
        {
          schemaVersion: SCHEMA_VERSION,
          handoffId: nextId("handoff"),
          missionId: record.mission.missionId,
          fromProfile: "coordinator",
          toProfile: "builder",
          summary: "Execute the bounded plan only inside the isolated Builder workspace.",
          requestedActions: builderActions,
          artifacts: [],
          evidence: [],
          authoritySnapshot: structuredClone(record.mission.authority),
          createdAt: now()
        },
        record.mission.authority
      );
      transition(record, "builder", "building");
      const builderStartedAt = now();
      appendMilestone(record, "builder", "builder.started", "Builder execution started.");

      await gitText(record.builderRoot, ["status", "--porcelain=v1", "-z"]);
      const gitFingerprint = await fingerprintTree(path.join(record.builderRoot, ".git"));
      const outsideFingerprint = await fingerprintTree(
        record.session.workspaceRoot,
        new Set([record.builderDirectoryName])
      );
      stage = "builder";
      if (record.manifest.installCommand.kind === "policy") {
        const installEvidence = await executePolicy(record, "run_install", "builder");
        if (!validationSucceeded(installEvidence)) {
          throw new OrchestrationFailure(
            installEvidence.timedOut ? "builder_timeout" : "builder_runtime_failed",
            "builder",
            "Builder dependency installation failed."
          );
        }
      }
      const buildEvidence = await executePolicy(record, "run_build", "builder");
      if (!validationSucceeded(buildEvidence)) {
        throw new OrchestrationFailure(
          buildEvidence.timedOut ? "builder_timeout" : "builder_runtime_failed",
          "builder",
          "Controlled Builder execution failed."
        );
      }
      const changedFiles = await listChangedFiles(record.builderRoot);
      await assertSafeChangedFiles(
        record.builderRoot,
        changedFiles,
        record.plan.expectedScope,
        record.plan.maximumChangedFiles
      );
      if (!hashesEqual(gitFingerprint, await fingerprintTree(path.join(record.builderRoot, ".git")))) {
        throw new OrchestrationFailure(
          "builder_git_mutation",
          "builder",
          "Builder modified isolated Git metadata."
        );
      }
      if (
        !hashesEqual(
          outsideFingerprint,
          await fingerprintTree(record.session.workspaceRoot, new Set([record.builderDirectoryName]))
        )
      ) {
        throw new OrchestrationFailure(
          "builder_traversal",
          "builder",
          "Builder modified data outside its isolated project workspace."
        );
      }
      record.builderResult = {
        schemaVersion: SCHEMA_VERSION,
        missionId: record.mission.missionId,
        builderAgentId: "builder-phase-four",
        workspaceId,
        baseRevision: record.manifest.sourceRevision,
        executedPolicyIds: [...new Set(record.builderEvidence.map((entry) => entry.command.policyId))]
          .sort((left, right) => left.localeCompare(right)),
        executionEvidenceIds: record.builderEvidence
          .map((entry) => entry.executionId)
          .sort((left, right) => left.localeCompare(right)),
        changedFiles,
        completionState: "completed",
        failureState: "none",
        startedAt: builderStartedAt,
        completedAt: now()
      };
      validateBuilderResult(record.builderResult);
      appendMilestone(record, "builder", "builder.completed", "Builder execution completed.", {
        evidenceIds: record.builderResult.executionEvidenceIds
      });

      const builderArtifact = await generateCandidateArtifact({
        originalRoot: record.projectRoot,
        builderRoot: record.builderRoot,
        baseRevision: record.manifest.sourceRevision
      });
      const builderArtifactSha256 = candidateArtifactSha256(builderArtifact);

      stage = "validation";
      appendMilestone(record, "builder", "validation.started", "Declared validation started.");
      const validationActions = ["run_build", "run_tests"];
      for (const action of validationActions) {
        const evidence = await executePolicy(record, action, "validation");
        if (!validationSucceeded(evidence)) {
          appendMilestone(
            record,
            "builder",
            "validation.failed",
            `Declared validation failed for ${evidence.command.policyId}.`,
            { evidenceIds: [evidence.executionId] }
          );
          throw new OrchestrationFailure(
            evidence.timedOut ? "validation_timeout" : "validation_failed",
            "validation",
            `Declared validation failed: ${evidence.command.policyId}.`
          );
        }
      }
      const validatedChangedFiles = await listChangedFiles(record.builderRoot);
      if (canonicalJson(validatedChangedFiles) !== canonicalJson(changedFiles)) {
        throw new OrchestrationFailure(
          "validation_changed_scope",
          "validation",
          "Validation changed the Builder file inventory."
        );
      }
      if (!hashesEqual(gitFingerprint, await fingerprintTree(path.join(record.builderRoot, ".git")))) {
        throw new OrchestrationFailure(
          "validation_git_mutation",
          "validation",
          "Validation modified isolated Git metadata."
        );
      }
      if (
        !hashesEqual(
          outsideFingerprint,
          await fingerprintTree(record.session.workspaceRoot, new Set([record.builderDirectoryName]))
        )
      ) {
        throw new OrchestrationFailure(
          "validation_traversal",
          "validation",
          "Validation modified data outside the isolated project workspace."
        );
      }
      const validatedArtifact = await generateCandidateArtifact({
        originalRoot: record.projectRoot,
        builderRoot: record.builderRoot,
        baseRevision: record.manifest.sourceRevision
      });
      if (!hashesEqual(builderArtifactSha256, candidateArtifactSha256(validatedArtifact))) {
        throw new OrchestrationFailure(
          "validation_changed_candidate",
          "validation",
          "Validation changed candidate content after Builder completion."
        );
      }
      record.artifact = validatedArtifact;
      appendMilestone(
        record,
        "builder",
        "validation.completed",
        "All declared validation policies passed.",
        { evidenceIds: record.validationEvidence.map((entry) => entry.executionId) }
      );

      stage = "candidate";
      const artifactSha256 = candidateArtifactSha256(record.artifact);
      transition(record, "reviewer", "reviewing");
      appendMilestone(record, "reviewer", "reviewer.started", "Reviewer evaluation started.");
      const review = reviewCandidateEvidence({
        mission: record.mission,
        manifest: record.manifest,
        artifact: record.artifact,
        builderResult: record.builderResult,
        validationEvidence: record.validationEvidence,
        expectedScope: record.plan.expectedScope,
        maximumChangedFiles: record.plan.maximumChangedFiles
      });
      const testEvidence = createTestEvidence(record.validationEvidence, artifactSha256);
      record.reviewerVerdict = createReviewerVerdict({
        reviewId: nextId("review"),
        decision: review.decision,
        candidateSha256: artifactSha256,
        testEvidence,
        createdAt: now()
      });
      validateReviewerVerdict(record.reviewerVerdict);
      record.candidate = createReviewedCandidatePatch({
        artifact: record.artifact,
        candidateId: nextId("candidate"),
        missionId: record.mission.missionId,
        projectId: record.manifest.projectId,
        patchPath: `artifacts/${nextId("candidate-artifact")}.json`,
        testEvidence,
        reviewerVerdict: record.reviewerVerdict,
        createdAt: now()
      });
      validateHandoff(
        {
          schemaVersion: SCHEMA_VERSION,
          handoffId: nextId("handoff"),
          missionId: record.mission.missionId,
          fromProfile: "coordinator",
          toProfile: "reviewer",
          summary: "Review the exact candidate and declared validation evidence without editing.",
          requestedActions: ["review_candidate"],
          artifacts: [{ path: record.candidate.patchPath, sha256: artifactSha256 }],
          evidence: testEvidence,
          authoritySnapshot: structuredClone(record.mission.authority),
          createdAt: now()
        },
        record.mission.authority
      );
      if (review.decision !== "approved") {
        appendMilestone(record, "reviewer", "reviewer.rejected", review.summary, {
          artifactSha256
        });
        throw new OrchestrationFailure("reviewer_rejected", "reviewer", review.summary);
      }
      appendMilestone(record, "reviewer", "reviewer.approved", review.summary, {
        artifactSha256
      });
      appendMilestone(record, "coordinator", "candidate.ready", "Reviewed candidate is ready.", {
        artifactSha256
      });

      stage = "cleanup";
      await cleanup(record);
      const afterOriginal = await originalProjectSnapshot(record.projectRoot);
      record.originalUnchanged = canonicalJson(afterOriginal) === canonicalJson(beforeOriginal);
      if (!record.originalUnchanged) {
        throw new OrchestrationFailure(
          "original_project_changed",
          "safety_check",
          "The original project changed during orchestration."
        );
      }
      transition(record, "coordinator", "awaiting_approval", { candidate: record.candidate });
      const summary = summarize(record, "awaiting_approval");
      record.summary = summary;
      runs.set(record.missionId, record);
      return summary;
    } catch (error) {
      let finalError = error;
      if (record.journal !== null) {
        const failureMilestone = stage === "validation" ? "validation.failed" : "builder.failed";
        const actor = stage === "validation" ? "builder" : "system";
        try {
          const milestoneAlreadyRecorded = record.journal.events().some(
            (event) =>
              event.eventType === "mission.milestone" &&
              event.payload.milestone === failureMilestone
          );
          if (
            !["cleanup", "reviewer", "candidate"].includes(stage) &&
            !milestoneAlreadyRecorded
          ) {
            appendMilestone(record, actor, failureMilestone, safeError(error));
          }
        } catch {
          // The authoritative failure transition below still validates the journal.
        }
      }
      if (record.builderRoot !== null || record.session !== null) {
        try {
          await cleanup(record);
        } catch (cleanupError) {
          finalError = cleanupError;
        }
      }
      if (record.projectRoot !== null && record.manifest !== null) {
        try {
          const snapshot = await originalProjectSnapshot(record.projectRoot);
          record.originalUnchanged =
            snapshot.revision === record.manifest.sourceRevision && snapshot.clean === true;
        } catch {
          record.originalUnchanged = false;
        }
      }
      if (record.journal !== null) {
        try {
          await blockRecord(record, finalError);
        } catch (journalError) {
          finalError = new OrchestrationFailure(
            "journal_failed",
            "journal",
            `Mission journal failure: ${safeError(journalError)}`
          );
        }
      }
      const failure = {
        code: finalError.code ?? "orchestration_failed",
        stage: finalError.stage ?? stage,
        summary: safeError(finalError)
      };
      const summary = summarize(record, "failed", failure);
      record.summary = summary;
      if (identifierPattern.test(record.missionId)) runs.set(record.missionId, record);
      return summary;
    } finally {
      active = false;
    }
  }

  function getMissionSummary(missionId) {
    assertIdentifier(missionId, "missionId");
    const record = runs.get(missionId);
    if (record === undefined) fail(`Unknown mission: ${missionId}.`);
    if (record.journal !== null) record.journal.replay();
    return structuredClone(record.summary);
  }

  function resumeMission(input) {
    assertExactKeys(input, ["missionId"], [], "ResumeMissionInput");
    const summary = getMissionSummary(input.missionId);
    if (summary.currentState === "awaiting_approval") {
      return summary;
    }
    fail(`Mission ${input.missionId} cannot resume from ${summary.currentState}.`);
  }

  function getPendingApplicationContext(missionId) {
    assertIdentifier(missionId, "missionId");
    const record = runs.get(missionId);
    if (record === undefined || record.summary.currentState !== "awaiting_approval") {
      fail("A pending application context exists only at awaiting_approval.");
    }
    record.journal.replay();
    return deepFreeze({
      candidate: structuredClone(record.candidate),
      artifact: structuredClone(record.artifact),
      projectRoot: record.projectRoot
    });
  }

  return Object.freeze({
    runMission,
    resumeMission,
    getMissionSummary,
    getPendingApplicationContext
  });
}
