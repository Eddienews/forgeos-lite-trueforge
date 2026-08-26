import {
  assertAuthorityShape,
  assertAuthoritySubset,
  assertCommandSpec,
  assertEnvironmentKeys,
  assertExactKeys,
  assertIsoTimestamp,
  assertNoForbiddenFields,
  assertNonEmptyString,
  assertSafeRelativePath,
  assertSha256,
  assertStringArray,
  canonicalJson,
  hashesEqual,
  sha256
} from "./security.js";

export {
  assertAuthoritySubset,
  assertCommandToken,
  assertExactKeys,
  assertIsoTimestamp,
  assertNonEmptyString,
  assertNoForbiddenFields,
  assertPlainObject,
  assertSafeRelativePath,
  assertSha256,
  assertStringArray,
  canonicalJson,
  hashesEqual,
  sha256
} from "./security.js";

export const SCHEMA_VERSION = "1";

export const MISSION_STATES = Object.freeze([
  "draft",
  "planned",
  "approved",
  "building",
  "reviewing",
  "awaiting_approval",
  "applying",
  "completed",
  "blocked",
  "cancelled"
]);

export const AUTHORITY_CAPABILITIES = Object.freeze([
  "project:inspect",
  "sandbox:prepare",
  "sandbox:write",
  "sandbox:install",
  "sandbox:test",
  "sandbox:build",
  "candidate:create",
  "candidate:review",
  "candidate:request-application"
]);

const schemaVersionFields = ["schemaVersion"];
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const sourceRevisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const capabilitySet = new Set(AUTHORITY_CAPABILITIES);
const stateSet = new Set(MISSION_STATES);
const profileNames = new Set(["coordinator", "builder", "reviewer"]);

const commandPolicies = Object.freeze({
  node: Object.freeze({
    installCommand: new Set(["npm-ci"]),
    testCommand: new Set(["npm-test"]),
    buildCommand: new Set(["npm-run-build"])
  }),
  python: Object.freeze({
    installCommand: new Set(["python-install-locked"]),
    testCommand: new Set(["python-test"]),
    buildCommand: new Set(["python-build"])
  }),
  static: Object.freeze({
    installCommand: new Set(),
    testCommand: new Set(["static-test"]),
    buildCommand: new Set(["static-build"])
  })
});

const environmentPolicies = Object.freeze({
  node: new Set(["CI", "NODE_ENV", "SOURCE_DATE_EPOCH", "TZ"]),
  python: new Set(["CI", "PYTHONHASHSEED", "SOURCE_DATE_EPOCH", "TZ"]),
  static: new Set(["CI", "SOURCE_DATE_EPOCH", "TZ"])
});

const actionCapability = new Map([
  ["inspect_project", "project:inspect"],
  ["prepare_sandbox", "sandbox:prepare"],
  ["write_sandbox", "sandbox:write"],
  ["run_install", "sandbox:install"],
  ["run_tests", "sandbox:test"],
  ["run_build", "sandbox:build"],
  ["create_candidate", "candidate:create"],
  ["review_candidate", "candidate:review"],
  ["request_application", "candidate:request-application"]
]);

const profileDefinitions = Object.freeze({
  coordinator: Object.freeze({
    profile: "coordinator",
    allowedActions: Object.freeze(["inspect_project", "prepare_sandbox"]),
    allowedTools: Object.freeze(["inspect_project", "get_project_manifest", "prepare_sandbox_copy"]),
    deniedActions: Object.freeze(["edit_project", "approve_delivery", "apply_candidate", "publish"]),
    timeoutSeconds: 300,
    tokenBudget: 16000,
    handoffDestinations: Object.freeze(["builder", "reviewer"])
  }),
  builder: Object.freeze({
    profile: "builder",
    allowedActions: Object.freeze([
      "inspect_project",
      "write_sandbox",
      "run_install",
      "run_tests",
      "run_build",
      "create_candidate"
    ]),
    allowedTools: Object.freeze([
      "read_project_file",
      "list_project_files",
      "run_declared_install",
      "run_declared_tests",
      "run_declared_build",
      "create_candidate_patch"
    ]),
    deniedActions: Object.freeze([
      "approve_delivery",
      "apply_candidate",
      "publish",
      "modify_authority"
    ]),
    timeoutSeconds: 900,
    tokenBudget: 32000,
    handoffDestinations: Object.freeze(["coordinator", "reviewer"])
  }),
  reviewer: Object.freeze({
    profile: "reviewer",
    allowedActions: Object.freeze(["inspect_project", "review_candidate"]),
    allowedTools: Object.freeze([
      "get_candidate_diff",
      "get_test_evidence",
      "read_project_file"
    ]),
    deniedActions: Object.freeze([
      "edit_project",
      "apply_candidate",
      "expand_authority",
      "publish"
    ]),
    timeoutSeconds: 600,
    tokenBudget: 24000,
    handoffDestinations: Object.freeze(["coordinator", "builder"])
  })
});

function fail(message) {
  throw new TypeError(message);
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail(`${label} must be a stable identifier.`);
  }
}

function assertSchemaVersion(value, label) {
  if (value.schemaVersion !== SCHEMA_VERSION) {
    fail(`${label}.schemaVersion must equal ${SCHEMA_VERSION}.`);
  }
}

function assertKnownAuthority(value, label) {
  assertAuthorityShape(value, label);
  for (const capability of value.capabilities) {
    if (!capabilitySet.has(capability)) {
      fail(`${label} contains unknown capability: ${capability}.`);
    }
  }
}

function assertEvidence(value, label) {
  assertExactKeys(value, ["kind", "summary", "observedAt"], ["artifactSha256"], label);
  assertIdentifier(value.kind, `${label}.kind`);
  assertNonEmptyString(value.summary, `${label}.summary`);
  assertIsoTimestamp(value.observedAt, `${label}.observedAt`);
  if (Object.hasOwn(value, "artifactSha256")) {
    assertSha256(value.artifactSha256, `${label}.artifactSha256`);
  }
  assertNoForbiddenFields(value, label);
}

function assertEvidenceArray(value, label) {
  if (!Array.isArray(value) || value.length > 100) {
    fail(`${label} must be an array with at most 100 entries.`);
  }
  value.forEach((entry, index) => assertEvidence(entry, `${label}[${index}]`));
}

function assertArtifact(value, label) {
  assertExactKeys(value, ["path", "sha256"], [], label);
  assertSafeRelativePath(value.path, `${label}.path`);
  assertSha256(value.sha256, `${label}.sha256`);
}

function assertCanonicalPathInventory(value, label) {
  assertStringArray(value, label, { maximumItems: 1000 });
  value.forEach((entry, index) => assertSafeRelativePath(entry, `${label}[${index}]`));
  const sorted = [...value].sort((left, right) => left.localeCompare(right));
  if (canonicalJson(value) !== canonicalJson(sorted)) {
    fail(`${label} must use canonical path ordering.`);
  }
}

/** Validate and return a project manifest with fail-closed command policies. */
export function validateProjectManifest(value) {
  assertExactKeys(
    value,
    [
      ...schemaVersionFields,
      "projectId",
      "name",
      "runtime",
      "installCommand",
      "testCommand",
      "buildCommand",
      "allowedEnvironmentKeys",
      "sourceRevision"
    ],
    [],
    "ProjectManifest"
  );
  assertSchemaVersion(value, "ProjectManifest");
  assertIdentifier(value.projectId, "ProjectManifest.projectId");
  assertNonEmptyString(value.name, "ProjectManifest.name", 200);
  if (!Object.hasOwn(commandPolicies, value.runtime)) {
    fail("ProjectManifest.runtime is unsupported.");
  }
  for (const field of ["installCommand", "testCommand", "buildCommand"]) {
    assertCommandSpec(value[field], `ProjectManifest.${field}`);
    if (value[field].kind === "policy" && !commandPolicies[value.runtime][field].has(value[field].policyId)) {
      fail(`ProjectManifest.${field}.policyId is not allowed for runtime ${value.runtime}.`);
    }
  }
  assertEnvironmentKeys(value.allowedEnvironmentKeys, "ProjectManifest.allowedEnvironmentKeys");
  for (const key of value.allowedEnvironmentKeys) {
    if (!environmentPolicies[value.runtime].has(key)) {
      fail(`ProjectManifest environment key is not allowed for runtime ${value.runtime}: ${key}.`);
    }
  }
  if (typeof value.sourceRevision !== "string" || !sourceRevisionPattern.test(value.sourceRevision)) {
    fail("ProjectManifest.sourceRevision must be a complete Git revision hash.");
  }
  return value;
}

/** Validate and return a mission contract and its explicit authority. */
export function validateMission(value) {
  assertExactKeys(
    value,
    [
      ...schemaVersionFields,
      "missionId",
      "projectId",
      "title",
      "brief",
      "successCriteria",
      "state",
      "authority",
      "createdAt",
      "updatedAt"
    ],
    [],
    "Mission"
  );
  assertSchemaVersion(value, "Mission");
  assertIdentifier(value.missionId, "Mission.missionId");
  assertIdentifier(value.projectId, "Mission.projectId");
  assertNonEmptyString(value.title, "Mission.title", 200);
  assertNonEmptyString(value.brief, "Mission.brief", 10000);
  assertStringArray(value.successCriteria, "Mission.successCriteria", { maximumItems: 50 });
  if (!stateSet.has(value.state)) {
    fail("Mission.state is unknown.");
  }
  assertKnownAuthority(value.authority, "Mission.authority");
  assertIsoTimestamp(value.createdAt, "Mission.createdAt");
  assertIsoTimestamp(value.updatedAt, "Mission.updatedAt");
  if (value.updatedAt < value.createdAt) {
    fail("Mission.updatedAt cannot precede createdAt.");
  }
  assertNoForbiddenFields(value, "Mission");
  return value;
}

/** Return an immutable fixed agent profile. */
export function getAgentProfile(profile) {
  if (!profileNames.has(profile)) {
    fail(`Unknown agent profile: ${profile}.`);
  }
  return profileDefinitions[profile];
}

/** Validate that a supplied profile exactly matches its fixed definition. */
export function validateAgentProfile(value) {
  assertExactKeys(
    value,
    [
      "profile",
      "allowedActions",
      "allowedTools",
      "deniedActions",
      "timeoutSeconds",
      "tokenBudget",
      "handoffDestinations"
    ],
    [],
    "AgentProfile"
  );
  const expected = getAgentProfile(value.profile);
  if (canonicalJson(value) !== canonicalJson(expected)) {
    fail(`AgentProfile ${value.profile} cannot expand or alter its fixed privileges.`);
  }
  return value;
}

/** Validate a handoff against the mission authority snapshot. */
export function validateHandoff(value, missionAuthority) {
  assertExactKeys(
    value,
    [
      ...schemaVersionFields,
      "handoffId",
      "missionId",
      "fromProfile",
      "toProfile",
      "summary",
      "requestedActions",
      "artifacts",
      "evidence",
      "authoritySnapshot",
      "createdAt"
    ],
    [],
    "Handoff"
  );
  assertSchemaVersion(value, "Handoff");
  assertIdentifier(value.handoffId, "Handoff.handoffId");
  assertIdentifier(value.missionId, "Handoff.missionId");
  getAgentProfile(value.fromProfile);
  const destination = getAgentProfile(value.toProfile);
  if (value.fromProfile === value.toProfile) {
    fail("Handoff source and destination profiles must differ.");
  }
  if (!getAgentProfile(value.fromProfile).handoffDestinations.includes(value.toProfile)) {
    fail("Handoff destination is not allowed for the source profile.");
  }
  assertNonEmptyString(value.summary, "Handoff.summary", 10000);
  assertStringArray(value.requestedActions, "Handoff.requestedActions", { maximumItems: 32 });
  assertKnownAuthority(value.authoritySnapshot, "Handoff.authoritySnapshot");
  assertAuthoritySubset(value.authoritySnapshot, missionAuthority, "Handoff.authoritySnapshot");
  for (const action of value.requestedActions) {
    const capability = actionCapability.get(action);
    if (!capability || !destination.allowedActions.includes(action)) {
      fail(`Handoff requests an action unavailable to the destination: ${action}.`);
    }
    if (!value.authoritySnapshot.capabilities.includes(capability)) {
      fail(`Handoff requests an action outside its authority snapshot: ${action}.`);
    }
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length > 100) {
    fail("Handoff.artifacts must be an array with at most 100 entries.");
  }
  value.artifacts.forEach((entry, index) => assertArtifact(entry, `Handoff.artifacts[${index}]`));
  assertEvidenceArray(value.evidence, "Handoff.evidence");
  assertIsoTimestamp(value.createdAt, "Handoff.createdAt");
  assertNoForbiddenFields(value, "Handoff");
  return value;
}

/** Validate a reviewed, content-addressed candidate patch contract. */
export function validateCandidatePatch(value) {
  assertExactKeys(
    value,
    [
      ...schemaVersionFields,
      "candidateId",
      "missionId",
      "projectId",
      "baseRevision",
      "patchPath",
      "patchSha256",
      "affectedFiles",
      "testEvidence",
      "reviewerVerdict",
      "createdAt"
    ],
    [],
    "CandidatePatch"
  );
  assertSchemaVersion(value, "CandidatePatch");
  assertIdentifier(value.candidateId, "CandidatePatch.candidateId");
  assertIdentifier(value.missionId, "CandidatePatch.missionId");
  assertIdentifier(value.projectId, "CandidatePatch.projectId");
  if (typeof value.baseRevision !== "string" || !sourceRevisionPattern.test(value.baseRevision)) {
    fail("CandidatePatch.baseRevision must be a complete Git revision hash.");
  }
  assertSafeRelativePath(value.patchPath, "CandidatePatch.patchPath");
  assertSha256(value.patchSha256, "CandidatePatch.patchSha256");
  assertCanonicalPathInventory(value.affectedFiles, "CandidatePatch.affectedFiles");
  assertEvidenceArray(value.testEvidence, "CandidatePatch.testEvidence");
  validateReviewerVerdict(value.reviewerVerdict);
  if (!hashesEqual(value.patchSha256, value.reviewerVerdict.candidateSha256)) {
    fail("CandidatePatch reviewer verdict is not bound to the patch hash.");
  }
  if (!hashesEqual(sha256(value.testEvidence), value.reviewerVerdict.evidenceSha256)) {
    fail("CandidatePatch reviewer verdict is not bound to the canonical test evidence.");
  }
  assertIsoTimestamp(value.createdAt, "CandidatePatch.createdAt");
  assertNoForbiddenFields(value, "CandidatePatch");
  return value;
}

/** Validate a closed reviewer decision bound to candidate and test-evidence identity. */
export function validateReviewerVerdict(value) {
  assertExactKeys(
    value,
    [
      "reviewId",
      "reviewerRole",
      "decision",
      "candidateSha256",
      "evidenceSha256",
      "createdAt"
    ],
    [],
    "ReviewerVerdict"
  );
  assertIdentifier(value.reviewId, "ReviewerVerdict.reviewId");
  if (value.reviewerRole !== "reviewer") {
    fail("ReviewerVerdict.reviewerRole must be reviewer.");
  }
  if (!new Set(["approved", "rejected"]).has(value.decision)) {
    fail("ReviewerVerdict.decision is invalid.");
  }
  assertSha256(value.candidateSha256, "ReviewerVerdict.candidateSha256");
  assertSha256(value.evidenceSha256, "ReviewerVerdict.evidenceSha256");
  assertIsoTimestamp(value.createdAt, "ReviewerVerdict.createdAt");
  assertNoForbiddenFields(value, "ReviewerVerdict");
  return value;
}

/** Return the canonical public identity of one reviewer decision. */
export function reviewerEvidenceHash(value) {
  validateReviewerVerdict(value);
  return sha256(value);
}

/** Validate an explicit human decision bound to one candidate hash. */
export function validateApprovalRecord(value) {
  assertExactKeys(
    value,
    [
      ...schemaVersionFields,
      "approvalId",
      "missionId",
      "candidateId",
      "projectId",
      "baseRevision",
      "candidateSha256",
      "reviewerEvidenceSha256",
      "actor",
      "actorId",
      "approvalContext",
      "decision",
      "createdAt"
    ],
    [],
    "ApprovalRecord"
  );
  assertSchemaVersion(value, "ApprovalRecord");
  assertIdentifier(value.approvalId, "ApprovalRecord.approvalId");
  assertIdentifier(value.missionId, "ApprovalRecord.missionId");
  assertIdentifier(value.candidateId, "ApprovalRecord.candidateId");
  assertIdentifier(value.projectId, "ApprovalRecord.projectId");
  if (typeof value.baseRevision !== "string" || !sourceRevisionPattern.test(value.baseRevision)) {
    fail("ApprovalRecord.baseRevision must be a complete Git revision hash.");
  }
  assertSha256(value.candidateSha256, "ApprovalRecord.candidateSha256");
  assertSha256(value.reviewerEvidenceSha256, "ApprovalRecord.reviewerEvidenceSha256");
  if (value.actor !== "human") {
    fail("ApprovalRecord.actor must be the human actor.");
  }
  assertIdentifier(value.actorId, "ApprovalRecord.actorId");
  validateApprovalContext(value.approvalContext);
  if (!new Set(["approved", "rejected"]).has(value.decision)) {
    fail("ApprovalRecord.decision is invalid.");
  }
  assertIsoTimestamp(value.createdAt, "ApprovalRecord.createdAt");
  assertNoForbiddenFields(value, "ApprovalRecord");
  return value;
}

/** Validate the exact TrueForge approval event that authorized one record. */
export function validateApprovalContext(value) {
  assertExactKeys(
    value,
    ["mechanism", "sessionId", "threadId", "toolCallId", "approvalEventId"],
    [],
    "ApprovalContext"
  );
  if (value.mechanism !== "trueforge.tool_approval") {
    fail("ApprovalContext.mechanism must be trueforge.tool_approval.");
  }
  assertIdentifier(value.sessionId, "ApprovalContext.sessionId");
  assertIdentifier(value.threadId, "ApprovalContext.threadId");
  assertIdentifier(value.toolCallId, "ApprovalContext.toolCallId");
  assertIdentifier(value.approvalEventId, "ApprovalContext.approvalEventId");
  assertNoForbiddenFields(value, "ApprovalContext");
  return value;
}

/** Reject duplicate approval identifiers without inferring a decision. */
export function assertUniqueApprovalId(record, existingRecords) {
  validateApprovalRecord(record);
  if (!Array.isArray(existingRecords)) {
    fail("existingRecords must be an array.");
  }
  if (existingRecords.some((entry) => entry.approvalId === record.approvalId)) {
    fail(`Duplicate approval identifier: ${record.approvalId}.`);
  }
}

/** Verify that one approval still matches the exact reviewed candidate. */
export function approvalMatchesCandidate(approval, candidate) {
  validateApprovalRecord(approval);
  validateCandidatePatch(candidate);
  return (
    approval.decision === "approved" &&
    candidate.reviewerVerdict.decision === "approved" &&
    approval.missionId === candidate.missionId &&
    approval.candidateId === candidate.candidateId &&
    approval.projectId === candidate.projectId &&
    approval.baseRevision === candidate.baseRevision &&
    hashesEqual(approval.candidateSha256, candidate.patchSha256) &&
    hashesEqual(approval.reviewerEvidenceSha256, reviewerEvidenceHash(candidate.reviewerVerdict))
  );
}

/** Validate deterministic evidence for an uncommitted working-tree application. */
export function validateApplicationEvidence(value) {
  assertExactKeys(
    value,
    [
      ...schemaVersionFields,
      "missionId",
      "candidateId",
      "candidateSha256",
      "projectId",
      "baseRevision",
      "workingTreeStatus",
      "changedFiles",
      "appliedAt",
      "success"
    ],
    [],
    "ApplicationEvidence"
  );
  assertSchemaVersion(value, "ApplicationEvidence");
  assertIdentifier(value.missionId, "ApplicationEvidence.missionId");
  assertIdentifier(value.candidateId, "ApplicationEvidence.candidateId");
  assertSha256(value.candidateSha256, "ApplicationEvidence.candidateSha256");
  assertIdentifier(value.projectId, "ApplicationEvidence.projectId");
  if (typeof value.baseRevision !== "string" || !sourceRevisionPattern.test(value.baseRevision)) {
    fail("ApplicationEvidence.baseRevision must be a complete Git revision hash.");
  }
  assertCanonicalPathInventory(value.changedFiles, "ApplicationEvidence.changedFiles");
  if (!Array.isArray(value.workingTreeStatus) || value.workingTreeStatus.length > 1000) {
    fail("ApplicationEvidence.workingTreeStatus must contain at most 1000 entries.");
  }
  const statusPaths = [];
  for (const [index, entry] of value.workingTreeStatus.entries()) {
    assertExactKeys(entry, ["operation", "path"], [], `ApplicationEvidence.workingTreeStatus[${index}]`);
    if (!new Set(["add", "modify", "delete"]).has(entry.operation)) {
      fail(`ApplicationEvidence.workingTreeStatus[${index}].operation is unknown.`);
    }
    assertSafeRelativePath(entry.path, `ApplicationEvidence.workingTreeStatus[${index}].path`);
    statusPaths.push(entry.path);
  }
  if (canonicalJson(statusPaths) !== canonicalJson(value.changedFiles)) {
    fail("ApplicationEvidence working-tree status must match changedFiles exactly.");
  }
  assertIsoTimestamp(value.appliedAt, "ApplicationEvidence.appliedAt");
  if (value.success !== true) {
    fail("ApplicationEvidence.success must be true.");
  }
  assertNoForbiddenFields(value, "ApplicationEvidence");
  return value;
}
