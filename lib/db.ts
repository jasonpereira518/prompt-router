import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  defaults,
  type Settings,
  type Conversation,
  type Message,
  type Generation,
  type Attachment,
  type ConversationDetail,
} from "./types";
import { AppError } from "./errors";
export const dataDir = () =>
  resolve(/* turbopackIgnore: true */ process.env.OMNI_DATA_DIR || "data");
const state = globalThis as typeof globalThis & { omniDb?: DatabaseSync };
export function db() {
  if (state.omniDb) return state.omniDb;
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const d = new DatabaseSync(resolve(dataDir(), "omni.sqlite"));
  d.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,route TEXT NOT NULL,outputCap INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS generations(id TEXT PRIMARY KEY,conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,requestedRoute TEXT NOT NULL,excludedMessageIds TEXT NOT NULL DEFAULT '[]',resolvedModel TEXT,provider TEXT,status TEXT NOT NULL,error TEXT,inputTokens INTEGER,outputTokens INTEGER,cost REAL,latency INTEGER,fallback TEXT,createdAt TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS active_generation ON generations(conversationId) WHERE status='pending';
 CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL,createdAt TEXT NOT NULL,generationId TEXT REFERENCES generations(id) ON DELETE CASCADE,attachmentIds TEXT NOT NULL DEFAULT '[]');
 CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,name TEXT NOT NULL,type TEXT NOT NULL,size INTEGER NOT NULL,status TEXT NOT NULL,error TEXT,text TEXT,path TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS login_attempts(id TEXT PRIMARY KEY,attempts INTEGER NOT NULL,resetAt INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS oauth(id TEXT PRIMARY KEY,provider TEXT NOT NULL,value TEXT NOT NULL,expires INTEGER NOT NULL);
 `);
  if (
    !(
      d.prepare("PRAGMA table_info(generations)").all() as { name: string }[]
    ).some((c) => c.name === "excludedMessageIds")
  )
    d.exec(
      "ALTER TABLE generations ADD COLUMN excludedMessageIds TEXT NOT NULL DEFAULT '[]'",
    );
  // One Node process owns the database. A crash leaves attempts visible rather than pending forever.
  d.prepare(
    "UPDATE generations SET status='interrupted',error='Server restarted before the response finished.' WHERE status='pending'",
  ).run();
  d.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
  state.omniDb = d;
  return d;
}
export function settings(): Settings {
  const row = db().prepare("SELECT value FROM settings WHERE id=1").get() as
    { value: string } | undefined;
  return row ? JSON.parse(row.value) : structuredClone(defaults);
}
export function saveSettings(value: Settings) {
  db()
    .prepare(
      "INSERT INTO settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
    )
    .run(JSON.stringify(value));
  return value;
}
export function listConversations(search = "") {
  return db()
    .prepare(
      "SELECT * FROM conversations WHERE title LIKE ? OR id IN (SELECT conversationId FROM messages WHERE content LIKE ?) ORDER BY updatedAt DESC",
    )
    .all(`%${search}%`, `%${search}%`) as unknown as Conversation[];
}
export function createConversation() {
  const now = new Date().toISOString();
  const c: Conversation = {
    id: randomUUID(),
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    route: "balanced",
    outputCap: settings().outputCap,
  };
  db()
    .prepare("INSERT INTO conversations VALUES (?,?,?,?,?,?)")
    .run(c.id, c.title, now, now, c.route, c.outputCap);
  return c;
}
export function detail(id: string): ConversationDetail {
  const c = db()
    .prepare("SELECT * FROM conversations WHERE id=?")
    .get(id) as unknown as Conversation | undefined;
  if (!c) throw new AppError("Conversation not found.", 404);
  return {
    ...c,
    messages: (
      db()
        .prepare("SELECT * FROM messages WHERE conversationId=? ORDER BY rowid")
        .all(id) as unknown as (Omit<Message, "attachmentIds"> & {
        attachmentIds: string;
      })[]
    ).map((m) => ({ ...m, attachmentIds: JSON.parse(m.attachmentIds) })),
    generations: (
      db()
        .prepare(
          "SELECT * FROM generations WHERE conversationId=? ORDER BY rowid",
        )
        .all(id) as unknown as (Omit<Generation, "excludedMessageIds"> & {
        excludedMessageIds: string;
      })[]
    ).map((g) => ({
      ...g,
      excludedMessageIds: JSON.parse(g.excludedMessageIds),
    })),
    attachments: db()
      .prepare("SELECT * FROM attachments WHERE conversationId=?")
      .all(id) as unknown as Attachment[],
  };
}
export function updateConversation(
  id: string,
  value: Partial<Pick<Conversation, "title" | "route" | "outputCap">>,
) {
  const c = detail(id);
  db()
    .prepare(
      "UPDATE conversations SET title=?,route=?,outputCap=?,updatedAt=? WHERE id=?",
    )
    .run(
      value.title ?? c.title,
      value.route ?? c.route,
      value.outputCap ?? c.outputCap,
      new Date().toISOString(),
      id,
    );
  return detail(id);
}
export function deleteConversation(id: string) {
  const c = detail(id);
  if (c.generations.some((g) => g.status === "pending"))
    throw new AppError(
      "Stop the active response before deleting this chat.",
      409,
    );
  db().prepare("DELETE FROM conversations WHERE id=?").run(id);
  return c.attachments;
}
export function addAttachment(a: Attachment) {
  db()
    .prepare("INSERT INTO attachments VALUES (?,?,?,?,?,?,?,?,?)")
    .run(
      a.id,
      a.conversationId,
      a.name,
      a.type,
      a.size,
      a.status,
      a.error,
      a.text,
      a.path,
    );
}
export function beginGeneration(
  conversationId: string,
  route: string,
  content: string,
  attachmentIds: string[],
  retryId?: string,
  excludedMessageIds: string[] = [],
) {
  const d = db(),
    id = randomUUID(),
    now = new Date().toISOString();
  d.exec("BEGIN IMMEDIATE");
  try {
    const c = detail(conversationId);
    if (c.generations.some((g) => g.status === "pending"))
      throw new AppError(
        "A response is already running in this conversation.",
        409,
        "generation_conflict",
      );
    if (retryId) {
      const last = c.messages.filter((m) => m.role === "user").at(-1);
      if (last?.id !== retryId)
        throw new AppError("Only the latest prompt can be retried.");
    }
    d.prepare(
      "INSERT INTO generations(id,conversationId,requestedRoute,status,createdAt,excludedMessageIds) VALUES (?,?,?,'pending',?,?)",
    ).run(id, conversationId, route, now, JSON.stringify(excludedMessageIds));
    if (!retryId)
      d.prepare("INSERT INTO messages VALUES (?,?, 'user',?,?,NULL,?)").run(
        randomUUID(),
        conversationId,
        content,
        now,
        JSON.stringify(attachmentIds),
      );
    d.prepare("INSERT INTO messages VALUES (?,?, 'assistant','',?,?,'[]')").run(
      randomUUID(),
      conversationId,
      now,
      id,
    );
    if (c.title === "New conversation")
      d.prepare("UPDATE conversations SET title=? WHERE id=?").run(
        content.slice(0, 70) || "Attachment conversation",
        conversationId,
      );
    d.prepare("UPDATE conversations SET updatedAt=? WHERE id=?").run(
      now,
      conversationId,
    );
    d.exec("COMMIT");
    return id;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}
export function checkpoint(
  id: string,
  content: string,
  patch: Partial<Generation> = {},
) {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare("UPDATE messages SET content=? WHERE generationId=?").run(
      content,
      id,
    );
    const allowed = [
      "resolvedModel",
      "provider",
      "status",
      "error",
      "inputTokens",
      "outputTokens",
      "cost",
      "latency",
      "fallback",
    ] as const;
    for (const key of allowed)
      if (patch[key] !== undefined)
        d.prepare(`UPDATE generations SET ${key}=? WHERE id=?`).run(
          patch[key]!,
          id,
        );
    d.prepare(
      "UPDATE conversations SET updatedAt=? WHERE id=(SELECT conversationId FROM generations WHERE id=?)",
    ).run(new Date().toISOString(), id);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}
