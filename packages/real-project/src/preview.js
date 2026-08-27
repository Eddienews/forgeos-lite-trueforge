import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  candidateArtifactSha256,
  validateCandidateArtifact
} from "@forgeos-lite/candidate-patch";
import { hashesEqual, sha256, validateCandidatePatch } from "@forgeos-lite/contracts";

const execFileAsync = promisify(execFile);
const controlOriginPattern = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u;
const revisionPattern = /^[a-f0-9]{40}$/u;

function fail(message) {
  throw new TypeError(message);
}

async function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    fail(`${label} must be an absolute path.`);
  }
  const normalized = path.normalize(value);
  if (normalized !== value || normalized === path.parse(normalized).root) {
    fail(`${label} must be a normalized non-root path.`);
  }
  const details = await lstat(value);
  if (!details.isDirectory() || details.isSymbolicLink()) fail(`${label} must be a real directory.`);
  const resolved = await realpath(value);
  if (resolved !== value) fail(`${label} must already be canonical.`);
  return resolved;
}

async function gitText(root, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout;
}

async function copyTextTree(source, destination) {
  let entries = 0;
  async function visit(currentSource, currentDestination) {
    await mkdir(currentDestination, { recursive: true, mode: 0o755 });
    const names = await readdir(currentSource);
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (name.startsWith(".")) fail("Preview source cannot contain dotfiles.");
      const sourcePath = path.join(currentSource, name);
      const destinationPath = path.join(currentDestination, name);
      const details = await lstat(sourcePath);
      entries += 1;
      if (entries > 1000) fail("Preview source exceeds its file-count safety bound.");
      if (details.isSymbolicLink()) fail("Preview source cannot contain symlinks.");
      if (details.isDirectory()) {
        await visit(sourcePath, destinationPath);
      } else if (details.isFile()) {
        if (details.size > 1_000_000) fail("Preview source file exceeds its size bound.");
        const content = await readFile(sourcePath);
        if (content.includes(0)) fail("Preview source must contain text files only.");
        const text = new TextDecoder("utf-8", { fatal: true })
          .decode(content)
          .replace(/\r\n?/gu, "\n");
        const handle = await open(
          destinationPath,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            (fsConstants.O_NOFOLLOW ?? 0),
          0o644
        );
        try {
          await handle.writeFile(text, "utf8");
        } finally {
          await handle.close();
        }
      } else {
        fail("Preview source contains an unsupported filesystem entry.");
      }
    }
  }
  await visit(source, destination);
}

async function ensurePreviewParents(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const details = await lstat(current);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        fail("Preview candidate contains an unsafe parent path.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o755 });
    }
    const resolved = await realpath(current);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      fail("Preview candidate parent escapes its root.");
    }
  }
}

async function previewEntry(root, relativePath) {
  const target = path.join(root, ...relativePath.split("/"));
  try {
    const details = await lstat(target);
    if (!details.isFile() || details.isSymbolicLink()) {
      fail("Preview target must be an ordinary file.");
    }
    const resolved = await realpath(target);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      fail("Preview target escapes its root.");
    }
    return resolved;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function makeReadOnly(root) {
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const target = path.join(directory, name);
      const details = await lstat(target);
      if (details.isSymbolicLink()) fail("Preview root cannot contain symlinks.");
      if (details.isDirectory()) await visit(target);
      else if (details.isFile()) await chmod(target, 0o444);
      else fail("Preview root contains an unsupported filesystem entry.");
    }
    await chmod(directory, 0o555);
  }
  await visit(root);
}

async function makeRemovable(root) {
  async function visit(directory) {
    await chmod(directory, 0o700).catch(() => undefined);
    for (const name of await readdir(directory).catch(() => [])) {
      const target = path.join(directory, name);
      const details = await lstat(target).catch(() => null);
      if (details?.isDirectory() && !details.isSymbolicLink()) await visit(target);
      else if (details?.isFile()) await chmod(target, 0o600).catch(() => undefined);
    }
  }
  await visit(root);
}

async function assertReadOnlyTree(root) {
  let entries = 0;
  async function visit(target) {
    const details = await lstat(target);
    entries += 1;
    if (entries > 1000) fail("Preview root exceeds its file-count safety bound.");
    if (details.isSymbolicLink()) fail("Preview root cannot contain symlinks.");
    if (details.mode & 0o222) fail("Preview root must be read-only before serving.");
    if (details.isDirectory()) {
      for (const name of await readdir(target)) {
        if (name.startsWith(".")) fail("Preview root cannot contain dotfiles.");
        await visit(path.join(target, name));
      }
    } else if (!details.isFile()) {
      fail("Preview root contains an unsupported filesystem entry.");
    }
  }
  await visit(root);
}

export async function materializeCandidatePreview(options) {
  const expectedKeys = ["artifact", "candidate", "originalRoot", "temporaryRoot"];
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).sort().join("\0") !== [...expectedKeys].sort().join("\0")
  ) {
    fail("CandidatePreviewOptions contain an unexpected field inventory.");
  }
  validateCandidateArtifact(options.artifact);
  validateCandidatePatch(options.candidate);
  if (!hashesEqual(options.candidate.patchSha256, candidateArtifactSha256(options.artifact))) {
    fail("Preview candidate identity does not match its artifact.");
  }
  const originalRoot = await canonicalDirectory(options.originalRoot, "Preview original root");
  const temporaryRoot = await canonicalDirectory(options.temporaryRoot, "Preview temporary root");
  const head = (await gitText(originalRoot, ["rev-parse", "HEAD"])).trim();
  if (!revisionPattern.test(head) || head !== options.candidate.baseRevision) {
    fail("Preview original root does not match the candidate base revision.");
  }
  if (
    (await gitText(originalRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) !==
    ""
  ) {
    fail("Preview requires an unchanged original project.");
  }
  const container = await mkdtemp(path.join(temporaryRoot, "candidate-preview-"));
  const siteRoot = path.join(container, "site");
  try {
    await copyTextTree(path.join(originalRoot, "public"), siteRoot);
    for (const operation of options.artifact.operations) {
      if (!operation.path.startsWith("public/")) fail("Preview artifact escapes public/.");
      const relativePath = operation.path.slice("public/".length);
      if (relativePath === "" || relativePath.split("/").some((segment) => segment.startsWith("."))) {
        fail("Preview artifact contains an unsafe public path.");
      }
      const existing = await previewEntry(siteRoot, relativePath);
      if (operation.operation === "delete") {
        if (existing === null) fail("Preview deletion target is missing.");
        await unlink(existing);
        continue;
      }
      await ensurePreviewParents(siteRoot, relativePath);
      const target = path.join(siteRoot, ...relativePath.split("/"));
      const flags =
        fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        (fsConstants.O_NOFOLLOW ?? 0);
      const handle = await open(target, flags, 0o644);
      try {
        await handle.writeFile(operation.content, "utf8");
      } finally {
        await handle.close();
      }
      const written = await readFile(target, "utf8");
      if (!hashesEqual(sha256(written), operation.contentSha256)) {
        fail("Preview materialization changed candidate content.");
      }
    }
    await makeReadOnly(siteRoot);
  } catch (error) {
    await makeRemovable(container);
    await rm(container, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  return Object.freeze({
    root: await realpath(siteRoot),
    candidateSha256: options.candidate.patchSha256,
    async close() {
      if (closed) return;
      await makeRemovable(container);
      await rm(container, { recursive: true, force: true });
      closed = true;
    }
  });
}

function contentType(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml; charset=utf-8",
      ".txt": "text/plain; charset=utf-8"
    }[extension] ?? "text/plain; charset=utf-8"
  );
}

function previewHeaders(type, controlOrigin, previewOrigin) {
  return {
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; script-src ${previewOrigin}; style-src ${previewOrigin}; img-src ${previewOrigin} data:; connect-src 'none'; font-src ${previewOrigin}; media-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${controlOrigin}`,
    "content-type": type,
    "cross-origin-resource-policy": "cross-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  };
}

function requestPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    fail("Preview request path is invalid.");
  }
  if (decoded.includes("\0") || decoded.includes("\\")) fail("Preview request path is invalid.");
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."))) {
    fail("Preview request path is forbidden.");
  }
  return segments.length === 0 ? "index.html" : segments.join("/");
}

export async function startCandidatePreviewServer(options) {
  const expectedKeys = ["root", "port", "controlOrigin"];
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).sort().join("\0") !== [...expectedKeys].sort().join("\0")
  ) {
    fail("CandidatePreviewServerOptions contain an unexpected field inventory.");
  }
  const root = await canonicalDirectory(options.root, "Candidate preview root");
  await assertReadOnlyTree(root);
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    fail("Candidate preview port must be an integer from 0 through 65535.");
  }
  if (!controlOriginPattern.test(options.controlOrigin)) {
    fail("Candidate preview controlOrigin must be an exact loopback HTTP origin.");
  }
  let previewOrigin = null;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(
          405,
          previewHeaders("text/plain; charset=utf-8", options.controlOrigin, previewOrigin)
        );
        response.end("Method not allowed.");
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const relativePath = requestPath(url.pathname);
      const target = path.join(root, ...relativePath.split("/"));
      const details = await lstat(target);
      if (!details.isFile() || details.isSymbolicLink()) fail("Preview resource is unavailable.");
      const resolved = await realpath(target);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        fail("Preview resource escapes its sealed root.");
      }
      const body = await readFile(resolved);
      response.writeHead(200, {
        ...previewHeaders(contentType(relativePath), options.controlOrigin, previewOrigin),
        "content-length": String(body.length)
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(
        404,
        previewHeaders("text/plain; charset=utf-8", options.controlOrigin, previewOrigin)
      );
      response.end("Not found.");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  previewOrigin = `http://127.0.0.1:${port}`;
  let closed = false;
  return Object.freeze({
    host: "127.0.0.1",
    port,
    url: `${previewOrigin}/`,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}
