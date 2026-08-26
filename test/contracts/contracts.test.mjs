import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalMatchesCandidate,
  assertAuthoritySubset,
  assertCommandToken,
  assertSafeRelativePath,
  assertUniqueApprovalId,
  canonicalJson,
  getAgentProfile,
  sha256,
  validateAgentProfile,
  validateApprovalRecord,
  validateCandidatePatch,
  validateHandoff,
  validateMission,
  validateProjectManifest
} from "../../packages/contracts/src/index.js";

const timestamp = "2026-08-26T04:00:00.000Z";
const gitRevision = "a".repeat(40);
const patchHash = "b".repeat(64);
const evidenceHash = "c".repeat(64);

function validManifest() {
  return {
    schemaVersion: "1",
    projectId: "project-1",
    name: "Sample project",
    runtime: "node",
    installCommand: { kind: "policy", policyId: "npm-ci", arguments: [] },
    testCommand: { kind: "policy", policyId: "npm-test", arguments: ["--", "--runInBand"] },
    buildCommand: { kind: "policy", policyId: "npm-run-build", arguments: [] },
    allowedEnvironmentKeys: ["CI", "NODE_ENV"],
    sourceRevision: gitRevision
  };
}

function validAuthority() {
  return {
    capabilities: [
      "project:inspect",
      "sandbox:prepare",
      "sandbox:write",
      "candidate:create",
      "candidate:review",
      "candidate:request-application"
    ],
    projectPaths: ["src", "test/fixture.js"]
  };
}

function validMission() {
  return {
    schemaVersion: "1",
    missionId: "mission-1",
    projectId: "project-1",
    title: "Add one safe feature",
    brief: "Prepare a reviewed candidate change in the sandbox.",
    successCriteria: ["Declared tests pass."],
    state: "draft",
    authority: validAuthority(),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function validCandidate() {
  return {
    schemaVersion: "1",
    candidateId: "candidate-1",
    missionId: "mission-1",
    projectId: "project-1",
    baseRevision: gitRevision,
    patchPath: "artifacts/candidate.patch",
    patchSha256: patchHash,
    affectedFiles: ["src/index.js"],
    testEvidence: [
      {
        kind: "test-run",
        summary: "All declared tests passed.",
        observedAt: timestamp,
        artifactSha256: "d".repeat(64)
      }
    ],
    reviewerVerdict: {
      decision: "approved",
      candidateSha256: patchHash,
      evidenceSha256: evidenceHash
    },
    createdAt: timestamp
  };
}

function validApproval() {
  return {
    schemaVersion: "1",
    approvalId: "approval-1",
    missionId: "mission-1",
    candidateId: "candidate-1",
    candidateSha256: patchHash,
    reviewerEvidenceSha256: evidenceHash,
    actor: "human",
    decision: "approved",
    createdAt: timestamp
  };
}

function validHandoff() {
  return {
    schemaVersion: "1",
    handoffId: "handoff-1",
    missionId: "mission-1",
    fromProfile: "coordinator",
    toProfile: "builder",
    summary: "Prepare the approved sandbox change.",
    requestedActions: ["write_sandbox", "create_candidate"],
    artifacts: [{ path: "plans/mission.json", sha256: "e".repeat(64) }],
    evidence: [{ kind: "plan", summary: "Plan validated.", observedAt: timestamp }],
    authoritySnapshot: validAuthority(),
    createdAt: timestamp
  };
}

test("accepts a structured project manifest", () => {
  assert.equal(validateProjectManifest(validManifest()).runtime, "node");
});

test("represents an empty command explicitly as not applicable", () => {
  const manifest = validManifest();
  manifest.buildCommand = { kind: "not_applicable" };
  assert.equal(validateProjectManifest(manifest).buildCommand.kind, "not_applicable");
});

test("rejects unknown schema fields", () => {
  const manifest = { ...validManifest(), command: "npm test" };
  assert.throws(() => validateProjectManifest(manifest), /unknown field/u);
});

test("rejects free shell command strings", () => {
  const manifest = validManifest();
  manifest.testCommand = "npm test";
  assert.throws(() => validateProjectManifest(manifest), /must be an object/u);
});

test("rejects shell metacharacters in structured command tokens", () => {
  for (const token of ["coverage|upload", "result>file", "$(command)", "first;second"] ) {
    assert.throws(() => assertCommandToken(token, "token"), /forbidden shell character/u);
  }
});

test("rejects interpreter evaluation and environment assignment tokens", () => {
  for (const token of ["-e", "--eval=code", "-c", "--require", "NODE_OPTIONS=value"]) {
    assert.throws(
      () => assertCommandToken(token, "token"),
      /interpreter evaluation|environment assignment/u
    );
  }
});

test("rejects malformed or unknown command policies", () => {
  const manifest = validManifest();
  manifest.testCommand = { kind: "policy", policyId: "npm test", arguments: [] };
  assert.throws(() => validateProjectManifest(manifest), /policy identifier/u);
  manifest.testCommand = { kind: "policy", policyId: "custom-runner", arguments: [] };
  assert.throws(() => validateProjectManifest(manifest), /not allowed/u);
});

test("rejects environment secret injection and undeclared keys", () => {
  const secretManifest = validManifest();
  secretManifest.allowedEnvironmentKeys = ["OPENROUTER_API_KEY"];
  assert.throws(() => validateProjectManifest(secretManifest), /secret-bearing/u);
  const unknownManifest = validManifest();
  unknownManifest.allowedEnvironmentKeys = ["CUSTOM_MODE"];
  assert.throws(() => validateProjectManifest(unknownManifest), /not allowed/u);
  assert.equal(Object.hasOwn(validManifest(), "environmentValues"), false);
});

test("accepts explicit known mission authority", () => {
  assert.equal(validateMission(validMission()).state, "draft");
});

test("denies unknown mission capabilities", () => {
  const mission = validMission();
  mission.authority.capabilities.push("host:write");
  assert.throws(() => validateMission(mission), /unknown capability/u);
});

test("rejects nested private reasoning and secret fields", () => {
  const mission = validMission();
  mission.authority.projectPaths = ["src"];
  mission.successCriteria = ["Review observable evidence."];
  mission.authority.extra = { nested: { reasoning: "private" } };
  assert.throws(() => validateMission(mission), /unknown field|forbidden field/u);

  const handoff = validHandoff();
  handoff.evidence[0].summary = "Evidence is observable.";
  handoff.evidence[0].conversationHistory = [];
  assert.throws(() => validateHandoff(handoff, validAuthority()), /unknown field|forbidden field/u);
});

test("returns only fixed least-privilege agent profiles", () => {
  for (const profile of ["coordinator", "builder", "reviewer"]) {
    assert.equal(validateAgentProfile(structuredClone(getAgentProfile(profile))).profile, profile);
  }
  assert.throws(() => getAgentProfile("administrator"), /Unknown agent profile/u);
});

test("rejects agent profile privilege escalation", () => {
  const coordinator = structuredClone(getAgentProfile("coordinator"));
  coordinator.allowedActions.push("edit_project");
  assert.throws(() => validateAgentProfile(coordinator), /cannot expand or alter/u);
});

test("enforces fixed profile boundaries", () => {
  assert.equal(getAgentProfile("coordinator").deniedActions.includes("edit_project"), true);
  assert.equal(getAgentProfile("coordinator").deniedActions.includes("approve_delivery"), true);
  assert.equal(getAgentProfile("builder").deniedActions.includes("apply_candidate"), true);
  assert.equal(getAgentProfile("builder").deniedActions.includes("modify_authority"), true);
  assert.equal(getAgentProfile("reviewer").deniedActions.includes("edit_project"), true);
  assert.equal(getAgentProfile("reviewer").deniedActions.includes("expand_authority"), true);
});

test("accepts a bounded cross-profile handoff", () => {
  assert.equal(validateHandoff(validHandoff(), validAuthority()).toProfile, "builder");
});

test("rejects same-profile handoff and unavailable destination actions", () => {
  const sameProfile = validHandoff();
  sameProfile.toProfile = "coordinator";
  assert.throws(() => validateHandoff(sameProfile, validAuthority()), /must differ/u);
  const unavailable = validHandoff();
  unavailable.toProfile = "reviewer";
  assert.throws(() => validateHandoff(unavailable, validAuthority()), /unavailable/u);
});

test("rejects authority expansion in handoffs", () => {
  const handoff = validHandoff();
  handoff.authoritySnapshot.capabilities.push("sandbox:execute:test");
  assert.throws(() => validateHandoff(handoff, validAuthority()), /unknown capability|expands/u);

  const subset = { capabilities: ["project:inspect"], projectPaths: ["src", "private"] };
  assert.throws(() => assertAuthoritySubset(subset, validAuthority()), /expands authorized project paths/u);
});

test("rejects unsafe relative paths", () => {
  for (const unsafePath of [
    "/absolute/file",
    "../escape",
    "safe/../escape",
    "safe\\..\\escape",
    "safe//file",
    "safe/./file",
    "safe/\0file",
    "C:\\outside\\file"
  ]) {
    assert.throws(() => assertSafeRelativePath(unsafePath, "path"), /safe|unsafe/u);
  }
  assert.doesNotThrow(() => assertSafeRelativePath("safe/nested/file.patch", "path"));
});

test("rejects incomplete hashes in artifacts and candidates", () => {
  const handoff = validHandoff();
  handoff.artifacts[0].sha256 = "abc123";
  assert.throws(() => validateHandoff(handoff, validAuthority()), /complete SHA-256/u);
  const candidate = validCandidate();
  candidate.patchSha256 = "b".repeat(63);
  assert.throws(() => validateCandidatePatch(candidate), /complete SHA-256/u);
});

test("binds reviewer verdict and human approval to the candidate hash", () => {
  assert.equal(approvalMatchesCandidate(validApproval(), validCandidate()), true);
  const mutatedCandidate = validCandidate();
  mutatedCandidate.patchSha256 = "f".repeat(64);
  assert.throws(() => validateCandidatePatch(mutatedCandidate), /not bound/u);

  const changedAfterApproval = validCandidate();
  changedAfterApproval.patchSha256 = "f".repeat(64);
  changedAfterApproval.reviewerVerdict.candidateSha256 = "f".repeat(64);
  assert.equal(approvalMatchesCandidate(validApproval(), changedAfterApproval), false);
});

test("rejects approval actor impersonation", () => {
  for (const actor of ["model", "coordinator", "builder", "reviewer", "api", "system"]) {
    const approval = { ...validApproval(), actor };
    assert.throws(() => validateApprovalRecord(approval), /human actor/u);
  }
});

test("rejects duplicate approval identifiers", () => {
  assert.throws(
    () => assertUniqueApprovalId(validApproval(), [validApproval()]),
    /Duplicate approval identifier/u
  );
});

test("canonical JSON and SHA-256 hashing are deterministic", () => {
  const left = { z: [3, { b: true, a: "value" }], a: 1 };
  const right = { a: 1, z: [3, { a: "value", b: true }] };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(sha256(left), sha256(right));
});

test("canonical JSON preserves prototype-shaped keys as data", () => {
  const value = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
  assert.equal(canonicalJson(value), '{"__proto__":{"polluted":true},"safe":1}');
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});
