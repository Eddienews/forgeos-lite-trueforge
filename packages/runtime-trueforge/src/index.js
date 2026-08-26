import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  assertCommandToken,
  assertNoForbiddenFields,
  assertSafeRelativePath,
  canonicalJson,
  validateProjectManifest
} from "@forgeos-lite/contracts";

export { createTrueForgeHttpDriver } from "./http-driver.js";

export const RUNTIME_SESSION_STATES = Object.freeze([
  "creating",
  "ready",
  "executing",
  "closing",
  "failed",
  "closed"
]);

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const environmentKeyPattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const secretEnvironmentKey = /(api.?key|credential|password|private|secret|token)/iu;
const actionToManifestField = Object.freeze({
  run_build: "buildCommand",
  run_install: "installCommand",
  run_tests: "testCommand"
});
const nodePolicyArgv = Object.freeze({
  "npm-ci": Object.freeze(["npm", "ci"]),
  "npm-run-build": Object.freeze(["npm", "run", "build"]),
  "npm-test": Object.freeze(["npm", "test"])
});
const resultKeys = Object.freeze([
  "command",
  "completedAt",
  "executionId",
  "exitStatus",
  "missionId",
  "runtimeError",
  "startedAt",
  "stderr",
  "stdout",
  "timedOut",
  "workingDirectory"
]);

function fail(message) {
  throw new TypeError(message);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a plain object.`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object.`);
  }
}

function assertExactKeys(value, required, optional, label) {
  assertPlainObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${label} contains unknown field: ${key}.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail(`${label} is missing required field: ${key}.`);
    }
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail(`${label} must be a stable identifier.`);
  }
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== "string") {
    fail(`${label} must be a canonical ISO 8601 timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail(`${label} must be a canonical ISO 8601 timestamp.`);
  }
}

function assertOutput(value, label) {
  if (typeof value !== "string" || value.length > 1_000_000 || value.includes("\0")) {
    fail(`${label} must be safe text no longer than 1000000 characters.`);
  }
}

function assertDriver(driver) {
  if (driver === null || (typeof driver !== "object" && typeof driver !== "function")) {
    fail("TrueForge driver must be an object.");
  }
  for (const method of ["createSession", "execute", "closeSession"]) {
    if (typeof driver[method] !== "function") {
      fail(`TrueForge driver.${method} must be a function.`);
    }
  }
}

function assertWithinRoot(root, candidate, label) {
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    fail(`${label} escapes the configured workspace root.`);
  }
}

async function validateAbsoluteDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    fail(`${label} must be an absolute host path.`);
  }
  const normalized = path.normalize(value);
  if (normalized !== value || normalized === path.parse(normalized).root) {
    fail(`${label} must be a normalized, non-root absolute host path.`);
  }
  const details = await lstat(value);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    fail(`${label} must be a real directory, not a symlink.`);
  }
  const resolved = await realpath(value);
  if (resolved !== value) {
    fail(`${label} must already use its canonical real path.`);
  }
  return resolved;
}

async function validateBoundWorkspace(configuredRoot, value) {
  const boundRoot = await validateAbsoluteDirectory(value, "TrueForge session workspaceRoot");
  assertWithinRoot(configuredRoot, boundRoot, "TrueForge session workspaceRoot");
  return boundRoot;
}

async function resolveWorkingDirectory(workspaceRoot, value) {
  assertSafeRelativePath(value, "RuntimeExecution.workingDirectory");
  const segments = value.split("/");
  let current = workspaceRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      fail("RuntimeExecution.workingDirectory must contain only real directories.");
    }
  }
  const resolved = await realpath(current);
  assertWithinRoot(workspaceRoot, resolved, "RuntimeExecution.workingDirectory");
  return resolved;
}

function validateEnvironment(value, manifest) {
  assertPlainObject(value, "RuntimeExecution.environment");
  const allowedKeys = new Set(manifest.allowedEnvironmentKeys);
  for (const [key, entry] of Object.entries(value)) {
    if (!environmentKeyPattern.test(key) || secretEnvironmentKey.test(key)) {
      fail(`RuntimeExecution.environment contains a forbidden key: ${key}.`);
    }
    if (!allowedKeys.has(key)) {
      fail(`RuntimeExecution.environment key is not declared by the manifest: ${key}.`);
    }
    if (typeof entry !== "string" || entry.length > 4096 || entry.includes("\0")) {
      fail(`RuntimeExecution.environment.${key} must be safe text.`);
    }
  }
  return Object.freeze({ ...value });
}

function commandForAction(action, manifest) {
  const manifestField = actionToManifestField[action];
  if (manifestField === undefined) {
    fail(`RuntimeExecution.action is unknown: ${String(action)}.`);
  }
  const command = manifest[manifestField];
  if (command.kind !== "policy") {
    fail(`RuntimeExecution.action ${action} is not applicable for this project.`);
  }
  const prefix = nodePolicyArgv[command.policyId];
  if (manifest.runtime !== "node" || prefix === undefined) {
    fail(`Runtime policy is not implemented in Phase 2: ${command.policyId}.`);
  }
  const argv = [...prefix, ...command.arguments];
  argv.forEach((token, index) => assertCommandToken(token, `RuntimeExecution.argv[${index}]`));
  return {
    command: Object.freeze({
      kind: command.kind,
      policyId: command.policyId,
      arguments: Object.freeze([...command.arguments])
    }),
    argv: Object.freeze(argv)
  };
}

function validateExecutionRequest(value, missionId, manifest) {
  assertExactKeys(
    value,
    ["action", "executionId", "missionId", "workingDirectory", "environment", "timeoutMs"],
    [],
    "RuntimeExecution"
  );
  assertIdentifier(value.executionId, "RuntimeExecution.executionId");
  assertIdentifier(value.missionId, "RuntimeExecution.missionId");
  if (value.missionId !== missionId) {
    fail("RuntimeExecution.missionId does not match the bound session mission.");
  }
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 300_000) {
    fail("RuntimeExecution.timeoutMs must be an integer from 1 through 300000.");
  }
  const selected = commandForAction(value.action, manifest);
  return {
    ...selected,
    environment: validateEnvironment(value.environment, manifest)
  };
}

function validateDriverResult(value) {
  assertExactKeys(
    value,
    ["exitStatus", "stdout", "stderr", "timedOut", "runtimeError"],
    [],
    "TrueForge execution result"
  );
  assertNoForbiddenFields(value, "TrueForge execution result");
  if (value.exitStatus !== null && (!Number.isInteger(value.exitStatus) || value.exitStatus < 0)) {
    fail("TrueForge execution result.exitStatus must be null or a non-negative integer.");
  }
  assertOutput(value.stdout, "TrueForge execution result.stdout");
  assertOutput(value.stderr, "TrueForge execution result.stderr");
  if (typeof value.timedOut !== "boolean") {
    fail("TrueForge execution result.timedOut must be a boolean.");
  }
  if (
    value.runtimeError !== null &&
    (typeof value.runtimeError !== "string" ||
      value.runtimeError.length > 4096 ||
      value.runtimeError.includes("\0"))
  ) {
    fail("TrueForge execution result.runtimeError must be null or safe text.");
  }
  return value;
}

export function validateRuntimeEvidence(value) {
  assertExactKeys(value, resultKeys, [], "RuntimeEvidence");
  assertNoForbiddenFields(value, "RuntimeEvidence");
  assertIdentifier(value.executionId, "RuntimeEvidence.executionId");
  assertIdentifier(value.missionId, "RuntimeEvidence.missionId");
  assertIsoTimestamp(value.startedAt, "RuntimeEvidence.startedAt");
  assertIsoTimestamp(value.completedAt, "RuntimeEvidence.completedAt");
  if (value.completedAt < value.startedAt) {
    fail("RuntimeEvidence.completedAt cannot precede startedAt.");
  }
  assertSafeRelativePath(value.workingDirectory, "RuntimeEvidence.workingDirectory");
  if (value.command === null || typeof value.command !== "object") {
    fail("RuntimeEvidence.command must be a structured command representation.");
  }
  commandForEvidence(value.command);
  validateDriverResult({
    exitStatus: value.exitStatus,
    stdout: value.stdout,
    stderr: value.stderr,
    timedOut: value.timedOut,
    runtimeError: value.runtimeError
  });
  return value;
}

function commandForEvidence(command) {
  assertExactKeys(command, ["kind", "policyId", "arguments"], [], "RuntimeEvidence.command");
  if (command.kind !== "policy" || typeof command.policyId !== "string") {
    fail("RuntimeEvidence.command must identify one runtime policy.");
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(command.policyId)) {
    fail("RuntimeEvidence.command.policyId must be a policy identifier.");
  }
  if (!Array.isArray(command.arguments) || command.arguments.length > 32) {
    fail("RuntimeEvidence.command.arguments must contain at most 32 tokens.");
  }
  command.arguments.forEach((token, index) =>
    assertCommandToken(token, `RuntimeEvidence.command.arguments[${index}]`)
  );
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message.slice(0, 4096);
  }
  return "TrueForge execution failed with a non-Error value.";
}

export class TrueForgeRuntimeSession {
  #clock;
  #closePromise;
  #driver;
  #manifest;
  #missionId;
  #sessionId;
  #state;
  #workspaceRoot;

  constructor(options) {
    this.#clock = options.clock;
    this.#closePromise = undefined;
    this.#driver = options.driver;
    this.#manifest = options.manifest;
    this.#missionId = options.missionId;
    this.#sessionId = options.sessionId;
    this.#state = "ready";
    this.#workspaceRoot = options.workspaceRoot;
  }

  get missionId() {
    return this.#missionId;
  }

  get sessionId() {
    return this.#sessionId;
  }

  get state() {
    return this.#state;
  }

  get workspaceRoot() {
    return this.#workspaceRoot;
  }

  async execute(request) {
    if (this.#state !== "ready") {
      fail(`TrueForge session cannot execute while state is ${this.#state}.`);
    }
    const validated = validateExecutionRequest(request, this.#missionId, this.#manifest);
    this.#state = "executing";
    let startedAt;
    try {
      await resolveWorkingDirectory(this.#workspaceRoot, request.workingDirectory);
      startedAt = this.#clock();
      assertIsoTimestamp(startedAt, "RuntimeEvidence.startedAt");
    } catch (error) {
      this.#state = "ready";
      throw error;
    }
    let rawResult;
    try {
      rawResult = validateDriverResult(
        await this.#driver.execute({
          argv: validated.argv,
          environment: validated.environment,
          missionId: this.#missionId,
          sessionId: this.#sessionId,
          timeoutMs: request.timeoutMs,
          workingDirectory: request.workingDirectory,
          workspaceRoot: this.#workspaceRoot
        })
      );
    } catch (error) {
      rawResult = {
        exitStatus: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        runtimeError: errorMessage(error)
      };
    }
    let completedAt;
    try {
      completedAt = this.#clock();
      assertIsoTimestamp(completedAt, "RuntimeEvidence.completedAt");
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
    const evidence = {
      executionId: request.executionId,
      missionId: this.#missionId,
      startedAt,
      completedAt,
      exitStatus: rawResult.exitStatus,
      command: validated.command,
      workingDirectory: request.workingDirectory,
      stdout: rawResult.stdout,
      stderr: rawResult.stderr,
      timedOut: rawResult.timedOut,
      runtimeError: rawResult.runtimeError
    };
    validateRuntimeEvidence(evidence);
    this.#state = rawResult.runtimeError === null ? "ready" : "failed";
    return Object.freeze(evidence);
  }

  async close() {
    if (this.#closePromise !== undefined) {
      return await this.#closePromise;
    }
    if (this.#state === "closed") {
      return;
    }
    if (this.#state === "executing") {
      fail("TrueForge session cannot close while execution is active.");
    }
    this.#state = "closing";
    this.#closePromise = (async () => {
      try {
        await this.#driver.closeSession({
          missionId: this.#missionId,
          sessionId: this.#sessionId,
          workspaceRoot: this.#workspaceRoot
        });
        this.#state = "closed";
      } catch (error) {
        this.#state = "failed";
        throw new Error(`TrueForge session shutdown failed: ${errorMessage(error)}`, { cause: error });
      }
    })();
    return await this.#closePromise;
  }
}

export async function createTrueForgeSession(options) {
  assertExactKeys(
    options,
    ["driver", "manifest", "missionId", "workspaceRoot"],
    ["clock"],
    "TrueForgeSessionOptions"
  );
  assertDriver(options.driver);
  assertIdentifier(options.missionId, "TrueForgeSessionOptions.missionId");
  const manifest = structuredClone(validateProjectManifest(options.manifest));
  const configuredRoot = await validateAbsoluteDirectory(
    options.workspaceRoot,
    "TrueForgeSessionOptions.workspaceRoot"
  );
  const clock = options.clock ?? (() => new Date().toISOString());
  if (typeof clock !== "function") {
    fail("TrueForgeSessionOptions.clock must be a function.");
  }
  let created;
  try {
    created = await options.driver.createSession({
      manifest,
      missionId: options.missionId,
      workspaceRoot: configuredRoot
    });
  } catch (error) {
    throw new Error(`TrueForge session startup failed: ${errorMessage(error)}`, { cause: error });
  }
  assertExactKeys(created, ["sessionId", "workspaceRoot"], [], "TrueForge created session");
  assertIdentifier(created.sessionId, "TrueForge created session.sessionId");
  const workspaceRoot = await validateBoundWorkspace(configuredRoot, created.workspaceRoot);
  return new TrueForgeRuntimeSession({
    clock,
    driver: options.driver,
    manifest,
    missionId: options.missionId,
    sessionId: created.sessionId,
    workspaceRoot
  });
}

export function runtimeCommandFingerprint(value) {
  commandForEvidence(value);
  return canonicalJson(value);
}
