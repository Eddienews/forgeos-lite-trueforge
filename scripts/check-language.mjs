import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const excludedDirectories = new Set([
  ".git",
  ".cache",
  ".next",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "tmp",
  "vendor"
]);

const scannedExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".py",
  ".scss",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

const extensionlessFiles = new Set([".editorconfig", ".gitignore", "LICENSE"]);

const encodedBlockedTerms = [
  "bsOjbw==",
  "b2JyaWdhZG8=",
  "YXJxdWl2bw==",
  "cHJvamV0bw==",
  "Y29uZmlndXJhw6fDo28=",
  "ZXJybw==",
  "c3VjZXNzbw==",
  "Y2FycmVnYW5kbw==",
  "c2FsdmFy",
  "Y2FuY2VsYXI=",
  "dXN1w6FyaW8=",
  "c2VuaGE=",
  "bWlzc8Ojbw==",
  "YXByb3Zhw6fDo28=",
  "cmV2aXPDo28=",
  "ZXhlY3V0YXI=",
  "dGVzdGU=",
  "Y2xpcXVl",
  "dm9sdGFy",
  "cHLDs3hpbW8=",
  "Y29uY2x1aXI=",
  "cG9ydHVndcOqcw==",
  "YmVtLXZpbmRv",
  "ZXN0ZSByZXBvc2l0w7NyaW8=",
  "cG9yIGZhdm9y"
];

const blockedTerms = encodedBlockedTerms.map((value, index) => ({
  id: `blocked-term-${String(index + 1).padStart(2, "0")}`,
  value: Buffer.from(value, "base64").toString("utf8").toLowerCase()
}));

const unintendedLatinAccent = /[\u00c0-\u00ff\u0100-\u017f]/u;

function isTextFile(filePath) {
  const name = path.basename(filePath);
  return extensionlessFiles.has(name) || scannedExtensions.has(path.extname(name).toLowerCase());
}

function containsTerm(text, term) {
  const normalized = text.toLowerCase();
  let offset = normalized.indexOf(term);

  while (offset !== -1) {
    const before = offset === 0 ? "" : normalized[offset - 1];
    const afterIndex = offset + term.length;
    const after = afterIndex >= normalized.length ? "" : normalized[afterIndex];
    const beforeIsLetter = /[a-z\u00c0-\u017f]/u.test(before);
    const afterIsLetter = /[a-z\u00c0-\u017f]/u.test(after);

    if (!beforeIsLetter && !afterIsLetter) {
      return true;
    }

    offset = normalized.indexOf(term, offset + 1);
  }

  return false;
}

export function findLanguageViolations(text) {
  const violations = [];

  if (unintendedLatinAccent.test(text)) {
    violations.push("Latin accented text");
  }

  for (const term of blockedTerms) {
    if (containsTerm(text, term.value)) {
      violations.push(`Blocked non-English term (${term.id})`);
    }
  }

  return violations;
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else if (entry.isFile() && isTextFile(entryPath)) {
      files.push(entryPath);
    }
  }

  return files;
}

export async function scanRepository(root = repositoryRoot) {
  const files = await collectFiles(root);
  const findings = [];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    const violations = findLanguageViolations(content);

    if (violations.length > 0) {
      findings.push({
        file: path.relative(root, filePath),
        violations
      });
    }
  }

  return { filesScanned: files.length, findings };
}

async function main() {
  const result = await scanRepository();

  if (result.findings.length > 0) {
    console.error("Repository language check failed.");
    for (const finding of result.findings) {
      console.error(`${finding.file}: ${finding.violations.join(", ")}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Repository language check passed (${result.filesScanned} files scanned).`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
