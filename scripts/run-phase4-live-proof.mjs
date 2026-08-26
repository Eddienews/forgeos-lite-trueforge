import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createMissionOrchestrator } from "../packages/orchestrator/src/index.js";
import { createTrueForgeHttpDriver } from "../packages/runtime-trueforge/src/index.js";

const execFileAsync = promisify(execFile);
const baseUrl = process.env.TRUEFORGE_BASE_URL;
const trustedWorkspaceRoot = process.env.TRUEFORGE_WORKSPACE_ROOT;

if (baseUrl === undefined || trustedWorkspaceRoot === undefined) {
  throw new Error("TRUEFORGE_BASE_URL and TRUEFORGE_WORKSPACE_ROOT are required for the live proof.");
}

async function git(root, ...args) {
  return execFileAsync("git", args, { cwd: root, encoding: "utf8" });
}

async function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function fixture(temporaryRoot, name, generatedValue) {
  const projectRoot = path.join(temporaryRoot, name);
  await mkdir(projectRoot);
  await git(projectRoot, "init", "--quiet");
  await git(projectRoot, "config", "user.name", "Phase Four Live Proof");
  await git(projectRoot, "config", "user.email", "phase-four-live@example.invalid");
  await write(
    projectRoot,
    "package.json",
    `${JSON.stringify(
      {
        name: `forgeos-phase-four-${name}`,
        private: true,
        type: "module",
        scripts: { build: "node build.mjs", test: "node --test" }
      },
      null,
      2
    )}\n`
  );
  await write(projectRoot, ".npmrc", "loglevel=silent\nlogs-max=0\nupdate-notifier=false\n");
  await write(
    projectRoot,
    "build.mjs",
    [
      'import { writeFile } from "node:fs/promises";',
      "",
      `await writeFile("src/value.js", "export const value = ${generatedValue};\\n", "utf8");`,
      `console.log("PHASE4_BUILDER_VALUE_${generatedValue}");`,
      ""
    ].join("\n")
  );
  await write(projectRoot, "src/value.js", "export const value = 1;\n");
  await write(
    projectRoot,
    "test/value.test.mjs",
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { value } from "../src/value.js";',
      "",
      'test("reviewed value", () => assert.equal(value, 2));',
      ""
    ].join("\n")
  );
  await git(projectRoot, "add", ".");
  await git(projectRoot, "commit", "--quiet", "-m", "Live proof baseline");
  return {
    projectRoot: await realpath(projectRoot),
    baseRevision: (await git(projectRoot, "rev-parse", "HEAD")).stdout.trim()
  };
}

function project(fixtureValue, suffix) {
  return {
    projectId: `project-${suffix}`,
    projectRoot: fixtureValue.projectRoot,
    projectName: `Phase Four ${suffix} Live Proof`,
    projectType: "node",
    commandPolicies: { install: null, build: "npm-run-build", test: "npm-test" },
    allowedEnvironmentKeys: ["CI", "TZ"]
  };
}

function mission(suffix) {
  return {
    missionId: `mission-${suffix}`,
    title: "Update the reviewed value",
    brief: "Update the bounded value module through the declared Builder transformation.",
    successCriteria: ["Declared tests pass.", "Only src/value.js changes."],
    authority: {
      capabilities: [
        "candidate:create",
        "candidate:request-application",
        "candidate:review",
        "project:inspect",
        "sandbox:build",
        "sandbox:prepare",
        "sandbox:test",
        "sandbox:write"
      ],
      projectPaths: ["src/value.js"]
    },
    expectedScope: ["src/value.js"],
    maximumChangedFiles: 1
  };
}

function driver() {
  return createTrueForgeHttpDriver({
    baseUrl,
    agentSpec: {
      model: {
        name: "openai/gpt-5-4-mini",
        params: { reasoning_effort: "low" }
      },
      config: {
        iteration_limit: 10,
        sandbox: { enabled: true, file_downloads: true },
        dynamic_sub_agents: { enabled: false },
        context_management: {
          compaction: { enabled: false },
          large_tool_response: { enabled: true }
        },
        generative_ui: { enabled: false },
        ask_user_questions: { enabled: false }
      },
      instructions: [
        "Execute only the exact prevalidated ForgeOS Lite command supplied by the runtime.",
        "Use the sandbox exec tool exactly once per turn.",
        "Do not transform, extend, or combine the supplied command."
      ].join(" ")
    }
  });
}

const temporaryRoot = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "forgeos-phase4-live-"))
);
try {
  const positiveFixture = await fixture(temporaryRoot, "positive", 2);
  const negativeFixture = await fixture(temporaryRoot, "negative", 0);
  const originalPositive = await readFile(
    path.join(positiveFixture.projectRoot, "src/value.js"),
    "utf8"
  );
  const originalNegative = await readFile(
    path.join(negativeFixture.projectRoot, "src/value.js"),
    "utf8"
  );
  const orchestrator = await createMissionOrchestrator({
    driver: driver(),
    trustedWorkspaceRoot: await realpath(trustedWorkspaceRoot),
    executionTimeoutMs: 120_000
  });

  const positive = await orchestrator.runMission({
    project: project(positiveFixture, "positive-live"),
    mission: mission("positive-live")
  });
  if (positive.status !== "awaiting_approval") {
    console.error(JSON.stringify({ positiveFailure: positive.failure }, null, 2));
  }
  assert.equal(positive.status, "awaiting_approval");
  assert.equal(positive.currentState, "awaiting_approval");
  assert.equal(positive.approvalState, "pending_human");
  assert.equal(positive.reviewerVerdict.decision, "approved");
  assert.deepEqual(positive.affectedFiles, ["src/value.js"]);
  assert.equal(positive.baseRevision, positiveFixture.baseRevision);
  assert.equal(
    await readFile(path.join(positiveFixture.projectRoot, "src/value.js"), "utf8"),
    originalPositive
  );
  const pending = orchestrator.getPendingApplicationContext("mission-positive-live");
  assert.equal(pending.candidate.patchSha256, positive.candidateSha256);
  const positiveMilestones = positive.timeline.flatMap((entry) =>
    entry.milestone === undefined ? [] : [entry.milestone]
  );
  for (const milestone of [
    "plan.ready",
    "builder.started",
    "builder.completed",
    "validation.completed",
    "reviewer.approved",
    "candidate.ready"
  ]) {
    assert.equal(positiveMilestones.includes(milestone), true);
  }

  const negative = await orchestrator.runMission({
    project: project(negativeFixture, "negative-live"),
    mission: mission("negative-live")
  });
  if (negative.status !== "failed") {
    console.error(JSON.stringify({ unexpectedNegativeSummary: negative }, null, 2));
  }
  assert.equal(negative.status, "failed");
  assert.notEqual(negative.currentState, "awaiting_approval");
  assert.equal(negative.approvalState, "not_available");
  assert.equal(negative.failure.code, "validation_failed");
  assert.notEqual(negative.builderResult, null);
  assert.equal(negative.candidateId, null);
  assert.equal(negative.reviewerVerdict, null);
  assert.equal(
    negative.timeline.filter((entry) => entry.milestone === "validation.failed").length,
    1
  );
  assert.equal(
    await readFile(path.join(negativeFixture.projectRoot, "src/value.js"), "utf8"),
    originalNegative
  );
  assert.throws(
    () => orchestrator.getPendingApplicationContext("mission-negative-live"),
    /only at awaiting_approval/u
  );

  for (const stage of [
    "MISSION CREATED",
    "PLAN READY",
    "BUILDER STARTED",
    "BUILDER COMPLETED",
    "VALIDATION PASSED",
    "REVIEWER APPROVED",
    "CANDIDATE READY",
    "AWAITING HUMAN APPROVAL"
  ]) {
    console.log(stage);
  }
  console.log("MISSION BLOCKED: VALIDATION FAILED");

  console.log(
    JSON.stringify(
      {
        positive: {
          model: "gpt-5.4-mini",
          missionId: positive.missionId,
          state: positive.currentState,
          coordinatorPlan: positive.plan,
          builderResult: positive.builderResult,
          candidateSha256: positive.candidateSha256,
          affectedFiles: positive.affectedFiles,
          validationSummary: positive.validationSummary,
          reviewerDecision: positive.reviewerVerdict.decision,
          approvalState: positive.approvalState,
          nextAction: positive.nextAction,
          originalRevision: positiveFixture.baseRevision,
          originalUnchanged: positive.originalUnchanged,
          workspaceCleanup: positive.workspaceCleanup,
          timeline: positive.timeline
        },
        negative: {
          model: "gpt-5.4-mini",
          missionId: negative.missionId,
          state: negative.currentState,
          builderResult: negative.builderResult,
          failure: negative.failure,
          approvalState: negative.approvalState,
          originalRevision: negativeFixture.baseRevision,
          originalUnchanged: negative.originalUnchanged,
          workspaceCleanup: negative.workspaceCleanup,
          timeline: negative.timeline
        }
      },
      null,
      2
    )
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
