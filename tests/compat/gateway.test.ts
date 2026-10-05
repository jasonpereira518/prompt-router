// Explicit opt-in test against a disposable pinned gateway. Never uses real accounts.
import { beforeAll, afterAll, it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalog,
  prepareInference,
  inference,
  management,
} from "@/lib/gateway";
import { defaults } from "@/lib/types";
import { events } from "@/lib/sse";
const origin = "http://127.0.0.1:20138";
let providerCancelled = false;
let dir: string,
  connectionId: string,
  modelId: string,
  managementId: string,
  nodeId: string;
const requests: { model: string; content: unknown }[] = [];
const server = createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: [
          {
            id: "compat-text",
            object: "model",
            owned_by: "compat",
            context_length: 64000,
            max_output_tokens: 4096,
          },
        ],
      }),
    );
    return;
  }
  let raw = "";
  for await (const b of req) raw += b;
  const body = JSON.parse(raw || "{}");
  requests.push({ model: body.model, content: body.messages });
  if (!body.stream) {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: "compat",
        object: "chat.completion",
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Fixture answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }),
    );
    return;
  }
  if (JSON.stringify(body.messages).includes("cancel-fixture")) {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(
      `data: ${JSON.stringify({ id: "cancel", model: body.model, choices: [{ index: 0, delta: { content: "Partial fixture answer " }, finish_reason: null }] })}\n\n`,
    );
    const interval = setInterval(
      () =>
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "still streaming " }, finish_reason: null }] })}\n\n`,
        ),
      200,
    );
    res.on("close", () => {
      providerCancelled = true;
      clearInterval(interval);
    });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.end(`data: ${JSON.stringify({ id: "compat", model: body.model, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Fixture streamed answer" }, finish_reason: null }] })}

data: ${JSON.stringify({ id: "compat", model: body.model, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}

data: [DONE]

`);
});
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "omni-live-compat-"));
  process.env.OMNI_DATA_DIR = dir;
  process.env.OMNI_GATEWAY_URL = origin;
  await new Promise<void>((resolve) =>
    server.listen(20139, "0.0.0.0", resolve),
  );
  const login = await fetch(origin + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "compat-test-password" }),
  });
  expect(login.ok).toBe(true);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  async function authenticated(path: string, body: unknown) {
    const r = await fetch(origin + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    const value = await r.json();
    expect(r.ok, JSON.stringify(value)).toBe(true);
    return value;
  }
  const key = await authenticated("/api/keys", {
    name: "omni-compat-test-only",
    scopes: ["manage"],
  });
  process.env.OMNI_MANAGEMENT_KEY = key.key;
  managementId = key.id;
  const node = await authenticated("/api/provider-nodes", {
    name: "Omni compatibility fixture",
    prefix: "omni-compat",
    apiType: "chat",
    type: "openai-compatible",
    baseUrl: "http://host.docker.internal:20139/v1",
  });
  nodeId = node.node.id;
  const created = await authenticated("/api/providers", {
    provider: nodeId,
    apiKey: "fixture-only",
    name: "Omni test connection",
  });
  connectionId = created.connection.id;
  await management(`/api/providers/${connectionId}`, "PUT", { isActive: true });
  await authenticated("/api/provider-models", {
    provider: nodeId,
    modelId: "compat-text",
    modelName: "Compatibility text model",
    max_input_tokens: 64000,
    max_output_tokens: 4096,
    apiFormat: "chat-completions",
    supportedEndpoints: ["chat"],
    supportsVision: false,
  });
  await authenticated("/api/provider-models", {
    provider: nodeId,
    modelId: "compat-vision",
    modelName: "Compatibility vision model",
    max_input_tokens: 64000,
    max_output_tokens: 4096,
    apiFormat: "chat-completions",
    supportedEndpoints: ["chat"],
    supportsVision: true,
  });
  modelId = "omni-compat/compat-text";
});
afterAll(async () => {
  if (connectionId)
    await management(`/api/providers/${connectionId}`, "DELETE").catch(
      () => {},
    );
  if (nodeId)
    await management(`/api/provider-nodes/${nodeId}`, "DELETE").catch(() => {});
  if (managementId)
    await management(`/api/keys/${managementId}`, "DELETE").catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dir) rmSync(dir, { recursive: true, force: true });
});
it("discovers actual metadata and uses a restricted key plus a gateway-scored combo", async () => {
  const c = await catalog();
  expect(c.version).toBe("3.8.51");
  const model = c.models.find((m) => m.id === modelId);
  expect(model).toBeDefined();
  expect(model?.context).toBe(64000);
  const s = {
    ...structuredClone(defaults),
    paidEnabled: true,
    routes: { balanced: [modelId], quality: [], fast: [], economy: [] },
  };
  const controller = new AbortController(),
    prepared = await prepareInference(
      c,
      s,
      "balanced",
      false,
      controller.signal,
    );
  try {
    const r = await inference(
      {
        model: prepared.comboName,
        messages: [{ role: "user", content: "Test only" }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 2048,
      },
      prepared.key,
      controller.signal,
    );
    expect(r.ok).toBe(true);
    const frames = [];
    for await (const e of events(r.body!)) frames.push(e);
    expect(frames.some((e) => e.includes("Fixture streamed answer"))).toBe(
      true,
    );
    expect(requests.at(-1)?.model).toBe("compat-text");
  } finally {
    await prepared.cleanup();
  }
});

it("restricts image routes and rejects a text target outside the attempt key", async () => {
  const c = await catalog();
  const visionId = "omni-compat/compat-vision";
  expect(c.models.find((m) => m.id === visionId)?.vision).toBe(true);
  const s = {
    ...structuredClone(defaults),
    paidEnabled: true,
    routes: {
      balanced: [modelId, visionId],
      quality: [],
      fast: [],
      economy: [],
    },
  };
  const controller = new AbortController();
  const prepared = await prepareInference(
    c,
    s,
    "balanced",
    true,
    controller.signal,
  );
  try {
    expect(prepared.models.map((m) => m.id)).toEqual([visionId]);
    await expect(
      inference(
        {
          model: modelId,
          messages: [{ role: "user", content: "Forbidden target" }],
          stream: true,
        },
        prepared.key,
        controller.signal,
      ),
    ).rejects.toThrow();
    const response = await inference(
      {
        model: prepared.comboName,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe fixture" },
              {
                type: "image_url",
                image_url: {
                  url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
                },
              },
            ],
          },
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 2048,
      },
      prepared.key,
      controller.signal,
    );
    for await (const frame of events(response.body!)) {
      void frame;
    }
    expect(requests.at(-1)?.model).toBe("compat-vision");
    expect(JSON.stringify(requests.at(-1)?.content)).toContain("image_url");
  } finally {
    await prepared.cleanup();
  }
});
it("propagates cancellation through the pinned gateway to the serving provider", async () => {
  const c = await catalog();
  const s = {
    ...structuredClone(defaults),
    paidEnabled: true,
    routes: { balanced: [modelId], quality: [], fast: [], economy: [] },
  };
  const controller = new AbortController();
  const prepared = await prepareInference(
    c,
    s,
    "balanced",
    false,
    controller.signal,
  );
  try {
    const response = await inference(
      {
        model: prepared.comboName,
        messages: [{ role: "user", content: "cancel-fixture" }],
        stream: true,
        max_tokens: 2048,
      },
      prepared.key,
      controller.signal,
    );
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await expect.poll(() => providerCancelled, { timeout: 10000 }).toBe(true);
  } finally {
    await prepared.cleanup();
  }
});
