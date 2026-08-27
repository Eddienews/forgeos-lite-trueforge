import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { originalProjectSnapshot } from "@forgeos-lite/candidate-patch";
import {
  createCandidateApplicationRegistry,
  createHumanApprovalRecord,
  startLoopbackMcpServer,
  trueForgeApprovalConfiguration
} from "@forgeos-lite/mcp-server";
import { createMissionOrchestrator } from "@forgeos-lite/orchestrator";
import { createTrueForgeHttpDriver } from "@forgeos-lite/runtime-trueforge";

import { createDemoProject } from "../../../scripts/create-demo-project.mjs";
import {
  abbreviate,
  candidateSummaryLines,
  coordinatorPlanLines,
  formatDuration,
  stage
} from "./presentation.js";
import { runPreflight } from "./preflight.js";
import { startLocalTrueForge } from "./trueforge-local.js";

const execFileAsync = promisify(execFile);
const connectorName = "forgeos-lite-demo-approval";
export const DEMO_MISSION_TEXT =
  "Update the greeting returned by the application and keep all tests passing.";
const expectedGreeting = 'export const greeting = "Hello from the TrueForge sandbox.";\n';

async function publishUpdate(options, type, value = {}) {
  if (typeof options.onUpdate !== "function") return;
  try {
    await options.onUpdate(Object.freeze({ type, value: structuredClone(value) }));
  } catch {
    // Presentation observers cannot influence mission authority or cleanup.
  }
}

async function git(root, ...args) {
  return execFileAsync("git", args, { cwd: root, encoding: "utf8" });
}

export async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

export async function api(baseUrl, pathname, options = {}) {
  const { allowNotFound = false, timeoutMs = 30_000, ...fetchOptions } = options;
  const response = await fetch(new URL(pathname, baseUrl), {
    ...fetchOptions,
    headers: { "content-type": "application/json", ...fetchOptions.headers },
    signal: fetchOptions.signal ?? AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let body = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`TrueForge API ${response.status} at ${pathname}.`);
  }
  return body?.data ?? body;
}

export function pollingRequestTimeout(deadline, now = Date.now()) {
  if (!Number.isFinite(deadline) || !Number.isFinite(now) || now >= deadline) return 1;
  return Math.max(1, Math.min(5000, deadline - now));
}

export async function waitForTurn(baseUrl, sessionId, turnId, options = {}) {
  const clock = options.clock ?? Date.now;
  const request = options.request ?? api;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = clock() + (options.deadlineMs ?? 120_000);
  while (clock() < deadline) {
    try {
      const turn = await request(
        baseUrl,
        `/api/v1/sessions/${sessionId}/turns/${turnId}`,
        { timeoutMs: pollingRequestTimeout(deadline, clock()) }
      );
      if (turn.state.status !== "running") return turn;
    } catch (error) {
      if (error?.name !== "TimeoutError" || clock() >= deadline) throw error;
    }
    await sleep(Math.min(200, Math.max(1, deadline - clock())));
  }
  throw new Error(`TrueForge turn did not finish in time: ${turnId}.`);
}

function demoProject(fixture) {
  return {
    projectId: "project-demo",
    projectRoot: fixture.projectRoot,
    projectName: "Greeting Demo",
    projectType: "node",
    commandPolicies: { install: null, build: "npm-run-build", test: "npm-test" },
    allowedEnvironmentKeys: ["CI", "TZ"]
  };
}

function demoMission() {
  return {
    missionId: "mission-demo",
    title: "Update the greeting",
    brief: DEMO_MISSION_TEXT,
    successCriteria: [
      "The greeting names the TrueForge sandbox.",
      "The declared build and test policies pass.",
      "Only src/greeting.js changes."
    ],
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
      projectPaths: ["src/greeting.js"]
    },
    expectedScope: ["src/greeting.js"],
    maximumChangedFiles: 1
  };
}

export function trackedDriver(baseUrl, workspaceRoots) {
  const driver = createTrueForgeHttpDriver({
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
  return {
    async createSession(input) {
      const result = await driver.createSession(input);
      workspaceRoots.add(result.workspaceRoot);
      return result;
    },
    execute(input) {
      return driver.execute(input);
    },
    closeSession(input) {
      return driver.closeSession(input);
    }
  };
}

export async function createApprovalSession(baseUrl, service) {
  await api(baseUrl, "/api/v1/settings/mcp-servers", {
    method: "PUT",
    body: JSON.stringify({
      manifest: {
        type: "remote",
        name: connectorName,
        url: service.url,
        description: "Local ForgeOS Lite approval-gated candidate application.",
        auth: {
          type: "header",
          headers: { Authorization: `Bearer ${service.authorizationToken}` }
        }
      }
    })
  });
  return api(baseUrl, "/api/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      agent: {
        spec: {
          model: {
            name: "openai/gpt-5-4-mini",
            params: { reasoning_effort: "low", parallel_tool_calls: false }
          },
          instructions: [
            "Call apply_candidate_patch exactly once with the contextId supplied by the user.",
            "Do not call any other tool and do not invent or alter arguments.",
            "After the tool result, report only whether it succeeded."
          ].join(" "),
          mcp_servers: [trueForgeApprovalConfiguration(connectorName)],
          config: {
            iteration_limit: 4,
            sandbox: { enabled: false, file_downloads: false },
            dynamic_sub_agents: { enabled: false },
            context_management: {
              compaction: { enabled: false },
              large_tool_response: { enabled: true }
            },
            generative_ui: { enabled: false },
            ask_user_questions: { enabled: false }
          }
        }
      }
    })
  });
}

export async function invokeApproval(baseUrl, sessionId, contextId) {
  const invoked = await api(baseUrl, `/api/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({
      input: [
        {
          type: "user.message",
          content: `Apply the sealed candidate using contextId ${contextId}.`
        }
      ],
      previous_turn_id: "none",
      stream: false
    })
  });
  const paused = await waitForTurn(baseUrl, sessionId, invoked.id);
  const approvalAction = paused.state.required_actions.find(
    ({ type }) => type === "tool.approval_required"
  );
  assert.ok(approvalAction, "TrueForge must emit tool.approval_required.");
  assert.equal(approvalAction.tool_calls.length, 1);
  return { paused, approvalAction, toolCall: approvalAction.tool_calls[0] };
}

export async function answerApproval(baseUrl, sessionId, paused, approvalAction, toolCall, status) {
  return api(baseUrl, `/api/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({
      input: [
        {
          type: "user.tool_approval",
          thread_id: approvalAction.thread_id,
          tool_call_id: toolCall.id,
          approval: { status }
        }
      ],
      previous_turn_id: paused.id,
      stream: false
    })
  });
}

export async function promptForDecision(deny, decisionProvider) {
  if (deny) return "deny";
  if (decisionProvider !== undefined) {
    if (typeof decisionProvider !== "function") {
      throw new Error("The approval decision provider must be a function.");
    }
    const decision = await decisionProvider();
    if (decision !== "allow" && decision !== "deny") {
      throw new Error("The approval decision must be allow or deny.");
    }
    return decision;
  }
  if (!process.stdin.isTTY) {
    throw new Error("Interactive approval requires a terminal. Run npm run demo in a terminal.");
  }
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await input.question("Type APPROVE to apply or DENY to reject: ");
    if (answer.trim().toUpperCase() === "APPROVE") return "allow";
    if (answer.trim().toUpperCase() === "DENY") return "deny";
    throw new Error("Approval was not granted. Enter exactly APPROVE or DENY.");
  } finally {
    input.close();
  }
}

export async function removeDemoSandboxes(sandboxRoot, workspaceRoots) {
  for (const workspace of workspaceRoots) {
    const relative = path.relative(sandboxRoot, workspace);
    const [topLevel] = relative.split(path.sep);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || !topLevel) {
      continue;
    }
    const target = path.join(sandboxRoot, topLevel);
    if (path.dirname(target) === sandboxRoot) {
      await rm(target, { recursive: true, force: true });
    }
  }
}

function safeMessage(error) {
  return error instanceof Error ? error.message.slice(0, 4096) : "unknown failure";
}

export function assertDeniedTurnOutcome(turn, events, toolCallId) {
  assert.equal(turn.state.status, "done", "TrueForge must complete the denial turn.");
  assert.deepEqual(
    turn.state.required_actions,
    [],
    "TrueForge denial must leave no pending approval action."
  );
  const successfulResponse = events.find(
    (event) =>
      event.type === "tool.response" &&
      event.tool_call_id === toolCallId &&
      /"success":true/u.test(event.content ?? "")
  );
  assert.equal(successfulResponse, undefined, "A denied tool call must not report application success.");
}

export async function runCleanupSteps(steps) {
  const failures = [];
  for (const [label, action] of steps) {
    try {
      await action();
    } catch (error) {
      failures.push(`${label}: ${safeMessage(error)}`);
    }
  }
  return failures;
}

function printLines(lines) {
  for (const line of lines) console.log(line);
}

async function publicCandidateChanges(pending) {
  const changes = [];
  for (const operation of pending.artifact.operations) {
    const target = path.join(pending.projectRoot, ...operation.path.split("/"));
    changes.push({
      path: operation.path,
      operation: operation.operation,
      before:
        operation.operation === "add" ? null : await readFile(target, "utf8"),
      after: operation.operation === "delete" ? null : operation.content
    });
  }
  return changes;
}

export async function runDemo(options) {
  const startedAt = performance.now();
  const preflight = await runPreflight({
    repositoryRoot: options.repositoryRoot,
    requireCleanRepository: options.requireCleanRepository
  });
  const demoRoot = await realpath(
    await mkdtemp(path.join(preflight.temporaryRoot, "demo-project-"))
  );
  const workspaceRoots = new Set();
  let fixture;
  let trueForge;
  let mcpService;
  let approvalSessionId;
  let connectorConfigured = false;
  let primaryError = null;
  let cleanupFailures = [];
  const result = {
    model: "gpt-5.4-mini",
    trueForgeVersion: preflight.trueForgeVersion,
    decision: options.deny ? "denied" : "pending",
    projectRoot: null,
    candidateId: null,
    candidateSha256: null,
    approvalEvent: null,
    denialEventCannotBeReused: false,
    originalUnchangedBeforeApproval: false,
    appliedFiles: [],
    approvalConsumed: false,
    gitHeadUnchanged: false,
    automaticCommitOrPush: false,
    cleanup: "pending",
    durationMs: null
  };
  try {
    fixture = await createDemoProject(demoRoot);
    result.projectRoot = fixture.projectRoot;
    await publishUpdate(options, "project_connected", {
      project: { name: "greeting-project", branch: "main", clean: true, type: "Node.js" },
      baseRevision: fixture.baseRevision
    });
    console.log(stage("PROJECT CONNECTED"));
    console.log(`Disposable Git project: ${fixture.projectRoot}`);
    console.log(`Baseline revision: ${abbreviate(fixture.baseRevision)}`);

    console.log(stage("MISSION RECEIVED"));
    console.log(DEMO_MISSION_TEXT);
    await publishUpdate(options, "mission_received", { mission: DEMO_MISSION_TEXT });

    trueForge = await startLocalTrueForge({
      apiKey: process.env.OPENAI_API_KEY,
      binary: preflight.trueForgeBinary,
      port: await unusedPort(),
      temporaryRoot: preflight.temporaryRoot,
      verbose: options.verbose
    });
    const orchestrator = await createMissionOrchestrator({
      driver: trackedDriver(trueForge.baseUrl, workspaceRoots),
      trustedWorkspaceRoot: preflight.sandboxRoot,
      executionTimeoutMs: 120_000
    });
    await publishUpdate(options, "autonomous_work_running", {
      outcome: "ForgeOS is working in an isolated TrueForge workspace."
    });
    const summary = await orchestrator.runMission({
      project: demoProject(fixture),
      mission: demoMission()
    });
    if (summary.status !== "awaiting_approval") {
      await publishUpdate(options, "mission_failed", {
        failure: summary.failure,
        originalUnchanged: summary.originalUnchanged,
        validationSummary: summary.validationSummary
      });
      throw new Error(
        `Mission stopped at ${summary.failure?.stage ?? summary.status}: ${summary.failure?.summary ?? "unknown failure"}`
      );
    }

    console.log(stage("COORDINATOR PLAN"));
    printLines(coordinatorPlanLines(summary.plan));
    console.log(stage("BUILDER WORKSPACE CREATED"));
    console.log("Isolated TrueForge sandbox confirmed.");
    console.log(stage("TRUEFORGE BUILDER RUNNING"));
    console.log("TrueForge session established; declared commands ran only in the isolated workspace.");
    console.log(stage("VALIDATION PASSED"));
    printLines(
      summary.validationSummary.map(
        (entry) => `${entry.policyId}: passed (${formatDuration(Date.parse(entry.completedAt) - Date.parse(entry.startedAt))})`
      )
    );
    console.log(stage("REVIEWER APPROVED"));
    console.log(summary.reviewerVerdict.decision);
    console.log(stage("CANDIDATE PATCH READY"));
    printLines(candidateSummaryLines(summary));
    console.log("Original project unchanged.");
    console.log("Human approval required before application.");

    const pending = orchestrator.getPendingApplicationContext("mission-demo");
    result.candidateId = pending.candidate.candidateId;
    result.candidateSha256 = pending.candidate.patchSha256;
    await publishUpdate(options, "candidate_ready", {
      outcome: "Updated the application greeting successfully.",
      plan: {
        objective: summary.plan.objective,
        scope: summary.plan.expectedScope,
        builderActions: summary.plan.steps
          .filter((entry) => entry.actor === "builder")
          .map((entry) => entry.summary),
        validationPolicies: summary.plan.validationPolicyIds,
        reviewerCriteria:
          "Scope, candidate identity, Builder proof, and validation evidence must match."
      },
      validation: summary.validationSummary.map((entry) => ({
        policyId: entry.policyId,
        success: entry.success,
        durationMs: Date.parse(entry.completedAt) - Date.parse(entry.startedAt)
      })),
      reviewer: { decision: summary.reviewerVerdict.decision },
      candidate: {
        id: pending.candidate.candidateId,
        sha256: pending.candidate.patchSha256,
        baseRevision: pending.candidate.baseRevision,
        affectedFiles: pending.candidate.affectedFiles
      },
      changes: await publicCandidateChanges(pending),
      timeline: summary.timeline,
      originalUnchanged: summary.originalUnchanged
    });
    const beforeApproval = await originalProjectSnapshot(fixture.projectRoot);
    assert.equal(summary.originalUnchanged, true);
    assert.deepEqual(beforeApproval, await originalProjectSnapshot(fixture.projectRoot));
    result.originalUnchangedBeforeApproval = true;

    const registry = createCandidateApplicationRegistry();
    const contextId = `demo-${randomUUID()}`;
    registry.registerContext({
      contextId,
      candidate: pending.candidate,
      artifact: pending.artifact,
      projectRoot: pending.projectRoot
    });
    const authorizationToken = randomUUID();
    const startedService = await startLoopbackMcpServer({
      registry,
      port: await unusedPort(),
      authorizationToken
    });
    mcpService = Object.freeze({ ...startedService, authorizationToken });
    const approvalSession = await createApprovalSession(trueForge.baseUrl, mcpService);
    connectorConfigured = true;
    approvalSessionId = approvalSession.id;
    const approval = await invokeApproval(trueForge.baseUrl, approvalSession.id, contextId);
    result.approvalEvent = approval.approvalAction.type;
    assert.deepEqual(await originalProjectSnapshot(fixture.projectRoot), beforeApproval);
    await publishUpdate(options, "approval_required", {
      eventType: approval.approvalAction.type
    });

    console.log(stage("AWAITING HUMAN APPROVAL"));
    console.log("TrueForge event: tool.approval_required");
    console.log("TrueForge paused before the irreversible action.");
    console.log("Original project unchanged.");
    console.log("Approve candidate application?");
    const decision = await promptForDecision(options.deny, options.decisionProvider);
    await publishUpdate(options, "human_decision_submitted", { decision });

    if (decision === "deny") {
      const denied = await answerApproval(
        trueForge.baseUrl,
        approvalSession.id,
        approval.paused,
        approval.approvalAction,
        approval.toolCall,
        "deny"
      );
      const deniedCompleted = await waitForTurn(
        trueForge.baseUrl,
        approvalSession.id,
        denied.id
      );
      const deniedEvents = await api(
        trueForge.baseUrl,
        `/api/v1/sessions/${approvalSession.id}/turns/${deniedCompleted.id}/events?limit=100&order=asc`
      );
      assertDeniedTurnOutcome(deniedCompleted, deniedEvents, approval.toolCall.id);
      let reuseRejected = false;
      try {
        const replay = await answerApproval(
          trueForge.baseUrl,
          approvalSession.id,
          approval.paused,
          approval.approvalAction,
          approval.toolCall,
          "allow"
        );
        await waitForTurn(trueForge.baseUrl, approvalSession.id, replay.id);
      } catch {
        reuseRejected = true;
      }
      assert.deepEqual(await originalProjectSnapshot(fixture.projectRoot), beforeApproval);
      assert.equal(registry.contextSnapshot(contextId).applied, false);
      result.decision = "denied";
      result.denialEventCannotBeReused = true;
      result.gitHeadUnchanged = true;
      await publishUpdate(options, "denied", {
        originalUnchanged: true,
        eventCannotBeReused: true
      });
      console.log(stage("HUMAN DENIED"));
      console.log("Patch not applied; project unchanged.");
      console.log(
        reuseRejected
          ? "The denied approval event could not be replayed as an allow."
          : "A later allow could not apply because no human ApprovalRecord existed."
      );
    } else {
      const approvalRecord = createHumanApprovalRecord({
        approvalId: `approval-${randomUUID()}`,
        actorId: "demo-human",
        approvalContext: {
          mechanism: "trueforge.tool_approval",
          sessionId: approvalSession.id,
          threadId: approval.approvalAction.thread_id,
          toolCallId: approval.toolCall.id,
          approvalEventId: approval.approvalAction.id
        },
        candidate: pending.candidate,
        createdAt: new Date().toISOString()
      });
      registry.recordHumanApproval({ contextId, approvalRecord });
      const resumed = await answerApproval(
        trueForge.baseUrl,
        approvalSession.id,
        approval.paused,
        approval.approvalAction,
        approval.toolCall,
        "allow"
      );
      registry.confirmHumanApproval({
        contextId,
        approvalContext: approvalRecord.approvalContext
      });
      await publishUpdate(options, "applying", {
        candidateId: pending.candidate.candidateId
      });
      console.log(stage("HUMAN APPROVED"));
      console.log("TrueForge accepted user.tool_approval: allow.");
      const completed = await waitForTurn(trueForge.baseUrl, approvalSession.id, resumed.id);
      assert.equal(completed.state.status, "done");
      const events = await api(
        trueForge.baseUrl,
        `/api/v1/sessions/${approvalSession.id}/turns/${completed.id}/events?limit=100&order=asc`
      );
      const toolResponse = events.find(({ type }) => type === "tool.response");
      assert.ok(toolResponse, "TrueForge must return the controlled MCP tool result.");
      assert.match(toolResponse.content, /"success":true/u);
      const source = await readFile(path.join(fixture.projectRoot, "src/greeting.js"), "utf8");
      assert.equal(source, expectedGreeting);
      const head = (await git(fixture.projectRoot, "rev-parse", "HEAD")).stdout.trim();
      assert.equal(head, fixture.baseRevision);
      const snapshot = registry.contextSnapshot(contextId);
      assert.equal(snapshot.applied, true);
      assert.equal(snapshot.attempted, true);
      result.decision = "approved";
      result.appliedFiles = ["src/greeting.js"];
      result.approvalConsumed = true;
      result.gitHeadUnchanged = true;
      await publishUpdate(options, "applied", {
        outcome: "Updated the application greeting successfully.",
        appliedFiles: ["src/greeting.js"],
        gitHeadUnchanged: true,
        commitCreated: false,
        pushPerformed: false,
        approvalConsumed: true
      });
      console.log(stage("PATCH APPLIED"));
      console.log("Applied files: src/greeting.js");
      console.log(`Git HEAD unchanged: ${abbreviate(head)}`);
      console.log("Working-tree diff: 1 file changed");
      console.log("Approval consumed: yes");
      console.log("No commit or push was created automatically.");
      console.log(stage("MISSION COMPLETE"));
      console.log('Exact result: greeting now returns "Hello from the TrueForge sandbox."');
    }
  } catch (error) {
    primaryError = error;
  } finally {
    cleanupFailures = await runCleanupSteps([
      ["TrueForge approval session", async () => {
        if (approvalSessionId !== undefined && trueForge !== undefined) {
          await api(trueForge.baseUrl, `/api/v1/sessions/${approvalSessionId}`, {
            method: "DELETE",
            allowNotFound: true
          });
        }
      }],
      ["TrueForge MCP connector", async () => {
        if (connectorConfigured && trueForge !== undefined) {
          await api(
            trueForge.baseUrl,
            `/api/v1/settings/mcp-servers/${encodeURIComponent(connectorName)}`,
            { method: "DELETE", allowNotFound: true }
          );
        }
      }],
      ["MCP server", async () => mcpService?.close()],
      ["TrueForge service", async () => trueForge?.close()],
      ["TrueForge demo sandboxes", async () => {
        await removeDemoSandboxes(preflight.sandboxRoot, workspaceRoots);
      }],
      ["disposable fixture", async () => {
        if (!options.keepProject) await rm(demoRoot, { recursive: true, force: true });
      }]
    ]);
    result.cleanup = cleanupFailures.length === 0 ? "completed" : "failed";
    result.durationMs = Math.round(performance.now() - startedAt);
    await publishUpdate(options, "cleanup_completed", {
      status: result.cleanup,
      durationMs: result.durationMs
    });
  }
  if (primaryError !== null) {
    if (cleanupFailures.length > 0) {
      throw new Error(
        `${safeMessage(primaryError)} Cleanup also failed: ${cleanupFailures.join("; ")}`,
        { cause: primaryError }
      );
    }
    throw primaryError;
  }
  if (cleanupFailures.length > 0) {
    throw new Error(`Demo completed, but cleanup failed: ${cleanupFailures.join("; ")}`);
  }
  console.log(stage("CLEAN SHUTDOWN"));
  console.log("TrueForge session, MCP server, connector, and temporary workspaces closed.");
  if (options.keepProject) console.log(`Disposable project retained: ${fixture.projectRoot}`);
  console.log(`Total runtime: ${formatDuration(result.durationMs)}`);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  return Object.freeze(result);
}
