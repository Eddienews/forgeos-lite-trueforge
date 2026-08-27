import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  candidateArtifactSha256,
  createReviewedCandidatePatch,
  createReviewerVerdict,
  generateCandidateArtifact
} from "@forgeos-lite/candidate-patch";
import {
  createBoundedCoordinatorPlan,
  createStaticWebProject,
  materializeCandidatePreview,
  runBoundedRepairLoop,
  startCandidatePreviewServer,
  validateBoundedCoordinatorPlan
} from "@forgeos-lite/real-project";

const execFileAsync = promisify(execFile);

function requirements(runId = "REAL-ONE") {
  const mission = `Build a static status view for ${runId}.`;
  return {
    schemaVersion: "1",
    runId,
    displayName: `Status ${runId}`,
    mission,
    requiredText: [`Status ${runId}`, runId],
    requiredControls: ["filter"],
    acceptanceCriteria: ["Show the current status."]
  };
}

test("static fixtures are fresh Git projects bound to current immutable requirements", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "forgeos-real-fixture-"));
  try {
    const first = await createStaticWebProject({ temporaryRoot, requirements: requirements("REAL-A") });
    const second = await createStaticWebProject({ temporaryRoot, requirements: requirements("REAL-B") });
    assert.notEqual(first.projectRoot, second.projectRoot);
    assert.equal(first.baseRevision.length, 40);
    assert.equal(second.baseRevision.length, 40);
    assert.match(await readFile(path.join(first.projectRoot, "requirements.json"), "utf8"), /REAL-A/u);
    assert.doesNotMatch(await readFile(path.join(second.projectRoot, "requirements.json"), "utf8"), /REAL-A/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Coordinator plan preserves exact mission and cannot broaden scope or policies", () => {
  const current = requirements();
  const plan = createBoundedCoordinatorPlan({
    requirements: current,
    mission: current.mission,
    baseRevision: "a".repeat(40)
  });
  assert.deepEqual(plan.writableScope, ["public/**"]);
  assert.deepEqual(plan.validationPolicies, ["npm-run-build", "npm-test"]);
  assert.throws(
    () => validateBoundedCoordinatorPlan({ ...plan, writableScope: ["**"] }, { mission: current.mission, requirements: current }),
    /broaden/u
  );
  assert.throws(
    () => validateBoundedCoordinatorPlan({ ...plan, validationPolicies: ["npm-test"] }, { mission: current.mission, requirements: current }),
    /fixed validation/u
  );
});

function evidence(success) {
  return {
    command: { policyId: "npm-test" },
    exitStatus: success ? 0 : 1,
    runtimeError: null,
    timedOut: false,
    stdout: success ? "passed" : "failed",
    stderr: ""
  };
}

test("repair loop stops on success and never exceeds its hard limit", async () => {
  let turns = 0;
  const repaired = await runBoundedRepairLoop({
    maximumTurns: 3,
    initialPrompt: "Implement the mission.",
    runTurn: async (_prompt, previousTurnId) => ({ id: `turn-${++turns}`, previousTurnId }),
    assertWorkspace: async () => undefined,
    validate: async () => [evidence(turns === 2)]
  });
  assert.equal(repaired.builderTurns, 2);
  assert.equal(repaired.repairRequired, true);
  turns = 0;
  await assert.rejects(
    runBoundedRepairLoop({
      maximumTurns: 3,
      initialPrompt: "Implement the mission.",
      runTurn: async () => ({ id: `turn-${++turns}` }),
      assertWorkspace: async () => undefined,
      validate: async () => [evidence(false)]
    }),
    /hard limit of 3/u
  );
  assert.equal(turns, 3);
});

async function previewFixture() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "forgeos-preview-test-"));
  const project = await createStaticWebProject({ temporaryRoot, requirements: requirements() });
  const builderRoot = path.join(temporaryRoot, "builder");
  await execFileAsync("git", ["clone", "--quiet", "--no-hardlinks", project.projectRoot, builderRoot]);
  await writeFile(
    path.join(builderRoot, "public", "index.html"),
    "<!doctype html><link rel=\"stylesheet\" href=\"app.css\"><h1>Status REAL-ONE</h1><script src=\"app.js\"></script>\n",
    "utf8"
  );
  await writeFile(path.join(builderRoot, "public", "app.css"), "body { color: white; }\n@media (max-width: 600px) {}\n", "utf8");
  await writeFile(path.join(builderRoot, "public", "app.js"), "document.body.dataset.ready = 'true';\n", "utf8");
  const artifact = await generateCandidateArtifact({
    originalRoot: project.projectRoot,
    builderRoot: await realpath(builderRoot),
    baseRevision: project.baseRevision
  });
  const candidateSha256 = candidateArtifactSha256(artifact);
  const reviewerVerdict = createReviewerVerdict({
    reviewId: "review-preview",
    decision: "approved",
    candidateSha256,
    testEvidence: [],
    createdAt: "2026-08-26T00:00:00.000Z"
  });
  const candidate = createReviewedCandidatePatch({
    artifact,
    candidateId: "candidate-preview",
    missionId: "mission-preview",
    projectId: "project-preview",
    patchPath: "artifacts/preview.json",
    testEvidence: [],
    reviewerVerdict,
    createdAt: "2026-08-26T00:00:00.000Z"
  });
  return { temporaryRoot, project, artifact, candidate };
}

test("sealed CandidatePatch preview is read-only and serves only GET or HEAD with restrictive CSP", async () => {
  const value = await previewFixture();
  let preview;
  let server;
  try {
    preview = await materializeCandidatePreview({
      artifact: value.artifact,
      candidate: value.candidate,
      originalRoot: value.project.projectRoot,
      temporaryRoot: await realpath(value.temporaryRoot)
    });
    assert.equal((await stat(preview.root)).mode & 0o222, 0);
    server = await startCandidatePreviewServer({
      root: preview.root,
      port: 0,
      controlOrigin: "http://127.0.0.1:4173"
    });
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Status REAL-ONE/u);
    assert.match(page.headers.get("content-security-policy"), /connect-src 'none'/u);
    assert.match(
      page.headers.get("content-security-policy"),
      new RegExp(`script-src ${server.url.slice(0, -1).replaceAll(".", "\\.")}`, "u")
    );
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors http:\/\/127\.0\.0\.1:4173/u);
    assert.equal(page.headers.get("cross-origin-resource-policy"), "cross-origin");
    const head = await fetch(new URL("app.css", server.url), { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(server.url, { method: "POST" })).status, 405);
    assert.equal((await fetch(new URL("%2e%2e/requirements.json", server.url))).status, 404);
    assert.equal((await fetch(new URL(".git/config", server.url))).status, 404);
  } finally {
    await server?.close();
    await preview?.close();
    await chmod(value.temporaryRoot, 0o755).catch(() => undefined);
    await rm(value.temporaryRoot, { recursive: true, force: true });
  }
});
