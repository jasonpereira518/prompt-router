import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { db } from "./db";
import { AppError } from "./errors";
export const sessionCookie = "omni_session";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function checkOrigin(request: Request) {
  const expected = process.env.APP_ORIGIN || "http://localhost:3000";
  if (request.headers.get("origin") !== new URL(expected).origin)
    throw new AppError(
      "This request must come from Omni.",
      403,
      "invalid_origin",
    );
}
export function authorized(request: Request) {
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(sessionCookie + "="))
    ?.slice(sessionCookie.length + 1);
  if (!raw) return false;
  return Boolean(
    db()
      .prepare("SELECT hash FROM sessions WHERE hash=? AND expires>?")
      .get(hash(raw), Date.now()),
  );
}
export function requireOwner(request: Request) {
  if (!authorized(request))
    throw new AppError("Sign in to continue.", 401, "unauthorized");
  if (!["GET", "HEAD"].includes(request.method)) checkOrigin(request);
}
export function verifyPassword(password: string, encoded: string) {
  const [salt, key] = encoded.split(":");
  if (!salt || !key || !/^[a-f0-9]{128}$/.test(key)) return false;
  const expected = Buffer.from(key, "hex");
  return timingSafeEqual(scryptSync(password, salt, 64), expected);
}
export function login(email: string, password: string) {
  if (!process.env.OWNER_EMAIL || !process.env.OWNER_PASSWORD_HASH)
    throw new AppError(
      "Owner sign-in is not configured. Follow the server setup guide.",
      503,
      "setup_required",
    );
  const now = Date.now(),
    d = db();
  const row = d
    .prepare("SELECT attempts,resetAt FROM login_attempts WHERE id='owner'")
    .get() as { attempts: number; resetAt: number } | undefined;
  if (row && row.resetAt > now && row.attempts >= 10)
    throw new AppError(
      "Too many sign-in attempts. Try again in 15 minutes.",
      429,
    );
  const valid =
    verifyPassword(password, process.env.OWNER_PASSWORD_HASH) &&
    email.toLowerCase() === process.env.OWNER_EMAIL.toLowerCase();
  if (!valid) {
    d.prepare(
      "INSERT INTO login_attempts VALUES ('owner',1,?) ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN resetAt<? THEN 1 ELSE attempts+1 END,resetAt=CASE WHEN resetAt<? THEN excluded.resetAt ELSE resetAt END",
    ).run(now + 900000, now, now);
    throw new AppError("Email or password is incorrect.", 401);
  }
  d.prepare("DELETE FROM login_attempts WHERE id='owner'").run();
  const token = randomBytes(32).toString("base64url");
  d.prepare("INSERT INTO sessions VALUES (?,?)").run(
    hash(token),
    now + 7 * 86400000,
  );
  return token;
}
export function cookie(value: string, maxAge = 604800) {
  return `${sessionCookie}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export function logout(request: Request) {
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(sessionCookie + "="))
    ?.slice(sessionCookie.length + 1);
  if (raw) db().prepare("DELETE FROM sessions WHERE hash=?").run(hash(raw));
}
