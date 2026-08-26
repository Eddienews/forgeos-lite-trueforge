import { realpath } from "node:fs/promises";
import path from "node:path";

import { assertNoForbiddenFields, canonicalJson } from "@forgeos-lite/contracts";

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

function fail(message) {
  throw new Error(message);
}

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 4096) : "Unknown TrueForge transport error.";
}

function validateBaseUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname) || parsed.username || parsed.password) {
    fail("TrueForge baseUrl must be an unauthenticated loopback HTTP URL.");
  }
  return parsed.href.replace(/\/$/u, "");
}

function shellToken(token) {
  if (/^[A-Za-z0-9_./:=+-]+$/u.test(token)) {
    return token;
  }
  return `'${token.replaceAll("'", `'"'"'`)}'`;
}

function parseEventStream(body) {
  const events = [];
  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") {
      continue;
    }
    try {
      const parsed = JSON.parse(data);
      events.push(parsed.event ?? parsed.data ?? parsed);
    } catch {
      fail("TrueForge returned malformed event-stream JSON.");
    }
  }
  if (events.length === 0) {
    fail("TrueForge returned no turn events.");
  }
  return events;
}

function toolExecution(events) {
  const toolCalls = [];
  const responses = new Map();
  for (const event of events) {
    if (event?.type === "model.message" && Array.isArray(event.tool_calls)) {
      for (const call of event.tool_calls) {
        if (call?.function?.name === "exec") {
          toolCalls.push(call);
        }
      }
    }
    if (event?.type === "tool.response" && typeof event.tool_call_id === "string") {
      responses.set(event.tool_call_id, event);
    }
  }
  if (toolCalls.length !== 1) {
    const eventTypes = events
      .map((event) => (typeof event?.type === "string" ? event.type : "unknown"))
      .join(", ");
    fail(
      `TrueForge must issue exactly one sandbox exec call for a runtime execution; received ${toolCalls.length} across events: ${eventTypes}.`
    );
  }
  const call = toolCalls[0];
  const response = responses.get(call.id);
  if (response === undefined || typeof response.content !== "string") {
    fail("TrueForge did not return evidence for its sandbox exec call.");
  }
  let argumentsValue;
  let responseValue;
  try {
    argumentsValue = JSON.parse(call.function.arguments);
    responseValue = JSON.parse(response.content);
  } catch {
    fail("TrueForge returned malformed sandbox execution evidence.");
  }
  assertNoForbiddenFields(argumentsValue, "TrueForge sandbox exec arguments");
  assertNoForbiddenFields(responseValue, "TrueForge sandbox exec response");
  return { argumentsValue, responseValue };
}

function verifyToolArguments(actual, expected) {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    fail("TrueForge sandbox exec arguments must be an object.");
  }
  const allowed = new Set(["command", "cwd", "env", "intent"]);
  for (const key of Object.keys(actual)) {
    if (!allowed.has(key)) {
      fail(`TrueForge sandbox exec returned an unknown field: ${key}.`);
    }
  }
  if (actual.command !== expected.command || actual.cwd !== expected.cwd) {
    fail("TrueForge changed the validated command or working directory.");
  }
  const actualEnvironment = actual.env ?? {};
  if (canonicalJson(actualEnvironment) !== canonicalJson(expected.environment)) {
    fail("TrueForge changed the validated execution environment.");
  }
}

function normalizeToolResponse(value) {
  if (value?.success !== true) {
    const message = typeof value?.error === "string" ? value.error : "TrueForge sandbox execution failed.";
    return {
      exitStatus: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      runtimeError: message.slice(0, 4096)
    };
  }
  const exitStatus = value.response?.exitCode;
  const stdout = value.response?.result;
  if (!Number.isInteger(exitStatus) || exitStatus < 0 || typeof stdout !== "string") {
    fail("TrueForge sandbox execution response has an invalid shape.");
  }
  return {
    exitStatus,
    stdout,
    stderr: "",
    timedOut: false,
    runtimeError: null
  };
}

export function createTrueForgeHttpDriver(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("TrueForge HTTP driver options must be an object.");
  }
  const allowed = new Set(["agentSpec", "authorizationToken", "baseUrl", "fetchImpl"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      fail(`TrueForge HTTP driver options contain unknown field: ${key}.`);
    }
  }
  const baseUrl = validateBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    fail("TrueForge HTTP driver requires a fetch implementation.");
  }
  if (options.agentSpec === null || typeof options.agentSpec !== "object" || Array.isArray(options.agentSpec)) {
    fail("TrueForge HTTP driver agentSpec must be an object.");
  }
  const agentSpec = structuredClone(options.agentSpec);
  assertNoForbiddenFields(agentSpec, "TrueForge HTTP driver agentSpec");
  const token = options.authorizationToken;
  if (token !== undefined && (typeof token !== "string" || token.length === 0 || token.includes("\0"))) {
    fail("TrueForge HTTP driver authorizationToken must be safe text when supplied.");
  }

  async function request(route, init = {}) {
    const headers = { "content-type": "application/json", ...(init.headers ?? {}) };
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    const response = await fetchImpl(`${baseUrl}${route}`, { ...init, headers });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 4096);
      fail(`TrueForge HTTP ${response.status}: ${body}`);
    }
    return response;
  }

  async function runTurn(sessionId, expected, timeoutMs) {
    const prompt = [
      "Execute one prevalidated ForgeOS Lite runtime command.",
      "Use the TrueForge sandbox exec tool exactly once.",
      "Copy the command, cwd, and environment exactly from this JSON object.",
      "Do not add operators, redirects, pipelines, substitutions, or additional commands.",
      canonicalJson(expected)
    ].join("\n");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
        method: "POST",
        body: JSON.stringify({
          input: [{ type: "user.message", content: prompt }],
          previous_turn_id: "auto",
          stream: true
        }),
        signal: controller.signal
      });
      parseEventStream(await response.text());
      const historyResponse = await request(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/events?limit=100`,
        { signal: controller.signal }
      );
      const history = await historyResponse.json();
      if (!Array.isArray(history?.data) || history.data.length === 0) {
        fail("TrueForge returned no merged events after the turn completed.");
      }
      const turnId = history.data[0]?.turn_id;
      if (typeof turnId !== "string") {
        fail("TrueForge merged event history omitted the turn identifier.");
      }
      const events = history.data
        .filter((entry) => entry?.turn_id === turnId)
        .map((entry) => entry.event);
      const execution = toolExecution(events);
      verifyToolArguments(execution.argumentsValue, expected);
      return normalizeToolResponse(execution.responseValue);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async createSession({ workspaceRoot }) {
      const response = await request("/api/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ agent: { spec: agentSpec } })
      });
      const payload = await response.json();
      const sessionId = payload?.data?.id;
      if (typeof sessionId !== "string") {
        fail("TrueForge did not return a session identifier.");
      }
      try {
        const probe = await runTurn(
          sessionId,
          { command: "pwd", cwd: ".", environment: {} },
          120_000
        );
        if (probe.exitStatus !== 0 || probe.runtimeError !== null) {
          fail(`TrueForge workspace probe failed: ${probe.runtimeError ?? probe.stdout}`);
        }
        const firstLine = probe.stdout.split(/\r?\n/u).find((line) => line.trim() !== "");
        if (firstLine === undefined || !path.isAbsolute(firstLine)) {
          fail("TrueForge workspace probe did not return an absolute path.");
        }
        const boundRoot = await realpath(firstLine);
        if (boundRoot !== workspaceRoot && !boundRoot.startsWith(`${workspaceRoot}${path.sep}`)) {
          fail("TrueForge created its sandbox outside the configured workspace root.");
        }
        return { sessionId, workspaceRoot: boundRoot };
      } catch (error) {
        await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(
          () => undefined
        );
        throw error;
      }
    },

    async execute({ argv, environment, sessionId, timeoutMs, workingDirectory }) {
      const expected = {
        command: argv.map(shellToken).join(" "),
        cwd: workingDirectory,
        environment
      };
      try {
        return await runTurn(sessionId, expected, timeoutMs);
      } catch (error) {
        if (error?.name === "AbortError") {
          let cancellationError = null;
          try {
            await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {
              method: "POST",
              body: "{}"
            });
          } catch (cancelError) {
            cancellationError = `TrueForge timeout cancellation failed: ${safeError(cancelError)}`;
          }
          return {
            exitStatus: null,
            stdout: "",
            stderr: "",
            timedOut: true,
            runtimeError: cancellationError
          };
        }
        return {
          exitStatus: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          runtimeError: safeError(error)
        };
      }
    },

    async closeSession({ sessionId }) {
      await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    }
  };
}
