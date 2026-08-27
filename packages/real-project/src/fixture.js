import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalJson, sha256 } from "@forgeos-lite/contracts";

const execFileAsync = promisify(execFile);

function fail(message) {
  throw new TypeError(message);
}

function canonicalStrings(value, label, maximumItems = 100) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    fail(`${label} must be a non-empty bounded array.`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 1000 || entry.includes("\0")) {
      fail(`${label} must contain bounded strings.`);
    }
  }
  return [...new Set(value)];
}

export function validateStaticWebRequirements(value) {
  const expectedKeys = [
    "schemaVersion",
    "runId",
    "displayName",
    "mission",
    "requiredText",
    "requiredControls",
    "acceptanceCriteria"
  ];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("Static web requirements must be an object.");
  }
  if (
    Object.keys(value).sort().join("\0") !== [...expectedKeys].sort().join("\0")
  ) {
    fail("Static web requirements contain an unexpected field inventory.");
  }
  if (value.schemaVersion !== "1") fail("Static web requirements schemaVersion must equal 1.");
  for (const field of ["runId", "displayName", "mission"]) {
    if (typeof value[field] !== "string" || value[field].length === 0 || value[field].length > 10_000) {
      fail(`Static web requirements ${field} must be bounded text.`);
    }
  }
  const requiredText = canonicalStrings(value.requiredText, "Static web requiredText");
  const requiredControls = canonicalStrings(
    value.requiredControls,
    "Static web requiredControls",
    8
  );
  if (requiredControls.some((entry) => !["filter", "search"].includes(entry))) {
    fail("Static web requirements contain an unsupported interaction contract.");
  }
  const acceptanceCriteria = canonicalStrings(
    value.acceptanceCriteria,
    "Static web acceptanceCriteria",
    50
  );
  return Object.freeze({
    ...value,
    requiredText: Object.freeze(requiredText),
    requiredControls: Object.freeze(requiredControls),
    acceptanceCriteria: Object.freeze(acceptanceCriteria)
  });
}

const buildCheckSource = `import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const requiredFiles = ["public/index.html", "public/app.css", "public/app.js"];
await Promise.all(requiredFiles.map((file) => access(file)));
const [html, css, script] = await Promise.all(requiredFiles.map((file) => readFile(file, "utf8")));
assert.match(html, /app\\.css/u, "HTML must load public/app.css.");
assert.match(html, /app\\.js/u, "HTML must load public/app.js.");
assert.match(css, /@media/u, "CSS must contain responsive styling.");
assert.doesNotMatch([html, css, script].join("\\n"), /https?:\\/\\//iu, "External resources are forbidden.");
console.log("Static application integrity check passed.");
`;

const acceptanceTestSource = `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const requirements = JSON.parse(await readFile("requirements.json", "utf8"));
const immutableManifest = JSON.parse(await readFile("immutable-manifest.json", "utf8"));
const requiredFiles = ["public/index.html", "public/app.css", "public/app.js"];

function fileSha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function projectFiles(directory = ".") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await projectFiles(target)));
    else result.push(target.replaceAll(path.sep, "/").replace(/^\\.\\//u, ""));
  }
  return result.sort();
}

test("generated application satisfies the immutable mission contract", async () => {
  const [html, css, script] = await Promise.all(requiredFiles.map((file) => readFile(file, "utf8")));
  const combined = [html, css, script].join("\\n");
  for (const required of requirements.requiredText) {
    assert.ok(combined.includes(required), "Generated application must contain: " + required);
  }
  assert.match(html, /app\\.css/u);
  assert.match(html, /app\\.js/u);
  assert.match(css, /@media/u, "Responsive CSS is required.");
  assert.doesNotMatch(combined, /https?:\\/\\//iu, "External HTTP resources are forbidden.");
  if (requirements.requiredControls.includes("filter")) {
    assert.match(html, /<(button|select|input)[^>]*(filter|status)/iu, "A status filter control is required.");
    assert.match(script, /addEventListener/u, "The filter must have local JavaScript behavior.");
  }
  if (requirements.requiredControls.includes("search")) {
    assert.match(html, /<input[^>]*(search|placeholder)/iu, "A local search field is required.");
    assert.match(script, /addEventListener/u, "The search field must have local JavaScript behavior.");
  }
});

test("immutable contract files and writable application scope remain intact", async () => {
  const immutablePaths = Object.keys(immutableManifest.files).sort();
  assert.deepEqual(immutablePaths, ["package.json", "requirements.json", "scripts/build-check.mjs", "test/acceptance.test.mjs"]);
  for (const file of immutablePaths) {
    assert.equal(fileSha256(await readFile(file, "utf8")), immutableManifest.files[file], "Immutable file changed: " + file);
  }
  const allowedBaseline = new Set(["immutable-manifest.json", ...immutablePaths]);
  for (const file of await projectFiles()) {
    assert.ok(allowedBaseline.has(file) || file.startsWith("public/"), "Forbidden project file: " + file);
  }
});
`;

export async function createStaticWebProject(options) {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).sort().join("\0") !== ["requirements", "temporaryRoot"].sort().join("\0")
  ) {
    fail("StaticWebProjectOptions must contain requirements and temporaryRoot only.");
  }
  const requirements = validateStaticWebRequirements(options.requirements);
  const root = await mkdtemp(path.join(options.temporaryRoot, "real-project-"));
  const projectRoot = path.join(root, "static-web-project");
  await mkdir(path.join(projectRoot, "public"), { recursive: true });
  await mkdir(path.join(projectRoot, "scripts"));
  await mkdir(path.join(projectRoot, "test"));
  await writeFile(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "forgeos-generated-static-app",
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: { build: "node scripts/build-check.mjs", test: "node --test" }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(projectRoot, "requirements.json"),
    `${JSON.stringify(requirements, null, 2)}\n`,
    "utf8"
  );
  await writeFile(path.join(projectRoot, "scripts", "build-check.mjs"), buildCheckSource, "utf8");
  await writeFile(
    path.join(projectRoot, "test", "acceptance.test.mjs"),
    acceptanceTestSource,
    "utf8"
  );
  await writeFile(
    path.join(projectRoot, "public", "index.html"),
    `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${requirements.displayName}</title></head>\n<body><main><h1>Starter project for ${requirements.displayName}</h1><p>ForgeOS will materialize this mission in an isolated workspace.</p></main></body>\n</html>\n`,
    "utf8"
  );
  const immutablePaths = [
    "package.json",
    "requirements.json",
    "scripts/build-check.mjs",
    "test/acceptance.test.mjs"
  ];
  const immutableFiles = Object.fromEntries(
    await Promise.all(
      immutablePaths.map(async (relativePath) => [
        relativePath,
        sha256(await readFile(path.join(projectRoot, relativePath), "utf8"))
      ])
    )
  );
  await writeFile(
    path.join(projectRoot, "immutable-manifest.json"),
    `${JSON.stringify({ schemaVersion: "1", files: immutableFiles }, null, 2)}\n`,
    "utf8"
  );
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: projectRoot });
  await execFileAsync("git", ["add", "."], { cwd: projectRoot });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=ForgeOS Demo",
      "-c",
      "user.email=demo@forgeos.local",
      "commit",
      "--quiet",
      "-m",
      "Create immutable static web starter"
    ],
    { cwd: projectRoot }
  );
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8"
  });
  return Object.freeze({
    temporaryRoot: await realpath(root),
    projectRoot: await realpath(projectRoot),
    baseRevision: stdout.trim(),
    requirements,
    requirementsSha256: sha256(canonicalJson(requirements))
  });
}
