import { execFile } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { assertCandidatePath } from "@forgeos-lite/candidate-patch";
import { assertExactKeys, canonicalJson } from "@forgeos-lite/contracts";
import * as z from "zod/v4";

const execFileAsync = promisify(execFile);
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const allowedWritableExtension = new Set([".css", ".html", ".js", ".json", ".svg", ".txt"]);

export const BUILDER_WORKSPACE_TOOL_NAMES = Object.freeze([
  "list_workspace_files",
  "read_text_file",
  "write_text_file",
  "delete_text_file"
]);

function fail(message) {
  throw new TypeError(message);
}

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 4096) : "Unknown workspace tool failure.";
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail(`${label} must be a stable identifier.`);
  }
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
  if (!details.isDirectory() || details.isSymbolicLink()) {
    fail(`${label} must be a real directory.`);
  }
  const resolved = await realpath(value);
  if (resolved !== value) fail(`${label} must already be canonical.`);
  return resolved;
}

function workspacePath(value, label) {
  assertCandidatePath(value, label);
  if (value.split("/").some((segment) => segment.startsWith("."))) {
    fail(`${label} cannot target dotfiles.`);
  }
  return value;
}

function writablePath(value, prefix) {
  const relativePath = workspacePath(value, "Builder workspace path");
  if (!relativePath.startsWith(`${prefix}/`)) {
    fail(`Builder write path must remain below ${prefix}/.`);
  }
  if (!allowedWritableExtension.has(path.extname(relativePath).toLowerCase())) {
    fail("Builder write path uses a forbidden file type.");
  }
  return relativePath;
}

async function gitText(root, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout;
}

async function changedFiles(root) {
  const changed = (await gitText(root, ["diff", "--name-only", "-z", "--no-renames", "HEAD"]))
    .split("\0")
    .filter(Boolean);
  const untracked = (
    await gitText(root, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter(Boolean);
  return [...new Set([...changed, ...untracked])].sort((left, right) =>
    left.localeCompare(right)
  );
}

async function baselineText(root, relativePath) {
  try {
    await execFileAsync("git", ["cat-file", "-e", `HEAD:${relativePath}`], {
      cwd: root,
      maxBuffer: 1024 * 1024
    });
  } catch {
    return null;
  }
  const { stdout } = await execFileAsync("git", ["show", `HEAD:${relativePath}`], {
    cwd: root,
    encoding: null,
    maxBuffer: 2 * 1024 * 1024
  });
  return new TextDecoder("utf-8", { fatal: true }).decode(stdout).replace(/\r\n?/gu, "\n");
}

async function existingFile(root, relativePath) {
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (details.isSymbolicLink()) fail(`Workspace path contains a symlink: ${relativePath}.`);
    if (segment !== segments.at(-1) && !details.isDirectory()) {
      fail(`Workspace path contains a non-directory parent: ${relativePath}.`);
    }
  }
  const details = await lstat(current);
  if (!details.isFile() || details.isSymbolicLink()) {
    fail(`Workspace path must resolve to an ordinary file: ${relativePath}.`);
  }
  const resolved = await realpath(current);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    fail(`Workspace path escapes its root: ${relativePath}.`);
  }
  return { path: current, size: details.size };
}

async function ensureParents(root, relativePath, prefix) {
  const segments = relativePath.split("/").slice(0, -1);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const details = await lstat(current);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        fail(`Builder write parent is unsafe: ${relativePath}.`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (index === 0 && segment !== prefix) fail("Builder cannot create a new top-level directory.");
      await mkdir(current, { mode: 0o755 });
    }
    const resolved = await realpath(current);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      fail(`Builder write parent escapes its workspace: ${relativePath}.`);
    }
  }
}

async function projectedCandidateBytes(root, paths, targetPath, targetContent) {
  let total = 0;
  for (const relativePath of paths) {
    if (relativePath === targetPath) {
      if (targetContent !== null) total += Buffer.byteLength(targetContent, "utf8");
      continue;
    }
    const entry = await existingFile(root, relativePath);
    if (entry !== null) total += entry.size;
  }
  return total;
}

export async function createBuilderWorkspaceBoundary(options) {
  assertExactKeys(
    options,
    [
      "workspaceRoot",
      "readPaths",
      "writePrefix",
      "maximumChangedFiles",
      "maximumCandidateBytes"
    ],
    [],
    "BuilderWorkspaceBoundaryOptions"
  );
  const root = await canonicalDirectory(options.workspaceRoot, "Builder workspace root");
  if (!Array.isArray(options.readPaths) || options.readPaths.length === 0) {
    fail("Builder workspace readPaths must be a non-empty array.");
  }
  const readPaths = new Set(
    options.readPaths.map((entry) => workspacePath(entry, "Builder readable path"))
  );
  const writePrefix = workspacePath(options.writePrefix, "Builder write prefix");
  if (!Number.isInteger(options.maximumChangedFiles) || options.maximumChangedFiles < 1) {
    fail("Builder maximumChangedFiles must be a positive integer.");
  }
  if (!Number.isInteger(options.maximumCandidateBytes) || options.maximumCandidateBytes < 1) {
    fail("Builder maximumCandidateBytes must be a positive integer.");
  }
  let mutationQueue = Promise.resolve();

  function canRead(relativePath) {
    return readPaths.has(relativePath) || relativePath.startsWith(`${writePrefix}/`);
  }

  async function inventory() {
    const files = [];
    async function visit(relativeDirectory) {
      const absoluteDirectory =
        relativeDirectory === "" ? root : path.join(root, ...relativeDirectory.split("/"));
      const names = await readdir(absoluteDirectory);
      names.sort((left, right) => left.localeCompare(right));
      for (const name of names) {
        if (name === ".git" || name === "node_modules" || name.startsWith(".")) continue;
        const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
        const details = await lstat(path.join(absoluteDirectory, name));
        if (details.isSymbolicLink()) fail(`Workspace contains a forbidden symlink: ${relativePath}.`);
        if (details.isDirectory()) {
          await visit(relativePath);
        } else if (details.isFile() && canRead(relativePath)) {
          files.push({
            path: relativePath,
            size: details.size,
            writable: relativePath.startsWith(`${writePrefix}/`)
          });
        }
        if (files.length > 1000) fail("Workspace file inventory exceeds its safety limit.");
      }
    }
    await visit("");
    return files;
  }

  async function read(relativePath) {
    const safePath = workspacePath(relativePath, "Builder read path");
    if (!canRead(safePath)) fail("Builder read path is outside the admitted project context.");
    const entry = await existingFile(root, safePath);
    if (entry === null || entry.size > 1_000_000) fail("Builder read target is unavailable or too large.");
    const buffer = await readFile(entry.path);
    if (buffer.includes(0)) fail("Builder read target is not UTF-8 text.");
    return new TextDecoder("utf-8", { fatal: true })
      .decode(buffer)
      .replace(/\r\n?/gu, "\n");
  }

  function serializeMutation(operation) {
    const next = mutationQueue.then(operation, operation);
    mutationQueue = next.catch(() => undefined);
    return next;
  }

  async function assertProjection(relativePath, content) {
    const current = new Set(await changedFiles(root));
    const baseline = await baselineText(root, relativePath);
    if (content === baseline || (content === null && baseline === null)) current.delete(relativePath);
    else current.add(relativePath);
    const projected = [...current].sort((left, right) => left.localeCompare(right));
    if (projected.some((entry) => !entry.startsWith(`${writePrefix}/`))) {
      fail("Builder workspace contains a change outside its write authority.");
    }
    if (projected.length > options.maximumChangedFiles) {
      fail("Builder candidate exceeds the changed-file limit.");
    }
    if (
      (await projectedCandidateBytes(root, projected, relativePath, content)) >
      options.maximumCandidateBytes
    ) {
      fail("Builder candidate exceeds the total text-size limit.");
    }
    return projected;
  }

  async function write(relativePath, content) {
    return serializeMutation(async () => {
      const safePath = writablePath(relativePath, writePrefix);
      if (
        typeof content !== "string" ||
        content.includes("\0") ||
        content.includes("\r") ||
        Buffer.byteLength(content, "utf8") > 100_000
      ) {
        fail("Builder file content must be bounded canonical UTF-8 text.");
      }
      await assertProjection(safePath, content);
      await ensureParents(root, safePath, writePrefix);
      const current = await existingFile(root, safePath);
      if (current !== null) {
        const details = await lstat(current.path);
        if (details.mode & 0o111) fail("Builder cannot modify executable files.");
      }
      const target = path.join(root, ...safePath.split("/"));
      const handle = await open(
        target,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_TRUNC |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o644
      );
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
      const changed = await changedFiles(root);
      if (
        changed.length > options.maximumChangedFiles ||
        changed.some((entry) => !entry.startsWith(`${writePrefix}/`))
      ) {
        fail("Builder mutation violated its authoritative workspace limits.");
      }
      return { path: safePath, bytes: Buffer.byteLength(content, "utf8") };
    });
  }

  async function remove(relativePath) {
    return serializeMutation(async () => {
      const safePath = writablePath(relativePath, writePrefix);
      const entry = await existingFile(root, safePath);
      if (entry === null) fail("Builder delete target does not exist.");
      await assertProjection(safePath, null);
      await unlink(entry.path);
      return { path: safePath, deleted: true };
    });
  }

  return Object.freeze({
    root,
    writePrefix,
    maximumChangedFiles: options.maximumChangedFiles,
    maximumCandidateBytes: options.maximumCandidateBytes,
    listFiles: inventory,
    readTextFile: read,
    writeTextFile: write,
    deleteTextFile: remove,
    changedFiles: () => changedFiles(root)
  });
}

export function trueForgeBuilderWorkspaceConfiguration(serverName) {
  assertIdentifier(serverName, "serverName");
  return Object.freeze({
    name: serverName,
    enable_tools: BUILDER_WORKSPACE_TOOL_NAMES,
    disable_tools: Object.freeze([]),
    preload_tools: BUILDER_WORKSPACE_TOOL_NAMES,
    require_approval_for_tools: Object.freeze([]),
    preload: false
  });
}

function protocolServer(boundary) {
  const server = new McpServer({ name: "forgeos-lite-builder-workspace", version: "0.1.0" });
  server.registerTool(
    "list_workspace_files",
    {
      title: "List admitted workspace files",
      description: "List readable project files without exposing the host workspace path.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      const result = { files: await boundary.listFiles() };
      return { content: [{ type: "text", text: canonicalJson(result) }], structuredContent: result };
    }
  );
  server.registerTool(
    "read_text_file",
    {
      title: "Read admitted text file",
      description: "Read one admitted UTF-8 project file by safe relative path.",
      inputSchema: z.object({ path: z.string().min(1).max(512) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ path: relativePath }) => {
      try {
        const result = { path: relativePath, content: await boundary.readTextFile(relativePath) };
        return { content: [{ type: "text", text: canonicalJson(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: safeError(error) }] };
      }
    }
  );
  server.registerTool(
    "write_text_file",
    {
      title: "Write bounded application text file",
      description: "Create or replace one allowed UTF-8 file below the admitted public directory.",
      inputSchema: z
        .object({ path: z.string().min(1).max(512), content: z.string().max(100_000) })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ path: relativePath, content }) => {
      try {
        const result = await boundary.writeTextFile(relativePath, content);
        return { content: [{ type: "text", text: canonicalJson(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: safeError(error) }] };
      }
    }
  );
  server.registerTool(
    "delete_text_file",
    {
      title: "Delete bounded application text file",
      description: "Delete one allowed ordinary text file below the admitted public directory.",
      inputSchema: z.object({ path: z.string().min(1).max(512) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ path: relativePath }) => {
      try {
        const result = await boundary.deleteTextFile(relativePath);
        return { content: [{ type: "text", text: canonicalJson(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: safeError(error) }] };
      }
    }
  );
  return server;
}

export async function startBuilderWorkspaceMcpServer(options) {
  assertExactKeys(
    options,
    ["boundary", "port", "authorizationToken"],
    ["host", "serverName"],
    "BuilderWorkspaceMcpServerOptions"
  );
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    fail("Builder workspace MCP port must be an integer from 1024 through 65535.");
  }
  if (typeof options.authorizationToken !== "string" || options.authorizationToken.length < 32) {
    fail("Builder workspace MCP authorizationToken must be a strong token.");
  }
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    fail("Builder workspace MCP server must bind to loopback.");
  }
  const serverName = options.serverName ?? `forgeos-builder-${randomUUID()}`;
  assertIdentifier(serverName, "Builder workspace MCP serverName");
  const app = createMcpExpressApp();
  app.post("/mcp", async (request, response) => {
    const supplied = Buffer.from(request.get("authorization") ?? "", "utf8");
    const expected = Buffer.from(`Bearer ${options.authorizationToken}`, "utf8");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized MCP client." }, id: null });
      return;
    }
    const server = protocolServer(options.boundary);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: safeError(error) }, id: null });
      }
    } finally {
      if (response.writableEnded) {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    }
  });
  for (const method of ["get", "delete", "put", "patch"]) {
    app[method]("/mcp", (_request, response) => {
      response.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    });
  }
  const httpServer = await new Promise((resolve, reject) => {
    const listening = app.listen(options.port, host, () => resolve(listening));
    listening.once("error", reject);
  });
  let closed = false;
  return Object.freeze({
    host,
    port: options.port,
    name: serverName,
    url: `http://${host === "::1" ? `[${host}]` : host}:${options.port}/mcp`,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}
