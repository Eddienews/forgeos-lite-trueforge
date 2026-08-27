import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEMO_MISSION_TEXT } from "../../packages/cli/src/demo.js";
import { validationFailureUpdate } from "../../packages/cli/src/real-project-demo.js";
import {
  applyWorkflowUpdate,
  createControlServer
} from "../../packages/control/src/index.js";

function candidateUpdate() {
  return {
    type: "candidate_ready",
    value: {
      missionId: "mission-control",
      outcome: "Updated the application greeting successfully.",
      plan: {
        objective: DEMO_MISSION_TEXT,
        scope: ["src/greeting.js"],
        builderActions: ["Run the declared controlled Builder transformation."],
        validationPolicies: ["npm-run-build", "npm-test"],
        reviewerCriteria: "Scope and evidence must match."
      },
      validation: [
        { policyId: "npm-run-build", success: true, durationMs: 1200 },
        { policyId: "npm-test", success: true, durationMs: 1500 }
      ],
      reviewer: { decision: "approved" },
      candidate: {
        id: "candidate-control",
        sha256: "a".repeat(64),
        baseRevision: "b".repeat(40),
        affectedFiles: ["src/greeting.js"]
      },
      changes: [
        {
          path: "src/greeting.js",
          operation: "modify",
          before: 'export const greeting = "Before.";\n',
          after: 'export const greeting = "After.";\n'
        }
      ],
      preview: {
        url: "http://127.0.0.1:43123/",
        candidateSha256: "a".repeat(64),
        sandbox: "allow-scripts",
        source: "sealed CandidatePatch materialization"
      },
      timeline: [
        {
          eventType: "mission.milestone",
          summary: "Coordinator plan is ready.",
          timestamp: "2026-01-01T00:00:00.000Z"
        }
      ],
      originalUnchanged: true
    }
  };
}

test("Control frontend preserves its authority-first visual contract", async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL("../../packages/control/public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../packages/control/public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../packages/control/public/app.css", import.meta.url), "utf8")
  ]);

  assert.match(html, /Agents can propose\. Humans authorize irreversible changes\./u);
  assert.match(app, /HUMAN AUTHORITY/u);
  assert.match(app, /Approval submitted to TrueForge/u);
  assert.match(app, /View Rejected Changes/u);
  assert.match(app, /No candidate was made available for application\./u);
  assert.match(app, /state\.status === "approval_required"/u);
  assert.match(app, /\["preview", "Preview"\]/u);
  assert.match(app, /sandbox="allow-scripts"/u);
  assert.doesNotMatch(app, /allow-same-origin/u);
  assert.match(app, /Running from the isolated candidate\./u);
  assert.doesNotMatch(app, /67%/u);
  assert.match(css, /width: min\(960px, 100%\)/u);
  assert.match(css, /font-size: 15px;\n  line-height: 1\.75/u);
});

async function waitForState(url, predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/state`);
    const state = await response.json();
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("ForgeOS Control test state did not arrive.");
}

async function post(url, path, token, value) {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forgeos-control-token": token
    },
    body: JSON.stringify(value)
  });
}

test("result view model keeps outcome primary and technical identity secondary", () => {
  const initial = {
    revision: 1,
    status: "running",
    headerStatus: "Running",
    project: { name: "greeting-project", branch: "main", clean: true, type: "Node.js" },
    mission: { suggested: DEMO_MISSION_TEXT, submitted: DEMO_MISSION_TEXT },
    stages: [],
    latestOutcome: null,
    safety: { state: "unchanged", message: "Original unchanged." },
    plan: null,
    validation: [],
    reviewer: null,
    result: null,
    changes: [],
    approval: { state: "unavailable", canApply: false, canReject: false },
    application: null,
    timeline: [],
    evidence: {},
    failure: null,
    cleanup: null,
    tabsAvailable: false
  };
  const candidate = applyWorkflowUpdate(initial, candidateUpdate());
  assert.equal(candidate.status, "candidate_ready");
  assert.equal(candidate.result.heading, "Mission ready for review");
  assert.equal(candidate.result.fileCount, 1);
  assert.equal(candidate.safety.message, "Your original project is still unchanged.");
  assert.equal(candidate.approval.canApply, false);
  assert.equal(candidate.evidence.missionId, "mission-control");
  assert.equal(candidate.evidence.candidateId, "candidate-control");
  assert.equal(candidate.preview.url, "http://127.0.0.1:43123/");

  const gated = applyWorkflowUpdate(candidate, {
    type: "approval_required",
    value: { eventType: "tool.approval_required" }
  });
  assert.equal(gated.status, "approval_required");
  assert.equal(gated.approval.canApply, true);
  assert.match(gated.safety.message, /Nothing irreversible happens until you decide/u);
});

test("bounded Builder validation exhaustion publishes a validation-specific failure", () => {
  const update = validationFailureUpdate(
    {
      validationSummary: [
        {
          policyId: "npm-test",
          success: false,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z"
        }
      ]
    },
    true
  );
  const failed = applyWorkflowUpdate(
    {
      revision: 1,
      status: "running",
      headerStatus: "Running",
      project: { name: "greeting-project", branch: "main", clean: true, type: "Node.js" },
      mission: { suggested: DEMO_MISSION_TEXT, submitted: DEMO_MISSION_TEXT },
      stages: [],
      latestOutcome: null,
      safety: { state: "unchanged", message: "Original unchanged." },
      plan: null,
      validation: [],
      reviewer: null,
      result: null,
      changes: [],
      approval: { state: "unavailable", canApply: false, canReject: false },
      application: null,
      timeline: [],
      evidence: {},
      failure: null,
      cleanup: null,
      tabsAvailable: false
    },
    update
  );
  assert.equal(failed.status, "validation_failed");
  assert.equal(failed.validation[0].policyId, "npm-test");
  assert.equal(failed.safety.message, "Your original project remains unchanged.");
});

test("local control server requires its token and routes allow and deny through the decision provider", async () => {
  const decisions = [];
  const runner = async ({ onUpdate, decisionProvider }) => {
    await onUpdate({ type: "mission_received", value: { mission: DEMO_MISSION_TEXT } });
    await onUpdate({
      type: "autonomous_work_running",
      value: { outcome: "ForgeOS is working in an isolated TrueForge workspace." }
    });
    await onUpdate(candidateUpdate());
    await onUpdate({
      type: "approval_required",
      value: { eventType: "tool.approval_required" }
    });
    const decision = await decisionProvider();
    decisions.push(decision);
    if (decision === "deny") {
      await onUpdate({
        type: "denied",
        value: { originalUnchanged: true, eventCannotBeReused: true }
      });
    } else {
      await onUpdate({ type: "applying", value: { candidateId: "candidate-control" } });
      await onUpdate({
        type: "applied",
        value: {
          outcome: "Updated the application greeting successfully.",
          appliedFiles: ["src/greeting.js"],
          gitHeadUnchanged: true,
          commitCreated: false,
          pushPerformed: false,
          approvalConsumed: true
        }
      });
    }
    await onUpdate({
      type: "cleanup_completed",
      value: { status: "completed", durationMs: 2000 }
    });
  };
  const control = createControlServer({
    port: 0,
    runner,
    controlToken: "control-test-token"
  });
  const url = await control.listen();
  try {
    const unauthorized = await fetch(`${url}/api/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission: DEMO_MISSION_TEXT })
    });
    assert.equal(unauthorized.status, 403);

    const prematureApproval = await post(
      url,
      "/api/approval",
      "control-test-token",
      { decision: "allow" }
    );
    assert.equal(prematureApproval.status, 409);

    const started = await post(url, "/api/missions", "control-test-token", {
      mission: DEMO_MISSION_TEXT
    });
    assert.equal(started.status, 202);
    let state = await waitForState(url, (value) => value.status === "approval_required");
    assert.equal(state.approval.canApply, true);
    assert.equal(JSON.stringify(state).includes("OPENAI_API_KEY"), false);

    const allowed = await post(url, "/api/approval", "control-test-token", {
      decision: "allow"
    });
    assert.equal(allowed.status, 202);
    state = await waitForState(url, (value) => value.status === "complete");
    assert.equal(state.application.approvalConsumed, true);
    assert.equal(state.application.commitCreated, false);
    assert.equal(state.project.clean, false);

    await waitForState(url, (value) => value.cleanup?.status === "completed");
    const reset = await post(url, "/api/reset", "control-test-token", {});
    assert.equal(reset.status, 200);

    const second = await post(url, "/api/missions", "control-test-token", {
      mission: DEMO_MISSION_TEXT
    });
    assert.equal(second.status, 202);
    await waitForState(url, (value) => value.status === "approval_required");
    const denied = await post(url, "/api/approval", "control-test-token", {
      decision: "deny"
    });
    assert.equal(denied.status, 202);
    state = await waitForState(url, (value) => value.status === "denied");
    assert.equal(state.safety.message, "Your project was not modified.");
    assert.equal(state.approval.canApply, false);
    assert.deepEqual(decisions, ["allow", "deny"]);
  } finally {
    await control.close();
  }
});

test("control server refuses non-loopback binding", () => {
  assert.throws(
    () => createControlServer({ host: "0.0.0.0", port: 4173 }),
    /must bind to 127\.0\.0\.1/u
  );
});

test("control retains cleanup authority until cleanup succeeds", async () => {
  let cleanupAttempts = 0;
  const runner = async ({ onUpdate }) => {
    await onUpdate({
      type: "mission_failed",
      value: {
        failure: { code: "blocked", stage: "runtime", summary: "Controlled test failure." },
        validationSummary: [],
        originalUnchanged: true
      }
    });
    return {
      retainedCleanup: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error("Transient cleanup failure.");
      }
    };
  };
  const control = createControlServer({
    port: 0,
    runner,
    controlToken: "cleanup-retry-token"
  });
  const url = await control.listen();
  try {
    const started = await post(url, "/api/missions", "cleanup-retry-token", {
      mission: DEMO_MISSION_TEXT
    });
    assert.equal(started.status, 202);
    await waitForState(url, (value) => value.status === "runtime_failed");
    const firstReset = await post(url, "/api/reset", "cleanup-retry-token", {});
    assert.equal(firstReset.status, 500);
    const secondReset = await post(url, "/api/reset", "cleanup-retry-token", {});
    assert.equal(secondReset.status, 200);
    assert.equal(cleanupAttempts, 2);
  } finally {
    await control.close();
  }
});
