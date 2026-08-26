import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { decodeOwnedText } from "./owned-text-files.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const environmentAssignment = new RegExp(`${"OPENAI_API_KEY"}\\s*=`, "u");
const privateKeyHeader = new RegExp(`${"-----BEGIN "}(?:RSA |EC |OPENSSH )?PRIVATE KEY-----`, "u");
const secretKeyPrefix = new RegExp(`s${"k-"}[A-Za-z0-9_-]{12,}`, "u");
const forbiddenEnvironmentFiles = /(?:^|\/)\.env(?:\.[^/]+)?$/u;

export function findSecretViolations(relativePath, content) {
  const violations = [];
  if (forbiddenEnvironmentFiles.test(relativePath) && relativePath !== ".env.example") {
    violations.push("tracked environment file");
  }
  if (environmentAssignment.test(content)) violations.push("OpenAI key assignment");
  if (privateKeyHeader.test(content)) violations.push("private key header");
  if (secretKeyPrefix.test(content)) violations.push("secret-like key prefix");
  return violations;
}

export async function scanRepositorySecrets(root = repositoryRoot) {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" }
  );
  const files = [];
  for (const relativePath of stdout.split("\0").filter(Boolean)) {
    const filePath = path.join(root, relativePath);
    let buffer;
    try {
      buffer = await readFile(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const content = decodeOwnedText(filePath, buffer);
    if (content !== null) files.push({ filePath, content });
  }
  const findings = [];
  for (const { filePath, content } of files) {
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    const violations = findSecretViolations(relativePath, content);
    if (violations.length > 0) findings.push({ file: relativePath, violations });
  }
  return { filesScanned: files.length, findings };
}

async function main() {
  const result = await scanRepositorySecrets();
  if (result.findings.length > 0) {
    console.error("Repository secret check failed.");
    for (const finding of result.findings) {
      console.error(`${finding.file}: ${finding.violations.join(", ")}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `Repository secret check passed (${result.filesScanned} owned text files scanned; lightweight patterns only).`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
