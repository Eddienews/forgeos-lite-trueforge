import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const excluded = new Set([".git", "node_modules", "coverage", "dist", "build", "out", ".next"]);
const extensions = new Set([".js", ".json", ".md", ".mjs", ".yml", ".yaml"]);
const violations = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && excluded.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath);
      continue;
    }

    if (!entry.isFile() || (!extensions.has(path.extname(entry.name)) && entry.name !== "LICENSE")) {
      continue;
    }

    const content = await readFile(entryPath, "utf8");
    const relativePath = path.relative(root, entryPath);
    if (!content.endsWith("\n")) {
      violations.push(`${relativePath}: missing final newline`);
    }
    content.split("\n").forEach((line, index) => {
      if (/[ \t]+$/u.test(line)) {
        violations.push(`${relativePath}:${index + 1}: trailing whitespace`);
      }
    });
  }
}

await walk(root);

if (violations.length > 0) {
  console.error("Formatting check failed.");
  violations.forEach((violation) => console.error(violation));
  process.exitCode = 1;
} else {
  console.log("Formatting check passed.");
}

