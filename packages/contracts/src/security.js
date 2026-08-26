import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";

export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const forbiddenFieldNames = new Set([
  "chainOfThought",
  "conversationHistory",
  "eval",
  "reasoning",
  "secrets",
  "shell"
]);

const shellMetacharacters = /[|&;<>()`$\\\r\n*?{}\[\]~!]/u;
const secretEnvironmentKey = /(api.?key|credential|password|private|secret|token)/iu;
const interpreterEvaluationTokens = new Set([
  "-c",
  "-e",
  "-p",
  "--command",
  "--eval",
  "--exec",
  "--import",
  "--loader",
  "--print",
  "--require"
]);

function fail(message) {
  throw new TypeError(message);
}

export function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object.`);
  }
}

export function assertExactKeys(value, required, optional, label) {
  assertPlainObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${label} contains unknown field: ${key}.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail(`${label} is missing required field: ${key}.`);
    }
  }
}

export function assertNonEmptyString(value, label, maximumLength = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`${label} must be a non-empty trimmed string.`);
  }
  if (value.length > maximumLength || value.includes("\0")) {
    fail(`${label} is not a safe string.`);
  }
}

export function assertStringArray(value, label, options = {}) {
  const { maximumItems = 100, unique = true } = options;
  if (!Array.isArray(value) || value.length > maximumItems) {
    fail(`${label} must be an array with at most ${maximumItems} entries.`);
  }
  value.forEach((entry, index) => assertNonEmptyString(entry, `${label}[${index}]`));
  if (unique && new Set(value).size !== value.length) {
    fail(`${label} must not contain duplicate entries.`);
  }
}

export function assertIsoTimestamp(value, label) {
  assertNonEmptyString(value, label, 64);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail(`${label} must be a canonical ISO 8601 timestamp.`);
  }
}

export function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase, complete SHA-256 hash.`);
  }
}

export function assertSafeRelativePath(value, label) {
  assertNonEmptyString(value, label, 1024);
  if (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    fail(`${label} must be a safe relative POSIX path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${label} contains an unsafe path segment.`);
  }
  if (path.posix.normalize(value) !== value) {
    fail(`${label} must already be normalized.`);
  }
}

export function assertCommandToken(value, label) {
  assertNonEmptyString(value, label, 256);
  if (shellMetacharacters.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} contains a forbidden shell character.`);
  }
  const optionName = value.split("=", 1)[0];
  if (interpreterEvaluationTokens.has(optionName)) {
    fail(`${label} requests interpreter evaluation or dynamic loading.`);
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(value)) {
    fail(`${label} cannot inject an environment assignment.`);
  }
}

export function assertCommandSpec(value, label) {
  assertExactKeys(value, ["kind"], ["policyId", "arguments"], label);
  if (value.kind === "not_applicable") {
    if (Object.hasOwn(value, "policyId") || Object.hasOwn(value, "arguments")) {
      fail(`${label} cannot include policy data when it is not applicable.`);
    }
    return;
  }
  if (value.kind !== "policy") {
    fail(`${label}.kind must be policy or not_applicable.`);
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value.policyId ?? "")) {
    fail(`${label}.policyId must be a policy identifier, not a command.`);
  }
  if (!Array.isArray(value.arguments) || value.arguments.length > 32) {
    fail(`${label}.arguments must contain at most 32 structured tokens.`);
  }
  value.arguments.forEach((token, index) =>
    assertCommandToken(token, `${label}.arguments[${index}]`)
  );
}

export function assertEnvironmentKeys(value, label) {
  assertStringArray(value, label, { maximumItems: 64 });
  for (const key of value) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(key)) {
      fail(`${label} contains an invalid environment key: ${key}.`);
    }
    if (secretEnvironmentKey.test(key)) {
      fail(`${label} cannot allow a secret-bearing environment key: ${key}.`);
    }
  }
}

export function assertNoForbiddenFields(value, label = "value") {
  const seen = new Set();
  function visit(node, location) {
    if (node === null || typeof node !== "object") {
      return;
    }
    if (seen.has(node)) {
      fail(`${location} contains a circular reference.`);
    }
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${location}[${index}]`));
    } else {
      for (const [key, entry] of Object.entries(node)) {
        if (forbiddenFieldNames.has(key)) {
          fail(`${location} contains forbidden field: ${key}.`);
        }
        visit(entry, `${location}.${key}`);
      }
    }
    seen.delete(node);
  }
  visit(value, label);
}

function canonicalize(value, location, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail(`${location} contains a non-canonical number.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    fail(`${location} contains an unsupported JSON value.`);
  }
  if (seen.has(value)) {
    fail(`${location} contains a circular reference.`);
  }
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry, index) => canonicalize(entry, `${location}[${index}]`, seen));
  } else {
    assertPlainObject(value, location);
    result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key], `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value, "value", new Set()));
}

export function sha256(value) {
  const input = typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hashesEqual(left, right) {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function assertAuthoritySubset(subset, superset, label = "authority") {
  assertAuthorityShape(subset, `${label}.subset`);
  assertAuthorityShape(superset, `${label}.superset`);
  const allowedCapabilities = new Set(superset.capabilities);
  const allowedPaths = new Set(superset.projectPaths);
  if (subset.capabilities.some((entry) => !allowedCapabilities.has(entry))) {
    fail(`${label} expands mission capabilities.`);
  }
  if (subset.projectPaths.some((entry) => !allowedPaths.has(entry))) {
    fail(`${label} expands authorized project paths.`);
  }
}

export function assertAuthorityShape(value, label) {
  assertExactKeys(value, ["capabilities", "projectPaths"], [], label);
  assertStringArray(value.capabilities, `${label}.capabilities`, { maximumItems: 32 });
  assertStringArray(value.projectPaths, `${label}.projectPaths`, { maximumItems: 64 });
  value.projectPaths.forEach((entry, index) =>
    assertSafeRelativePath(entry, `${label}.projectPaths[${index}]`)
  );
}
