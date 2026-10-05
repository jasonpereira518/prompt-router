import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
import {
  db,
  createConversation,
  detail,
  beginGeneration,
  checkpoint,
  saveSettings,
  deleteConversation,
  addAttachment,
} from "@/lib/db";
import {
  login,
  authorized,
  cookie,
  checkOrigin,
  verifyPassword,
} from "@/lib/auth";
import { defaults, type Catalog } from "@/lib/types";
import { eligibleModels, prepareInference, catalog } from "@/lib/gateway";
import * as gatewayModule from "@/lib/gateway";
import { extract } from "@/lib/files";
import { events } from "@/lib/sse";
import { estimateContext, startChat, usableHistory } from "@/lib/chat";
const subscription = "11111111-1111-4111-8111-111111111111",
  paid = "22222222-2222-4222-8222-222222222222";
const fixture: Catalog = {
  version: "3.8.51",
  providers: [
    {
      id: "demo",
      alias: "demo",
      name: "Demo",
      capabilities: ["apikey"],
      authType: "apikey",
      models: 2,
      setup: "key",
    },
  ],
  connections: [
    {
      id: subscription,
      provider: "demo",
      name: "Subscription",
      active: true,
      authType: "oauth",
      status: "active",
    },
    {
      id: paid,
      provider: "demo",
      name: "API",
      active: true,
      authType: "apikey",
      status: "active",
    },
  ],
  models: [
    {
      id: "demo/text",
      name: "Text",
      provider: "demo",
      vision: false,
      context: 64000,
      maxOutput: 4096,
      unsupportedParams: [],
    },
    {
      id: "demo/vision",
      name: "Vision",
      provider: "demo",
      vision: true,
      context: 64000,
      maxOutput: 4096,
      unsupportedParams: [],
    },
  ],
};
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omni-tests-"));
  process.env.OMNI_DATA_DIR = dir;
  process.env.APP_ORIGIN = "http://localhost:3000";
  process.env.OWNER_EMAIL = "owner@example.test";
  process.env.OWNER_PASSWORD_HASH = `salt:${scryptSync("valid-password", "salt", 64).toString("hex")}`;
  process.env.OMNI_MANAGEMENT_KEY = "test-management";
});
beforeEach(() => {
  db().exec(
    "DELETE FROM conversations;DELETE FROM settings;DELETE FROM sessions;DELETE FROM login_attempts;DELETE FROM oauth;",
  );
  vi.restoreAllMocks();
});
afterAll(() => {
  db().close();
  delete (globalThis as typeof globalThis & { omniDb?: unknown }).omniDb;
  rmSync(dir, { recursive: true, force: true });
});
const configured = () => ({
  ...structuredClone(defaults),
  billing: { [subscription]: "subscription" as const },
  routes: {
    balanced: ["demo/text", "demo/vision"],
    quality: ["demo/text"],
    fast: [],
    economy: [],
  },
});
function byteStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const b of chunks) c.enqueue(b);
      c.close();
    },
  });
}
describe("owner boundary", () => {
  it("authenticates only the configured identity and persists opaque sessions", () => {
    expect(() => login("other@example.test", "valid-password")).toThrow(
      "incorrect",
    );
    const token = login("owner@example.test", "valid-password");
    expect(
      authorized(
        new Request("http://localhost", { headers: { cookie: cookie(token) } }),
      ),
    ).toBe(true);
    expect(
      authorized(
        new Request("http://localhost", {
          headers: { cookie: cookie("forged") },
        }),
      ),
    ).toBe(false);
    expect(token).not.toContain("password");
  });
  it("requires exact origin for mutations", () => {
    expect(() =>
      checkOrigin(
        new Request("http://localhost", {
          headers: { origin: "https://evil.test" },
        }),
      ),
    ).toThrow();
    expect(() =>
      checkOrigin(
        new Request("http://localhost", {
          headers: { origin: "http://localhost:3000" },
        }),
      ),
    ).not.toThrow();
  });
  it("rejects malformed hashes and limits password attempts", () => {
    expect(verifyPassword("x", "invalid")).toBe(false);
    for (let i = 0; i < 10; i++)
      expect(() => login("owner@example.test", "wrong")).toThrow();
    expect(() => login("owner@example.test", "valid-password")).toThrow(
      "Too many",
    );
  });
});
describe("conversation durability", () => {
  it("keeps partial responses and independent retry records", () => {
    const c = createConversation();
    const a = beginGeneration(c.id, "balanced", "hello", []);
    checkpoint(a, "partial", { status: "stopped" });
    const prompt = detail(c.id).messages[0];
    const retry = beginGeneration(c.id, "quality", "hello", [], prompt.id);
    checkpoint(retry, "completed", {
      status: "completed",
      inputTokens: 10,
      outputTokens: 5,
    });
    const stored = detail(c.id);
    expect(stored.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(stored.generations).toHaveLength(2);
    expect(stored.messages[1].content).toBe("partial");
    expect(stored.generations[0].inputTokens).toBeNull();
    expect(stored.generations[1].outputTokens).toBe(5);
  });
  it("preserves checkpointed partial output and exclusions after restart", () => {
    const c = createConversation();
    const g = beginGeneration(c.id, "balanced", "hello", [], undefined, [
      "prior-turn",
    ]);
    checkpoint(g, "checkpointed partial", {});
    db().close();
    delete (globalThis as typeof globalThis & { omniDb?: unknown }).omniDb;
    const recovered = detail(c.id);
    expect(recovered.generations[0].status).toBe("interrupted");
    expect(recovered.generations[0].excludedMessageIds).toEqual(["prior-turn"]);
    expect(recovered.messages[1].content).toBe("checkpointed partial");
    expect(() => beginGeneration(c.id, "balanced", "next", [])).not.toThrow();
  });
  it("uses the latest attempt as context, retaining and identifying partial answers", () => {
    const c = createConversation();
    const first = beginGeneration(c.id, "balanced", "prompt", []);
    checkpoint(first, "old answer", { status: "completed" });
    const user = detail(c.id).messages[0];
    const retry = beginGeneration(c.id, "balanced", "prompt", [], user.id);
    checkpoint(retry, "new partial", { status: "stopped" });
    const stored = detail(c.id),
      history = usableHistory(stored.messages, stored.generations);
    expect(history).toHaveLength(2);
    expect(history[1].content).toContain("new partial");
    expect(history[1].content).toContain("partial: stopped");
    expect(stored.messages[2].content).toBe("new partial");
  });
  it("enforces one active generation across requests and protects deletion", () => {
    const c = createConversation();
    beginGeneration(c.id, "balanced", "hello", []);
    expect(() => beginGeneration(c.id, "balanced", "duplicate", [])).toThrow(
      "already running",
    );
    expect(() => deleteConversation(c.id)).toThrow("Stop");
    expect(detail(c.id).messages).toHaveLength(2);
  });
  it("cascades chat deletion through generations and attachments", () => {
    const c = createConversation(),
      g = beginGeneration(c.id, "balanced", "hello", []);
    checkpoint(g, "answer", { status: "completed" });
    addAttachment({
      id: "a",
      conversationId: c.id,
      name: "note",
      type: "text/plain",
      size: 4,
      text: "text",
      path: "",
      error: null,
      status: "ready",
    });
    deleteConversation(c.id);
    expect(db().prepare("SELECT * FROM generations").all()).toHaveLength(0);
    expect(db().prepare("SELECT * FROM attachments").all()).toHaveLength(0);
  });
  it("backs up and restores a real database and attachment at a new location", () => {
    const c = createConversation();
    const g = beginGeneration(c.id, "balanced", "hello", []);
    checkpoint(g, "saved", { status: "completed" });
    mkdirSync(join(dir, "attachments"), { recursive: true });
    writeFileSync(
      join(dir, "attachments", "backup-file"),
      "preserved attachment",
    );
    addAttachment({
      id: "backup-file",
      conversationId: c.id,
      name: "source.txt",
      type: "text/plain",
      size: 20,
      text: "preserved attachment",
      path: join(dir, "attachments", "backup-file"),
      error: null,
      status: "ready",
    });
    const backup = join(dir, "..", `${dir.split("/").at(-1)}-backup`),
      restore = join(dir, "..", `${dir.split("/").at(-1)}-restore`);
    const created = spawnSync(
      process.execPath,
      ["scripts/backup.mjs", "create", backup],
      { env: { ...process.env, OMNI_DATA_DIR: dir }, encoding: "utf8" },
    );
    expect(created.status, created.stderr).toBe(0);
    const restored = spawnSync(
      process.execPath,
      ["scripts/backup.mjs", "restore", backup],
      { env: { ...process.env, OMNI_DATA_DIR: restore }, encoding: "utf8" },
    );
    expect(restored.status, restored.stderr).toBe(0);
    const checked = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(${JSON.stringify(join(restore, "omni.sqlite"))});console.log(d.prepare('SELECT content FROM messages WHERE role=?').get('assistant').content)`,
      ],
      { encoding: "utf8" },
    );
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout.trim()).toBe("saved");
    expect(
      readFileSync(join(restore, "attachments", "backup-file"), "utf8"),
    ).toBe("preserved attachment");
    rmSync(backup, { recursive: true, force: true });
    rmSync(restore, { recursive: true, force: true });
  });
});
describe("eligibility through fallback", () => {
  it("excludes unknown and paid connections by default", () => {
    expect(() => eligibleModels(fixture, defaults, "demo/text", false)).toThrow(
      "No eligible",
    );
    const result = eligibleModels(fixture, configured(), "balanced", false);
    expect(result.connections.map((c) => c.id)).toEqual([subscription]);
  });
  it("fails closed for empty presets and filters every vision target", () => {
    expect(() =>
      eligibleModels(fixture, configured(), "economy", false),
    ).toThrow("not configured");
    expect(
      eligibleModels(fixture, configured(), "balanced", true).models.map(
        (m) => m.id,
      ),
    ).toEqual(["demo/vision"]);
    expect(() =>
      eligibleModels(fixture, configured(), "quality", true),
    ).toThrow("vision");
  });
  it("requires verified context and expands paid eligibility only when enabled", () => {
    expect(() =>
      eligibleModels(
        {
          ...fixture,
          models: fixture.models.map((m) => ({ ...m, context: null })),
        },
        configured(),
        "balanced",
        false,
      ),
    ).toThrow("context limit");
    expect(
      eligibleModels(
        fixture,
        { ...configured(), paidEnabled: true },
        "balanced",
        false,
      ).connections,
    ).toHaveLength(2);
  });
  it("creates restricted keys and explicit gateway combos, then removes both", async () => {
    const calls: {
      path: string;
      method: string;
      body: Record<string, unknown>;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, options: RequestInit) => {
        const body = options.body ? JSON.parse(String(options.body)) : {};
        calls.push({ path: url.pathname, method: options.method!, body });
        return Response.json(
          url.pathname === "/api/keys"
            ? { id: "key-id", key: "test-inference" }
            : { id: "combo-id" },
        );
      }),
    );
    const r = await prepareInference(
      fixture,
      configured(),
      "balanced",
      true,
      new AbortController().signal,
    );
    const combo = calls.find((c) => c.path === "/api/combos")!;
    expect(combo.body.models).toEqual([
      { model: "demo/vision", allowedConnectionIds: [subscription] },
    ]);
    const key = calls.find((c) => c.path === "/api/keys")!;
    expect(key.body.allowedConnections).toEqual([subscription]);
    expect(key.body.allowedModels).toEqual(["demo/vision"]);
    expect(key.body.allowedCombos).toEqual([r.comboName]);
    await r.cleanup();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
    vi.unstubAllGlobals();
  });
  it("verifies gateway version before creating inference attempts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          version: "wrong",
          schemaVersion: 1,
          providers: [],
          connections: [],
          models: [],
        }),
      ),
    );
    await expect(catalog()).rejects.toThrow("pinned");
    vi.unstubAllGlobals();
  });
});
describe("stream boundaries", () => {
  it("handles split UTF-8, CRLF, comments, and multi-line SSE", async () => {
    const b = new TextEncoder().encode(
      ':ping\r\n\r\ndata: {"text":"你好"}\r\n\r\ndata: first\ndata: second\n\ndata: [DONE]\n\n',
    );
    const result = [];
    for await (const e of events(
      byteStream(Array.from(b, (b) => Uint8Array.of(b))),
    ))
      result.push(e);
    expect(result).toEqual(['{"text":"你好"}', "first\nsecond", "[DONE]"]);
  });
  it("does not accept truncated SSE frames", async () => {
    const parse = async () => {
      for await (const e of events(
        byteStream([new TextEncoder().encode("data: incomplete")]),
      )) {
        void e;
      }
    };
    await expect(parse()).rejects.toThrow("inside an event");
  });
});
describe("attachment and context validation", () => {
  it("extracts UTF-8 text and rejects binary or unsupported files", async () => {
    expect(
      (await extract("a.md", new TextEncoder().encode("# Hello"))).text,
    ).toBe("# Hello");
    await expect(extract("a.exe", new Uint8Array([1]))).rejects.toThrow(
      "Use PNG",
    );
    await expect(extract("a.txt", new Uint8Array([255]))).rejects.toThrow(
      "UTF-8",
    );
    await expect(extract("a.png", new Uint8Array([1]))).rejects.toThrow(
      "extension",
    );
  });
  it("extracts a text PDF and reports the unreadable page in an image-only PDF", async () => {
    function pdf(content: string) {
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      ];
      let value = "%PDF-1.4\n";
      const offsets = [0];
      objects.forEach((o, i) => {
        offsets.push(value.length);
        value += `${i + 1} 0 obj\n${o}\nendobj\n`;
      });
      const xref = value.length;
      value += `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      return new TextEncoder().encode(value);
    }
    const original = pdf("BT /F1 12 Tf 10 100 Td (Readable document) Tj ET");
    expect((await extract("text.pdf", original)).text).toContain(
      "Readable document",
    );
    expect(original.byteLength).toBeGreaterThan(0);
    await expect(extract("scan.pdf", pdf("0 0 100 100 re f"))).rejects.toThrow(
      "Page 1 has no readable text",
    );
  });
  it("decodes images and enforces dimension and extracted-text limits", async () => {
    const { default: sharp } = await import("sharp");
    const image = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    expect((await extract("image.png", image)).type).toBe("image/png");
    const wide = await sharp({
      create: { width: 4097, height: 1, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await expect(extract("wide.png", wide)).rejects.toThrow("4096");
    await expect(
      extract("long.txt", new TextEncoder().encode("a".repeat(200001))),
    ).rejects.toThrow("200,000");
  });
  it("reads a real OOXML Word document as text", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Document words</w:t></w:r></w:p></w:body></w:document>',
    );
    const data = await zip.generateAsync({ type: "uint8array" });
    expect((await extract("note.docx", data)).text).toContain("Document words");
  });
  it("counts non-ASCII content conservatively and rejects missing attachments", () => {
    const m = {
      id: "m",
      conversationId: "c",
      role: "user" as const,
      content: "你好",
      createdAt: "",
      generationId: null,
      attachmentIds: [],
    };
    expect(estimateContext([m], [], 2048)).toBeGreaterThan(3074);
    expect(() =>
      estimateContext([{ ...m, attachmentIds: ["missing"] }], [], 2048),
    ).toThrow("missing");
  });
  it("rejects a paid-eligibility change during asynchronous preparation", async () => {
    const c = createConversation();
    saveSettings(configured());
    vi.spyOn(gatewayModule, "catalog").mockImplementation(async () => {
      saveSettings({ ...configured(), paidEnabled: true });
      return fixture;
    });
    await expect(
      startChat({
        conversationId: c.id,
        content: "hello",
        attachmentIds: [],
        excludeMessageIds: [],
      }),
    ).rejects.toThrow("Routing settings changed");
    expect(detail(c.id).generations).toHaveLength(0);
  });
  it("does not persist a new attempt on invalid attachments", async () => {
    const c = createConversation();
    saveSettings(configured());
    await expect(
      startChat({
        conversationId: c.id,
        content: "hello",
        attachmentIds: ["missing"],
        excludeMessageIds: [],
      }),
    ).rejects.toThrow("missing");
    expect(detail(c.id).generations).toHaveLength(0);
  });
});
