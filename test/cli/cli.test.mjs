import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createDemoProject } from "../../scripts/create-demo-project.mjs";
import {
  assertDeniedTurnOutcome,
  pollingRequestTimeout,
  runCleanupSteps,
  waitForTurn
} from "../../packages/cli/src/demo.js";
import {
  abbreviate,
  candidateSummaryLines,
  coordinatorPlanLines,
  formatDuration,
  parseArguments,
  stage
} from "../../packages/cli/src/presentation.js";
import {
  ensurePrivateTemporaryRoot,
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
    reading: false,
    verbose: false
  });
  assert.deepEqual(parseArguments(["demo", "--deny", "--keep-project"]), {
    command: "demo",
    deny: true,
    json: false,
    keepProject: true,
    reading: false,
    verbose: false
  });
  assert.equal(parseArguments(["real", "--reading", "--deny"]).reading, true);
  assert.throws(() => parseArguments(["demo", "--reading"]), /only for the real-project/u);
  assert.throws(() => parseArguments(["check", "--verbose"]), /does not accept options/u);
  assert.throws(() => parseArguments(["unknown"]), /Unknown ForgeOS Lite command/u);
});

test("preflight hardens its current-user temporary root", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "forgeos-preflight-test-")));
  try {
    await chmod(root, 0o755);
    assert.equal((await stat(root)).mode & 0o777, 0o755);
    assert.equal(await ensurePrivateTemporaryRoot(root), root);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("denial outcome requires a completed turn without successful application", () => {
  const completed = { state: { status: "done", required_actions: [] } };
  assert.doesNotThrow(() => assertDeniedTurnOutcome(completed, [], "tool-call-1"));
  assert.throws(
    () =>
      assertDeniedTurnOutcome(
        { state: { status: "failed", required_actions: [] } },
        [],
        "tool-call-1"
      ),
    /complete the denial turn/u
  );
  assert.throws(
    () =>
      assertDeniedTurnOutcome(
        completed,
        [
          {
            type: "tool.response",
            tool_call_id: "tool-call-1",
            content: '{"success":true}'
          }
        ],
        "tool-call-1"
      ),
    /must not report application success/u
  );
});

test("cleanup attempts every step and reports each failure", async () => {
  const calls = [];
  const failures = await runCleanupSteps([
    ["first", async () => {
      calls.push("first");
      throw new Error("first failed");
    }],
    ["second", async () => {
      calls.push("second");
    }],
    ["third", async () => {
      calls.push("third");
      throw new Error("third failed");
    }]
  ]);
  assert.deepEqual(calls, ["first", "second", "third"]);
  assert.deepEqual(failures, ["first: first failed", "third: third failed"]);
});

test("turn polling bounds every request by the remaining deadline", async () => {
  let now = 100;
  const observedTimeouts = [];
  const turn = await waitForTurn("http://localhost:8790", "session-1", "turn-1", {
    clock: () => now,
    deadlineMs: 6000,
    request: async (_baseUrl, _pathname, options) => {
      observedTimeouts.push(options.timeoutMs);
      now += 1000;
      return {
        state: {
          status: observedTimeouts.length === 2 ? "done" : "running",
          required_actions: []
        }
      };
    },
    sleep: async () => {
      now += 200;
    }
  });
  assert.equal(turn.state.status, "done");
  assert.deepEqual(observedTimeouts, [5000, 4800]);
  assert.equal(pollingRequestTimeout(1000, 1000), 1);
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
    const { stdout: branch } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: fixture.projectRoot,
      encoding: "utf8"
    });
    assert.equal(branch.trim(), "main");
    assert.equal(
      await readFile(path.join(fixture.projectRoot, "src/greeting.js"), "utf8"),
      fixture.originalGreeting
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
