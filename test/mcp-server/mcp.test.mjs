import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  candidateArtifactSha256,
  createReviewedCandidatePatch,
  createReviewerVerdict
} from "../../packages/candidate-patch/src/index.js";
import { sha256 } from "../../packages/contracts/src/index.js";
import {
  APPLY_CANDIDATE_TOOL_ANNOTATIONS,
  APPLY_CANDIDATE_TOOL_NAME,
  createCandidateApplicationRegistry,
  createHumanApprovalRecord,
  startLoopbackMcpServer,
  trueForgeApprovalConfiguration
} from "../../packages/mcp-server/src/index.js";

const execFileAsync = promisify(execFile);
const now = "2026-08-26T13:00:00.000Z";

async function git(root, ...args) {
  return execFileAsync("git", args, { cwd: root, encoding: "utf8" });
}

async function projectFixture() {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "forgeos-mcp-")));
  const projectRoot = path.join(temporary, "project");
  await mkdir(path.join(projectRoot, "src"), { recursive: true });
  await git(projectRoot, "init", "--quiet");
  await git(projectRoot, "config", "user.name", "MCP Test");
  await git(projectRoot, "config", "user.email", "mcp@example.invalid");
  const original = "Original MCP fixture.\n";
  await writeFile(path.join(projectRoot, "src/value.txt"), original, "utf8");
  await git(projectRoot, "add", ".");
  await git(projectRoot, "commit", "--quiet", "-m", "MCP fixture baseline");
  const baseRevision = (await git(projectRoot, "rev-parse", "HEAD")).stdout.trim();
  const content = "Approved MCP fixture.\n";
  const artifact = {
    schemaVersion: "1",
    baseRevision,
    operations: [
      {
        operation: "modify",
        path: "src/value.txt",
        baseContentSha256: sha256(original),
        content,
        contentSha256: sha256(content)
      }
    ]
  };
  const testEvidence = [
    {
      kind: "test-run",
      summary: "MCP candidate tests passed.",
      observedAt: now,
      artifactSha256: candidateArtifactSha256(artifact)
    }
  ];
  const reviewerVerdict = createReviewerVerdict({
    reviewId: "review-mcp",
    decision: "approved",
    candidateSha256: candidateArtifactSha256(artifact),
    testEvidence,
    createdAt: now
  });
  const candidate = createReviewedCandidatePatch({
    artifact,
    candidateId: "candidate-mcp",
    missionId: "mission-mcp",
    projectId: "project-mcp",
    patchPath: "artifacts/candidate-mcp.json",
    testEvidence,
    reviewerVerdict,
    createdAt: now
  });
  return {
    temporary,
    projectRoot,
    artifact,
    candidate,
    async cleanup() {
      await rm(temporary, { recursive: true, force: true });
    }
  };
}

function approval(candidate, overrides = {}) {
  return {
    ...createHumanApprovalRecord({
      approvalId: "approval-mcp",
      actorId: "human-reviewer",
      candidate,
      createdAt: now
    }),
    ...overrides
  };
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

test("marks the real write tool destructive and explicitly approval-required in TrueForge", () => {
  assert.deepEqual(APPLY_CANDIDATE_TOOL_ANNOTATIONS, {
    title: "Apply reviewed candidate patch",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
  });
  assert.deepEqual(trueForgeApprovalConfiguration("phase-three-gate"), {
    name: "phase-three-gate",
    enable_tools: [APPLY_CANDIDATE_TOOL_NAME],
    disable_tools: [],
    preload_tools: [APPLY_CANDIDATE_TOOL_NAME],
    require_approval_for_tools: [APPLY_CANDIDATE_TOOL_NAME],
    preload: false
  });
});

test("does not accept application without a human ApprovalRecord", async (t) => {
  const state = await projectFixture();
  t.after(state.cleanup);
  const registry = createCandidateApplicationRegistry();
  registry.registerContext({
    contextId: "context-missing-approval",
    candidate: state.candidate,
    artifact: state.artifact,
    projectRoot: state.projectRoot
  });
  await assert.rejects(registry.apply("context-missing-approval"), /human ApprovalRecord/u);
});

test("rejects nonhuman, rejected, and cross-context approvals", async (t) => {
  const state = await projectFixture();
  t.after(state.cleanup);
  for (const [contextId, changedApproval, expected] of [
    ["context-nonhuman", approval(state.candidate, { actor: "model" }), /human actor/u],
    ["context-rejected", approval(state.candidate, { decision: "rejected" }), /does not match/u],
    ["context-project", approval(state.candidate, { projectId: "other-project" }), /does not match/u],
    ["context-mission", approval(state.candidate, { missionId: "other-mission" }), /does not match/u]
  ]) {
    const registry = createCandidateApplicationRegistry();
    registry.registerContext({
      contextId,
      candidate: state.candidate,
      artifact: state.artifact,
      projectRoot: state.projectRoot
    });
    assert.throws(
      () => registry.recordHumanApproval({ contextId, approvalRecord: changedApproval }),
      expected
    );
  }
});

test("keeps a rejected reviewer verdict ineligible for human approval", async (t) => {
  const state = await projectFixture();
  t.after(state.cleanup);
  const rejectedVerdict = { ...state.candidate.reviewerVerdict, decision: "rejected" };
  const rejectedCandidate = createReviewedCandidatePatch({
    artifact: state.artifact,
    candidateId: state.candidate.candidateId,
    missionId: state.candidate.missionId,
    projectId: state.candidate.projectId,
    patchPath: state.candidate.patchPath,
    testEvidence: state.candidate.testEvidence,
    reviewerVerdict: rejectedVerdict,
    createdAt: now
  });
  const registry = createCandidateApplicationRegistry();
  registry.registerContext({
    contextId: "context-reviewer-rejected",
    candidate: rejectedCandidate,
    artifact: state.artifact,
    projectRoot: state.projectRoot
  });
  assert.throws(
    () =>
      registry.recordHumanApproval({
        contextId: "context-reviewer-rejected",
        approvalRecord: approval(rejectedCandidate)
      }),
    /does not match/u
  );
});

test("rejects replaying an approval against another candidate identity", async (t) => {
  const state = await projectFixture();
  t.after(state.cleanup);
  const otherCandidate = { ...state.candidate, candidateId: "candidate-mcp-other" };
  const registry = createCandidateApplicationRegistry();
  registry.registerContext({
    contextId: "context-other-candidate",
    candidate: otherCandidate,
    artifact: state.artifact,
    projectRoot: state.projectRoot
  });
  assert.throws(
    () =>
      registry.recordHumanApproval({
        contextId: "context-other-candidate",
        approvalRecord: approval(state.candidate)
      }),
    /does not match/u
  );
});

test("rejects approval reuse across registered application contexts", async (t) => {
  const state = await projectFixture();
  t.after(state.cleanup);
  const registry = createCandidateApplicationRegistry();
  for (const contextId of ["context-one", "context-two"]) {
    registry.registerContext({
      contextId,
      candidate: state.candidate,
      artifact: state.artifact,
      projectRoot: state.projectRoot
    });
  }
  const record = approval(state.candidate);
  registry.recordHumanApproval({ contextId: "context-one", approvalRecord: record });
  assert.throws(
    () => registry.recordHumanApproval({ contextId: "context-two", approvalRecord: record }),
    /already been used/u
  );
});

test("detects candidate and ApprovalRecord mutation after registration", async (t) => {
  const candidateState = await projectFixture();
  t.after(candidateState.cleanup);
  const mutableCandidate = structuredClone(candidateState.candidate);
  const candidateRegistry = createCandidateApplicationRegistry();
  candidateRegistry.registerContext({
    contextId: "context-mutated-candidate",
    candidate: mutableCandidate,
    artifact: candidateState.artifact,
    projectRoot: candidateState.projectRoot
  });
  candidateRegistry.recordHumanApproval({
    contextId: "context-mutated-candidate",
    approvalRecord: approval(mutableCandidate)
  });
  mutableCandidate.createdAt = "2026-08-26T13:00:01.000Z";
  await assert.rejects(candidateRegistry.apply("context-mutated-candidate"), /candidate mutated/u);

  const approvalState = await projectFixture();
  t.after(approvalState.cleanup);
  const mutableApproval = approval(approvalState.candidate);
  const approvalRegistry = createCandidateApplicationRegistry();
  approvalRegistry.registerContext({
    contextId: "context-mutated-approval",
    candidate: approvalState.candidate,
    artifact: approvalState.artifact,
    projectRoot: approvalState.projectRoot
  });
  approvalRegistry.recordHumanApproval({
    contextId: "context-mutated-approval",
    approvalRecord: mutableApproval
  });
  mutableApproval.createdAt = "2026-08-26T13:00:01.000Z";
  await assert.rejects(approvalRegistry.apply("context-mutated-approval"), /approval mutated/u);
});

test("invalidates approval when reviewer evidence mutates", async (t) => {
  const state = await projectFixture();
  t.after(state.cleanup);
  const mutableCandidate = structuredClone(state.candidate);
  const registry = createCandidateApplicationRegistry();
  registry.registerContext({
    contextId: "context-mutated-review",
    candidate: mutableCandidate,
    artifact: state.artifact,
    projectRoot: state.projectRoot
  });
  registry.recordHumanApproval({
    contextId: "context-mutated-review",
    approvalRecord: approval(mutableCandidate)
  });
  mutableCandidate.reviewerVerdict.createdAt = "2026-08-26T13:00:01.000Z";
  await assert.rejects(registry.apply("context-mutated-review"), /candidate mutated/u);
});

test("consumes one approval, emits lifecycle callbacks, and prevents replay", async (t) => {
  const state = await projectFixture();
  t.after(state.cleanup);
  const lifecycle = [];
  const registry = createCandidateApplicationRegistry();
  registry.registerContext({
    contextId: "context-success",
    candidate: state.candidate,
    artifact: state.artifact,
    projectRoot: state.projectRoot,
    clock: () => now,
    onApplying: ({ approval: record }) => lifecycle.push(`applying:${record.actorId}`),
    onCompleted: (evidence) => lifecycle.push(`completed:${evidence.success}`)
  });
  registry.recordHumanApproval({
    contextId: "context-success",
    approvalRecord: approval(state.candidate)
  });
  const evidence = await registry.apply("context-success");
  assert.equal(evidence.success, true);
  assert.deepEqual(lifecycle, ["applying:human-reviewer", "completed:true"]);
  await assert.rejects(registry.apply("context-success"), /cannot be replayed/u);
});

test("consumes approval after a failed application and rolls the target back", async (t) => {
  const state = await projectFixture();
  t.after(state.cleanup);
  const registry = createCandidateApplicationRegistry();
  registry.registerContext({
    contextId: "context-failed-attempt",
    candidate: state.candidate,
    artifact: state.artifact,
    projectRoot: state.projectRoot,
    clock: () => "invalid-time"
  });
  registry.recordHumanApproval({
    contextId: "context-failed-attempt",
    approvalRecord: approval(state.candidate)
  });
  await assert.rejects(registry.apply("context-failed-attempt"), /application failed/u);
  assert.equal(
    await readFile(path.join(state.projectRoot, "src/value.txt"), "utf8"),
    "Original MCP fixture.\n"
  );
  await assert.rejects(registry.apply("context-failed-attempt"), /consumed/u);
});

test("does not misreport a successful write when a completion callback fails", async (t) => {
  const state = await projectFixture();
  t.after(state.cleanup);
  const registry = createCandidateApplicationRegistry();
  registry.registerContext({
    contextId: "context-callback-failure",
    candidate: state.candidate,
    artifact: state.artifact,
    projectRoot: state.projectRoot,
    clock: () => now,
    onCompleted: () => {
      throw new Error("Lifecycle sink unavailable.");
    }
  });
  registry.recordHumanApproval({
    contextId: "context-callback-failure",
    approvalRecord: approval(state.candidate)
  });
  const evidence = await registry.apply("context-callback-failure");
  const snapshot = registry.contextSnapshot("context-callback-failure");
  assert.equal(evidence.success, true);
  assert.equal(snapshot.applied, true);
  assert.equal(snapshot.applicationError, null);
  assert.match(snapshot.lifecycleError, /Lifecycle sink unavailable/u);
});

test("exposes only the sealed context identifier through the MCP protocol", async (t) => {
  const state = await projectFixture();
  t.after(state.cleanup);
  const registry = createCandidateApplicationRegistry();
  registry.registerContext({
    contextId: "context-protocol",
    candidate: state.candidate,
    artifact: state.artifact,
    projectRoot: state.projectRoot
  });
  const service = await startLoopbackMcpServer({ registry, port: await unusedPort() });
  t.after(() => service.close());
  const client = new Client({ name: "phase-three-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(service.url));
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  const tool = tools.tools.find(({ name }) => name === APPLY_CANDIDATE_TOOL_NAME);
  assert.deepEqual(tool.annotations, APPLY_CANDIDATE_TOOL_ANNOTATIONS);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["contextId"]);
  const extraField = await client.callTool({
    name: APPLY_CANDIDATE_TOOL_NAME,
    arguments: { contextId: "context-protocol", targetPath: "/tmp/escape" }
  });
  assert.equal(extraField.isError, true);
  const missingApproval = await client.callTool({
    name: APPLY_CANDIDATE_TOOL_NAME,
    arguments: { contextId: "context-protocol" }
  });
  assert.equal(missingApproval.isError, true);
  assert.match(missingApproval.content[0].text, /human ApprovalRecord/u);
});

test("refuses non-loopback MCP binding", async () => {
  await assert.rejects(
    startLoopbackMcpServer({
      registry: createCandidateApplicationRegistry(),
      port: await unusedPort(),
      host: "0.0.0.0"
    }),
    /loopback host/u
  );
});
