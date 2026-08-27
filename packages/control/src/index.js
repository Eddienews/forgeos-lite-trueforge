#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEMO_MISSION_TEXT } from "../../cli/src/demo.js";
import { runRealProjectDemo } from "../../cli/src/real-project-demo.js";
import {
  createCustomStaticWebSpec,
  createOperationsDashboardSpec
} from "../../cli/src/real-project-spec.js";

const defaultHost = "127.0.0.1";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultPublicRoot = path.resolve(moduleDirectory, "../public");
const defaultRepositoryRoot = path.resolve(moduleDirectory, "../../..");
const terminalStates = new Set(["complete", "denied", "validation_failed", "runtime_failed"]);
const stageDefinitions = [
  ["coordinator", "Coordinator"],
  ["builder", "Builder"],
  ["validation", "Validation"],
  ["reviewer", "Reviewer"],
  ["approval", "Approval"]
];

function stages(overrides = {}) {
  return stageDefinitions.map(([id, label]) => ({
    id,
    label,
    status: overrides[id] ?? "waiting"
  }));
}

function initialState(missionSpec = { mission: DEMO_MISSION_TEXT }) {
  const realProject = missionSpec.kind !== undefined;
  return {
    revision: 1,
    status: "home",
    headerStatus: "Ready",
    project: {
      name: realProject ? "operations-status-project" : "greeting-project",
      branch: "main",
      clean: true,
      type: realProject ? "Node.js static web project" : "Node.js",
      disposition: "Created fresh when the mission starts"
    },
    mission: { suggested: missionSpec.mission, submitted: null },
    stages: stages(),
    latestOutcome: null,
    safety: {
      state: "unchanged",
      message: "ForgeOS works in isolation and asks before changing your project."
    },
    plan: null,
    validation: [],
    reviewer: null,
    result: null,
    changes: [],
    preview: null,
    approval: { state: "unavailable", canApply: false, canReject: false },
    application: null,
    timeline: [],
    evidence: {},
    failure: null,
    cleanup: null,
    tabsAvailable: false
  };
}

function durationLabel(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return milliseconds < 1000
    ? `${Math.round(milliseconds)} ms`
    : `${(milliseconds / 1000).toFixed(1)}s`;
}

function publicTimeline(entries) {
  return entries
    .filter((entry) => entry.eventType === "mission.milestone")
    .map((entry) => ({
      label: entry.summary,
      status: "passed",
      timestamp: entry.timestamp
    }));
}

function safeFailure(value) {
  return {
    code: typeof value?.code === "string" ? value.code.slice(0, 128) : "mission_failed",
    stage: typeof value?.stage === "string" ? value.stage.slice(0, 128) : "runtime",
    summary:
      typeof value?.summary === "string"
        ? value.summary.slice(0, 1024)
        : "ForgeOS could not complete the mission."
  };
}

function appendTimeline(state, label, status = "passed") {
  return [...state.timeline, { label, status, timestamp: new Date().toISOString() }];
}

export function applyWorkflowUpdate(current, update) {
  if (
    update.type === "human_decision_submitted" &&
    current.status === "decision_submitted" &&
    current.approval.state === `${update.value.decision}_submitted`
  ) {
    return current;
  }
  const next = structuredClone(current);
  next.revision += 1;
  switch (update.type) {
    case "project_connected":
      next.project = { ...update.value.project, disposition: "Disposable local Git project" };
      next.evidence.baseRevision = update.value.baseRevision;
      break;
    case "mission_received":
      next.status = "running";
      next.headerStatus = "Running";
      next.mission.submitted = update.value.mission;
      next.latestOutcome = "ForgeOS accepted your request.";
      next.timeline = appendTimeline(next, "Mission received");
      break;
    case "autonomous_work_running":
      next.status = "running";
      next.latestOutcome = update.value.outcome;
      next.safety = {
        state: "unchanged",
        message: "Your original project is unchanged while ForgeOS works in isolation."
      };
      break;
    case "candidate_ready":
      next.status = "candidate_ready";
      next.headerStatus = "Ready for review";
      next.latestOutcome = update.value.outcome;
      next.stages = stages({
        coordinator: "passed",
        builder: "passed",
        validation: "passed",
        reviewer: "passed"
      });
      next.plan = update.value.plan;
      next.validation = update.value.validation.map((entry) => ({
        ...entry,
        duration: durationLabel(entry.durationMs)
      }));
      next.reviewer = update.value.reviewer;
      next.result = {
        heading: "Mission ready for review",
        outcome: update.value.outcome,
        affectedFiles: update.value.candidate.affectedFiles,
        fileCount: update.value.candidate.affectedFiles.length
      };
      next.changes = update.value.changes;
      next.preview = update.value.preview ?? null;
      next.approval = { state: "preparing", canApply: false, canReject: false };
      next.safety = {
        state: "unchanged",
        message: "Your original project is still unchanged."
      };
      next.timeline = publicTimeline(update.value.timeline);
      next.evidence = {
        ...next.evidence,
        missionId: update.value.missionId,
        candidateId: update.value.candidate.id,
        candidateSha256: update.value.candidate.sha256,
        baseRevision: update.value.candidate.baseRevision,
        affectedFiles: update.value.candidate.affectedFiles
      };
      if (update.value.runtime !== undefined) next.evidence.runtime = update.value.runtime;
      if (update.value.preview !== undefined) {
        next.evidence.previewSource = update.value.preview.source;
        next.evidence.previewCandidateSha256 = update.value.preview.candidateSha256;
      }
      next.tabsAvailable = true;
      break;
    case "approval_required":
      next.status = "approval_required";
      next.headerStatus = "Human action required";
      next.stages = stages({
        coordinator: "passed",
        builder: "passed",
        validation: "passed",
        reviewer: "passed",
        approval: "action_required"
      });
      next.approval = { state: "required", canApply: true, canReject: true };
      next.safety.message =
        "Your original project is still unchanged. Nothing irreversible happens until you decide.";
      next.evidence.approvalEvent = update.value.eventType;
      next.timeline = appendTimeline(next, "Human approval required", "action_required");
      break;
    case "human_decision_submitted":
      next.status = "decision_submitted";
      next.headerStatus = "Decision submitted";
      next.approval = {
        state: update.value.decision === "allow" ? "allow_submitted" : "deny_submitted",
        canApply: false,
        canReject: false
      };
      next.timeline = appendTimeline(
        next,
        update.value.decision === "allow"
          ? "Human approval submitted to TrueForge"
          : "Human rejection submitted to TrueForge",
        "running"
      );
      break;
    case "applying":
      next.status = "applying";
      next.headerStatus = "Applying approved changes";
      next.stages = stages({
        coordinator: "passed",
        builder: "passed",
        validation: "passed",
        reviewer: "passed",
        approval: "running"
      });
      next.approval = { state: "confirmed", canApply: false, canReject: false };
      next.application = { state: "running" };
      next.timeline = appendTimeline(next, "Human approval confirmed", "running");
      break;
    case "applied":
      next.status = "complete";
      next.headerStatus = "Mission complete";
      next.stages = stages({
        coordinator: "passed",
        builder: "passed",
        validation: "passed",
        reviewer: "passed",
        approval: "passed"
      });
      next.result = {
        heading: "Mission complete",
        outcome: update.value.outcome,
        affectedFiles: update.value.appliedFiles,
        fileCount: update.value.appliedFiles.length
      };
      next.approval = { state: "consumed", canApply: false, canReject: false };
      next.application = { state: "applied", ...update.value };
      next.project.clean = false;
      next.safety = {
        state: "applied_after_approval",
        message: "Your project changed only after human approval."
      };
      next.timeline = appendTimeline(next, "Patch applied");
      next.timeline = appendTimeline(next, "Mission complete");
      break;
    case "denied":
      next.status = "denied";
      next.headerStatus = "Change rejected";
      next.stages = stages({
        coordinator: "passed",
        builder: "passed",
        validation: "passed",
        reviewer: "passed",
        approval: "denied"
      });
      next.result = {
        heading: "Change rejected",
        outcome: "The reviewed candidate can no longer be applied.",
        affectedFiles: next.result?.affectedFiles ?? [],
        fileCount: next.result?.fileCount ?? 0
      };
      next.approval = { state: "denied", canApply: false, canReject: false };
      next.safety = { state: "unchanged", message: "Your project was not modified." };
      next.timeline = appendTimeline(next, "Change rejected");
      break;
    case "mission_failed": {
      const failure = safeFailure(update.value.failure);
      const validationFailed = failure.stage === "validation";
      next.status = validationFailed ? "validation_failed" : "runtime_failed";
      next.headerStatus = validationFailed ? "Validation failed" : "Mission blocked";
      next.latestOutcome = validationFailed
        ? "A required validation check failed."
        : "ForgeOS could not complete the mission.";
      next.failure = failure;
      next.validation = update.value.validationSummary.map((entry) => ({
        policyId: entry.policyId,
        success: entry.success,
        duration: durationLabel(Date.parse(entry.completedAt) - Date.parse(entry.startedAt))
      }));
      next.stages = stages(
        validationFailed
          ? { coordinator: "passed", builder: "passed", validation: "failed" }
          : { coordinator: "failed" }
      );
      next.safety = {
        state: update.value.originalUnchanged ? "unchanged" : "requires_review",
        message: update.value.originalUnchanged
          ? "Your original project remains unchanged."
          : "The project state requires technical review."
      };
      next.approval = { state: "unavailable", canApply: false, canReject: false };
      next.tabsAvailable = true;
      next.timeline = appendTimeline(next, next.headerStatus, "failed");
      break;
    }
    case "cleanup_completed":
      next.cleanup = {
        status: update.value.status,
        duration: durationLabel(update.value.durationMs)
      };
      break;
    default:
      break;
  }
  return next;
}

async function requestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString("utf8");
    if (body.length > 16_384) throw new Error("Request body is too large.");
  }
  if (body === "") return {};
  return JSON.parse(body);
}

function responseHeaders(contentType) {
  return {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, responseHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(value));
}

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 1024) : "Unknown local control error.";
}

export function createControlServer(options = {}) {
  const host = options.host ?? defaultHost;
  if (host !== defaultHost) throw new Error("ForgeOS Control must bind to 127.0.0.1.");
  const requestedPort = options.port ?? 4173;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error("ForgeOS Control port must be an integer from 0 through 65535.");
  }
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
  const publicRoot = options.publicRoot ?? defaultPublicRoot;
  const runner = options.runner ?? runRealProjectDemo;
  let missionSpec =
    options.missionSpec ??
    (options.runner === undefined
      ? createOperationsDashboardSpec()
      : { mission: DEMO_MISSION_TEXT });
  const controlToken = options.controlToken ?? randomUUID();
  let state = initialState(missionSpec);
  let activeRun = null;
  let decisionResolve = null;
  let boundPort = null;
  let retainedCleanup = null;

  const assets = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/app.css", ["app.css", "text/css; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]]
  ]);

  function publish(update) {
    state = applyWorkflowUpdate(state, update);
  }

  function authorized(request) {
    return request.headers["x-forgeos-control-token"] === controlToken;
  }

  async function releaseRetainedCleanup() {
    if (retainedCleanup === null) return;
    const cleanup = retainedCleanup;
    await cleanup();
    if (retainedCleanup === cleanup) retainedCleanup = null;
  }

  async function startMission(request, response) {
    if (!authorized(request)) {
      sendJson(response, 403, { error: "Local control authorization failed." });
      return;
    }
    if (activeRun !== null) {
      sendJson(response, 409, { error: "A mission is already active." });
      return;
    }
    const body = await requestBody(request);
    if (
      typeof body.mission !== "string" ||
      body.mission.trim().length < 10 ||
      body.mission.length > 6000
    ) {
      sendJson(response, 422, {
        error: "Describe one bounded static web mission using 10 through 6000 characters."
      });
      return;
    }
    const submitted = body.mission.trim();
    const runSpec =
      submitted === missionSpec.mission ? missionSpec : createCustomStaticWebSpec(submitted);
    state = {
      ...initialState(runSpec),
      revision: state.revision + 1,
      status: "running",
      headerStatus: "Mission received",
      mission: { suggested: runSpec.mission, submitted: runSpec.mission },
      latestOutcome: "ForgeOS accepted your request.",
      safety: {
        state: "unchanged",
        message: "Your original project is unchanged while ForgeOS works in isolation."
      },
      timeline: [
        { label: "Mission received", status: "passed", timestamp: new Date().toISOString() }
      ]
    };
    const decisionPromise = new Promise((resolve) => {
      decisionResolve = resolve;
    });
    activeRun = runner({
      repositoryRoot,
      requireCleanRepository: false,
      deny: false,
      json: false,
      keepProject: false,
      verbose: false,
      decisionProvider: async () => decisionPromise,
      onUpdate: async (update) => publish(update),
      spec: runSpec,
      retainPreview: options.runner === undefined,
      controlOrigin: `http://${host}:${boundPort ?? requestedPort}`
    })
      .then((runResult) => {
        if (typeof runResult?.retainedCleanup === "function") {
          retainedCleanup = runResult.retainedCleanup;
        }
      })
      .catch((error) => {
        if (!terminalStates.has(state.status)) {
          state = {
            ...state,
            revision: state.revision + 1,
            status: "runtime_failed",
            headerStatus: "Mission blocked",
            latestOutcome: "ForgeOS could not complete the mission.",
            failure: { code: "control_run_failed", stage: "runtime", summary: safeError(error) },
            approval: { state: "unavailable", canApply: false, canReject: false },
            safety: {
              state: "requires_review",
              message: "The project state requires technical review."
            },
            tabsAvailable: true
          };
        }
      })
      .finally(() => {
        activeRun = null;
        decisionResolve = null;
      });
    sendJson(response, 202, state);
  }

  async function submitDecision(request, response) {
    if (!authorized(request)) {
      sendJson(response, 403, { error: "Local control authorization failed." });
      return;
    }
    if (state.status !== "approval_required" || decisionResolve === null) {
      sendJson(response, 409, { error: "No genuine approval-required event is active." });
      return;
    }
    const body = await requestBody(request);
    if (body.decision !== "allow" && body.decision !== "deny") {
      sendJson(response, 422, { error: "Decision must be allow or deny." });
      return;
    }
    const resolve = decisionResolve;
    decisionResolve = null;
    publish({ type: "human_decision_submitted", value: { decision: body.decision } });
    resolve(body.decision);
    sendJson(response, 202, state);
  }

  async function resetMission(request, response) {
    if (!authorized(request)) {
      sendJson(response, 403, { error: "Local control authorization failed." });
      return;
    }
    if (activeRun !== null || !terminalStates.has(state.status)) {
      sendJson(response, 409, { error: "The active mission cannot be reset yet." });
      return;
    }
    await releaseRetainedCleanup();
    missionSpec =
      options.runner === undefined ? createOperationsDashboardSpec() : { mission: DEMO_MISSION_TEXT };
    state = { ...initialState(missionSpec), revision: state.revision + 1 };
    sendJson(response, 200, state);
  }

  const server = createServer(async (request, response) => {
    try {
      const port = boundPort ?? requestedPort;
      const url = new URL(request.url ?? "/", `http://${host}:${port}`);
      if (request.method === "GET" && url.pathname === "/api/state") {
        sendJson(response, 200, state);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/missions") {
        await startMission(request, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/approval") {
        await submitDecision(request, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/reset") {
        await resetMission(request, response);
        return;
      }
      if (request.method !== "GET" || !assets.has(url.pathname)) {
        sendJson(response, 404, { error: "Not found." });
        return;
      }
      const [fileName, contentType] = assets.get(url.pathname);
      let content = await readFile(path.join(publicRoot, fileName), "utf8");
      if (fileName === "index.html") {
        content = content.replace("__FORGEOS_CONTROL_TOKEN__", controlToken);
      }
      response.writeHead(200, responseHeaders(contentType));
      response.end(content);
    } catch (error) {
      sendJson(response, 500, { error: safeError(error) });
    }
  });

  return Object.freeze({
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(requestedPort, host, resolve);
      });
      const address = server.address();
      boundPort = typeof address === "object" && address !== null ? address.port : requestedPort;
      return `http://${host}:${boundPort}`;
    },
    async close() {
      if (activeRun !== null) {
        if (decisionResolve !== null) {
          const resolve = decisionResolve;
          decisionResolve = null;
          resolve("deny");
        }
        await activeRun;
      }
      await releaseRetainedCleanup();
      if (!server.listening) return;
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
    state: () => structuredClone(state),
    controlToken
  });
}

async function main() {
  const port = Number.parseInt(process.env.FORGEOS_CONTROL_PORT ?? "4173", 10);
  const control = createControlServer({ port });
  const url = await control.listen();
  console.log(`ForgeOS Control: ${url}`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      await control.close();
      process.exit(0);
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`ForgeOS Control: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
