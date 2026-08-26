import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  return execFileAsync("git", args, { cwd: root, encoding: "utf8" });
}

async function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

export async function createDemoProject(demoRoot) {
  const projectRoot = path.join(demoRoot, "greeting-project");
  await mkdir(projectRoot);
  await git(projectRoot, "init", "--quiet");
  await git(projectRoot, "config", "user.name", "ForgeOS Lite Demo");
  await git(projectRoot, "config", "user.email", "forgeos-lite-demo@example.invalid");
  await write(
    projectRoot,
    "package.json",
    `${JSON.stringify(
      {
        name: "forgeos-lite-greeting-demo",
        private: true,
        type: "module",
        scripts: { build: "node build.mjs", test: "node --test" }
      },
      null,
      2
    )}\n`
  );
  await write(projectRoot, ".npmrc", "loglevel=silent\nlogs-max=0\nupdate-notifier=false\n");
  await write(
    projectRoot,
    "build.mjs",
    [
      'import { writeFile } from "node:fs/promises";',
      "",
      'const nextSource = \'export const greeting = "Hello from the TrueForge sandbox.";\\n\';',
      'await writeFile("src/greeting.js", nextSource, "utf8");',
      'console.log("Greeting updated in the isolated Builder workspace.");',
      ""
    ].join("\n")
  );
  await write(
    projectRoot,
    "src/greeting.js",
    'export const greeting = "Hello from the original project.";\n'
  );
  await write(
    projectRoot,
    "test/greeting.test.mjs",
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { greeting } from "../src/greeting.js";',
      "",
      'test("greeting remains a clear English sentence", () => {',
      '  assert.match(greeting, /^Hello from the (original project|TrueForge sandbox)\\.$/u);',
      "});",
      ""
    ].join("\n")
  );
  await git(projectRoot, "add", ".");
  await git(projectRoot, "commit", "--quiet", "-m", "Create demo baseline");
  const canonicalRoot = await realpath(projectRoot);
  const baseRevision = (await git(canonicalRoot, "rev-parse", "HEAD")).stdout.trim();
  const originalGreeting = await readFile(path.join(canonicalRoot, "src/greeting.js"), "utf8");
  return Object.freeze({ projectRoot: canonicalRoot, baseRevision, originalGreeting });
}

async function main() {
  const requestedRoot = process.argv[2];
  if (requestedRoot === undefined || !path.isAbsolute(requestedRoot)) {
    throw new Error("Usage: node scripts/create-demo-project.mjs /absolute/demo/root");
  }
  const result = await createDemoProject(await realpath(requestedRoot));
  console.log(`Demo project created: ${result.projectRoot}`);
  console.log(`Baseline revision: ${result.baseRevision}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
