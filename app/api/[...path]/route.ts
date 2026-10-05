import { z } from "zod";
import { readFile } from "node:fs/promises";
import {
  requireOwner,
  authorized,
  checkOrigin,
  login,
  logout,
  cookie,
} from "@/lib/auth";
import {
  catalog,
  management,
  connectionAction,
  startOAuth,
  finishOAuth,
} from "@/lib/gateway";
import {
  createConversation,
  listConversations,
  detail,
  updateConversation,
  deleteConversation,
  settings,
  saveSettings,
  db,
} from "@/lib/db";
import { upload, removeFiles } from "@/lib/files";
import { startChat, stop } from "@/lib/chat";
import { AppError, publicError } from "@/lib/errors";
import { presets } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routeSchema = z.string().min(1).max(300);
const settingsSchema = z.object({
  paidEnabled: z.boolean(),
  outputCap: z.number().int().min(128).max(32768),
  routes: z.object(
    Object.fromEntries(
      presets.map((p) => [p, z.array(routeSchema).max(10)]),
    ) as Record<(typeof presets)[number], z.ZodArray<typeof routeSchema>>,
  ),
  billing: z.record(z.string().uuid(), z.enum(["subscription", "paid"])),
  theme: z.enum(["system", "light", "dark"]),
});
async function json(request: Request) {
  if (Number(request.headers.get("content-length")) > 512000)
    throw new AppError("Request is too large.", 413);
  const text = await request.text();
  if (Buffer.byteLength(text) > 512000)
    throw new AppError("Request is too large.", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("Request must contain valid JSON.");
  }
}
function cleanConversation(c: ReturnType<typeof detail>) {
  return {
    ...c,
    attachments: c.attachments.map(({ path, ...a }) => {
      void path;
      return a;
    }),
  };
}
function result(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
async function handle(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await params,
      method = request.method,
      url = new URL(request.url),
      [group, id, action] = path;
    if (group === "session") {
      if (method === "GET")
        return result({
          authenticated: authorized(request),
          configured: Boolean(
            process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD_HASH,
          ),
        });
      checkOrigin(request);
      if (method === "POST") {
        const b = z
          .object({
            email: z.email().max(254),
            password: z.string().min(1).max(256),
          })
          .parse(await json(request));
        const token = login(b.email, b.password);
        return Response.json(
          { authenticated: true },
          {
            headers: {
              "Set-Cookie": cookie(token),
              "Cache-Control": "no-store",
            },
          },
        );
      }
      if (method === "DELETE") {
        logout(request);
        return Response.json(
          { authenticated: false },
          {
            headers: {
              "Set-Cookie": cookie("", 0),
              "Cache-Control": "no-store",
            },
          },
        );
      }
    }
    requireOwner(request);
    if (group === "catalog" && method === "GET") return result(await catalog());
    if (group === "settings") {
      if (method === "GET") return result(settings());
      if (method === "PUT") {
        const value = settingsSchema.parse(await json(request));
        if (
          db()
            .prepare("SELECT id FROM generations WHERE status='pending'")
            .get()
        )
          throw new AppError(
            "Stop active responses before changing routing settings.",
            409,
          );
        const c = await catalog();
        for (const model of Object.values(value.routes).flat())
          if (!c.models.some((m) => m.id === model))
            throw new AppError(
              "Routing includes a model not present in the gateway catalog.",
            );
        for (const connection of Object.keys(value.billing))
          if (!c.connections.some((x) => x.id === connection))
            delete value.billing[connection];
        if (
          db()
            .prepare("SELECT id FROM generations WHERE status='pending'")
            .get()
        )
          throw new AppError(
            "Stop active responses before changing routing settings.",
            409,
          );
        return result(saveSettings(value));
      }
    }
    if (group === "conversations") {
      if (!id && method === "GET")
        return result(
          listConversations(
            (url.searchParams.get("search") || "").slice(0, 300),
          ),
        );
      if (!id && method === "POST") return result(createConversation(), 201);
      if (id && action === "export" && method === "GET") {
        const c = cleanConversation(detail(id));
        const format = url.searchParams.get("format");
        const text =
          format === "json"
            ? JSON.stringify(c, null, 2)
            : `# ${c.title}\n\n` +
              c.messages
                .map(
                  (m) =>
                    `## ${m.role === "user" ? "You" : "Omni"}\n\n${m.content}\n\n${m.attachmentIds.map((a) => `Attachment: ${c.attachments.find((x) => x.id === a)?.name || a}`).join("\n")}\n\n`,
                )
                .join("");
        return new Response(text, {
          headers: {
            "Content-Type":
              format === "json"
                ? "application/json"
                : "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="omni-${c.id}.${format === "json" ? "json" : "md"}"`,
            "Cache-Control": "no-store",
          },
        });
      }
      if (id && !action && method === "GET")
        return result(cleanConversation(detail(id)));
      if (id && !action && method === "PATCH")
        return result(
          cleanConversation(
            updateConversation(
              id,
              z
                .object({
                  title: z.string().trim().min(1).max(200).optional(),
                  route: routeSchema.optional(),
                  outputCap: z.number().int().min(128).max(32768).optional(),
                })
                .parse(await json(request)),
            ),
          ),
        );
      if (id && !action && method === "DELETE") {
        await removeFiles(deleteConversation(id));
        return result({ deleted: true });
      }
      if (id && action === "attachments" && method === "POST") {
        const length = Number(request.headers.get("content-length"));
        if (!length || length > 11 * 1024 * 1024)
          throw new AppError("Upload must be no larger than 10 MB.", 413);
        const data = await request.formData();
        const file = data.get("file");
        if (!(file instanceof File))
          throw new AppError("Select a file to upload.");
        const a = await upload(id, file);
        return result(
          {
            id: a.id,
            name: a.name,
            type: a.type,
            status: a.status,
            error: a.error,
          },
          201,
        );
      }
    }
    if (group === "attachments" && id && method === "GET") {
      const row = db()
        .prepare("SELECT * FROM attachments WHERE id=? AND status='ready'")
        .get(id) as { path: string; type: string; name: string } | undefined;
      if (!row) throw new AppError("Attachment not found.", 404);
      const file = await readFile(row.path);
      return new Response(file, {
        headers: {
          "Content-Type": row.type,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
          "Cache-Control": "private, no-store",
        },
      });
    }
    if (group === "chat" && method === "POST")
      return await startChat(
        z
          .object({
            conversationId: z.string().uuid(),
            content: z.string().max(100000),
            attachmentIds: z.array(z.string().uuid()).max(6),
            retryId: z.string().uuid().optional(),
            excludeMessageIds: z.array(z.string().uuid()).max(1000).default([]),
          })
          .parse(await json(request)),
      );
    if (
      group === "generations" &&
      id &&
      action === "stop" &&
      method === "POST"
    ) {
      stop(id);
      return result({ stopped: true });
    }
    if (group === "providers") {
      if (!id && method === "POST") {
        const b = z
          .object({
            provider: z.string().max(120),
            name: z.string().min(1).max(100),
            apiKey: z.string().min(1).max(16000),
          })
          .parse(await json(request));
        const c = await catalog(),
          p = c.providers.find((x) => x.id === b.provider);
        if (!p?.capabilities.includes("apikey"))
          throw new AppError(
            "This provider does not expose verified API-key setup.",
            422,
          );
        const r = await management("/api/providers", "POST", b);
        const connection = r.connection as Record<string, unknown>;
        return result({ id: connection?.id, provider: b.provider }, 201);
      }
      if (id && action === "oauth" && method === "POST")
        return result(await startOAuth(id));
      if (id && method === "POST" && action === "test")
        return result(await connectionAction(id, "test"));
      if (id && method === "DELETE") {
        await connectionAction(id, "remove");
        return result({ deleted: true });
      }
      if (id && method === "PATCH") {
        const value = z
          .object({
            isActive: z.boolean().optional(),
            apiKey: z.string().min(1).max(16000).optional(),
            name: z.string().min(1).max(100).optional(),
          })
          .parse(await json(request));
        await connectionAction(id, "update", value);
        return result({ updated: true });
      }
    }
    if (group === "oauth" && id && method === "POST") {
      const b = z
        .object({ callback: z.string().max(8000).optional() })
        .parse(await json(request));
      return result(await finishOAuth(id, b.callback));
    }
    throw new AppError("Endpoint not found.", 404);
  } catch (error) {
    if (error instanceof z.ZodError)
      return result(
        {
          error: "Some fields are invalid. Check your input.",
          code: "validation_error",
        },
        400,
      );
    const e = publicError(error);
    return result({ error: e.error, code: e.code }, e.status);
  }
}
export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
};
