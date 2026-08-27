import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBuilderWorkspaceBoundary } from "@forgeos-lite/mcp-server";
import { createStaticWebProject } from "@forgeos-lite/real-project";

function requirements() {
  return {
    schemaVersion: "1",
    runId: "BOUNDARY-1",
    displayName: "Boundary Fixture",
    mission: "Build a bounded static application.",
    requiredText: ["Boundary Fixture"],
    requiredControls: ["filter"],
    acceptanceChecks: [
      { kind: "visible-text", value: "Boundary Fixture" },
      { kind: "control", value: "filter" }
    ],
    acceptanceCriteria: [
      "Display exact visible text: Boundary Fixture",
      "Provide local filter behavior."
    ]
  };
}

async function fixture(maximumChangedFiles = 8, maximumCandidateBytes = 200_000) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "forgeos-boundary-test-"));
  const project = await createStaticWebProject({ temporaryRoot, requirements: requirements() });
  const boundary = await createBuilderWorkspaceBoundary({
    workspaceRoot: project.projectRoot,
    readPaths: [
      "package.json",
      "requirements.json",
      "scripts/build-check.mjs",
      "test/acceptance.test.mjs"
    ],
    writePrefix: "public",
    maximumChangedFiles,
    maximumCandidateBytes
  });
  return { temporaryRoot, project, boundary };
}

test("Builder workspace exposes admitted reads and public-only text writes", async () => {
  const value = await fixture();
  try {
    assert.match(await value.boundary.readTextFile("requirements.json"), /Boundary Fixture/u);
    await value.boundary.writeTextFile("public/app.css", "body { color: #fff; }\n");
    await value.boundary.writeTextFile("public/app.js", "document.body.dataset.ready = 'true';\n");
    assert.deepEqual(await value.boundary.changedFiles(), ["public/app.css", "public/app.js"]);
    assert.match(await value.boundary.readTextFile("public/app.css"), /color/u);
  } finally {
    await rm(value.temporaryRoot, { recursive: true, force: true });
  }
});

test("Builder workspace rejects immutable, traversal, Git, absolute, and null-byte paths", async () => {
  const value = await fixture();
  try {
    for (const target of [
      "requirements.json",
      "package.json",
      "test/acceptance.test.mjs",
      "scripts/build-check.mjs",
      ".git/config",
      "../escape.txt",
      "/tmp/escape.txt",
      "public/../requirements.json",
      "public/bad\0.txt"
    ]) {
      await assert.rejects(
        value.boundary.writeTextFile(target, "forbidden\n"),
        /path|public|relative|dotfiles|safe/u
      );
    }
  } finally {
    await rm(value.temporaryRoot, { recursive: true, force: true });
  }
});

test("Builder workspace rejects symlink escape and executable-file mutation", async () => {
  const value = await fixture();
  const outside = path.join(value.temporaryRoot, "outside.txt");
  try {
    await writeFile(outside, "outside\n", "utf8");
    await symlink(outside, path.join(value.project.projectRoot, "public", "escape.txt"));
    await assert.rejects(value.boundary.readTextFile("public/escape.txt"), /symlink/u);
    await unlink(path.join(value.project.projectRoot, "public", "escape.txt"));
    await chmod(path.join(value.project.projectRoot, "public", "index.html"), 0o755);
    await assert.rejects(
      value.boundary.writeTextFile("public/index.html", "replacement\n"),
      /executable/u
    );
  } finally {
    await rm(value.temporaryRoot, { recursive: true, force: true });
  }
});

test("Builder workspace enforces per-file, changed-file, and total candidate bounds", async () => {
  const value = await fixture(2, 20);
  try {
    await assert.rejects(
      value.boundary.writeTextFile("public/large.txt", "x".repeat(100_001)),
      /bounded/u
    );
    await value.boundary.writeTextFile("public/a.txt", "1234567890");
    await value.boundary.writeTextFile("public/b.txt", "1234567890");
    await assert.rejects(
      value.boundary.writeTextFile("public/c.txt", "x"),
      /changed-file limit/u
    );
    await assert.rejects(
      value.boundary.writeTextFile("public/b.txt", "12345678901"),
      /total text-size limit/u
    );
  } finally {
    await rm(value.temporaryRoot, { recursive: true, force: true });
  }
});
