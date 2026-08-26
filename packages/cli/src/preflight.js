import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import envPaths from "env-paths";

const execFileAsync = promisify(execFile);
const supportedTrueForgeVersion = "0.1.4";

function cleanEnvironment() {
  const environment = { ...process.env };
  delete environment.OPENAI_API_KEY;
  return environment;
}

export function usableApiKey(value) {
  return (
    typeof value === "string" &&
    value.trim().length >= 20 &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}

export function nodeVersionCompatible(version = process.versions.node) {
  const [major] = version.split(".").map(Number);
  return major === 22;
}

async function confirmPortBinding() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function ensurePrivateTemporaryRoot(temporaryRoot) {
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  let details = await lstat(temporaryRoot);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${temporaryRoot} must be a real directory, not a symlink.`);
  }
  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && details.uid !== currentUserId) {
    throw new Error(`${temporaryRoot} must be owned by the current user.`);
  }
  if ((details.mode & 0o777) !== 0o700) {
    await chmod(temporaryRoot, 0o700);
    details = await lstat(temporaryRoot);
  }
  if (
    !details.isDirectory() ||
    details.isSymbolicLink() ||
    (currentUserId !== undefined && details.uid !== currentUserId) ||
    (details.mode & 0o777) !== 0o700
  ) {
    throw new Error(`${temporaryRoot} must remain a private current-user directory with mode 0700.`);
  }
  const resolvedBeforeAccess = await realpath(temporaryRoot);
  await access(temporaryRoot, constants.R_OK | constants.W_OK | constants.X_OK);
  if ((await realpath(temporaryRoot)) !== resolvedBeforeAccess) {
    throw new Error(`${temporaryRoot} changed during its security check.`);
  }
  return resolvedBeforeAccess;
}

async function trueForgeCandidate(repositoryRoot, configuredBinary) {
  const candidates = [
    ...(configuredBinary === undefined ? [] : [configuredBinary]),
    path.join(repositoryRoot, "node_modules", ".bin", "trueforge"),
    "trueforge"
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(candidate, ["--help"], {
        encoding: "utf8",
        env: cleanEnvironment(),
        timeout: 15_000
      });
      const output = `${stdout}\n${stderr}`;
      if (!output.includes(`TrueForge v${supportedTrueForgeVersion}`)) {
        errors.push(`${candidate}: expected TrueForge ${supportedTrueForgeVersion}`);
        continue;
      }
      return { binary: candidate, version: supportedTrueForgeVersion };
    } catch {
      errors.push(`${candidate}: unavailable`);
    }
  }
  throw new Error(
    `TrueForge ${supportedTrueForgeVersion} is unavailable. Run npm install or set TRUEFORGE_BINARY to the qualified executable. ${errors.join("; ")}`
  );
}

export async function runPreflight(options) {
  const repositoryRoot = await realpath(options.repositoryRoot);
  const checks = [];
  if (!nodeVersionCompatible()) {
    throw new Error(`Node.js 22 is required; detected ${process.versions.node}.`);
  }
  checks.push(`Node.js ${process.versions.node}`);

  const { stdout: gitVersion } = await execFileAsync("git", ["--version"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  checks.push(gitVersion.trim());

  if (!usableApiKey(process.env.OPENAI_API_KEY)) {
    throw new Error("OPENAI_API_KEY is unavailable. Configure it in the ignored .env.local file.");
  }
  checks.push("OPENAI_API_KEY available without disclosure");

  const trueForge = await trueForgeCandidate(repositoryRoot, process.env.TRUEFORGE_BINARY);
  checks.push(`TrueForge ${trueForge.version}`);

  const temporaryRoot = "/tmp/forgeos-lite";
  await ensurePrivateTemporaryRoot(temporaryRoot);
  checks.push("private short TMPDIR /tmp/forgeos-lite");

  await confirmPortBinding();
  await confirmPortBinding();
  checks.push("two loopback service ports available");

  await access(path.join(repositoryRoot, "node_modules"), constants.R_OK | constants.X_OK);
  await access(
    path.join(repositoryRoot, "node_modules", "@modelcontextprotocol", "sdk"),
    constants.R_OK | constants.X_OK
  );
  checks.push("dependencies installed");

  const { stdout: status } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  if (options.requireCleanRepository !== false && status !== "") {
    throw new Error("The ForgeOS Lite checkout has tracked or untracked changes. Commit or remove them before the demo.");
  }
  checks.push("ForgeOS Lite checkout clean");

  const sandboxRoot = path.join(envPaths("trueforge", { suffix: "" }).data, "sandboxes");
  await mkdir(sandboxRoot, { recursive: true });
  return Object.freeze({
    checks: Object.freeze(checks),
    repositoryRoot,
    sandboxRoot: await realpath(sandboxRoot),
    temporaryRoot,
    trueForgeBinary: trueForge.binary,
    trueForgeVersion: trueForge.version
  });
}
