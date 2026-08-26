import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectOwnedTextFiles } from "./owned-text-files.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  "cG9yIGZhdm9y",
  "ZXUgZ29zdG8gZGUgZXNjcmV2ZXIgY29kaWdv",
  "Z29zdG8=",
  "ZXNjcmV2ZXI=",
  "Y29kaWdv",
  "Y8OzZGlnbw==",
  "YWx0ZXJhY29lcw==",
  "YWx0ZXJhw6fDtWVz",
  "bmFvIGZvaSBwb3NzaXZlbA==",
  "bsOjbyBmb2kgcG9zc8OtdmVs",
  "dGVudGFyIG5vdmFtZW50ZQ==",
  "c2FsdmFyIGFsdGVyYWNvZXM=",
  "c2FsdmFyIGFsdGVyYcOnw7Vlcw==",
  "Y2xpcXVlIGFxdWk=",
  "YmVtIHZpbmRv",
  "ZW52aWFy",
  "ZXhjbHVpcg==",
  "YWRpY2lvbmFy",
  "ZWRpdGFy",
  "Y29uZmlybWFy",
  "Y29udGludWFy",
  "cGFnaW5h",
  "cMOhZ2luYQ==",
  "bWVuc2FnZW0=",
  "cmVzdWx0YWRv",
  "ZmFsaGE=",
  "Y29uZXhhbw==",
  "Y29uZXjDo28=",
  "cmVwb3NpdG9yaW8=",
  "cmVwb3NpdMOzcmlv"
];

const blockedTerms = encodedBlockedTerms.map((value, index) => ({
  id: `blocked-term-${String(index + 1).padStart(2, "0")}`,
  value: Buffer.from(value, "base64").toString("utf8").toLowerCase()
}));

function containsNonAsciiLatinLetter(text) {
  return Array.from(text).some(
    (character) => /[^\x00-\x7f]/u.test(character) && /\p{Script=Latin}/u.test(character)
  );
}

function containsTerm(text, term) {
  const normalized = text.toLowerCase();
  let offset = normalized.indexOf(term);

  while (offset !== -1) {
    const before = offset === 0 ? "" : normalized[offset - 1];
    const afterIndex = offset + term.length;
    const after = afterIndex >= normalized.length ? "" : normalized[afterIndex];
    const beforeIsLetter = /\p{Letter}/u.test(before);
    const afterIsLetter = /\p{Letter}/u.test(after);

    if (!beforeIsLetter && !afterIsLetter) {
      return true;
    }

    offset = normalized.indexOf(term, offset + 1);
  }

  return false;
}

export function findLanguageViolations(text) {
  const violations = [];
  const normalizedText = text.normalize("NFC");

  if (containsNonAsciiLatinLetter(normalizedText)) {
    violations.push("Latin accented text");
  }

  for (const term of blockedTerms) {
    if (containsTerm(normalizedText, term.value)) {
      violations.push(`Blocked non-English term (${term.id})`);
    }
  }

  return violations;
}

export async function scanRepository(root = repositoryRoot) {
  const files = await collectOwnedTextFiles(root);
  const findings = [];

  for (const { filePath, content } of files) {
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
