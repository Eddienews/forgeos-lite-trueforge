import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createCoordinatorPlan,
  createMissionOrchestrator,
  intakeNodeProject,
  reviewCandidateEvidence,
  validateBuilderResult,
  validateCoordinatorPlan
} from "../../packages/orchestrator/src/index.js";
import {
  validateCandidatePatch,
  validateHandoff,
  validateReviewerVerdict
} from "../../packages/contracts/src/index.js";
import {
  InMemoryMissionJournal,
  replayMissionJournal
} from "../../packages/core/src/index.js";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  return execFileAsync("git", args, { cwd: root, encoding: "utf8" });
}

async function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function fixture() {
  const temporaryRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "forgeos-phase4-test-"))
  );
  const projectRoot = path.join(temporaryRoot, "project");
  const trustedWorkspaceRoot = path.join(temporaryRoot, "trueforge-workspaces");
  await mkdir(projectRoot);
  await mkdir(trustedWorkspaceRoot);
  await git(projectRoot, "init", "--quiet");
  await git(projectRoot, "config", "user.name", "Phase Four Test");
  await git(projectRoot, "config", "user.email", "phase-four@example.invalid");
  await write(
    projectRoot,
    "package.json",
    `${JSON.stringify(
      {
        name: "phase-four-fixture",
        private: true,
        type: "module",
        scripts: { build: "node build.mjs", test: "node --test" }
      },
      null,
      2
    )}\n`
  );
  await write(projectRoot, "build.mjs", 'console.log("fixture build");\n');
  await write(projectRoot, "src/value.js", "export const value = 1;\n");
  await write(
    projectRoot,
    "test/value.test.mjs",
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { value } from "../src/value.js";',
      '',
      'test("value is reviewed", () => assert.equal(value, 2));',
      ""
    ].join("\n")
  );
  await git(projectRoot, "add", ".");
  await git(projectRoot, "commit", "--quiet", "-m", "Fixture baseline");
  const sourceRevision = (await git(projectRoot, "rev-parse", "HEAD")).stdout.trim();
  return {
    temporaryRoot,
    projectRoot,
    trustedWorkspaceRoot,
    sourceRevision,
    async cleanup() {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  };
}

function clock() {
  let index = 0;
  return () => new Date(Date.UTC(2026, 7, 26, 12, 0, index++)).toISOString();
}

function ids() {
  let index = 0;
  return (label) => `${label}-${++index}`;
}

function authority(paths = ["src/value.js"], additions = []) {
  return {
    capabilities: [
      "candidate:create",
      "candidate:request-application",
      "candidate:review",
      "project:inspect",
      "sandbox:build",
      "sandbox:prepare",
      "sandbox:test",
      "sandbox:write",
      ...additions
    ].sort((left, right) => left.localeCompare(right)),
    projectPaths: [...paths].sort((left, right) => left.localeCompare(right))
  };
}

function missionInput(overrides = {}) {
  return {
    missionId: "mission-phase-four",
    title: "Update the reviewed value",
    brief: "Update the bounded value module through the declared Builder transformation.",
    successCriteria: ["Declared tests pass.", "Only src/value.js changes."],
    authority: authority(),
    expectedScope: ["src/value.js"],
    maximumChangedFiles: 1,
    ...overrides
  };
}

function projectInput(state, overrides = {}) {
  return {
    projectId: "project-phase-four",
    projectRoot: state.projectRoot,
    projectName: "Phase Four Fixture",
    projectType: "node",
    commandPolicies: { install: null, build: "npm-run-build", test: "npm-test" },
    allowedEnvironmentKeys: ["CI", "TZ"],
    ...overrides
  };
}

function fakeDriver(state, behavior = {}) {
  const calls = [];
  let buildCount = 0;
  return {
    calls,
    driver: {
      async createSession() {
        if (behavior.startupErrorCode !== undefined) {
          const error = new Error("external workspace startup failed");
          error.code = behavior.startupErrorCode;
          throw error;
        }
        const workspaceRoot = path.join(state.trustedWorkspaceRoot, `session-${calls.length + 1}`);
        await mkdir(workspaceRoot);
        calls.push({ method: "createSession", workspaceRoot });
        return { sessionId: "trueforge-phase-four", workspaceRoot };
      },
      async execute(input) {
        calls.push({ method: "execute", input });
        const command = input.argv.join(" ");
        if (command === "npm run build") {
          buildCount += 1;
          if (behavior.buildFailureAt === buildCount) {
            return {
              exitStatus: 1,
              stdout: "build failed\n",
              stderr: "",
              timedOut: false,
              runtimeError: null
            };
          }
          if (buildCount === 1) {
            if (behavior.runtimeFailure === true) throw new Error("runtime unavailable");
            if (behavior.timeout === true) {
              return {
                exitStatus: null,
                stdout: "",
                stderr: "",
                timedOut: true,
                runtimeError: null
              };
            }
            await write(input.workingDirectory, "src/value.js", "export const value = 2;\n");
            if (behavior.unexpectedFile === true) {
              await write(input.workingDirectory, "src/unexpected.js", "export const extra = true;\n");
            }
            if (behavior.gitMutation === true) {
              await write(input.workingDirectory, ".git/phase-four-mutation", "forbidden\n");
            }
            if (behavior.traversal === true) {
              await write(path.dirname(input.workingDirectory), "outside.txt", "forbidden\n");
            }
            if (behavior.emptyRuntimeCache === true) {
              await mkdir(path.join(path.dirname(input.workingDirectory), ".runtime-cache"));
            }
            if (behavior.symlinkChange === true) {
              await rm(path.join(input.workingDirectory, "src/value.js"));
              await symlink("../build.mjs", path.join(input.workingDirectory, "src/value.js"));
            }
          }
        }
        if (command === "npm test" && behavior.testFailure === true) {
          return {
            exitStatus: 1,
            stdout: "test failed\n",
            stderr: "",
            timedOut: false,
            runtimeError: null
          };
        }
        return {
          exitStatus: 0,
          stdout: `${command} passed\n`,
          stderr: "",
          timedOut: false,
          runtimeError: null
        };
      },
      async closeSession(input) {
        calls.push({ method: "closeSession", input });
      }
    }
  };
}

async function orchestrator(state, behavior = {}, options = {}) {
  const fake = fakeDriver(state, behavior);
  const instance = await createMissionOrchestrator({
    driver: fake.driver,
    trustedWorkspaceRoot: state.trustedWorkspaceRoot,
    clock: clock(),
    idFactory: ids(),
    ...(options.cleanupWorkspace === undefined
      ? {}
      : { cleanupWorkspace: options.cleanupWorkspace })
  });
  return { fake, instance };
}

test("runs the bounded mission to awaiting human approval without changing the original", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const before = await readFile(path.join(state.projectRoot, "src/value.js"), "utf8");
  const { fake, instance } = await orchestrator(state);
  const summary = await instance.runMission({
    project: projectInput(state),
    mission: missionInput()
  });
  assert.equal(summary.status, "awaiting_approval");
  assert.equal(summary.currentState, "awaiting_approval");
  assert.equal(summary.approvalState, "pending_human");
  assert.deepEqual(summary.affectedFiles, ["src/value.js"]);
  assert.equal(summary.reviewerVerdict.decision, "approved");
  assert.equal(summary.originalUnchanged, true);
  assert.equal(summary.workspaceCleanup, "completed");
  assert.equal(await readFile(path.join(state.projectRoot, "src/value.js"), "utf8"), before);
  assert.equal(fake.calls.filter((entry) => entry.method === "execute").length, 3);
  const milestones = summary.timeline.flatMap((entry) =>
    entry.milestone === undefined ? [] : [entry.milestone]
  );
  for (const required of [
    "plan.ready",
    "builder.workspace_ready",
    "builder.started",
    "builder.completed",
    "validation.started",
    "validation.completed",
    "reviewer.started",
    "reviewer.approved",
    "candidate.ready"
  ]) {
    assert.equal(milestones.includes(required), true);
  }
  assert.equal(instance.resumeMission({ missionId: summary.missionId }).currentState, "awaiting_approval");
  const context = instance.getPendingApplicationContext(summary.missionId);
  assert.equal(context.candidate.patchSha256, summary.candidateSha256);
  assert.equal(context.projectRoot, state.projectRoot);
});

test("rejects a symlink project root, a non-Git directory, and a dirty repository", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const link = path.join(state.temporaryRoot, "project-link");
  await symlink(state.projectRoot, link);
  await assert.rejects(intakeNodeProject(projectInput(state, { projectRoot: link })), /symlink|canonical/u);

  const plain = path.join(state.temporaryRoot, "plain");
  await mkdir(plain);
  await assert.rejects(
    intakeNodeProject(projectInput(state, { projectRoot: await realpath(plain) })),
    /Git repository/u
  );

  await write(state.projectRoot, "dirty.txt", "dirty\n");
  await assert.rejects(intakeNodeProject(projectInput(state)), /clean initial/u);
});

test("rejects unsupported project types and command policies", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  await assert.rejects(
    intakeNodeProject(projectInput(state, { projectType: "python" })),
    /must be node/u
  );
  await assert.rejects(
    intakeNodeProject(
      projectInput(state, {
        commandPolicies: { install: null, build: "arbitrary-command", test: "npm-test" }
      })
    ),
    /unsupported/u
  );
});

test("fails closed when mission authority expands beyond the admitted project", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const { instance } = await orchestrator(state);
  const summary = await instance.runMission({
    project: projectInput(state),
    mission: missionInput({ authority: authority(["src/value.js"], ["sandbox:install"]) })
  });
  assert.equal(summary.status, "failed");
  assert.match(summary.failure.summary, /expands mission capabilities/u);
  assert.equal(summary.originalUnchanged, true);
});

test("rejects Coordinator unknown actions and undeclared policies", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const admitted = await intakeNodeProject(projectInput(state));
  const timestamp = "2026-08-26T12:00:00.000Z";
  const mission = {
    schemaVersion: "1",
    missionId: "mission-plan",
    projectId: admitted.manifest.projectId,
    title: "Plan fixture",
    brief: "Plan one bounded change.",
    successCriteria: ["Tests pass."],
    state: "draft",
    authority: authority(),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const plan = createCoordinatorPlan({
    manifest: admitted.manifest,
    mission,
    maximumChangedFiles: 1,
    createdAt: timestamp
  });
  const unknownAction = structuredClone(plan);
  unknownAction.steps[0].action = "execute_anything";
  assert.throws(
    () => validateCoordinatorPlan(unknownAction, { manifest: admitted.manifest, mission }),
    /unknown actor or action/u
  );
  const undeclared = structuredClone(plan);
  undeclared.allowedCommandPolicyIds.push("npm-ci");
  undeclared.allowedCommandPolicyIds.sort();
  assert.throws(
    () => validateCoordinatorPlan(undeclared, { manifest: admitted.manifest, mission }),
    /undeclared/u
  );
});

for (const [name, behavior, pattern] of [
  ["unexpected changed files", { unexpectedFile: true }, /unexpected file/u],
  ["isolated Git metadata mutation", { gitMutation: true }, /Git metadata/u],
  ["workspace traversal", { traversal: true }, /outside its isolated/u],
  ["symlink candidate output", { symlinkChange: true }, /unsupported file entry/u],
  ["Builder runtime failure", { runtimeFailure: true }, /Builder execution failed/u],
  ["Builder timeout", { timeout: true }, /Builder execution failed/u],
  ["test failure", { testFailure: true }, /validation failed/u],
  ["build validation failure", { buildFailureAt: 2 }, /validation failed/u]
]) {
  test(`fails closed for ${name}`, async (t) => {
    const state = await fixture();
    t.after(state.cleanup);
    const { instance } = await orchestrator(state, behavior);
    const summary = await instance.runMission({
      project: projectInput(state),
      mission: missionInput()
    });
    assert.equal(summary.status, "failed");
    assert.notEqual(summary.currentState, "awaiting_approval");
    assert.match(summary.failure.summary, pattern);
    assert.equal(summary.originalUnchanged, true);
    if (behavior.testFailure === true) {
      assert.equal(
        summary.timeline.filter((entry) => entry.milestone === "validation.failed").length,
        1
      );
    }
    assert.throws(
      () => instance.getPendingApplicationContext("mission-phase-four"),
      /only at awaiting_approval/u
    );
  });
}

test("surfaces cleanup failure and prevents awaiting approval", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const { instance } = await orchestrator(state, {}, {
    async cleanupWorkspace() {
      throw new Error("cleanup permission denied");
    }
  });
  const summary = await instance.runMission({
    project: projectInput(state),
    mission: missionInput()
  });
  assert.equal(summary.status, "failed");
  assert.equal(summary.failure.code, "cleanup_failed");
  assert.equal(summary.workspaceCleanup, "failed");
  assert.notEqual(summary.currentState, "awaiting_approval");
});

test("accepts a Builder workspace already removed by the TrueForge session lifecycle", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const { instance } = await orchestrator(state, {}, {
    async cleanupWorkspace(target) {
      await rm(target, { recursive: true, force: true });
      const error = new Error("Builder workspace is already absent");
      error.code = "ENOENT";
      throw error;
    }
  });
  const summary = await instance.runMission({
    project: projectInput(state),
    mission: missionInput()
  });
  assert.equal(summary.status, "awaiting_approval");
  assert.equal(summary.workspaceCleanup, "completed");
  assert.equal(summary.originalUnchanged, true);
});

test("ignores empty provider-owned runtime directories without ignoring traversal files", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const { instance } = await orchestrator(state, { emptyRuntimeCache: true });
  const summary = await instance.runMission({
    project: projectInput(state),
    mission: missionInput()
  });
  assert.equal(summary.status, "awaiting_approval");
  assert.equal(summary.originalUnchanged, true);
});

test("normalizes external error codes before journaling a blocked mission", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const { instance } = await orchestrator(state, { startupErrorCode: "ENOENT" });
  const summary = await instance.runMission({
    project: projectInput(state),
    mission: missionInput()
  });
  assert.equal(summary.status, "failed");
  assert.equal(summary.currentState, "blocked");
  assert.equal(summary.failure.code, "orchestration_failed");
  assert.match(summary.failure.summary, /external workspace startup failed/u);
});

test("Reviewer rejects missing evidence, base mismatch, and excessive file count", async () => {
  const timestamp = "2026-08-26T12:00:00.000Z";
  const mission = {
    schemaVersion: "1",
    missionId: "mission-review",
    projectId: "project-review",
    title: "Review fixture",
    brief: "Review a bounded fixture.",
    successCriteria: ["Tests pass."],
    state: "reviewing",
    authority: authority(["src/a.js", "src/b.js"]),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const manifest = {
    schemaVersion: "1",
    projectId: "project-review",
    name: "Review Fixture",
    runtime: "node",
    installCommand: { kind: "not_applicable" },
    testCommand: { kind: "policy", policyId: "npm-test", arguments: [] },
    buildCommand: { kind: "policy", policyId: "npm-run-build", arguments: [] },
    allowedEnvironmentKeys: ["CI", "TZ"],
    sourceRevision: "a".repeat(40)
  };
  const artifact = {
    schemaVersion: "1",
    baseRevision: "a".repeat(40),
    operations: [
      {
        operation: "add",
        path: "src/a.js",
        content: "export const a = true;\n",
        contentSha256: "af96f0481fa32769cb5faced02ae44b2de5152e3710f5166ab12cd5d30a308a2"
      },
      {
        operation: "add",
        path: "src/b.js",
        content: "export const b = true;\n",
        contentSha256: "565d86fef931d1c20254772c3f8804544bc9fd671f0f3f19861f7144755d3a34"
      }
    ]
  };
  const builderResult = {
    schemaVersion: "1",
    missionId: "mission-review",
    builderAgentId: "builder-review",
    workspaceId: "workspace-review",
    baseRevision: "a".repeat(40),
    executedPolicyIds: ["npm-run-build"],
    executionEvidenceIds: ["execution-review"],
    changedFiles: ["src/a.js", "src/b.js"],
    completionState: "completed",
    failureState: "none",
    startedAt: timestamp,
    completedAt: timestamp
  };
  const missing = reviewCandidateEvidence({
    mission,
    manifest,
    artifact,
    builderResult,
    validationEvidence: [],
    expectedScope: ["src/a.js", "src/b.js"],
    maximumChangedFiles: 2
  });
  assert.equal(missing.decision, "rejected");
  assert.match(missing.summary, /missing/u);

  const stale = structuredClone(artifact);
  stale.baseRevision = "b".repeat(40);
  const baseMismatch = reviewCandidateEvidence({
    mission,
    manifest,
    artifact: stale,
    builderResult,
    validationEvidence: [],
    expectedScope: ["src/a.js", "src/b.js"],
    maximumChangedFiles: 2
  });
  assert.equal(baseMismatch.decision, "rejected");
  assert.match(baseMismatch.summary, /base/u);

  const tooMany = reviewCandidateEvidence({
    mission,
    manifest,
    artifact,
    builderResult,
    validationEvidence: [],
    expectedScope: ["src/a.js", "src/b.js"],
    maximumChangedFiles: 1
  });
  assert.equal(tooMany.decision, "rejected");
  assert.match(tooMany.summary, /file-count/u);
});

test("enforces BuilderResult evidence and authority boundaries", () => {
  const timestamp = "2026-08-26T12:00:00.000Z";
  const result = {
    schemaVersion: "1",
    missionId: "mission-builder",
    builderAgentId: "builder-one",
    workspaceId: "workspace-one",
    baseRevision: "a".repeat(40),
    executedPolicyIds: ["npm-run-build"],
    executionEvidenceIds: ["execution-one"],
    changedFiles: ["src/value.js"],
    completionState: "completed",
    failureState: "none",
    startedAt: timestamp,
    completedAt: timestamp
  };
  assert.equal(validateBuilderResult(result), result);
  assert.throws(
    () => validateBuilderResult({ ...result, executionEvidenceIds: [] }),
    /executionEvidenceIds/u
  );
  const missionAuthority = authority();
  for (const action of ["write_sandbox", "request_application"]) {
    assert.throws(
      () =>
        validateHandoff(
          {
            schemaVersion: "1",
            handoffId: `handoff-${action}`,
            missionId: "mission-builder",
            fromProfile: "coordinator",
            toProfile: "reviewer",
            summary: "Attempt an unavailable Reviewer action.",
            requestedActions: [action],
            artifacts: [],
            evidence: [],
            authoritySnapshot: missionAuthority,
            createdAt: timestamp
          },
          missionAuthority
        ),
      /unavailable/u
    );
  }
});

test("rejects malformed and mutated Reviewer evidence", () => {
  const verdict = {
    reviewId: "review-one",
    reviewerRole: "reviewer",
    decision: "approved",
    candidateSha256: "a".repeat(64),
    evidenceSha256: "b".repeat(64),
    createdAt: "2026-08-26T12:00:00.000Z"
  };
  assert.throws(() => validateReviewerVerdict({ ...verdict, decision: "maybe" }), /invalid/u);
  const candidate = {
    schemaVersion: "1",
    candidateId: "candidate-one",
    missionId: "mission-one",
    projectId: "project-one",
    baseRevision: "a".repeat(40),
    patchPath: "artifacts/candidate.json",
    patchSha256: "a".repeat(64),
    affectedFiles: ["src/value.js"],
    testEvidence: [],
    reviewerVerdict: verdict,
    createdAt: "2026-08-26T12:00:00.000Z"
  };
  assert.throws(() => validateCandidatePatch(candidate), /test evidence/u);
});

test("milestone events preserve replay state and corruption remains detectable", () => {
  const journal = new InMemoryMissionJournal();
  const timestamp = "2026-08-26T12:00:00.000Z";
  journal.append({
    eventId: "event-created",
    missionId: "mission-timeline",
    eventType: "mission.created",
    actor: "system",
    timestamp,
    payload: { state: "draft" }
  });
  journal.append({
    eventId: "event-plan",
    missionId: "mission-timeline",
    eventType: "mission.milestone",
    actor: "coordinator",
    timestamp,
    payload: { milestone: "plan.ready", summary: "The bounded plan is ready." }
  });
  assert.equal(journal.replay().state, "draft");
  const corrupted = journal.events();
  corrupted[1].payload.summary = "Mutated timeline evidence.";
  assert.throws(() => replayMissionJournal(corrupted), /invalid event hash/u);
});

for (const forbidden of [
  { reasoning: "private" },
  { conversationHistory: ["raw"] },
  { secrets: { token: "hidden" } }
]) {
  test(`rejects forbidden mission input field ${Object.keys(forbidden)[0]}`, async (t) => {
    const state = await fixture();
    t.after(state.cleanup);
    const { instance } = await orchestrator(state);
    const summary = await instance.runMission({
      project: projectInput(state),
      mission: { ...missionInput(), ...forbidden }
    });
    assert.equal(summary.status, "failed");
    assert.match(summary.failure.summary, /unknown field|forbidden/u);
  });
}
