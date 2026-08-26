export function abbreviate(value, length = 12) {
  if (typeof value !== "string" || value.length < length) return String(value);
  return value.slice(0, length);
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

export function stage(label) {
  return `\n=== ${label} ===`;
}

export function coordinatorPlanLines(plan) {
  const builderActions = plan.steps
    .filter((entry) => entry.actor === "builder")
    .map((entry) => entry.summary);
  return [
    `Objective: ${plan.objective}`,
    `Files in scope: ${plan.expectedScope.join(", ")}`,
    `Builder actions: ${builderActions.join(" ")}`,
    `Validation policies: ${plan.validationPolicyIds.join(", ")}`,
    "Reviewer criteria: exact base, scope, Builder proof, candidate identity, and passing validation."
  ];
}

export function candidateSummaryLines(summary) {
  const validation = summary.validationSummary
    .map((entry) => `${entry.policyId}: ${entry.success ? "passed" : "failed"}`)
    .join(", ");
  return [
    `Candidate ID: ${summary.candidateId}`,
    `Candidate hash: ${abbreviate(summary.candidateSha256)}`,
    `Base revision: ${abbreviate(summary.baseRevision)}`,
    `Affected files: ${summary.affectedFiles.join(", ")}`,
    `Reviewer verdict: ${summary.reviewerVerdict.decision}`,
    `Validation: ${validation}`,
    `Original project: ${summary.originalUnchanged ? "unchanged" : "changed"}`
  ];
}

export function parseArguments(argv) {
  const [command = "help", ...flags] = argv;
  const allowedCommands = new Set(["check", "demo", "help"]);
  if (!allowedCommands.has(command)) {
    throw new Error(`Unknown ForgeOS Lite command: ${command}.`);
  }
  const allowedFlags = new Set(["--deny", "--json", "--keep-project", "--verbose"]);
  for (const flag of flags) {
    if (!allowedFlags.has(flag)) throw new Error(`Unknown ForgeOS Lite option: ${flag}.`);
  }
  if (command !== "demo" && flags.length > 0) {
    throw new Error(`Command ${command} does not accept options.`);
  }
  return Object.freeze({
    command,
    deny: flags.includes("--deny"),
    json: flags.includes("--json"),
    keepProject: flags.includes("--keep-project"),
    verbose: flags.includes("--verbose")
  });
}

export function helpText() {
  return [
    "ForgeOS Lite — TrueForge Edition",
    "",
    "Commands:",
    "  npm run demo             Run the interactive approval demo.",
    "  npm run demo:deny        Run the real human-denial path.",
    "  npm run demo:check       Verify local demo prerequisites.",
    "",
    "Demo options:",
    "  --keep-project           Preserve the disposable target project.",
    "  --verbose                Show additional public execution identifiers.",
    "  --json                   Print a final structured public summary."
  ].join("\n");
}
