import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectOwnedTextFiles } from "./owned-text-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function findFormattingViolations(content, relativePath) {
  const violations = [];

  if (!content.endsWith("\n")) {
    violations.push(`${relativePath}: missing final newline`);
  }
  content.split("\n").forEach((line, index) => {
    if (/[ \t]+$/u.test(line)) {
      violations.push(`${relativePath}:${index + 1}: trailing whitespace`);
    }
  });

  return violations;
}

async function main() {
  const files = await collectOwnedTextFiles(root);
  const violations = files.flatMap(({ filePath, content }) =>
    findFormattingViolations(content, path.relative(root, filePath))
  );

  if (violations.length > 0) {
    console.error("Formatting check failed.");
    violations.forEach((violation) => console.error(violation));
    process.exitCode = 1;
  } else {
    console.log(`Formatting check passed (${files.length} files scanned).`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
