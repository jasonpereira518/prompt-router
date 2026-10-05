// Deterministic gateway fixture. No provider, subscription, or billable API calls.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
const connectionId = "11111111-1111-4111-8111-111111111111",
  keys = new Map(),
  combos = new Map();
const models = [
  {
    id: "text",
    name: "Demo Text",
    contextLength: 64000,
    maxOutputTokens: 4096,
  },
  {
    id: "vision",
    name: "Demo Vision",
    contextLength: 64000,
    maxOutputTokens: 4096,
    supportsVision: true,
  },
];
createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"),
    path = url.pathname;
  let input = "";
  for await (const chunk of req) input += chunk;
  const body = input ? JSON.parse(input) : {};
  const json = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (path === "/api/health") return json({ status: "ok" });
  if (path === "/api/monitoring/health") return json({ version: "3.8.51" });
  if (path === "/api/v1/provider-plugin-manifest")
    return json({
      schemaVersion: 1,
      providers: [
        {
          id: "demo",
          alias: "demo",
          auth: { type: "apikey" },
          capabilities: ["apikey"],
          defaultContextLength: 64000,
          models,
        },
      ],
    });
  if (path === "/api/providers" && req.method === "GET")
    return json({
      connections: [
        {
          id: connectionId,
          provider: "demo",
          name: "Demo subscription",
          isActive: true,
          authType: "oauth",
          testStatus: "active",
          apiKey: "DO-NOT-EXPOSE",
          accessToken: "DO-NOT-EXPOSE",
        },
      ],
    });
  if (path === "/api/provider-nodes") return json({ nodes: [] });
  if (path === "/v1/models")
    return json({
      data: models.map((m) => ({
        ...m,
        id: `demo/${m.id}`,
        owned_by: "demo",
        root: m.id,
        type: "chat",
        context_length: m.contextLength,
        max_output_tokens: m.maxOutputTokens,
        capabilities: { vision: m.supportsVision === true },
      })),
    });
  if (path === "/api/combos" && req.method === "POST") {
    const id = randomUUID();
    combos.set(id, body);
    return json({ id, name: body.name }, 201);
  }
  if (path === "/api/keys" && req.method === "POST") {
    const id = randomUUID(),
      key = `fixture-${id}`;
    keys.set(id, { ...body, key });
    return json({ id, key }, 201);
  }
  if (path.startsWith("/api/keys/") && req.method === "PATCH")
    return json({ updated: true });
  if (path.startsWith("/api/keys/") && req.method === "DELETE") {
    keys.delete(path.split("/").at(-1));
    return json({ deleted: true });
  }
  if (path.startsWith("/api/combos/") && req.method === "DELETE") {
    combos.delete(path.split("/").at(-1));
    return json({ deleted: true });
  }
  if (path === "/v1/chat/completions") {
    const key = [...keys.values()].find(
        (k) => req.headers.authorization === `Bearer ${k.key}`,
      ),
      combo = [...combos.values()].find((c) => c.name === body.model);
    if (
      !key ||
      !combo ||
      !key.allowedCombos.includes(combo.name) ||
      key.allowedConnections.length !== 1 ||
      key.allowedConnections[0] !== connectionId ||
      combo.models.some((m) => !key.allowedModels.includes(m.model))
    )
      return json({ error: "Unsafe fixture request" }, 403);
    const last = body.messages.at(-1).content,
      prompt = typeof last === "string" ? last : JSON.stringify(last);
    const slow = prompt.includes("slow"),
      malformed = prompt.includes("malformed");
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "X-OmniRoute-Version": "3.8.51",
      "X-OmniRoute-Provider": "demo",
    });
    const text = prompt.includes("unsafe")
      ? "Safe text <script>window.omniUnsafe=true</script> [bad](javascript:alert(1))"
      : "A thoughtful answer.\n\n```ts\nconst answer = 42;\n```";
    const pieces = slow
      ? ["A partial response. ", "Still working. ", "Finished."]
      : [text];
    let index = 0;
    const timer = setInterval(
      () => {
        if (malformed) {
          res.write("data: {bad-json}\n\n");
          clearInterval(timer);
          res.end();
          return;
        }
        if (index < pieces.length) {
          res.write(
            `data: ${JSON.stringify({ model: "demo/text", choices: [{ delta: { content: pieces[index++] } }] })}\n\n`,
          );
        } else {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`,
          );
          res.end();
          clearInterval(timer);
        }
      },
      slow ? 700 : 40,
    );
    res.on("close", () => clearInterval(timer));
    return;
  }
  if (path.endsWith("/test")) return json({ valid: true });
  return json({ error: "Unsupported fixture endpoint" }, 404);
}).listen(20137, "127.0.0.1");
