import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  createTrueForgeHttpDriver,
  createTrueForgeSession,
  runtimeCommandFingerprint,
  validateRuntimeEvidence
} from "../../packages/runtime-trueforge/src/index.js";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((entry) => rm(entry, { force: true, recursive: true }))
  );
});

function validManifest(argumentsValue = []) {
  return {
    schemaVersion: "1",
    projectId: "project-phase-two",
    name: "Phase Two Fixture",
    runtime: "node",
    installCommand: { kind: "policy", policyId: "npm-ci", arguments: [] },
    testCommand: { kind: "policy", policyId: "npm-test", arguments: argumentsValue },
    buildCommand: { kind: "policy", policyId: "npm-run-build", arguments: [] },
    allowedEnvironmentKeys: ["CI", "TZ"],
    sourceRevision: "a".repeat(40)
  };
}

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "forgeos-lite-runtime-test-"));
  temporaryRoots.push(root);
  const bound = path.join(root, "session-one");
  await mkdir(path.join(bound, "fixture"), { recursive: true });
  return { root: await real(root), bound: await real(bound) };
}

async function real(value) {
  return await import("node:fs/promises").then(({ realpath }) => realpath(value));
}

function successfulDriver(boundRoot, overrides = {}) {
  const calls = [];
  const driver = {
    async createSession(input) {
      calls.push({ method: "createSession", input });
      return { sessionId: "trueforge-session-one", workspaceRoot: boundRoot };
    },
    async execute(input) {
      calls.push({ method: "execute", input });
      return {
        exitStatus: 0,
        stdout: "fixture passed\n",
        stderr: "",
        timedOut: false,
        runtimeError: null
      };
    },
    async closeSession(input) {
      calls.push({ method: "closeSession", input });
    },
    ...overrides
  };
  return { calls, driver };
}

function execution(overrides = {}) {
  return {
    action: "run_tests",
    executionId: "execution-one",
    missionId: "mission-one",
    workingDirectory: "fixture",
    environment: { CI: "true", TZ: "UTC" },
    timeoutMs: 10_000,
    ...overrides
  };
}

async function readySession(options = {}) {
  const paths = await workspace();
  const fake = successfulDriver(paths.bound, options.driverOverrides);
  const session = await createTrueForgeSession({
    driver: fake.driver,
    manifest: options.manifest ?? validManifest(),
    missionId: "mission-one",
    workspaceRoot: paths.root,
    ...(options.clock === undefined ? {} : { clock: options.clock })
  });
  return { ...paths, ...fake, session };
}

test("runs one declared policy through the replaceable TrueForge boundary", async () => {
  const times = ["2026-08-26T12:00:00.000Z", "2026-08-26T12:00:01.000Z"];
  const { calls, session } = await readySession({ clock: () => times.shift() });
  const evidence = await session.execute(execution());

  assert.equal(session.state, "ready");
  assert.equal(evidence.exitStatus, 0);
  assert.deepEqual(evidence.command, { kind: "policy", policyId: "npm-test", arguments: [] });
  assert.deepEqual(calls[1].input.argv, ["npm", "test"]);
  assert.equal(calls[1].input.workingDirectory, path.join(session.workspaceRoot, "fixture"));
  assert.equal(evidence.workingDirectory, "fixture");
  assert.equal(Object.hasOwn(evidence, "environment"), false);
  assert.equal(validateRuntimeEvidence(evidence), evidence);

  await session.close();
  assert.equal(session.state, "closed");
});

test("exposes stable session identity and a confined workspace", async () => {
  const { bound, session } = await readySession();
  assert.equal(session.sessionId, "trueforge-session-one");
  assert.equal(session.missionId, "mission-one");
  assert.equal(session.workspaceRoot, bound);
  assert.equal(session.state, "ready");
});

test("rejects an unknown runtime action", async () => {
  const { session } = await readySession();
  await assert.rejects(session.execute(execution({ action: "run_anything" })), /unknown/u);
});

test("rejects unknown execution fields", async () => {
  const { session } = await readySession();
  await assert.rejects(session.execute({ ...execution(), rawCommand: "npm test" }), /unknown field/u);
});

test("rejects traversal, absolute, null, and malformed working directories", async () => {
  const { session } = await readySession();
  for (const workingDirectory of ["../outside", "/tmp/outside", "bad\0path", "fixture/../outside"]) {
    await assert.rejects(session.execute(execution({ workingDirectory })), /safe|unsafe|path/u);
  }
});

test("rejects a working-directory symlink escape", async () => {
  const { bound, root, session } = await readySession();
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(bound, "linked"));
  await assert.rejects(
    session.execute(execution({ workingDirectory: "linked" })),
    /real directories/u
  );
});

test("rejects a driver workspace outside the trusted root", async () => {
  const trusted = await workspace();
  const outside = await mkdtemp(path.join(os.tmpdir(), "forgeos-lite-outside-"));
  temporaryRoots.push(outside);
  const { calls, driver } = successfulDriver(await real(outside));
  await assert.rejects(
    createTrueForgeSession({
      driver,
      manifest: validManifest(),
      missionId: "mission-one",
      workspaceRoot: trusted.root
    }),
    /escapes/u
  );
  assert.equal(calls.filter((entry) => entry.method === "closeSession").length, 1);
});

test("reports cleanup failure after rejecting invalid startup metadata", async () => {
  const trusted = await workspace();
  const outside = await mkdtemp(path.join(os.tmpdir(), "forgeos-lite-outside-"));
  temporaryRoots.push(outside);
  const { driver } = successfulDriver(await real(outside), {
    async closeSession() {
      throw new Error("cleanup transport unavailable");
    }
  });
  await assert.rejects(
    createTrueForgeSession({
      driver,
      manifest: validManifest(),
      missionId: "mission-one",
      workspaceRoot: trusted.root
    }),
    /startup validation failed:.*escapes.*Cleanup failed: cleanup transport unavailable/u
  );
});

test("rejects a symlink as the configured workspace root", async () => {
  const target = await workspace();
  const link = path.join(path.dirname(target.root), `${path.basename(target.root)}-link`);
  temporaryRoots.push(link);
  await symlink(target.root, link);
  const { driver } = successfulDriver(target.bound);
  await assert.rejects(
    createTrueForgeSession({
      driver,
      manifest: validManifest(),
      missionId: "mission-one",
      workspaceRoot: link
    }),
    /symlink|canonical/u
  );
});

test("preserves Phase 1 rejection of shell operators and substitutions", async () => {
  const paths = await workspace();
  const { driver } = successfulDriver(paths.bound);
  for (const token of ["alpha&&beta", "alpha|beta", "result>file", "$(command)", "alpha;beta"]) {
    await assert.rejects(
      createTrueForgeSession({
        driver,
        manifest: validManifest([token]),
        missionId: "mission-one",
        workspaceRoot: paths.root
      }),
      /forbidden shell/u
    );
  }
});

test("preserves Phase 1 rejection of interpreter evaluation and environment assignment", async () => {
  const paths = await workspace();
  const { driver } = successfulDriver(paths.bound);
  for (const token of ["--eval=code", "NODE_ENV=production"]) {
    await assert.rejects(
      createTrueForgeSession({
        driver,
        manifest: validManifest([token]),
        missionId: "mission-one",
        workspaceRoot: paths.root
      }),
      /interpreter evaluation|environment assignment/u
    );
  }
});

test("rejects npm configuration and path arguments that could redirect execution", async () => {
  for (const argument of [
    "--prefix=/tmp/other-project",
    "--prefix",
    "/tmp/other-project",
    "--userconfig=/tmp/npmrc",
    "--script-shell=/tmp/custom-shell"
  ]) {
    const { session } = await readySession({ manifest: validManifest([argument]) });
    await assert.rejects(session.execute(execution()), /arguments are not implemented/u);
  }
});

test("rejects undeclared and secret-bearing environment injection", async () => {
  const { session } = await readySession();
  await assert.rejects(
    session.execute(execution({ environment: { HOME: "/tmp" } })),
    /not declared/u
  );
  await assert.rejects(
    session.execute(execution({ environment: { API_TOKEN: "hidden" } })),
    /forbidden key/u
  );
});

test("normalizes a runtime failure without hiding it", async () => {
  const { session } = await readySession({
    driverOverrides: {
      async execute() {
        throw new Error("runtime transport unavailable");
      }
    }
  });
  const evidence = await session.execute(execution());
  assert.equal(evidence.exitStatus, null);
  assert.equal(evidence.runtimeError, "runtime transport unavailable");
  assert.equal(session.state, "failed");
});

test("normalizes timeout evidence separately from runtime failure", async () => {
  const { session } = await readySession({
    driverOverrides: {
      async execute() {
        return {
          exitStatus: null,
          stdout: "",
          stderr: "",
          timedOut: true,
          runtimeError: null
        };
      }
    }
  });
  const evidence = await session.execute(execution());
  assert.equal(evidence.timedOut, true);
  assert.equal(evidence.runtimeError, null);
  assert.equal(session.state, "ready");
});

test("passes the execution deadline signal to merged-history retrieval", async () => {
  const requests = [];
  const driver = createTrueForgeHttpDriver({
    agentSpec: { model: "qualified-test-model" },
    baseUrl: "http://localhost:8792",
    async fetchImpl(url, init) {
      requests.push({ url, init });
      if (url.endsWith("/turns")) {
        return {
          ok: true,
          async text() {
            return 'data: {"event":{"type":"turn.completed"}}\n';
          }
        };
      }
      assert.match(url, /\/events\?limit=100$/u);
      assert.ok(init.signal instanceof AbortSignal);
      throw new Error("history transport stopped");
    }
  });
  const result = await driver.execute({
    argv: ["npm", "test"],
    environment: {},
    sessionId: "trueforge-session-one",
    timeoutMs: 10_000,
    workingDirectory: "/tmp/confined/fixture"
  });
  assert.equal(requests.length, 2);
  assert.equal(result.runtimeError, "history transport stopped");
});

test("marks a timeout as failed when TrueForge cancellation fails", async () => {
  const driver = createTrueForgeHttpDriver({
    agentSpec: { model: "qualified-test-model" },
    baseUrl: "http://localhost:8792",
    async fetchImpl(url) {
      if (url.endsWith("/turns")) {
        throw new DOMException("execution deadline elapsed", "AbortError");
      }
      assert.match(url, /\/cancel$/u);
      throw new Error("cancel transport unavailable");
    }
  });
  const result = await driver.execute({
    argv: ["npm", "test"],
    environment: {},
    sessionId: "trueforge-session-one",
    timeoutMs: 10_000,
    workingDirectory: "/tmp/confined/fixture"
  });
  assert.equal(result.timedOut, true);
  assert.equal(
    result.runtimeError,
    "TrueForge timeout cancellation failed: cancel transport unavailable"
  );
});

test("keeps a session failed when timeout cancellation is unconfirmed", async () => {
  const { session } = await readySession({
    driverOverrides: {
      async execute() {
        return {
          exitStatus: null,
          stdout: "",
          stderr: "",
          timedOut: true,
          runtimeError: "TrueForge timeout cancellation failed: unavailable"
        };
      }
    }
  });
  const evidence = await session.execute(execution());
  assert.equal(evidence.timedOut, true);
  assert.match(evidence.runtimeError, /cancellation failed/u);
  assert.equal(session.state, "failed");
  await assert.rejects(
    session.execute(execution({ executionId: "execution-two" })),
    /state is failed/u
  );
});

test("removes forbidden private reasoning from the evidence boundary", async () => {
  const { session } = await readySession({
    driverOverrides: {
      async execute() {
        return {
          exitStatus: 0,
          stdout: "ok\n",
          stderr: "",
          timedOut: false,
          runtimeError: null,
          reasoning: "private"
        };
      }
    }
  });
  const evidence = await session.execute(execution());
  assert.match(evidence.runtimeError, /unknown field|forbidden field/u);
  assert.equal(Object.hasOwn(evidence, "reasoning"), false);
  assert.equal(session.state, "failed");
});

test("surfaces session startup failure", async () => {
  const paths = await workspace();
  const { driver } = successfulDriver(paths.bound, {
    async createSession() {
      throw new Error("TrueForge is unavailable");
    }
  });
  await assert.rejects(
    createTrueForgeSession({
      driver,
      manifest: validManifest(),
      missionId: "mission-one",
      workspaceRoot: paths.root
    }),
    /startup failed: TrueForge is unavailable/u
  );
});

test("rejects execution after session close", async () => {
  const { session } = await readySession();
  await session.close();
  await assert.rejects(session.execute(execution()), /state is closed/u);
});

test("rejects concurrent execution in one TrueForge session", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { session } = await readySession({
    driverOverrides: {
      async execute() {
        await pending;
        return {
          exitStatus: 0,
          stdout: "done\n",
          stderr: "",
          timedOut: false,
          runtimeError: null
        };
      }
    }
  });
  const first = session.execute(execution());
  await assert.rejects(
    session.execute(execution({ executionId: "execution-two" })),
    /state is executing/u
  );
  release();
  await first;
});

test("close is idempotent and releases the TrueForge session once", async () => {
  const { calls, session } = await readySession();
  await session.close();
  await session.close();
  assert.equal(calls.filter((entry) => entry.method === "closeSession").length, 1);
});

test("rejects execution while shutdown is active", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { session } = await readySession({
    driverOverrides: {
      async closeSession() {
        await pending;
      }
    }
  });
  const closing = session.close();
  assert.equal(session.state, "closing");
  await assert.rejects(session.execute(execution()), /state is closing/u);
  release();
  await closing;
  assert.equal(session.state, "closed");
});

test("surfaces shutdown failure and retains failed state", async () => {
  let attempts = 0;
  const { session } = await readySession({
    driverOverrides: {
      async closeSession() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("release failed");
        }
      }
    }
  });
  await assert.rejects(session.close(), /shutdown failed: release failed/u);
  assert.equal(session.state, "failed");
  await session.close();
  assert.equal(attempts, 2);
  assert.equal(session.state, "closed");
});

test("rejects execution evidence containing a private conversation field", () => {
  assert.throws(
    () =>
      validateRuntimeEvidence({
        executionId: "execution-one",
        missionId: "mission-one",
        startedAt: "2026-08-26T12:00:00.000Z",
        completedAt: "2026-08-26T12:00:01.000Z",
        exitStatus: 0,
        command: {
          kind: "policy",
          policyId: "npm-test",
          arguments: [],
          conversationHistory: []
        },
        workingDirectory: "fixture",
        stdout: "ok\n",
        stderr: "",
        timedOut: false,
        runtimeError: null
      }),
    /unknown field|forbidden field/u
  );
});

test("fingerprints only the structured command representation", () => {
  assert.equal(
    runtimeCommandFingerprint({ kind: "policy", policyId: "npm-test", arguments: ["--runInBand"] }),
    '{"arguments":["--runInBand"],"kind":"policy","policyId":"npm-test"}'
  );
});
