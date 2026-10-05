import { mkdir, cp, access, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
const [mode = "create", directory] = process.argv.slice(2);
const source = resolve(process.env.OMNI_DATA_DIR || "data");
if (!directory || !["create", "restore"].includes(mode)) {
  console.error(
    "Usage: node scripts/backup.mjs create|restore DIRECTORY. Stop the app before restore; stop gateway before its filesystem backup.",
  );
  process.exit(1);
}
const target = resolve(directory);
if (target === source || target.startsWith(source + "/"))
  throw new Error("Backup directory must be outside application data.");
if (mode === "create") {
  await mkdir(target, { recursive: true, mode: 0o700 });
  if ((await readdir(target)).length)
    throw new Error("Use an empty backup directory to avoid mixing snapshots.");
  await access(resolve(source, "omni.sqlite"));
  const database = new DatabaseSync(resolve(source, "omni.sqlite"));
  await backup(database, resolve(target, "omni.sqlite"));
  database.close();
  try {
    await access(resolve(source, "attachments"));
    await cp(resolve(source, "attachments"), resolve(target, "attachments"), {
      recursive: true,
    });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  console.log(
    "Application database and attachments backed up. Follow docs/operations.md for encrypted gateway and secret backups.",
  );
} else {
  try {
    const files = await readdir(source);
    if (files.length)
      throw new Error(
        "Restore requires an empty data directory. Preserve existing data first.",
      );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await mkdir(source, { recursive: true, mode: 0o700 });
  await cp(resolve(target, "omni.sqlite"), resolve(source, "omni.sqlite"));
  try {
    await access(resolve(target, "attachments"));
    await cp(resolve(target, "attachments"), resolve(source, "attachments"), {
      recursive: true,
    });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const database = new DatabaseSync(resolve(source, "omni.sqlite"));
  database.exec(
    "DELETE FROM sessions; DELETE FROM oauth; UPDATE attachments SET path='" +
      source.replaceAll("'", "''") +
      "/attachments/'||id WHERE path!=''",
  );
  const check = database.prepare("PRAGMA integrity_check").get();
  database.close();
  if (check.integrity_check !== "ok")
    throw new Error("Restored database failed integrity check.");
  console.log(
    "Application data restored and sessions revoked. Start the app and verify chat and attachment access.",
  );
}
