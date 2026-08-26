import assert from "node:assert/strict";
import test from "node:test";

import { findSecretViolations } from "../scripts/check-secrets.mjs";

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
