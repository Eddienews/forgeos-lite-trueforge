import { canonicalJson } from "@forgeos-lite/contracts";

import { validateStaticWebRequirements } from "./fixture.js";

function fail(message) {
  throw new TypeError(message);
}

export function validateBoundedCoordinatorPlan(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("Bounded Coordinator plan must be an object.");
  }
  const fields = [
    "objective",
    "projectContext",
    "writableScope",
    "implementationTasks",
    "acceptanceCriteria",
    "validationPolicies",
    "riskNotes"
  ];
  if (Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    fail("Bounded Coordinator plan contains an unexpected field inventory.");
  }
  for (const field of [
    "writableScope",
    "implementationTasks",
    "acceptanceCriteria",
    "validationPolicies",
    "riskNotes"
  ]) {
    if (!Array.isArray(value[field]) || value[field].length === 0 || value[field].length > 32) {
      fail(`Bounded Coordinator plan ${field} must be a bounded non-empty array.`);
    }
    if (value[field].some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 2000)) {
      fail(`Bounded Coordinator plan ${field} must contain bounded text.`);
    }
  }
  if (canonicalJson(value.writableScope) !== canonicalJson(["public/**"])) {
    fail("Coordinator plan cannot broaden the public-only write authority.");
  }
  if (
    canonicalJson(value.validationPolicies) !==
    canonicalJson(["npm-run-build", "npm-test"])
  ) {
    fail("Coordinator plan cannot change the fixed validation policies.");
  }
  if (value.objective !== context.mission) {
    fail("Coordinator plan objective must preserve the exact mission.");
  }
  if (!value.projectContext.includes(context.requirements.runId)) {
    fail("Coordinator plan must bind to the current immutable requirements.");
  }
  return value;
}

export function createBoundedCoordinatorPlan(options) {
  const requirements = validateStaticWebRequirements(options.requirements);
  if (options.mission !== requirements.mission) {
    fail("Coordinator mission must match the immutable requirements contract.");
  }
  const plan = {
    objective: options.mission,
    projectContext: `Dependency-free Node.js static web starter at revision ${options.baseRevision.slice(0, 12)} with immutable requirements ${requirements.runId}.`,
    writableScope: ["public/**"],
    implementationTasks: [
      "Inspect the starter project and immutable mission requirements.",
      "Design a clear static application structure for the current mission.",
      "Implement the required content below public/ using plain HTML and CSS.",
      "Implement the required local interaction with bounded browser JavaScript.",
      "Keep the result responsive and free of external resources.",
      "Submit the actual workspace changes for fixed build and test validation."
    ],
    acceptanceCriteria: [...requirements.acceptanceCriteria],
    validationPolicies: ["npm-run-build", "npm-test"],
    riskNotes: [
      "The Builder may read the admitted starter and immutable acceptance contract.",
      "The Builder may write only ordinary UTF-8 text files below public/.",
      "No network, dependency installation, shell authority, commit, push, or deployment is allowed.",
      "Application to the original project remains behind the real TrueForge human gate."
    ]
  };
  validateBoundedCoordinatorPlan(plan, { mission: options.mission, requirements });
  return Object.freeze(structuredClone(plan));
}
