import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createDemoProject } from "../../scripts/create-demo-project.mjs";
import {
  abbreviate,
  candidateSummaryLines,
  coordinatorPlanLines,
  formatDuration,
  parseArguments,
  stage
} from "../../packages/cli/src/presentation.js";
import {
  nodeVersionCompatible,
  usableApiKey
} from "../../packages/cli/src/preflight.js";

const execFileAsync = promisify(execFile);

test("demo argument parsing keeps the primary path simple", () => {
  assert.deepEqual(parseArguments(["demo"]), {
    command: "demo",
    deny: false,
    json: false,
    keepProject: false,
    verbose: false
  });
  assert.deepEqual(parseArguments(["demo", "--deny", "--keep-project"]), {
    command: "demo",
    deny: true,
    json: false,
    keepProject: true,
    verbose: false
  });
  assert.throws(() => parseArguments(["check", "--verbose"]), /does not accept options/u);
  assert.throws(() => parseArguments(["unknown"]), /Unknown ForgeOS Lite command/u);
});

test("presentation helpers produce concise public evidence", () => {
  assert.equal(abbreviate("1234567890abcdef"), "1234567890ab");
  assert.equal(formatDuration(1500), "1.5 s");
  assert.equal(stage("MISSION COMPLETE"), "\n=== MISSION COMPLETE ===");
  const planLines = coordinatorPlanLines({
    objective: "Update a greeting.",
    expectedScope: ["src/greeting.js"],
    validationPolicyIds: ["npm-run-build", "npm-test"],
    steps: [
      { actor: "builder", summary: "Run the declared transformation." },
      { actor: "reviewer", summary: "Review evidence." }
    ]
  });
  assert.match(planLines.join("\n"), /Files in scope: src\/greeting\.js/u);
  assert.doesNotMatch(planLines.join("\n"), /schemaVersion/u);

  const candidateLines = candidateSummaryLines({
    candidateId: "candidate-demo",
    candidateSha256: "a".repeat(64),
    baseRevision: "b".repeat(40),
    affectedFiles: ["src/greeting.js"],
    reviewerVerdict: { decision: "approved" },
    validationSummary: [{ policyId: "npm-test", success: true }],
    originalUnchanged: true
  });
  assert.match(candidateLines.join("\n"), /Original project: unchanged/u);
});

test("preflight helpers reject unsafe or unsupported values", () => {
  assert.equal(nodeVersionCompatible("22.23.2"), true);
  assert.equal(nodeVersionCompatible("23.0.0"), false);
  assert.equal(usableApiKey("x".repeat(20)), true);
  assert.equal(usableApiKey("short"), false);
  assert.equal(usableApiKey(`${"x".repeat(20)}\n`), false);
});

test("fixture generator creates a clean, disposable Git project", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "forgeos-demo-test-")));
  try {
    const fixture = await createDemoProject(root);
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.projectRoot,
      encoding: "utf8"
    });
    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: fixture.projectRoot, encoding: "utf8" }
    );
    assert.equal(head.trim(), fixture.baseRevision);
    assert.equal(status, "");
    assert.equal(
      await readFile(path.join(fixture.projectRoot, "src/greeting.js"), "utf8"),
      fixture.originalGreeting
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
