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
  if (binaryExtensions.has(path.extname(filePath).toLowerCase())) {
    return null;
  }

  if (buffer.includes(0)) {
    throw new Error(`Owned text file contains a null byte: ${filePath}`);
  }

  try {
    return utf8Decoder.decode(buffer);
  } catch (error) {
    throw new Error(`Owned text file is not valid UTF-8: ${filePath}`, { cause: error });
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
