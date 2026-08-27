import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { originalProjectSnapshot } from "@forgeos-lite/candidate-patch";
import {
  createCandidateApplicationRegistry,
  createHumanApprovalRecord,
  startLoopbackMcpServer
} from "@forgeos-lite/mcp-server";
import {
  createBoundedCoordinatorPlan,
  createStaticWebProject,
  prepareRealProjectCandidate
} from "@forgeos-lite/real-project";

import {
  answerApproval,
  api,
  assertDeniedTurnOutcome,
  createApprovalSession,
  invokeApproval,
  promptForDecision,
  runCleanupSteps,
  trackedDriver,
  unusedPort,
  waitForTurn
} from "./demo.js";
import { abbreviate, formatDuration, stage } from "./presentation.js";
import { runPreflight } from "./preflight.js";
import { createOperationsDashboardSpec, createReadingListSpec } from "./real-project-spec.js";
import { startLocalTrueForge } from "./trueforge-local.js";

const execFileAsync = promisify(execFile);

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

function durationMs(evidence) {
  return Date.parse(evidence.completedAt) - Date.parse(evidence.startedAt);
}

export function validationFailureUpdate(iteration, originalUnchanged) {
  return Object.freeze({
    type: "mission_failed",
    value: Object.freeze({
      failure: Object.freeze({
        code: "validation_failed",
        stage: "validation",
        summary: "Fixed build or test validation failed after the bounded Builder repair limit."
      }),
      validationSummary: Object.freeze(
        iteration.validationSummary.map((entry) => Object.freeze({ ...entry }))
      ),
      originalUnchanged
    })
  });
}

function publicPlan(plan) {
  return {
    objective: plan.objective,
    scope: plan.writableScope,
    builderActions: plan.implementationTasks,
    validationPolicies: plan.validationPolicies,
    reviewerCriteria:
      "Exact mission, base, public-only diff, immutable requirements, candidate identity, and bound validation evidence must match."
  };
}

async function previewAssets(previewUrl) {
  const results = {};
  for (const relativePath of ["", "app.css", "app.js"]) {
    const response = await fetch(new URL(relativePath, previewUrl), {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Candidate preview asset failed: ${relativePath || "index.html"}.`);
    results[relativePath || "index.html"] = await response.text();
  }
  return results;
}

function requiredValuesAppear(spec, candidate) {
  const content = candidate.artifact.operations.map((entry) => entry.content ?? "").join("\n");
  return spec.requirements.requiredText.every((value) => content.includes(value));
}

export async function runRealProjectDemo(options) {
  const startedAt = performance.now();
  const spec =
    options.spec ?? (options.reading ? createReadingListSpec() : createOperationsDashboardSpec());
  const preflight = await runPreflight({
    repositoryRoot: options.repositoryRoot,
    requireCleanRepository: options.requireCleanRepository ?? false
  });
  const fixture = await createStaticWebProject({
    temporaryRoot: preflight.temporaryRoot,
    requirements: spec.requirements
  });
  const workspaceRoots = new Set();
  const projectId = `project-${randomUUID()}`;
  const missionId = `mission-${randomUUID()}`;
  let trueForge;
  let prepared;
  let mcpService;
  let approvalSessionId;
  let connectorConfigured = false;
  let primaryError = null;
  let cleanupFailures = [];
  let retainProject = options.retainPreview === true;
  let latestBuilderIteration = null;
  const result = {
    kind: spec.kind,
    mission: spec.mission,
    uniqueValues: spec.uniqueValues,
    model: "gpt-5.4-mini",
    coordinatorModelCalls: 0,
    builderTurns: null,
    repairRequired: null,
    trueForgeVersion: preflight.trueForgeVersion,
    decision: options.deny ? "denied" : "pending",
    projectRoot: fixture.projectRoot,
    candidateId: null,
    candidateSha256: null,
    previewUrl: null,
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
    await publishUpdate(options, "project_connected", {
      project: {
        name: "operations-status-project",
        branch: "main",
        clean: true,
        type: "Node.js static web project"
      },
      baseRevision: fixture.baseRevision
    });
    console.log(stage("PROJECT CONNECTED"));
    console.log(`Fresh disposable Git project: ${fixture.projectRoot}`);
    console.log(`Baseline revision: ${abbreviate(fixture.baseRevision)}`);

    await publishUpdate(options, "mission_received", { mission: spec.mission });
    console.log(stage("MISSION RECEIVED"));
    console.log(spec.mission);

    const plan = createBoundedCoordinatorPlan({
      requirements: fixture.requirements,
      mission: spec.mission,
      baseRevision: fixture.baseRevision
    });
    console.log(stage("COORDINATOR PLAN"));
    console.log(`Objective: ${plan.objective}`);
    console.log(`Writable scope: ${plan.writableScope.join(", ")}`);
    console.log(`Implementation tasks: ${plan.implementationTasks.join(" ")}`);
    console.log(`Validation policies: ${plan.validationPolicies.join(", ")}`);

    trueForge = await startLocalTrueForge({
      apiKey: process.env.OPENAI_API_KEY,
      binary: preflight.trueForgeBinary,
      port: await unusedPort(),
      temporaryRoot: preflight.temporaryRoot,
      verbose: options.verbose
    });
    await publishUpdate(options, "autonomous_work_running", {
      outcome: "ForgeOS is working in an isolated TrueForge workspace."
    });
    prepared = await prepareRealProjectCandidate({
      driver: trackedDriver(trueForge.baseUrl, workspaceRoots),
      trueForgeBaseUrl: trueForge.baseUrl,
      sandboxRoot: preflight.sandboxRoot,
      temporaryRoot: preflight.temporaryRoot,
      controlOrigin: options.controlOrigin ?? "http://127.0.0.1:4173",
      fixture,
      projectId,
      missionId,
      mission: spec.mission,
      plan,
      onIteration: async (iteration) => {
        latestBuilderIteration = {
          passed: iteration.passed,
          validationSummary: iteration.validationEvidence.map((entry) => ({
            policyId: entry.command.policyId,
            success:
              entry.exitStatus === 0 && entry.runtimeError === null && entry.timedOut === false,
            startedAt: entry.startedAt,
            completedAt: entry.completedAt
          }))
        };
        if (!iteration.passed) {
          console.log(stage(iteration.repair ? "BUILDER REPAIR REQUIRED" : "VALIDATION REQUIRES REPAIR"));
          for (const entry of iteration.validationEvidence.filter(
            (value) => value.exitStatus !== 0 || value.runtimeError !== null || value.timedOut
          )) {
            console.log(`${entry.command.policyId}: failed`);
            console.log(
              `${entry.stdout}\n${entry.stderr}`
                .replaceAll(/\b(?:sk|sess|proj|org)-[A-Za-z0-9_-]+/gu, "[redacted]")
                .replaceAll(/(?:\/[A-Za-z0-9._ @+-]+){2,}/gu, "[workspace]")
                .slice(0, 2000)
            );
          }
        }
        await publishUpdate(options, "builder_iteration", {
          turnNumber: iteration.turnNumber,
          repair: iteration.repair,
          validation: iteration.validationEvidence.map((entry) => ({
            policyId: entry.command.policyId,
            success:
              entry.exitStatus === 0 && entry.runtimeError === null && entry.timedOut === false,
            durationMs: durationMs(entry)
          }))
        });
      }
    });
    result.builderTurns = prepared.builderTurns;
    result.repairRequired = prepared.repairRequired;
    result.candidateId = prepared.candidate.candidateId;
    result.candidateSha256 = prepared.candidate.patchSha256;
    result.previewUrl = prepared.preview.url;
    assert.ok(requiredValuesAppear(spec, prepared));
    const assets = await previewAssets(prepared.preview.url);
    assert.match(assets["index.html"], /app\.css/u);
    assert.match(assets["index.html"], /app\.js/u);

    console.log(stage("TRUEFORGE BUILDER COMPLETED"));
    console.log(`Builder turns: ${prepared.builderTurns}`);
    console.log(`Repair required: ${prepared.repairRequired ? "yes" : "no"}`);
    console.log(`Authoritative files: ${prepared.candidate.affectedFiles.join(", ")}`);
    console.log(stage("VALIDATION PASSED"));
    for (const evidence of prepared.validationEvidence) {
      console.log(`${evidence.command.policyId}: passed (${formatDuration(durationMs(evidence))})`);
    }
    console.log(stage("REVIEWER APPROVED"));
    console.log(prepared.reviewerVerdict.decision);
    console.log(stage("CANDIDATE PATCH READY"));
    console.log(`Candidate ID: ${prepared.candidate.candidateId}`);
    console.log(`Candidate hash: ${abbreviate(prepared.candidate.patchSha256)}`);
    console.log(`Files changed: ${prepared.candidate.affectedFiles.length}`);
    console.log("Original project unchanged.");
    console.log(stage("ISOLATED CANDIDATE PREVIEW"));
    console.log(`Preview: ${prepared.preview.url}`);
    console.log("Entry document, CSS, and JavaScript loaded from the sealed CandidatePatch preview.");
    console.log(`Runtime values verified: ${spec.requirements.runId}`);

    await publishUpdate(options, "candidate_ready", {
      outcome: spec.outcome,
      plan: publicPlan(plan),
      validation: prepared.validationEvidence.map((entry) => ({
        policyId: entry.command.policyId,
        success: true,
        durationMs: durationMs(entry)
      })),
      reviewer: { decision: prepared.reviewerVerdict.decision },
      candidate: {
        id: prepared.candidate.candidateId,
        sha256: prepared.candidate.patchSha256,
        baseRevision: prepared.candidate.baseRevision,
        affectedFiles: prepared.candidate.affectedFiles
      },
      changes: prepared.changes,
      timeline: prepared.timeline,
      preview: prepared.preview,
      runtime: {
        coordinatorModelCalls: prepared.coordinatorModelCalls,
        builderTurns: prepared.builderTurns,
        repairRequired: prepared.repairRequired,
        model: prepared.model
      },
      originalUnchanged: true
    });
    assert.deepEqual(await originalProjectSnapshot(fixture.projectRoot), prepared.originalBefore);
    result.originalUnchangedBeforeApproval = true;

    const registry = createCandidateApplicationRegistry();
    const contextId = `real-${randomUUID()}`;
    registry.registerContext({
      contextId,
      candidate: prepared.candidate,
      artifact: prepared.artifact,
      projectRoot: fixture.projectRoot
    });
    const authorizationToken = `${randomUUID()}${randomUUID()}`;
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
    assert.deepEqual(await originalProjectSnapshot(fixture.projectRoot), prepared.originalBefore);
    await publishUpdate(options, "approval_required", {
      eventType: approval.approvalAction.type
    });
    console.log(stage("AWAITING HUMAN APPROVAL"));
    console.log("TrueForge event: tool.approval_required");
    console.log("The preview is visible, and the original project is still unchanged.");
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
      const deniedCompleted = await waitForTurn(trueForge.baseUrl, approvalSession.id, denied.id);
      const deniedEvents = await api(
        trueForge.baseUrl,
        `/api/v1/sessions/${approvalSession.id}/turns/${deniedCompleted.id}/events?limit=100&order=asc`
      );
      assertDeniedTurnOutcome(deniedCompleted, deniedEvents, approval.toolCall.id);
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
        // A consumed denial event is expected to reject replay at the transport boundary.
      }
      assert.deepEqual(await originalProjectSnapshot(fixture.projectRoot), prepared.originalBefore);
      assert.equal(registry.contextSnapshot(contextId).applied, false);
      result.decision = "denied";
      result.denialEventCannotBeReused = true;
      result.gitHeadUnchanged = true;
      await publishUpdate(options, "denied", {
        originalUnchanged: true,
        eventCannotBeReused: true
      });
      console.log(stage("HUMAN DENIED"));
      console.log("Candidate closed; original project unchanged.");
    } else {
      const approvalRecord = createHumanApprovalRecord({
        approvalId: `approval-${randomUUID()}`,
        actorId: "control-human",
        approvalContext: {
          mechanism: "trueforge.tool_approval",
          sessionId: approvalSession.id,
          threadId: approval.approvalAction.thread_id,
          toolCallId: approval.toolCall.id,
          approvalEventId: approval.approvalAction.id
        },
        candidate: prepared.candidate,
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
      registry.confirmHumanApproval({ contextId, approvalContext: approvalRecord.approvalContext });
      await publishUpdate(options, "applying", { candidateId: prepared.candidate.candidateId });
      const completed = await waitForTurn(trueForge.baseUrl, approvalSession.id, resumed.id);
      assert.equal(completed.state.status, "done");
      const events = await api(
        trueForge.baseUrl,
        `/api/v1/sessions/${approvalSession.id}/turns/${completed.id}/events?limit=100&order=asc`
      );
      assert.ok(
        events.some((event) => event.type === "tool.response" && /"success":true/u.test(event.content ?? ""))
      );
      const snapshot = registry.contextSnapshot(contextId);
      assert.equal(snapshot.applied, true);
      const head = (await git(fixture.projectRoot, "rev-parse", "HEAD")).stdout.trim();
      assert.equal(head, fixture.baseRevision);
      for (const operation of prepared.artifact.operations) {
        if (operation.operation === "delete") continue;
        assert.equal(
          await readFile(path.join(fixture.projectRoot, ...operation.path.split("/")), "utf8"),
          operation.content
        );
      }
      result.decision = "approved";
      result.appliedFiles = prepared.candidate.affectedFiles;
      result.approvalConsumed = true;
      result.gitHeadUnchanged = true;
      await publishUpdate(options, "applied", {
        outcome: spec.outcome,
        appliedFiles: prepared.candidate.affectedFiles,
        gitHeadUnchanged: true,
        commitCreated: false,
        pushPerformed: false,
        approvalConsumed: true
      });
      console.log(stage("PATCH APPLIED"));
      console.log(`Applied files: ${prepared.candidate.affectedFiles.join(", ")}`);
      console.log(`Git HEAD unchanged: ${abbreviate(head)}`);
      console.log("Approval consumed: yes");
      console.log("No commit or push was created automatically.");
      console.log(stage("MISSION COMPLETE"));
      console.log(spec.outcome);
    }
  } catch (error) {
    primaryError = error;
    if (
      latestBuilderIteration?.passed === false &&
      error instanceof Error &&
      error.message.startsWith("Validation failed after the hard limit")
    ) {
      let originalUnchanged = false;
      try {
        const status = await git(
          fixture.projectRoot,
          "status",
          "--porcelain=v1",
          "--untracked-files=all"
        );
        const head = await git(fixture.projectRoot, "rev-parse", "HEAD");
        originalUnchanged = status.stdout === "" && head.stdout.trim() === fixture.baseRevision;
      } catch {
        // Failure presentation cannot replace the primary mission error.
      }
      const failureUpdate = validationFailureUpdate(latestBuilderIteration, originalUnchanged);
      await publishUpdate(options, failureUpdate.type, failureUpdate.value);
    }
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
      ["TrueForge approval connector", async () => {
        if (connectorConfigured && trueForge !== undefined) {
          await api(
            trueForge.baseUrl,
            "/api/v1/settings/mcp-servers/forgeos-lite-demo-approval",
            { method: "DELETE", allowNotFound: true }
          );
        }
      }],
      ["approval MCP server", async () => mcpService?.close()],
      ["TrueForge service", async () => trueForge?.close()],
      ["candidate preview", async () => {
        if (!options.retainPreview) await prepared?.closePreview();
      }],
      ["disposable project", async () => {
        if (!options.keepProject && !retainProject) {
          await rm(fixture.temporaryRoot, { recursive: true, force: true });
        }
      }]
    ]);
    result.cleanup = cleanupFailures.length === 0 ? "completed" : "failed";
    result.durationMs = Math.round(performance.now() - startedAt);
    await publishUpdate(options, "cleanup_completed", {
      status: result.cleanup,
      durationMs: result.durationMs
    });
  }
  const releaseRetainedResources = async () => {
    const failures = await runCleanupSteps([
      ["candidate preview", async () => prepared?.closePreview()],
      ["disposable project", async () => rm(fixture.temporaryRoot, { recursive: true, force: true })]
    ]);
    if (failures.length > 0) {
      throw new Error(`Retained resource cleanup failed: ${failures.join("; ")}`);
    }
    retainProject = false;
  };
  if (primaryError !== null) {
    try {
      await releaseRetainedResources();
    } catch (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "Real-project proof failed and retained resources could not be removed."
      );
    }
    throw primaryError;
  }
  if (cleanupFailures.length > 0) {
    let retainedFailure = null;
    try {
      await releaseRetainedResources();
    } catch (error) {
      retainedFailure = error;
    }
    const cleanupError = new Error(`Real-project proof cleanup failed: ${cleanupFailures.join("; ")}`);
    if (retainedFailure !== null) {
      throw new AggregateError(
        [cleanupError, retainedFailure],
        "Real-project proof cleanup and retained-resource cleanup failed."
      );
    }
    throw cleanupError;
  }
  console.log(stage("CLEAN SHUTDOWN"));
  console.log("Builder session, MCP tools, approval service, and TrueForge runtime closed.");
  console.log(`Total runtime: ${formatDuration(result.durationMs)}`);
  if (options.keepProject || options.retainPreview) {
    console.log(`Disposable project retained: ${fixture.projectRoot}`);
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  const retainedCleanup = options.retainPreview ? releaseRetainedResources : undefined;
  return Object.freeze({ ...result, retainedCleanup });
}
