import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createTrueForgeHttpDriver,
  createTrueForgeSession
} from "../packages/runtime-trueforge/src/index.js";

const baseUrl = process.env.TRUEFORGE_BASE_URL;
const workspaceRoot = process.env.TRUEFORGE_WORKSPACE_ROOT;

if (baseUrl === undefined || workspaceRoot === undefined) {
  throw new Error("TRUEFORGE_BASE_URL and TRUEFORGE_WORKSPACE_ROOT are required for the live proof.");
}

const manifest = {
  schemaVersion: "1",
  projectId: "phase-two-live-proof",
  name: "Phase Two Live Proof",
  runtime: "node",
  installCommand: { kind: "not_applicable" },
  testCommand: { kind: "policy", policyId: "npm-test", arguments: [] },
  buildCommand: { kind: "not_applicable" },
  allowedEnvironmentKeys: ["CI", "TZ"],
  sourceRevision: "b".repeat(40)
};

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
      "You execute only the exact ForgeOS Lite command supplied in the user message.",
      "Use the sandbox exec tool exactly once per turn.",
      "Do not transform, extend, or combine the supplied command."
    ].join(" ")
  }
});

let session;
try {
  session = await createTrueForgeSession({
    driver,
    manifest,
    missionId: "mission-phase-two-live-proof",
    workspaceRoot
  });

  const fixtureRoot = path.join(session.workspaceRoot, "fixture");
  await mkdir(fixtureRoot, { recursive: false });
  await writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "forgeos-lite-phase-two-live-proof",
        private: true,
        scripts: { test: "node proof-script.mjs" }
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", flag: "wx" }
  );
  await writeFile(
    path.join(fixtureRoot, "proof-script.mjs"),
    [
      'import { writeFile } from "node:fs/promises";',
      "",
      'await writeFile("phase-two-proof.txt", "TrueForge Phase 2 live proof passed.\\n", "utf8");',
      'console.log("TRUEFORGE_PHASE_TWO_EXECUTION_OK");',
      ""
    ].join("\n"),
    { encoding: "utf8", flag: "wx" }
  );

  const evidence = await session.execute({
    action: "run_tests",
    executionId: "execution-phase-two-live-proof",
    missionId: "mission-phase-two-live-proof",
    workingDirectory: "fixture",
    environment: { CI: "true", TZ: "UTC" },
    timeoutMs: 120_000
  });

  assert.equal(evidence.exitStatus, 0);
  assert.equal(evidence.timedOut, false);
  assert.equal(evidence.runtimeError, null);
  assert.match(evidence.stdout, /TRUEFORGE_PHASE_TWO_EXECUTION_OK/u);
  assert.equal(evidence.stderr, "");
  const proofPath = path.join(fixtureRoot, "phase-two-proof.txt");
  assert.equal(await readFile(proofPath, "utf8"), "TrueForge Phase 2 live proof passed.\n");
  assert.equal(proofPath.startsWith(`${session.workspaceRoot}${path.sep}`), true);

  console.log(
    JSON.stringify(
      {
        command: evidence.command,
        executionId: evidence.executionId,
        exitStatus: evidence.exitStatus,
        missionId: evidence.missionId,
        proofContent: "TrueForge Phase 2 live proof passed.",
        proofRelativePath: "fixture/phase-two-proof.txt",
        stderr: evidence.stderr,
        stdout: evidence.stdout,
        timedOut: evidence.timedOut,
        trueForgeSessionId: session.sessionId,
        workspaceConfined: true
      },
      null,
      2
    )
  );
} finally {
  if (session !== undefined) {
    await session.close();
    assert.equal(session.state, "closed");
  }
}
