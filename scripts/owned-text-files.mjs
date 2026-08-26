import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

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

const binaryExtensions = new Set([
  ".7z",
  ".avif",
  ".bmp",
  ".bz2",
  ".dmg",
  ".eot",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".tar",
  ".tgz",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip"
]);

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function decodeOwnedText(filePath, buffer) {
  if (binaryExtensions.has(path.extname(filePath).toLowerCase()) || buffer.includes(0)) {
    return null;
  }

  try {
    return utf8Decoder.decode(buffer);
  } catch {
    return null;
  }
}

export async function collectOwnedTextFiles(root) {
  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) {
        continue;
      }

      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const content = decodeOwnedText(entryPath, await readFile(entryPath));
      if (content !== null) {
        files.push({ filePath: entryPath, content });
      }
    }
  }

  await walk(root);
  return files;
}

