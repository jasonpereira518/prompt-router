import { randomUUID } from "node:crypto";
import { AppError } from "./errors";
import { db } from "./db";
import {
  presets,
  type Settings,
  type Catalog,
  type Model,
  type Provider,
} from "./types";
export const GATEWAY_VERSION = "3.8.51";
type Json = Record<string, unknown>;
interface ManifestModel {
  id: string;
  name?: string;
  supportsVision?: boolean;
  contextLength?: number;
  maxOutputTokens?: number;
  unsupportedParams?: string[];
}
interface ManifestProvider {
  id: string;
  alias?: string;
  auth: { type: string };
  capabilities: string[];
  defaultContextLength?: number;
  models: ManifestModel[];
}
export function gatewayUrl(path: string) {
  const base = new URL(
    process.env.OMNI_GATEWAY_URL || "http://127.0.0.1:20128",
  );
  if (
    base.username ||
    base.password ||
    !["http:", "https:"].includes(base.protocol)
  )
    throw new AppError("Invalid server gateway URL.", 503);
  if (
    base.protocol !== "https:" &&
    !["127.0.0.1", "localhost", "omniroute"].includes(base.hostname)
  )
    throw new AppError("A remote gateway requires HTTPS.", 503);
  return new URL(path, base);
}
async function response(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
  key?: string,
) {
  const credential = key || process.env.OMNI_MANAGEMENT_KEY;
  if (!credential)
    throw new AppError(
      "Configure OMNI_MANAGEMENT_KEY on the server before connecting providers.",
      503,
      "gateway_setup",
    );
  let r: Response;
  try {
    r = await fetch(gatewayUrl(path), {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        ...(key
          ? { "x-omniroute-no-memory": "true", "X-OmniRoute-No-Cache": "true" }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: signal || AbortSignal.timeout(45000),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new AppError(
      "OmniRoute is unreachable or timed out. Check the gateway service.",
      503,
      "gateway_offline",
    );
  }
  if (!r.ok) {
    await r.body?.cancel();
    const messages: Record<number, string> = {
      401: "Gateway credentials are invalid.",
      403: "Gateway key lacks the required management or inference scope.",
      404: "The gateway endpoint or model is unavailable.",
      409: "The gateway reported a conflicting operation.",
      429: "A provider or gateway rate limit was reached. Try again later.",
    };
    throw new AppError(
      messages[r.status] ||
        "The gateway could not complete the request. Inspect its protected dashboard.",
      r.status >= 500 ? 502 : r.status,
      "gateway_error",
    );
  }
  return r;
}
export async function management(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<Json> {
  const r = await response(path, method, body, signal);
  try {
    return await r.json();
  } catch {
    throw new AppError("Gateway returned an invalid management response.", 502);
  }
}
const deviceProviders = new Set([
  "github",
  "qwen",
  "codebuddy",
  "codebuddy-cn",
]);
const browserProviders = new Set(["claude"]);
export async function catalog(): Promise<Catalog> {
  const [manifest, raw, listed, health, nodeResponse] = await Promise.all([
    management("/api/v1/provider-plugin-manifest"),
    management("/api/providers?limit=1000"),
    management("/v1/models"),
    management("/api/monitoring/health"),
    management("/api/provider-nodes?limit=200"),
  ]);
  if (health.version !== GATEWAY_VERSION)
    throw new AppError(
      "Install the pinned OmniRoute 3.8.51 gateway before connecting.",
      502,
      "incompatible_gateway",
    );
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.providers) ||
    !Array.isArray(raw.connections) ||
    !Array.isArray(listed.data)
  )
    throw new AppError(
      "Gateway contract does not match OmniRoute 3.8.51.",
      502,
      "incompatible_gateway",
    );
  const entries = manifest.providers as ManifestProvider[];
  const connections = (raw.connections as Json[]).map((c) => ({
    id: String(c.id),
    provider: String(c.provider),
    name: typeof c.name === "string" ? c.name : String(c.provider),
    active: c.isActive === true,
    authType: String(c.authType),
    status: typeof c.testStatus === "string" ? c.testStatus : "unknown",
  }));
  const providers: Provider[] = entries.map((p) => ({
    id: p.id,
    alias: p.alias || p.id,
    name: p.id,
    capabilities: p.capabilities,
    authType: p.auth.type,
    models: p.models.length,
    setup: deviceProviders.has(p.id)
      ? "device"
      : browserProviders.has(p.id)
        ? "browser"
        : p.capabilities.includes("apikey")
          ? "key"
          : "external",
  }));
  const nodes = Array.isArray(nodeResponse.nodes)
    ? (nodeResponse.nodes as Json[])
    : [];
  if (typeof nodeResponse.total === "number")
    while (nodes.length < nodeResponse.total) {
      const page = await management(
        `/api/provider-nodes?limit=200&offset=${nodes.length}`,
      );
      if (!Array.isArray(page.nodes) || page.nodes.length === 0)
        throw new AppError("Gateway provider catalog pagination failed.", 502);
      nodes.push(...(page.nodes as Json[]));
    }
  for (const n of nodes)
    if (
      typeof n.id === "string" &&
      typeof n.prefix === "string" &&
      !providers.some((p) => p.id === n.id)
    )
      providers.push({
        id: n.id,
        alias: n.prefix,
        name: typeof n.name === "string" ? n.name : n.prefix,
        capabilities: ["apikey"],
        authType: "apikey",
        models: 0,
        setup: "key",
      });
  const models: Model[] = [];
  for (const item of listed.data as Json[]) {
    if (typeof item.id !== "string" || typeof item.owned_by !== "string")
      continue;
    if (item.type && item.type !== "chat" && item.type !== "chat-completions")
      continue;
    const provider = providers.find(
      (p) => p.id === item.owned_by || p.alias === item.owned_by,
    );
    if (
      !provider ||
      !connections.some((c) => c.provider === provider.id && c.active)
    )
      continue;
    const entry = entries.find((p) => p.id === provider.id),
      meta = entry?.models.find(
        (m) =>
          m.id === item.root ||
          m.id === item.id ||
          `${provider.alias}/${m.id}` === item.id,
      );
    const capabilities = item.capabilities as Json | undefined;
    models.push({
      id: item.id,
      name: typeof item.name === "string" ? item.name : item.id,
      provider: provider.id,
      vision:
        capabilities?.vision === true ||
        (Array.isArray(item.input_modalities) &&
          item.input_modalities.includes("image")),
      context:
        typeof item.context_length === "number" && item.context_length > 0
          ? item.context_length
          : meta?.contextLength || entry?.defaultContextLength || null,
      maxOutput:
        typeof item.max_output_tokens === "number" && item.max_output_tokens > 0
          ? item.max_output_tokens
          : meta?.maxOutputTokens || null,
      unsupportedParams: meta?.unsupportedParams || [],
    });
  }
  return { version: GATEWAY_VERSION, providers, connections, models };
}
export function eligibleModels(
  c: Catalog,
  s: Settings,
  route: string,
  vision: boolean,
) {
  const ids = presets.includes(route as (typeof presets)[number])
    ? s.routes[route as (typeof presets)[number]]
    : [route];
  if (ids.length === 0)
    throw new AppError(
      "This route is not configured. Select its models in Settings → Routing.",
      422,
      "route_setup",
    );
  const connections = c.connections.filter(
    (x) => x.active && (s.paidEnabled || s.billing[x.id] === "subscription"),
  );
  const allowed = ids
    .map((id) => c.models.find((m) => m.id === id))
    .filter((m): m is Model =>
      Boolean(
        m &&
        (!vision || m.vision) &&
        connections.some((x) => x.provider === m.provider),
      ),
    );
  if (!allowed.length)
    throw new AppError(
      vision
        ? "No eligible vision model is available for this route. Configure a vision model or enable the required provider."
        : "No eligible model is available. Check provider status and API spending settings.",
      422,
      "no_eligible_model",
    );
  if (allowed.some((m) => !m.context))
    throw new AppError(
      "A selected model has no verified context limit. Select models with gateway context metadata.",
      422,
      "context_unknown",
    );
  return {
    models: allowed,
    connections: connections.filter((x) =>
      allowed.some((m) => m.provider === x.provider),
    ),
  };
}
export async function prepareInference(
  c: Catalog,
  s: Settings,
  route: string,
  vision: boolean,
  signal: AbortSignal,
) {
  const selected = eligibleModels(c, s, route, vision),
    comboName = `omni-${randomUUID()}`;
  let comboId: string | undefined, keyId: string | undefined;
  const cleanup = async () => {
    if (keyId)
      await management(
        `/api/keys/${encodeURIComponent(keyId)}`,
        "DELETE",
      ).catch(() => {});
    if (comboId)
      await management(
        `/api/combos/${encodeURIComponent(comboId)}`,
        "DELETE",
      ).catch(() => {});
  };
  try {
    if (signal.aborted) throw new AppError("Response stopped.", 409);
    const strategy = presets.includes(route as (typeof presets)[number])
      ? "auto"
      : "priority";
    const pack =
      route === "quality"
        ? "quality-first"
        : route === "fast"
          ? "ship-fast"
          : route === "economy"
            ? "cost-saver"
            : undefined;
    const combo = await management(
      "/api/combos",
      "POST",
      {
        name: comboName,
        models: selected.models.map((m) => ({
          model: m.id,
          allowedConnectionIds: selected.connections
            .filter((x) => x.provider === m.provider)
            .map((x) => x.id),
        })),
        strategy,
        config: {
          candidatePool: [
            ...new Set(
              selected.models.map(
                (m) =>
                  c.providers.find((p) => p.id === m.provider)?.alias ||
                  m.provider,
              ),
            ),
          ],
          maxRetries: 0,
          maxGlobalAttempts: Math.min(10, selected.models.length),
          comboTimeoutMs: 600000,
          compressionMode: "off",
          reasoningTokenBufferEnabled: false,
          fallbackCompressionMode: "off",
          hedging: false,
          explorationRate: 0,
          ...(pack ? { modePack: pack } : {}),
        },
      },
      signal,
    );
    comboId = String(combo.id);
    const key = await management(
      "/api/keys",
      "POST",
      {
        name: comboName,
        modelAccessMode: "restricted",
        allowedModels: selected.models.map((m) => m.id),
        allowedCombos: [comboName],
        allowedConnections: selected.connections.map((x) => x.id),
        scopes: ["read"],
        noLog: true,
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      },
      signal,
    );
    if (typeof key.key !== "string" || typeof key.id !== "string")
      throw new AppError(
        "Gateway did not issue a restricted inference credential.",
        502,
      );
    keyId = key.id;
    await management(
      `/api/keys/${encodeURIComponent(keyId)}`,
      "PATCH",
      {
        compressionEnabled: false,
        cacheDefaultMode: "bypass",
        streamDefaultMode: "legacy",
      },
      signal,
    );
    return { ...selected, comboName, key: key.key, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
export async function inference(
  body: unknown,
  key: string,
  signal: AbortSignal,
) {
  return response("/v1/chat/completions", "POST", body, signal, key);
}
export async function connectionAction(
  id: string,
  action: string,
  value?: unknown,
) {
  if (action === "test") {
    const result = await management(
      `/api/providers/${encodeURIComponent(id)}/test`,
      "POST",
      {},
    );
    return {
      valid: result.valid === true,
      success: result.success === true,
      status: typeof result.testStatus === "string" ? result.testStatus : null,
      message:
        result.valid === true || result.success === true
          ? "Connection test succeeded."
          : "Test finished. Review the connection status; unsupported tests are not proof of availability.",
    };
  }
  if (action === "remove")
    return management(`/api/providers/${encodeURIComponent(id)}`, "DELETE");
  return management(`/api/providers/${encodeURIComponent(id)}`, "PUT", value);
}
export async function startOAuth(provider: string) {
  const c = await catalog(),
    p = c.providers.find((p) => p.id === provider);
  if (!p) throw new AppError("Provider is not in the gateway catalog.");
  if (p.setup !== "device" && p.setup !== "browser")
    throw new AppError(
      "This provider requires the guided external connection steps.",
      422,
    );
  const value = await management(
    `/api/oauth/${encodeURIComponent(provider)}/${p.setup === "device" ? "device-code" : "authorize"}`,
  );
  if (value.supported === false)
    throw new AppError(
      "This provider's browser authorization is not configured in the gateway.",
      422,
    );
  const id = randomUUID();
  db().prepare("DELETE FROM oauth WHERE expires<?").run(Date.now());
  db()
    .prepare("INSERT INTO oauth VALUES (?,?,?,?)")
    .run(id, provider, JSON.stringify(value), Date.now() + 600000);
  if (p.setup === "device")
    return {
      id,
      kind: "device",
      url: String(
        value.verificationUriComplete ||
          value.verification_uri_complete ||
          value.verificationUri ||
          value.verification_uri ||
          value.verificationUrl ||
          "",
      ),
      code: String(value.userCode || value.user_code || ""),
      interval: typeof value.interval === "number" ? value.interval : 5,
    };
  return { id, kind: "browser", url: String(value.authUrl || ""), code: null };
}
export async function finishOAuth(id: string, callback?: string) {
  const ticket = db()
    .prepare("SELECT * FROM oauth WHERE id=? AND expires>?")
    .get(id, Date.now()) as { provider: string; value: string } | undefined;
  if (!ticket) throw new AppError("Authorization expired. Start again.", 410);
  const v = JSON.parse(ticket.value);
  let result: Json;
  if (callback) {
    let u: URL;
    try {
      u = new URL(callback);
    } catch {
      throw new AppError(
        "Paste the complete callback URL from the authorization window.",
      );
    }
    if (u.searchParams.get("state") !== v.state)
      throw new AppError("Authorization state does not match. Start again.");
    result = await management(
      `/api/oauth/${encodeURIComponent(ticket.provider)}/exchange`,
      "POST",
      {
        code: u.searchParams.get("code"),
        codeVerifier: v.codeVerifier,
        redirectUri: v.redirectUri,
        state: v.state,
      },
    );
  } else
    result = await management(
      `/api/oauth/${encodeURIComponent(ticket.provider)}/poll`,
      "POST",
      {
        deviceCode: v.deviceCode || v.device_code,
        codeVerifier: v.codeVerifier,
      },
    );
  if (result.success === true) {
    db().prepare("DELETE FROM oauth WHERE id=?").run(id);
    return { success: true, pending: false };
  }
  if (result.pending === true) return { success: false, pending: true };
  throw new AppError(
    "Provider authorization did not finish. Try reconnecting or use the external setup guide.",
    422,
  );
}
