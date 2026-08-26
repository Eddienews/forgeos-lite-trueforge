import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

function sanitizedEnvironment(runtimeRoot, temporaryRoot) {
  const environment = {
    ...process.env,
    SQLITE_PATH: path.join(runtimeRoot, "trueforge.sqlite"),
    TMPDIR: temporaryRoot
  };
  delete environment.OPENAI_API_KEY;
  delete environment.OPENAI_BASE_URL;
  return environment;
}

function appendBounded(current, chunk) {
  const next = `${current}${chunk.toString("utf8")}`;
  return next.length > 64_000 ? next.slice(-64_000) : next;
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`TrueForge stopped before startup completed. ${output().slice(-2000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/openapi.json`, {
        signal: AbortSignal.timeout(1000)
      });
      if (response.ok) return;
    } catch {
      // The local server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("TrueForge did not become ready within 30 seconds.");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  const closed = new Promise((resolve) => child.once("close", resolve));
  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 8000));
  if ((await Promise.race([closed, timeout])) === "timeout" && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
  }
}

export async function startLocalTrueForge(options) {
  const runtimeRoot = await mkdtemp(path.join(options.temporaryRoot, "demo-runtime-"));
  let output = "";
  const child = spawn(options.binary, ["--port", String(options.port)], {
    env: sanitizedEnvironment(runtimeRoot, options.temporaryRoot),
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => {
    output = appendBounded(output, chunk);
    if (options.verbose) process.stderr.write(".");
  });
  child.stderr.on("data", (chunk) => {
    output = appendBounded(output, chunk);
  });
  const baseUrl = `http://localhost:${options.port}`;
  try {
    await waitForServer(baseUrl, child, () => output);
    const response = await fetch(`${baseUrl}/api/v1/settings/model-providers`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        manifest: {
          type: "openai",
          base_url: "https://api.openai.com/v1",
          auth: { api_key: options.apiKey },
          models: [
            {
              model_id: "gpt-5.4-mini",
              name: "gpt-5-4-mini",
              properties: {
                context_length: 400_000,
                max_output_tokens: 128_000,
                reasoning_efforts: ["low"]
              }
            }
          ]
        }
      }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`TrueForge provider setup failed with HTTP ${response.status}.`);
    await response.arrayBuffer();
  } catch (error) {
    await stopChild(child);
    await rm(runtimeRoot, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  return Object.freeze({
    baseUrl,
    runtimeRoot,
    async close() {
      if (closed) return;
      closed = true;
      await stopChild(child);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });
}
