import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  findSecretViolations,
  scanRepositorySecrets
} from "../scripts/check-secrets.mjs";

const execFileAsync = promisify(execFile);

test("secret check recognizes intentionally ignored credential shapes", () => {
  assert.deepEqual(findSecretViolations("README.md", "No credentials here.\n"), []);
  assert.deepEqual(findSecretViolations(".env.example", "SAFE_PLACEHOLDER=value\n"), []);
});

test("secret check reports environment files and obvious secret patterns", () => {
  assert.deepEqual(findSecretViolations(".env.local", "SAFE_PLACEHOLDER=value\n"), [
    "tracked environment file"
  ]);
  assert.deepEqual(
    findSecretViolations("notes.txt", `${"OPENAI_API_KEY"}=s${"k-"}${"a".repeat(20)}\n`),
    ["OpenAI key assignment", "secret-like key prefix"]
  );
  assert.deepEqual(
    findSecretViolations("key.pem", `${"-----BEGIN "}PRIVATE KEY-----\n`),
    ["private key header"]
  );
});

test("secret scan accepts a tracked file staged for deletion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "forgeos-secret-test-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Secret Check Test"], { cwd: root });
    await execFileAsync(
      "git",
      ["config", "user.email", "secret-check@example.invalid"],
      { cwd: root }
    );
    await writeFile(path.join(root, "obsolete.txt"), "Safe tracked content.\n", "utf8");
    await execFileAsync("git", ["add", "obsolete.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "--quiet", "-m", "Add obsolete file"], {
      cwd: root
    });
    await rm(path.join(root, "obsolete.txt"));
    await execFileAsync("git", ["add", "--update"], { cwd: root });
    assert.deepEqual(await scanRepositorySecrets(root), { filesScanned: 0, findings: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
