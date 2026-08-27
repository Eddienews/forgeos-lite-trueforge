import { randomUUID, timingSafeEqual } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  applyCandidateArtifact,
  candidateArtifactSha256,
  validateCandidateArtifact
} from "@forgeos-lite/candidate-patch";
import {
  SCHEMA_VERSION,
  approvalMatchesCandidate,
  assertExactKeys,
  assertIsoTimestamp,
  assertNoForbiddenFields,
  canonicalJson,
  hashesEqual,
  reviewerEvidenceHash,
  sha256,
  validateApprovalRecord,
  validateApprovalContext,
  validateCandidatePatch
} from "@forgeos-lite/contracts";
import * as z from "zod/v4";

export {
  BUILDER_WORKSPACE_TOOL_NAMES,
  createBuilderWorkspaceBoundary,
  startBuilderWorkspaceMcpServer,
  trueForgeBuilderWorkspaceConfiguration
} from "./builder-workspace.js";

export const APPLY_CANDIDATE_TOOL_NAME = "apply_candidate_patch";
export const APPLY_CANDIDATE_TOOL_ANNOTATIONS = Object.freeze({
  title: "Apply reviewed candidate patch",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
});

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

function fail(message) {
  throw new TypeError(message);
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail(`${label} must be a stable identifier.`);
  }
}

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 4096) : "Unknown application failure.";
}

export function trueForgeApprovalConfiguration(serverName) {
  assertIdentifier(serverName, "serverName");
  return Object.freeze({
    name: serverName,
    enable_tools: Object.freeze([APPLY_CANDIDATE_TOOL_NAME]),
    disable_tools: Object.freeze([]),
    preload_tools: Object.freeze([APPLY_CANDIDATE_TOOL_NAME]),
    require_approval_for_tools: Object.freeze([APPLY_CANDIDATE_TOOL_NAME]),
    preload: false
  });
}

export function createHumanApprovalRecord(options) {
  assertExactKeys(
    options,
    ["approvalId", "actorId", "approvalContext", "candidate", "createdAt"],
    ["decision"],
    "HumanApprovalOptions"
  );
  validateCandidatePatch(options.candidate);
  assertIdentifier(options.approvalId, "HumanApprovalOptions.approvalId");
  assertIdentifier(options.actorId, "HumanApprovalOptions.actorId");
  assertIsoTimestamp(options.createdAt, "HumanApprovalOptions.createdAt");
  const approval = {
    schemaVersion: SCHEMA_VERSION,
    approvalId: options.approvalId,
    missionId: options.candidate.missionId,
    candidateId: options.candidate.candidateId,
    projectId: options.candidate.projectId,
    baseRevision: options.candidate.baseRevision,
    candidateSha256: options.candidate.patchSha256,
    reviewerEvidenceSha256: reviewerEvidenceHash(options.candidate.reviewerVerdict),
    actor: "human",
    actorId: options.actorId,
    approvalContext: structuredClone(options.approvalContext),
    decision: options.decision ?? "approved",
    createdAt: options.createdAt
  };
  validateApprovalRecord(approval);
  Object.freeze(approval.approvalContext);
  return Object.freeze(approval);
}

export class CandidateApplicationRegistry {
  #approvalIds = new Set();
  #contexts = new Map();

  registerContext(options) {
    assertExactKeys(
      options,
      ["contextId", "candidate", "artifact", "projectRoot"],
      ["clock", "beforeFinalValidation", "onApplying", "onCompleted", "onFailed"],
      "CandidateApplicationContext"
    );
    assertIdentifier(options.contextId, "CandidateApplicationContext.contextId");
    if (this.#contexts.has(options.contextId)) {
      fail(`Candidate application context already exists: ${options.contextId}.`);
    }
    validateCandidatePatch(options.candidate);
    validateCandidateArtifact(options.artifact);
    if (!hashesEqual(options.candidate.patchSha256, candidateArtifactSha256(options.artifact))) {
      fail("Candidate application context artifact does not match the reviewed candidate.");
    }
    for (const callbackName of [
      "clock",
      "beforeFinalValidation",
      "onApplying",
      "onCompleted",
      "onFailed"
    ]) {
      if (options[callbackName] !== undefined && typeof options[callbackName] !== "function") {
        fail(`CandidateApplicationContext.${callbackName} must be a trusted function.`);
      }
    }
    assertNoForbiddenFields(options.candidate, "CandidateApplicationContext.candidate");
    assertNoForbiddenFields(options.artifact, "CandidateApplicationContext.artifact");
    this.#contexts.set(options.contextId, {
      candidate: options.candidate,
      artifact: options.artifact,
      projectRoot: options.projectRoot,
      candidateBinding: sha256(options.candidate),
      artifactBinding: candidateArtifactSha256(options.artifact),
      approval: null,
      approvalBinding: null,
      approvalContextBinding: null,
      approvalConfirmed: false,
      approvalConfirmationWaiter: null,
      attempted: false,
      applicationEvidence: null,
      applicationError: null,
      lifecycleError: null,
      clock: options.clock,
      beforeFinalValidation: options.beforeFinalValidation,
      onApplying: options.onApplying,
      onCompleted: options.onCompleted,
      onFailed: options.onFailed
    });
    return this.contextSnapshot(options.contextId);
  }

  recordHumanApproval(options) {
    assertExactKeys(
      options,
      ["contextId", "approvalRecord"],
      [],
      "HumanApprovalRegistration"
    );
    const context = this.#context(options.contextId);
    if (context.attempted || context.applicationEvidence !== null) {
      fail("Human approval cannot be recorded after an application attempt.");
    }
    if (context.approval !== null) {
      fail("Candidate application context already has a human approval record.");
    }
    validateApprovalRecord(options.approvalRecord);
    this.#assertSealed(context);
    if (!approvalMatchesCandidate(options.approvalRecord, context.candidate)) {
      fail("Human approval does not match the exact reviewed candidate.");
    }
    if (this.#approvalIds.has(options.approvalRecord.approvalId)) {
      fail(`Approval record has already been used: ${options.approvalRecord.approvalId}.`);
    }
    this.#approvalIds.add(options.approvalRecord.approvalId);
    context.approval = options.approvalRecord;
    context.approvalBinding = sha256(options.approvalRecord);
    context.approvalContextBinding = sha256(options.approvalRecord.approvalContext);
    return this.contextSnapshot(options.contextId);
  }

  confirmHumanApproval(options) {
    assertExactKeys(
      options,
      ["contextId", "approvalContext"],
      [],
      "HumanApprovalConfirmation"
    );
    const context = this.#context(options.contextId);
    if (context.approval === null) {
      fail("Human approval cannot be confirmed before its ApprovalRecord exists.");
    }
    validateApprovalContext(options.approvalContext);
    if (!hashesEqual(sha256(options.approvalContext), context.approvalContextBinding)) {
      fail("TrueForge approval confirmation does not match the recorded approval context.");
    }
    if (context.attempted || context.applicationEvidence !== null) {
      fail("Human approval cannot be confirmed after an application attempt.");
    }
    if (!context.approvalConfirmed) {
      context.approvalConfirmed = true;
      context.approvalConfirmationWaiter?.resolve();
      context.approvalConfirmationWaiter = null;
    }
    return this.contextSnapshot(options.contextId);
  }

  async apply(contextId) {
    const context = this.#context(contextId);
    if (context.applicationEvidence !== null) {
      fail("Candidate application has already succeeded and cannot be replayed.");
    }
    if (context.attempted) {
      fail("Candidate approval was consumed by a prior application attempt.");
    }
    if (context.approval === null) {
      fail("Candidate application requires a human ApprovalRecord.");
    }
    await this.#awaitApprovalConfirmation(context);
    this.#assertSealed(context);
    validateApprovalRecord(context.approval);
    if (!hashesEqual(sha256(context.approval), context.approvalBinding)) {
      fail("Human approval mutated after it was recorded.");
    }
    if (!approvalMatchesCandidate(context.approval, context.candidate)) {
      fail("Human approval no longer matches the exact reviewed candidate.");
    }
    context.attempted = true;
    try {
      if (context.onApplying !== undefined) {
        await context.onApplying({
          candidate: context.candidate,
          approval: context.approval
        });
      }
      const evidence = await applyCandidateArtifact({
        candidate: context.candidate,
        artifact: context.artifact,
        projectRoot: context.projectRoot,
        ...(context.clock === undefined ? {} : { clock: context.clock }),
        ...(context.beforeFinalValidation === undefined
          ? {}
          : { beforeFinalValidation: context.beforeFinalValidation })
      });
      context.applicationEvidence = evidence;
    } catch (error) {
      context.applicationError = safeError(error);
      if (context.onFailed !== undefined) {
        try {
          await context.onFailed({ message: context.applicationError });
        } catch (callbackError) {
          context.lifecycleError = safeError(callbackError);
        }
      }
      throw error;
    }
    if (context.onCompleted !== undefined) {
      try {
        await context.onCompleted(context.applicationEvidence);
      } catch (error) {
        context.lifecycleError = safeError(error);
      }
    }
    return context.applicationEvidence;
  }

  contextSnapshot(contextId) {
    const context = this.#context(contextId);
    return Object.freeze({
      contextId,
      candidateId: context.candidate.candidateId,
      candidateSha256: context.candidate.patchSha256,
      reviewerEvidenceSha256: reviewerEvidenceHash(context.candidate.reviewerVerdict),
      humanApprovalRecorded: context.approval !== null,
      humanApprovalConfirmed: context.approvalConfirmed,
      attempted: context.attempted,
      applied: context.applicationEvidence !== null,
      applicationError: context.applicationError,
      lifecycleError: context.lifecycleError
    });
  }

  #assertSealed(context) {
    validateCandidatePatch(context.candidate);
    validateCandidateArtifact(context.artifact);
    if (!hashesEqual(sha256(context.candidate), context.candidateBinding)) {
      fail("Reviewed candidate mutated after registration.");
    }
    if (!hashesEqual(candidateArtifactSha256(context.artifact), context.artifactBinding)) {
      fail("Candidate artifact mutated after registration.");
    }
    if (!hashesEqual(context.candidate.patchSha256, context.artifactBinding)) {
      fail("Reviewed candidate no longer matches its registered artifact.");
    }
  }

  #context(contextId) {
    assertIdentifier(contextId, "contextId");
    const context = this.#contexts.get(contextId);
    if (context === undefined) {
      fail(`Unknown candidate application context: ${contextId}.`);
    }
    return context;
  }

  async #awaitApprovalConfirmation(context) {
    if (context.approvalConfirmed) return;
    if (context.approvalConfirmationWaiter !== null) {
      fail("Candidate application is already waiting for TrueForge approval confirmation.");
    }
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        context.approvalConfirmationWaiter = null;
        context.attempted = true;
        context.applicationError = "Candidate application requires confirmed TrueForge human approval.";
        reject(new TypeError("Candidate application requires confirmed TrueForge human approval."));
      }, 5000);
      context.approvalConfirmationWaiter = {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        }
      };
    });
  }
}

export function createCandidateApplicationRegistry() {
  return new CandidateApplicationRegistry();
}

function createProtocolServer(registry) {
  const server = new McpServer({ name: "forgeos-lite-approval-gate", version: "0.1.0" });
  server.registerTool(
    APPLY_CANDIDATE_TOOL_NAME,
    {
      title: APPLY_CANDIDATE_TOOL_ANNOTATIONS.title,
      description:
        "Apply one server-registered, reviewed candidate to its fixed project after TrueForge human approval.",
      inputSchema: z
        .object({
          contextId: z.string().regex(identifierPattern)
        })
        .strict(),
      annotations: APPLY_CANDIDATE_TOOL_ANNOTATIONS
    },
    async ({ contextId }) => {
      try {
        const evidence = await registry.apply(contextId);
        return {
          content: [{ type: "text", text: canonicalJson(evidence) }],
          structuredContent: evidence
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: safeError(error) }]
        };
      }
    }
  );
  return server;
}

export async function startLoopbackMcpServer(options) {
  assertExactKeys(
    options,
    ["registry", "port", "authorizationToken"],
    ["host"],
    "LoopbackMcpServerOptions"
  );
  if (!(options.registry instanceof CandidateApplicationRegistry)) {
    fail("LoopbackMcpServerOptions.registry must be a CandidateApplicationRegistry.");
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    fail("LoopbackMcpServerOptions.port must be an integer from 1024 through 65535.");
  }
  if (typeof options.authorizationToken !== "string" || options.authorizationToken.length < 32) {
    fail("LoopbackMcpServerOptions.authorizationToken must be a strong control-plane token.");
  }
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    fail("Phase 3 MCP server must bind to a loopback host.");
  }
  const app = createMcpExpressApp();
  app.post("/mcp", async (request, response) => {
    const suppliedAuthorization = request.get("authorization") ?? "";
    const expectedAuthorization = `Bearer ${options.authorizationToken}`;
    const supplied = Buffer.from(suppliedAuthorization, "utf8");
    const expected = Buffer.from(expectedAuthorization, "utf8");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized MCP client." },
        id: null
      });
      return;
    }
    const protocolServer = createProtocolServer(options.registry);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let resourcesClosed = false;
    const closeResources = () => {
      if (resourcesClosed) return;
      resourcesClosed = true;
      void transport.close();
      void protocolServer.close();
    };
    response.once("close", closeResources);
    try {
      await protocolServer.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: safeError(error) },
          id: null
        });
      }
    } finally {
      if (response.writableEnded) closeResources();
    }
  });
  app.get("/mcp", (_request, response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null
    });
  });
  app.delete("/mcp", (_request, response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null
    });
  });
  const httpServer = await new Promise((resolve, reject) => {
    const listening = app.listen(options.port, host, () => resolve(listening));
    listening.once("error", reject);
  });
  let closed = false;
  return Object.freeze({
    host,
    port: options.port,
    url: `http://${host === "::1" ? `[${host}]` : host}:${options.port}/mcp`,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}

export function approvalRecordBinding(value) {
  validateApprovalRecord(value);
  return sha256(value);
}

export function newApplicationContextId() {
  return `application-${randomUUID()}`;
}
