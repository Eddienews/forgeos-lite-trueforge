import { randomBytes } from "node:crypto";

function code(bytes = 3) {
  return randomBytes(bytes).toString("hex").toUpperCase();
}

export function createOperationsDashboardSpec() {
  const runId = `OPS-${code(3)}`;
  const company = `Northstar Systems ${code(2)}`;
  const services = [
    `Atlas API ${code(1)}`,
    `Beacon Web ${code(1)}`,
    `Cinder Queue ${code(1)}`,
    `Delta Storage ${code(1)}`
  ];
  const degradedService = services[1];
  const incident = `Elevated response time ${code(2)}`;
  const mission = [
    `Build a polished operations status dashboard for ${company}.`,
    `Show overall system health and these four service status cards: ${services.join(", ")}.`,
    `Mark ${degradedService} as degraded and the other services as operational.`,
    `Include a recent incident timeline containing "${incident}" and a control that filters operational and degraded services.`,
    `Use run identifier ${runId}, make it responsive, use only local plain HTML, CSS, and JavaScript, and keep all required checks passing.`
  ].join(" ");
  return Object.freeze({
    kind: "operations-dashboard",
    mission,
    outcome: "Built the operations status dashboard successfully.",
    requirements: Object.freeze({
      schemaVersion: "1",
      runId,
      displayName: company,
      mission,
      requiredText: Object.freeze([company, runId, ...services, degradedService, incident]),
      requiredControls: Object.freeze(["filter"]),
      acceptanceCriteria: Object.freeze([
        "Present overall system health and all four runtime-specific services.",
        "Represent the exact degraded service and incident supplied for this run.",
        "Provide a working local filter for operational and degraded services.",
        "Use responsive plain HTML, CSS, and JavaScript without external resources.",
        "Keep immutable build and acceptance policies passing."
      ])
    }),
    uniqueValues: Object.freeze({ company, runId, services: Object.freeze(services), degradedService, incident })
  });
}

export function createReadingListSpec() {
  const runId = `READ-${code(3)}`;
  const displayName = `Lantern Reading Room ${code(2)}`;
  const categories = [`Design ${code(1)}`, `Systems ${code(1)}`, `History ${code(1)}`];
  const featuredTitle = `The Quiet Index ${code(2)}`;
  const mission = [
    `Build a polished reading-list dashboard for ${displayName}.`,
    `Use the three category sections ${categories.join(", ")} and feature the title "${featuredTitle}".`,
    `Add a local search field, a reading-progress summary, responsive styling, and keep all required checks passing.`,
    `Use run identifier ${runId} and only local plain HTML, CSS, and JavaScript.`
  ].join(" ");
  return Object.freeze({
    kind: "reading-list",
    mission,
    outcome: "Built the reading-list dashboard successfully.",
    requirements: Object.freeze({
      schemaVersion: "1",
      runId,
      displayName,
      mission,
      requiredText: Object.freeze([displayName, runId, ...categories, featuredTitle]),
      requiredControls: Object.freeze(["search"]),
      acceptanceCriteria: Object.freeze([
        "Present all three runtime-specific reading categories.",
        "Include the exact featured title and a reading-progress summary.",
        "Provide working local search behavior.",
        "Use responsive plain HTML, CSS, and JavaScript without external resources.",
        "Keep immutable build and acceptance policies passing."
      ])
    }),
    uniqueValues: Object.freeze({ displayName, runId, categories: Object.freeze(categories), featuredTitle })
  });
}

export function createCustomStaticWebSpec(mission) {
  if (typeof mission !== "string" || mission.trim().length < 10 || mission.length > 6000) {
    throw new Error("A real-project mission must contain 10 through 6000 characters.");
  }
  const normalized = mission.trim();
  const runId = `IDEA-${code(3)}`;
  const displayName = `ForgeOS Project ${code(2)}`;
  const controls = [
    ...(mission.toLowerCase().includes("search") ? ["search"] : []),
    ...(mission.toLowerCase().includes("filter") ? ["filter"] : [])
  ];
  const requiredControls = controls.length === 0 ? ["filter"] : [...new Set(controls)];
  const boundedMission = `${normalized} Include visible project identifier ${runId} and title ${displayName}. Use only local plain HTML, CSS, and JavaScript, make it responsive, and keep all required checks passing.`;
  return Object.freeze({
    kind: "custom-static-web",
    mission: boundedMission,
    outcome: "Built the requested static application successfully.",
    requirements: Object.freeze({
      schemaVersion: "1",
      runId,
      displayName,
      mission: boundedMission,
      requiredText: Object.freeze([displayName, runId]),
      requiredControls: Object.freeze(requiredControls),
      acceptanceCriteria: Object.freeze([
        "Materialize the current natural-language mission as a working static application.",
        "Display the current runtime-specific project title and identifier.",
        "Provide the requested bounded local interaction.",
        "Use responsive plain HTML, CSS, and JavaScript without external resources.",
        "Keep immutable build and acceptance policies passing."
      ])
    }),
    uniqueValues: Object.freeze({ displayName, runId })
  });
}
