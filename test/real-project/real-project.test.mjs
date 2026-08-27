import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
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
  containsExternalResource,
  createBoundedCoordinatorPlan,
  createStaticWebProject,
  materializeCandidatePreview,
  runBoundedRepairLoop,
  startCandidatePreviewServer,
  validateBoundedCoordinatorPlan
} from "@forgeos-lite/real-project";
import { authoritativeChangedFileSize } from "../../packages/real-project/src/mission.js";

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
    acceptanceChecks: [
      { kind: "visible-text", value: `Status ${runId}` },
      { kind: "control", value: "filter" },
      { kind: "source-policy", value: "responsive" },
      { kind: "source-policy", value: "local-only" }
    ],
    acceptanceCriteria: [
      `Display exact visible text: Status ${runId}`,
      "Provide local filter behavior.",
      "Use responsive CSS.",
      "Use no external HTTP resources."
    ]
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

test("static fixture criteria map exactly to executable acceptance checks", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "forgeos-real-contract-"));
  try {
    const invalid = requirements("REAL-CONTRACT");
    invalid.acceptanceCriteria = [...invalid.acceptanceCriteria];
    invalid.acceptanceCriteria[0] = "A prose-only criterion.";
    await assert.rejects(
      createStaticWebProject({ temporaryRoot, requirements: invalid }),
      /map exactly to executable acceptanceChecks/u
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("immutable acceptance checks execute against visible content and local behavior", async () => {
  assert.equal(containsExternalResource("body { background: url(//example.com/pixel.png); }"), true);
  assert.equal(containsExternalResource('<script src="//example.com/app.js"></script>'), true);
  assert.equal(containsExternalResource("const value = 'local-only';"), false);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "forgeos-real-acceptance-"));
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  try {
    const project = await createStaticWebProject({
      temporaryRoot,
      requirements: requirements("REAL-ACCEPT")
    });
    await writeFile(
      path.join(project.projectRoot, "public", "index.html"),
      "<!doctype html><link rel=\"stylesheet\" href=\"app.css\"><h1>Status REAL-ACCEPT</h1><button data-filter=\"status\">Filter</button><script src=\"app.js\"></script>\n",
      "utf8"
    );
    await writeFile(
      path.join(project.projectRoot, "public", "app.css"),
      "body { color: black; }\n@media (max-width: 600px) { body { color: gray; } }\n",
      "utf8"
    );
    await writeFile(
      path.join(project.projectRoot, "public", "app.js"),
      "document.querySelector('[data-filter]').addEventListener('click', () => undefined);\n",
      "utf8"
    );
    await execFileAsync(
      process.execPath,
      ["--test", "test/acceptance.test.mjs"],
      { cwd: project.projectRoot, env: childEnvironment }
    );
    await writeFile(
      path.join(project.projectRoot, "public", "app.css"),
      "body { background: url(//example.com/pixel.png); }\n@media (max-width: 600px) {}\n",
      "utf8"
    );
    await assert.rejects(
      execFileAsync(process.execPath, ["scripts/build-check.mjs"], {
        cwd: project.projectRoot
      }),
      /Protocol-relative external resources are forbidden/u
    );
    await writeFile(
      path.join(project.projectRoot, "public", "app.css"),
      "body { color: black; }\n@media (max-width: 600px) {}\n",
      "utf8"
    );
    await writeFile(
      path.join(project.projectRoot, "public", "index.html"),
      "<!doctype html><link rel=\"stylesheet\" href=\"app.css\"><h1>Status REAL-ACCEPT</h1><button data-filter=\"status\">Filter</button><script src=\"//example.com/app.js\"></script><script src=\"app.js\"></script>\n",
      "utf8"
    );
    await assert.rejects(
      execFileAsync(process.execPath, ["--test", "test/acceptance.test.mjs"], {
        cwd: project.projectRoot,
        env: childEnvironment
      })
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("fixture setup removes its allocated project when Git initialization fails", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "forgeos-real-rollback-"));
  const fakeBin = path.join(temporaryRoot, "fake-bin");
  await mkdir(fakeBin);
  const fakeGit = path.join(fakeBin, "git");
  await writeFile(fakeGit, "#!/bin/sh\nexit 1\n", "utf8");
  await chmod(fakeGit, 0o755);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = fakeBin;
    await assert.rejects(
      createStaticWebProject({ temporaryRoot, requirements: requirements("REAL-ROLLBACK") })
    );
    assert.deepEqual(
      (await readdir(temporaryRoot)).filter((entry) => entry.startsWith("real-project-")),
      []
    );
  } finally {
    process.env.PATH = originalPath;
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
  return { temporaryRoot, project, builderRoot, artifact, candidate };
}

test("authoritative workspace accounting accepts tracked regular-file deletion", async () => {
  const value = await previewFixture();
  try {
    await unlink(path.join(value.builderRoot, "public", "index.html"));
    assert.equal(
      await authoritativeChangedFileSize(value.builderRoot, "public/index.html"),
      0
    );
  } finally {
    await rm(value.temporaryRoot, { recursive: true, force: true });
  }
});

test("candidate preview removes its container when source copying fails", async () => {
  const value = await previewFixture();
  const source = path.join(value.project.projectRoot, "public", "index.html");
  try {
    const before = (await readdir(value.temporaryRoot)).filter((entry) =>
      entry.startsWith("candidate-preview-")
    );
    await chmod(source, 0o000);
    await assert.rejects(
      materializeCandidatePreview({
        artifact: value.artifact,
        candidate: value.candidate,
        originalRoot: value.project.projectRoot,
        temporaryRoot: await realpath(value.temporaryRoot)
      })
    );
    const after = (await readdir(value.temporaryRoot)).filter((entry) =>
      entry.startsWith("candidate-preview-")
    );
    assert.deepEqual(after, before);
  } finally {
    await chmod(source, 0o644).catch(() => undefined);
    await rm(value.temporaryRoot, { recursive: true, force: true });
  }
});

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
