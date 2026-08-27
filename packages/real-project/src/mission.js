import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import {
  candidateArtifactSha256,
  createReviewedCandidatePatch,
  createReviewerVerdict,
  generateCandidateArtifact,
  originalProjectSnapshot
} from "@forgeos-lite/candidate-patch";
import { SCHEMA_VERSION, canonicalJson, hashesEqual, sha256 } from "@forgeos-lite/contracts";
import {
  createBuilderWorkspaceBoundary,
  startBuilderWorkspaceMcpServer,
  trueForgeBuilderWorkspaceConfiguration
} from "@forgeos-lite/mcp-server";
import { createTrueForgeSession } from "@forgeos-lite/runtime-trueforge";

import { validateBoundedCoordinatorPlan } from "./plan.js";
import { materializeCandidatePreview, startCandidatePreviewServer } from "./preview.js";

const execFileAsync = promisify(execFile);
const maximumChangedFiles = 8;
const maximumCandidateBytes = 200_000;
const maximumBuilderTurns = 3;
const runtimeMetadataPrefixes = Object.freeze([".home/.npm/_logs"]);
const builderReadPaths = Object.freeze([
  "package.json",
  "requirements.json",
  "scripts/build-check.mjs",
  "test/acceptance.test.mjs"
]);

function fail(message) {
  throw new Error(message);
}

function safeMessage(error) {
  return error instanceof Error ? error.message.slice(0, 4096) : "Unknown real-project failure.";
}

async function gitText(root, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
}

async function unusedPort() {
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

async function trueForgeApi(baseUrl, pathname, options = {}) {
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
  if (!response.ok) fail(`TrueForge API ${response.status} at ${pathname}.`);
  return body?.data ?? body;
}

async function waitForTurn(baseUrl, sessionId, turnId, deadlineMs = 180_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const turn = await trueForgeApi(
      baseUrl,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
      { timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())) }
    );
    if (turn.state.status !== "running") return turn;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  fail(`TrueForge Builder turn did not finish in time: ${turnId}.`);
}

function runtimeManifest(options) {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: options.projectId,
    name: options.displayName,
    runtime: "node",
    installCommand: { kind: "not_applicable" },
    testCommand: { kind: "policy", policyId: "npm-test", arguments: [] },
    buildCommand: { kind: "policy", policyId: "npm-run-build", arguments: [] },
    allowedEnvironmentKeys: ["CI", "TZ"],
    sourceRevision: options.baseRevision
  };
}

async function createBuilderSession(baseUrl, service) {
  await trueForgeApi(baseUrl, "/api/v1/settings/mcp-servers", {
    method: "PUT",
    body: JSON.stringify({
      manifest: {
        type: "remote",
        name: service.name,
        url: service.url,
        description: "A bounded UTF-8 file interface for one isolated ForgeOS Builder workspace.",
        auth: {
          type: "header",
          headers: { Authorization: `Bearer ${service.authorizationToken}` }
        }
      }
    })
  });
  return trueForgeApi(baseUrl, "/api/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      agent: {
        spec: {
          model: {
            name: "openai/gpt-5-4-mini",
            params: { reasoning_effort: "low", parallel_tool_calls: false }
          },
          instructions: [
            "You are the bounded ForgeOS Builder for one isolated static Node.js project.",
            "Inspect the admitted files with the provided workspace tools and implement the current mission.",
            "Write only below public/ and never request shell, network, package installation, Git, secrets, or host paths.",
            "Create a complete, polished, responsive plain HTML, CSS, and JavaScript result from the current mission and immutable requirements.",
            "Do not use external resources. Do not claim checks passed; ForgeOS runs them independently.",
            "Keep your final response concise and do not reveal hidden reasoning."
          ].join(" "),
          mcp_servers: [trueForgeBuilderWorkspaceConfiguration(service.name)],
          config: {
            iteration_limit: 40,
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

async function runBuilderTurn(baseUrl, sessionId, prompt, previousTurnId) {
  const invoked = await trueForgeApi(
    baseUrl,
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
    {
      method: "POST",
      body: JSON.stringify({
        input: [{ type: "user.message", content: prompt }],
        previous_turn_id: previousTurnId ?? "none",
        stream: false
      })
    }
  );
  const completed = await waitForTurn(baseUrl, sessionId, invoked.id);
  if (completed.state.status !== "done" || completed.state.required_actions.length !== 0) {
    fail("TrueForge Builder did not complete without an unexpected authority request.");
  }
  return completed;
}

function validationSucceeded(evidence) {
  return evidence.exitStatus === 0 && evidence.runtimeError === null && evidence.timedOut === false;
}

async function executeValidation(runtimeSession, missionId, workspaceId, turnNumber) {
  const build = await runtimeSession.execute({
    action: "run_build",
    executionId: `build-${turnNumber}-${randomUUID()}`,
    missionId,
    workingDirectory: workspaceId,
    environment: { CI: "1", TZ: "UTC" },
    timeoutMs: 120_000
  });
  const tests = await runtimeSession.execute({
    action: "run_tests",
    executionId: `test-${turnNumber}-${randomUUID()}`,
    missionId,
    workingDirectory: workspaceId,
    environment: { CI: "1", TZ: "UTC" },
    timeoutMs: 120_000
  });
  return [build, tests];
}

function sanitizedFailureEvidence(evidence) {
  return evidence
    .filter((entry) => !validationSucceeded(entry))
    .map((entry) => ({
      policyId: entry.command.policyId,
      exitStatus: entry.exitStatus,
      timedOut: entry.timedOut,
      runtimeError: entry.runtimeError,
      output: `${entry.stdout}\n${entry.stderr}`
        .replaceAll(/\b(?:sk|sess|proj|org)-[A-Za-z0-9_-]+/gu, "[redacted]")
        .replaceAll(/(?:\/[A-Za-z0-9._ @+-]+){2,}/gu, "[workspace]")
        .slice(0, 6000)
    }));
}

export async function runBoundedRepairLoop(options) {
  const maximumTurns = options.maximumTurns ?? maximumBuilderTurns;
  if (!Number.isInteger(maximumTurns) || maximumTurns < 1 || maximumTurns > maximumBuilderTurns) {
    fail(`Builder repair loop supports 1 through ${maximumBuilderTurns} turns.`);
  }
  let previousTurnId;
  let validationEvidence = [];
  for (let turnNumber = 1; turnNumber <= maximumTurns; turnNumber += 1) {
    const prompt =
      turnNumber === 1
        ? options.initialPrompt
        : [
            "Repair the isolated application so every fixed validation policy passes.",
            "Inspect the current admitted files before editing. Preserve all mission requirements.",
            "The following evidence is sanitized and bounded:",
            canonicalJson(sanitizedFailureEvidence(validationEvidence))
          ].join("\n");
    const turn = await options.runTurn(prompt, previousTurnId);
    previousTurnId = turn.id;
    await options.assertWorkspace();
    validationEvidence = await options.validate(turnNumber);
    await options.assertWorkspace();
    await options.onIteration?.({
      turnNumber,
      repair: turnNumber > 1,
      validationEvidence,
      passed: validationEvidence.every(validationSucceeded)
    });
    if (validationEvidence.every(validationSucceeded)) {
      return Object.freeze({
        builderTurns: turnNumber,
        repairRequired: turnNumber > 1,
        validationEvidence: Object.freeze(validationEvidence)
      });
    }
  }
  fail(
    `Validation failed after the hard limit of ${maximumTurns} Builder turns: ${canonicalJson(
      sanitizedFailureEvidence(validationEvidence)
    )}`
  );
}

async function changedFiles(root) {
  const changed = (await gitText(root, ["diff", "--name-only", "-z", "--no-renames", "HEAD"]))
    .split("\0")
    .filter(Boolean);
  const untracked = (await gitText(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  return [...new Set([...changed, ...untracked])].sort((left, right) => left.localeCompare(right));
}

async function trackedBaselineFile(root, relativePath) {
  const output = await gitText(root, ["ls-tree", "-z", "HEAD", "--", relativePath]);
  if (output === "") return false;
  const entry = output.replace(/\0$/u, "");
  const separator = entry.indexOf("\t");
  if (separator === -1 || entry.slice(separator + 1) !== relativePath) return false;
  const [mode, type] = entry.slice(0, separator).split(" ");
  return mode === "100644" && type === "blob";
}

export async function authoritativeChangedFileSize(builderRoot, relativePath) {
  let details;
  try {
    details = await lstat(path.join(builderRoot, ...relativePath.split("/")));
  } catch (error) {
    if (error?.code === "ENOENT" && (await trackedBaselineFile(builderRoot, relativePath))) {
      return 0;
    }
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o111) !== 0) {
    fail(`Builder produced an unsafe file entry: ${relativePath}.`);
  }
  return details.size;
}

async function treeInventory(
  root,
  excludedTopLevel = new Set(),
  excludedRelativePrefixes = runtimeMetadataPrefixes
) {
  const entries = [];
  let bytes = 0;
  async function visit(current, relative) {
    const names = (await readdir(current)).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (relative === "" && excludedTopLevel.has(name)) continue;
      const target = path.join(current, name);
      const relativePath = relative === "" ? name : `${relative}/${name}`;
      if (
        excludedRelativePrefixes.some(
          (prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`)
        )
      ) {
        continue;
      }
      const details = await lstat(target);
      if (details.isDirectory() && !details.isSymbolicLink()) {
        await visit(target, relativePath);
      } else if (details.isSymbolicLink()) {
        entries.push({ path: relativePath, type: "symlink", target: await readlink(target) });
      } else if (details.isFile()) {
        bytes += details.size;
        if (bytes > 100_000_000 || entries.length > 20_000) fail("Workspace fingerprint is too large.");
        entries.push({
          path: relativePath,
          type: "file",
          sha256: sha256((await readFile(target)).toString("base64"))
        });
      } else {
        fail(`Workspace contains an unsupported entry: ${relativePath}.`);
      }
    }
  }
  await visit(root, "");
  return entries;
}

async function fingerprintTree(root, excludedTopLevel = new Set()) {
  return sha256(await treeInventory(root, excludedTopLevel, []));
}

function changedInventoryPaths(before, after) {
  const left = new Map(before.map((entry) => [entry.path, canonicalJson(entry)]));
  const right = new Map(after.map((entry) => [entry.path, canonicalJson(entry)]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((entry) => left.get(entry) !== right.get(entry))
    .sort((leftPath, rightPath) => leftPath.localeCompare(rightPath));
}

async function assertAuthoritativeWorkspace(options) {
  const actual = await changedFiles(options.builderRoot);
  if (actual.length === 0) fail("Builder produced no application change.");
  if (actual.length > maximumChangedFiles) fail("Builder exceeded the changed-file limit.");
  let totalBytes = 0;
  for (const relativePath of actual) {
    if (!relativePath.startsWith("public/")) fail(`Builder changed a forbidden path: ${relativePath}.`);
    totalBytes += await authoritativeChangedFileSize(options.builderRoot, relativePath);
  }
  if (totalBytes > maximumCandidateBytes) fail("Builder exceeded the candidate-size limit.");
  if (!hashesEqual(options.gitFingerprint, await fingerprintTree(path.join(options.builderRoot, ".git")))) {
    fail("Builder or validation modified isolated Git metadata.");
  }
  const currentOutside = await treeInventory(options.sessionRoot, new Set([options.workspaceId]));
  if (!hashesEqual(sha256(options.outsideInventory), sha256(currentOutside))) {
    const changed = changedInventoryPaths(options.outsideInventory, currentOutside);
    fail(
      `Builder or validation modified data outside the admitted project workspace: ${changed.join(", ")}.`
    );
  }
  return Object.freeze({ changedFiles: Object.freeze(actual), totalBytes });
}

function reviewRealProjectCandidate(options) {
  try {
    validateBoundedCoordinatorPlan(options.plan, {
      mission: options.mission,
      requirements: options.requirements
    });
    assert.equal(options.artifact.baseRevision, options.baseRevision);
    assert.deepEqual(
      options.artifact.operations.map((entry) => entry.path),
      options.workspace.changedFiles
    );
    assert.ok(options.workspace.changedFiles.length <= maximumChangedFiles);
    assert.ok(options.workspace.totalBytes <= maximumCandidateBytes);
    assert.ok(options.workspace.changedFiles.every((entry) => entry.startsWith("public/")));
    assert.equal(options.requirementsSha256, options.expectedRequirementsSha256);
    assert.deepEqual(
      options.validationEvidence.map((entry) => entry.command.policyId).sort(),
      ["npm-run-build", "npm-test"]
    );
    assert.ok(options.validationEvidence.every(validationSucceeded));
    assert.ok(
      options.validationEvidence.every(
        (entry) => entry.missionId === options.missionId && entry.workingDirectory === options.workspaceId
      )
    );
    return Object.freeze({
      decision: "approved",
      summary: "Exact mission, scope, immutable requirements, candidate identity, and validation evidence passed."
    });
  } catch (error) {
    return Object.freeze({ decision: "rejected", summary: safeMessage(error) });
  }
}

function publicChanges(originalRoot, artifact) {
  return Promise.all(
    artifact.operations.map(async (operation) => ({
      path: operation.path,
      operation: operation.operation,
      before:
        operation.operation === "add"
          ? null
          : await readFile(path.join(originalRoot, ...operation.path.split("/")), "utf8"),
      after: operation.operation === "delete" ? null : operation.content
    }))
  );
}

function timeline() {
  const timestamp = new Date().toISOString();
  return [
    "Coordinator plan ready",
    "Isolated Builder workspace ready",
    "TrueForge Builder completed",
    "Declared validation passed",
    "Reviewer approved the exact candidate"
  ].map((summary, index) => ({
    sequence: index + 1,
    eventType: "mission.milestone",
    actor: index === 4 ? "reviewer" : index === 0 ? "coordinator" : "builder",
    timestamp,
    milestone: `real-project.${index + 1}`,
    summary
  }));
}

async function cleanupSessionWorkspace(sandboxRoot, sessionRoot) {
  const relative = path.relative(sandboxRoot, sessionRoot);
  const [topLevel] = relative.split(path.sep);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || !topLevel) return;
  const target = path.join(sandboxRoot, topLevel);
  if (path.dirname(target) === sandboxRoot) await rm(target, { recursive: true, force: true });
}

export async function prepareRealProjectCandidate(options) {
  const canonicalTemporaryRoot = await realpath(options.temporaryRoot);
  const plan = validateBoundedCoordinatorPlan(options.plan, {
    mission: options.mission,
    requirements: options.fixture.requirements
  });
  const originalBefore = await originalProjectSnapshot(options.fixture.projectRoot);
  const manifest = runtimeManifest({
    projectId: options.projectId,
    displayName: options.fixture.requirements.displayName,
    baseRevision: options.fixture.baseRevision
  });
  const missionId = options.missionId;
  let runtimeSession;
  let builderService;
  let builderSessionId;
  let connectorConfigured = false;
  let preview;
  let previewServer;
  try {
    runtimeSession = await createTrueForgeSession({
      driver: options.driver,
      manifest,
      missionId,
      workspaceRoot: options.sandboxRoot
    });
    const workspaceId = `builder-${randomUUID()}`;
    const builderRoot = path.join(runtimeSession.workspaceRoot, workspaceId);
    await execFileAsync(
      "git",
      ["clone", "--quiet", "--no-hardlinks", options.fixture.projectRoot, builderRoot],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
    );
    const canonicalBuilderRoot = await realpath(builderRoot);
    assert.equal((await gitText(canonicalBuilderRoot, ["rev-parse", "HEAD"])).trim(), options.fixture.baseRevision);
    const gitFingerprint = await fingerprintTree(path.join(canonicalBuilderRoot, ".git"));
    const outsideInventory = await treeInventory(runtimeSession.workspaceRoot, new Set([workspaceId]));
    const boundary = await createBuilderWorkspaceBoundary({
      workspaceRoot: canonicalBuilderRoot,
      readPaths: builderReadPaths,
      writePrefix: "public",
      maximumChangedFiles,
      maximumCandidateBytes
    });
    const authorizationToken = `${randomUUID()}${randomUUID()}`;
    const serviceName = `forgeos-builder-${randomUUID()}`;
    const startedService = await startBuilderWorkspaceMcpServer({
      boundary,
      port: await unusedPort(),
      authorizationToken,
      serverName: serviceName
    });
    builderService = Object.freeze({ ...startedService, authorizationToken });
    const builderSession = await createBuilderSession(options.trueForgeBaseUrl, builderService);
    connectorConfigured = true;
    builderSessionId = builderSession.id;
    const initialPrompt = [
      "Materialize this exact mission in the current isolated project:",
      options.mission,
      "Public Coordinator plan:",
      canonicalJson(plan),
      `Immutable requirements identity: ${options.fixture.requirementsSha256}`,
      "First list and inspect the admitted project files, especially requirements.json.",
      "Then create or edit the complete working application below public/.",
      "Do not stop after describing code; use the workspace tools to write the actual files."
    ].join("\n\n");
    const assertWorkspace = async () =>
      assertAuthoritativeWorkspace({
        builderRoot: canonicalBuilderRoot,
        workspaceId,
        sessionRoot: runtimeSession.workspaceRoot,
        gitFingerprint,
        outsideInventory
      });
    const loop = await runBoundedRepairLoop({
      maximumTurns: maximumBuilderTurns,
      initialPrompt,
      runTurn: (prompt, previousTurnId) =>
        runBuilderTurn(options.trueForgeBaseUrl, builderSession.id, prompt, previousTurnId),
      assertWorkspace,
      validate: (turnNumber) => executeValidation(runtimeSession, missionId, workspaceId, turnNumber),
      onIteration: options.onIteration
    });
    const workspace = await assertWorkspace();
    const requirementsSha256 = sha256(
      canonicalJson(JSON.parse(await readFile(path.join(canonicalBuilderRoot, "requirements.json"), "utf8")))
    );
    const artifact = await generateCandidateArtifact({
      originalRoot: options.fixture.projectRoot,
      builderRoot: canonicalBuilderRoot,
      baseRevision: options.fixture.baseRevision
    });
    const artifactSha256 = candidateArtifactSha256(artifact);
    const review = reviewRealProjectCandidate({
      plan,
      mission: options.mission,
      missionId,
      requirements: options.fixture.requirements,
      baseRevision: options.fixture.baseRevision,
      artifact,
      workspace,
      workspaceId,
      requirementsSha256,
      expectedRequirementsSha256: options.fixture.requirementsSha256,
      validationEvidence: loop.validationEvidence
    });
    if (review.decision !== "approved") fail(`Reviewer rejected the candidate: ${review.summary}`);
    const testEvidence = loop.validationEvidence.map((entry) => ({
      kind: "runtime-validation",
      summary: `${entry.command.policyId} passed.`,
      observedAt: entry.completedAt,
      artifactSha256
    }));
    const reviewerVerdict = createReviewerVerdict({
      reviewId: `review-${randomUUID()}`,
      decision: "approved",
      candidateSha256: artifactSha256,
      testEvidence,
      createdAt: new Date().toISOString()
    });
    const candidate = createReviewedCandidatePatch({
      artifact,
      candidateId: `candidate-${randomUUID()}`,
      missionId,
      projectId: options.projectId,
      patchPath: `artifacts/candidate-${randomUUID()}.json`,
      testEvidence,
      reviewerVerdict,
      createdAt: new Date().toISOString()
    });
    assert.deepEqual(await originalProjectSnapshot(options.fixture.projectRoot), originalBefore);
    preview = await materializeCandidatePreview({
      artifact,
      candidate,
      originalRoot: options.fixture.projectRoot,
      temporaryRoot: canonicalTemporaryRoot
    });
    previewServer = await startCandidatePreviewServer({
      root: preview.root,
      port: 0,
      controlOrigin: options.controlOrigin
    });
    const response = await fetch(previewServer.url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) fail("Candidate preview did not serve its entry document.");
    const previewHtml = await response.text();
    for (const required of options.fixture.requirements.requiredText) {
      if (!previewHtml.includes(required) && !artifact.operations.some((entry) => entry.content?.includes(required))) {
        fail(`Candidate preview omitted a runtime requirement: ${required}.`);
      }
    }
    return Object.freeze({
      missionId,
      projectId: options.projectId,
      model: "gpt-5.4-mini",
      coordinatorModelCalls: 0,
      builderTurns: loop.builderTurns,
      repairRequired: loop.repairRequired,
      plan,
      artifact,
      candidate,
      reviewerVerdict,
      validationEvidence: loop.validationEvidence,
      changes: await publicChanges(options.fixture.projectRoot, artifact),
      timeline: timeline(),
      originalBefore,
      preview: Object.freeze({
        url: previewServer.url,
        candidateSha256: preview.candidateSha256,
        sandbox: "allow-scripts",
        source: "sealed CandidatePatch materialization"
      }),
      async closePreview() {
        await previewServer?.close();
        await preview?.close();
      }
    });
  } catch (error) {
    await previewServer?.close().catch(() => undefined);
    await preview?.close().catch(() => undefined);
    throw error;
  } finally {
    if (builderSessionId !== undefined) {
      await trueForgeApi(
        options.trueForgeBaseUrl,
        `/api/v1/sessions/${encodeURIComponent(builderSessionId)}`,
        { method: "DELETE", allowNotFound: true }
      ).catch(() => undefined);
    }
    if (connectorConfigured && builderService !== undefined) {
      await trueForgeApi(
        options.trueForgeBaseUrl,
        `/api/v1/settings/mcp-servers/${encodeURIComponent(builderService.name)}`,
        { method: "DELETE", allowNotFound: true }
      ).catch(() => undefined);
    }
    await builderService?.close().catch(() => undefined);
    if (runtimeSession !== undefined) {
      const sessionRoot = runtimeSession.workspaceRoot;
      await runtimeSession.close().catch(() => undefined);
      await cleanupSessionWorkspace(options.sandboxRoot, sessionRoot).catch(() => undefined);
    }
  }
}

export const REAL_PROJECT_LIMITS = Object.freeze({
  maximumBuilderTurns,
  maximumChangedFiles,
  maximumCandidateBytes,
  readablePaths: builderReadPaths,
  writablePrefix: "public/"
});
