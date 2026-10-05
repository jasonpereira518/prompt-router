// Disposable recovery rehearsal. Creates only its own containers and fixture credentials.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const image =
  "diegosouzapw/omniroute:3.8.51@sha256:8bd462c9f60d8eda79329cfbb6ea7ea723505fe7721beb944f3d43835409e218";
const source = `omni-restore-source-${process.pid}`,
  target = `omni-restore-target-${process.pid}`;
const directory = mkdtempSync(join(tmpdir(), "omni-gateway-restore-"));
const env = [
  "-e",
  "INITIAL_PASSWORD=restore-fixture-password",
  "-e",
  "JWT_SECRET=restore-test-jwt-secret-0123456789abcdef",
  "-e",
  "API_KEY_SECRET=restore-test-encryption-secret-0123456789abcdef",
];
let credentialReachedProvider = false;
const fixture = createServer(async (request, response) => {
  credentialReachedProvider ||=
    request.headers.authorization === "Bearer restore-fixture-key";
  for await (const chunk of request) void chunk;
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify(
      request.url.endsWith("/models")
        ? { data: [{ id: "restore-model", object: "model" }] }
        : {
            id: "restore",
            object: "chat.completion",
            model: "restore-model",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Restored credentials work.",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          },
    ),
  );
});
function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  }).trim();
}
async function ready(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/monitoring/health`);
      if (r.ok) return;
    } catch {
      /* Startup is asynchronous. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Disposable gateway did not become ready.");
}
try {
  await new Promise((resolve) => fixture.listen(20141, "0.0.0.0", resolve));
  docker(
    "run",
    "-d",
    "--name",
    source,
    "--add-host=host.docker.internal:host-gateway",
    "-p",
    "127.0.0.1:20140:20128",
    ...env,
    image,
  );
  await ready(20140);
  const origin = "http://127.0.0.1:20140";
  const login = await fetch(origin + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "restore-fixture-password" }),
  });
  assert(login.ok);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  async function create(path, value) {
    const r = await fetch(origin + path, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    assert(r.ok, "Could not create recovery fixture");
    return r.json();
  }
  const key = await create("/api/keys", {
    name: "Recovery fixture",
    scopes: ["manage"],
  });
  const node = await create("/api/provider-nodes", {
    name: "Recovery fixture",
    prefix: "restore-fixture",
    apiType: "chat",
    type: "openai-compatible",
    baseUrl: "http://host.docker.internal:20141/v1",
  });
  const connection = await create("/api/providers", {
    provider: node.node.id,
    name: "Recovery connection",
    apiKey: "restore-fixture-key",
  });
  docker("stop", source);
  docker("cp", `${source}:/app/data/.`, directory);
  docker(
    "run",
    "-d",
    "--name",
    target,
    "--add-host=host.docker.internal:host-gateway",
    "-p",
    "127.0.0.1:20142:20128",
    "-v",
    `${directory}:/app/data`,
    ...env,
    image,
  );
  await ready(20142);
  const response = await fetch(
    `http://127.0.0.1:20142/api/providers/${connection.connection.id}/test`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key.key}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  assert(response.ok, "Restored management key did not work");
  const tested = await response.json();
  assert(
    tested.valid === true || tested.success === true,
    "Restored provider connection failed",
  );
  assert(
    credentialReachedProvider,
    "Restored encrypted provider credential was not sent to fixture",
  );
  console.log(
    "Gateway restore passed: persisted management key, provider node, and encrypted provider credential work in a new container.",
  );
} finally {
  for (const name of [target, source]) {
    try {
      docker("stop", name);
    } catch {
      /* An early failure may precede creation. */
    }
    try {
      docker("rm", name);
    } catch {
      /* Never remove unrelated containers. */
    }
  }
  await new Promise((resolve) => fixture.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
