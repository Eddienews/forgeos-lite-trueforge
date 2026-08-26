import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  candidateArtifactSha256,
  createReviewedCandidatePatch,
  createReviewerVerdict,
  generateCandidateArtifact,
  originalProjectSnapshot
} from "../packages/candidate-patch/src/index.js";
import { InMemoryMissionJournal } from "../packages/core/src/index.js";
import {
  createCandidateApplicationRegistry,
  createHumanApprovalRecord,
  startLoopbackMcpServer,
  trueForgeApprovalConfiguration
} from "../packages/mcp-server/src/index.js";

const execFileAsync = promisify(execFile);
const baseUrl = process.env.TRUEFORGE_BASE_URL;
const humanActorId = process.env.TRUEFORGE_HUMAN_ACTOR_ID;
const connectorName = "phase-three-approval-gate";
const proofTimestamp = "2026-08-26T14:00:00.000Z";

if (baseUrl === undefined || humanActorId === undefined) {
  throw new Error("TRUEFORGE_BASE_URL and TRUEFORGE_HUMAN_ACTOR_ID are required for the live proof.");
}

async function git(root, ...args) {
  return execFileAsync("git", args, { cwd: root, encoding: "utf8" });
}

async function api(pathname, options = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    ...options,
    headers: { "content-type": "application/json", ...options.headers }
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`TrueForge API ${response.status}: ${JSON.stringify(body)}`);
  }
  return body.data ?? body;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function createProjectFixture(temporary, name) {
  const originalRoot = path.join(temporary, `${name}-original`);
  const builderRoot = path.join(temporary, `${name}-builder`);
  await mkdir(path.join(originalRoot, "src"), { recursive: true });
  await git(originalRoot, "init", "--quiet");
  await git(originalRoot, "config", "user.name", "Phase Three Live Proof");
  await git(originalRoot, "config", "user.email", "phase-three-live@example.invalid");
  await writeFile(path.join(originalRoot, "src/proof.txt"), "Original proof state.\n", "utf8");
  await git(originalRoot, "add", ".");
  await git(originalRoot, "commit", "--quiet", "-m", "Live proof baseline");
  const baseRevision = (await git(originalRoot, "rev-parse", "HEAD")).stdout.trim();
  await git(temporary, "clone", "--quiet", originalRoot, builderRoot);
  await writeFile(path.join(builderRoot, "src/proof.txt"), "Reviewed Builder state.\n", "utf8");
  return { originalRoot, builderRoot, baseRevision };
}

async function createCandidate(fixture, suffix) {
  const artifact = await generateCandidateArtifact({
    originalRoot: fixture.originalRoot,
    builderRoot: fixture.builderRoot,
    baseRevision: fixture.baseRevision
  });
  const testEvidence = [
    {
      kind: "test-run",
      summary: "Disposable candidate verification passed.",
      observedAt: proofTimestamp,
      artifactSha256: candidateArtifactSha256(artifact)
    }
  ];
  const reviewerVerdict = createReviewerVerdict({
    reviewId: `review-${suffix}`,
    decision: "approved",
    candidateSha256: candidateArtifactSha256(artifact),
    testEvidence,
    createdAt: proofTimestamp
  });
  const candidate = createReviewedCandidatePatch({
    artifact,
    candidateId: `candidate-${suffix}`,
    missionId: `mission-${suffix}`,
    projectId: `project-${suffix}`,
    patchPath: `artifacts/candidate-${suffix}.json`,
    testEvidence,
    reviewerVerdict,
    createdAt: proofTimestamp
  });
  return { artifact, candidate };
}

function missionEvent(index, missionId, eventType, payload, actor = "system") {
  return {
    eventId: `live-event-${index}`,
    missionId,
    eventType,
    actor,
    timestamp: new Date(Date.UTC(2026, 7, 26, 14, 0, index)).toISOString(),
    payload
  };
}

function journalAwaitingApproval(candidate) {
  const journal = new InMemoryMissionJournal();
  journal.append(missionEvent(1, candidate.missionId, "mission.created", { state: "draft" }, "human"));
  for (const [index, [fromState, toState]] of [
    ["draft", "planned"],
    ["planned", "approved"],
    ["approved", "building"],
    ["building", "reviewing"]
  ].entries()) {
    journal.append(
      missionEvent(index + 2, candidate.missionId, "mission.transitioned", {
        fromState,
        toState
      })
    );
  }
  journal.append(
    missionEvent(6, candidate.missionId, "mission.transitioned", {
      fromState: "reviewing",
      toState: "awaiting_approval",
      candidate
    })
  );
  assert.equal(journal.replay().state, "awaiting_approval");
  return journal;
}

async function waitForTurn(sessionId, turnId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const turn = await api(`/api/v1/sessions/${sessionId}/turns/${turnId}`);
    if (turn.state.status !== "running") return turn;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`TrueForge turn did not finish in time: ${turnId}.`);
}

async function trueForgePositiveProof({ fixture, artifact, candidate, registry, service }) {
  const journal = journalAwaitingApproval(candidate);
  let approvalRecord;
  let positiveApplicationEvidence;
  registry.registerContext({
    contextId: "positive-application",
    candidate,
    artifact,
    projectRoot: fixture.originalRoot,
    clock: () => proofTimestamp,
    onApplying: ({ approval }) => {
      assert.equal(approval, approvalRecord);
      journal.append(
        missionEvent(7, candidate.missionId, "mission.transitioned", {
          fromState: "awaiting_approval",
          toState: "applying",
          candidate,
          approval
        })
      );
    },
    onCompleted: (applicationEvidence) => {
      positiveApplicationEvidence = applicationEvidence;
      journal.append(
        missionEvent(8, candidate.missionId, "mission.transitioned", {
          fromState: "applying",
          toState: "completed",
          applicationEvidence
        })
      );
    }
  });
  const originalBefore = await originalProjectSnapshot(fixture.originalRoot);
  console.log("STATE candidate ready: awaiting_approval");

  await api("/api/v1/settings/mcp-servers", {
    method: "PUT",
    body: JSON.stringify({
      manifest: {
        type: "remote",
        name: connectorName,
        url: service.url,
        description: "Local Phase 3 approval-gated candidate application proof.",
        auth: {
          type: "header",
          headers: { Authorization: `Bearer ${service.authorizationToken}` }
        }
      }
    })
  });
  const approvalConfiguration = trueForgeApprovalConfiguration(connectorName);
  const session = await api("/api/v1/sessions", {
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
          mcp_servers: [approvalConfiguration],
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
  const invoked = await api(`/api/v1/sessions/${session.id}/turns`, {
    method: "POST",
    body: JSON.stringify({
      input: [
        {
          type: "user.message",
          content: "Apply the sealed candidate using contextId positive-application."
        }
      ],
      previous_turn_id: "none",
      stream: false
    })
  });
  const paused = await waitForTurn(session.id, invoked.id);
  const approvalAction = paused.state.required_actions.find(
    ({ type }) => type === "tool.approval_required"
  );
  assert.ok(approvalAction, "TrueForge must emit tool.approval_required.");
  assert.equal(approvalAction.tool_calls.length, 1);
  assert.deepEqual(await originalProjectSnapshot(fixture.originalRoot), originalBefore);
  assert.equal(journal.replay().state, "awaiting_approval");

  approvalRecord = createHumanApprovalRecord({
    approvalId: "approval-positive-live",
    actorId: humanActorId,
    approvalContext: {
      mechanism: "trueforge.tool_approval",
      sessionId: session.id,
      threadId: approvalAction.thread_id,
      toolCallId: approvalAction.tool_calls[0].id,
      approvalEventId: approvalAction.id
    },
    candidate,
    createdAt: proofTimestamp
  });
  registry.recordHumanApproval({ contextId: "positive-application", approvalRecord });
  const resumed = await api(`/api/v1/sessions/${session.id}/turns`, {
    method: "POST",
    body: JSON.stringify({
      input: [
        {
          type: "user.tool_approval",
          thread_id: approvalAction.thread_id,
          tool_call_id: approvalAction.tool_calls[0].id,
          approval: { status: "allow" }
        }
      ],
      previous_turn_id: paused.id,
      stream: false
    })
  });
  registry.confirmHumanApproval({
    contextId: "positive-application",
    approvalContext: approvalRecord.approvalContext
  });
  console.log("STATE human approved: TrueForge accepted the tool approval resume");
  const completed = await waitForTurn(session.id, resumed.id);
  assert.equal(completed.state.status, "done");
  assert.equal(completed.state.required_actions.length, 0);
  const events = await api(
    `/api/v1/sessions/${session.id}/turns/${completed.id}/events?limit=100&order=asc`
  );
  const toolResponse = events.find(({ type }) => type === "tool.response");
  assert.ok(toolResponse);
  assert.match(toolResponse.content, /"success":true/u);
  assert.equal(await readFile(path.join(fixture.originalRoot, "src/proof.txt"), "utf8"), "Reviewed Builder state.\n");
  assert.equal((await git(fixture.originalRoot, "rev-parse", "HEAD")).stdout.trim(), fixture.baseRevision);
  assert.equal(journal.replay().state, "completed");
  console.log("STATE candidate applied: completed");
  return {
    approvalEventId: approvalAction.id,
    applicationEvidence: positiveApplicationEvidence,
    applicationState: registry.contextSnapshot("positive-application"),
    sessionId: session.id,
    toolCallId: approvalAction.tool_calls[0].id,
    trueForgeEvent: approvalAction.type
  };
}

async function negativeBaseDriftProof({ fixture, artifact, candidate, registry, sessionId }) {
  registry.registerContext({
    contextId: "negative-application",
    candidate,
    artifact,
    projectRoot: fixture.originalRoot
  });
  const invoked = await api(`/api/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({
      input: [
        {
          type: "user.message",
          content: "Apply the sealed candidate using contextId negative-application."
        }
      ],
      previous_turn_id: "none",
      stream: false
    })
  });
  const paused = await waitForTurn(sessionId, invoked.id);
  const approvalAction = paused.state.required_actions.find(
    ({ type }) => type === "tool.approval_required"
  );
  assert.ok(approvalAction);
  const approvalRecord = createHumanApprovalRecord({
    approvalId: "approval-negative-live",
    actorId: humanActorId,
    approvalContext: {
      mechanism: "trueforge.tool_approval",
      sessionId,
      threadId: approvalAction.thread_id,
      toolCallId: approvalAction.tool_calls[0].id,
      approvalEventId: approvalAction.id
    },
    candidate,
    createdAt: proofTimestamp
  });
  registry.recordHumanApproval({ contextId: "negative-application", approvalRecord });
  await writeFile(path.join(fixture.originalRoot, "base-drift.txt"), "Intentional base drift.\n", "utf8");
  await git(fixture.originalRoot, "add", "base-drift.txt");
  await git(fixture.originalRoot, "commit", "--quiet", "-m", "Create intentional base drift");
  const resumed = await api(`/api/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({
      input: [
        {
          type: "user.tool_approval",
          thread_id: approvalAction.thread_id,
          tool_call_id: approvalAction.tool_calls[0].id,
          approval: { status: "allow" }
        }
      ],
      previous_turn_id: paused.id,
      stream: false
    })
  });
  registry.confirmHumanApproval({
    contextId: "negative-application",
    approvalContext: approvalRecord.approvalContext
  });
  const completed = await waitForTurn(sessionId, resumed.id);
  const events = await api(
    `/api/v1/sessions/${sessionId}/turns/${completed.id}/events?limit=100&order=asc`
  );
  const toolResponse = events.find(({ type }) => type === "tool.response");
  assert.ok(toolResponse);
  assert.match(toolResponse.content, /HEAD does not match/u);
  assert.equal(
    await readFile(path.join(fixture.originalRoot, "src/proof.txt"), "utf8"),
    "Original proof state.\n"
  );
  return {
    approvalEventId: approvalAction.id,
    rejected: true,
    reason: "projectRoot HEAD does not match the candidate base revision.",
    toolCallId: approvalAction.tool_calls[0].id,
    trueForgeEvent: approvalAction.type
  };
}

const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "forgeos-phase3-live-")));
const registry = createCandidateApplicationRegistry();
const authorizationToken = randomUUID();
const mcpService = await startLoopbackMcpServer({
  registry,
  port: await unusedPort(),
  authorizationToken
});
const service = Object.freeze({ ...mcpService, authorizationToken });
try {
  const positiveFixture = await createProjectFixture(temporary, "positive");
  const positiveCandidate = await createCandidate(positiveFixture, "positive-live");
  const positive = await trueForgePositiveProof({
    fixture: positiveFixture,
    ...positiveCandidate,
    registry,
    service
  });
  const negativeFixture = await createProjectFixture(temporary, "negative");
  const negativeCandidate = await createCandidate(negativeFixture, "negative-live");
  const negative = await negativeBaseDriftProof({
    fixture: negativeFixture,
    ...negativeCandidate,
    registry,
    sessionId: positive.sessionId
  });
  console.log(
    JSON.stringify(
      {
        positive,
        negative,
        proof: "TrueForge real approval event followed by one controlled application",
        transport: "local loopback Streamable HTTP",
        trueForgeVersion: "0.1.4"
      },
      null,
      2
    )
  );
} finally {
  await service.close();
  await rm(temporary, { recursive: true, force: true });
  await fetch(new URL(`/api/v1/settings/mcp-servers/${connectorName}`, baseUrl), {
    method: "DELETE"
  }).catch(() => undefined);
}
