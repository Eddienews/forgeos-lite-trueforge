#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";

import { runDemo } from "./demo.js";
import { helpText, parseArguments } from "./presentation.js";
import { runPreflight } from "./preflight.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help") {
    console.log(helpText());
    return;
  }
  if (options.command === "check") {
    const result = await runPreflight({ repositoryRoot });
    console.log("ForgeOS Lite demo preflight passed:");
    for (const check of result.checks) console.log(`- ${check}`);
    return;
  }
  await runDemo({ ...options, repositoryRoot });
}

main().catch((error) => {
  console.error(`ForgeOS Lite: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
});
