import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { addAttachment, dataDir, detail } from "./db";
import { AppError } from "./errors";
import type { Attachment } from "./types";
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 6;
export const MAX_TEXT_CHARS = 200000;
export async function extract(
  name: string,
  bytes: Uint8Array,
): Promise<{ type: string; text: string | null }> {
  const ext = extname(name).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
    const b = Buffer.from(bytes);
    const valid =
      ext === ".png"
        ? b
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : ext === ".webp"
          ? b.toString("ascii", 0, 4) === "RIFF" &&
            b.toString("ascii", 8, 12) === "WEBP"
          : b[0] === 255 && b[1] === 216;
    if (!valid)
      throw new AppError("Image contents do not match its file extension.");
    const { default: sharp } = await import("sharp");
    const image = sharp(bytes, { limitInputPixels: 16_777_216 });
    const meta = await image.metadata();
    if (
      !meta.width ||
      !meta.height ||
      meta.width > 4096 ||
      meta.height > 4096 ||
      (meta.pages || 1) > 1
    )
      throw new AppError(
        "Use a single image no larger than 4096 × 4096 pixels.",
      );
    await image.stats();
    return {
      type:
        ext === ".png"
          ? "image/png"
          : ext === ".webp"
            ? "image/webp"
            : "image/jpeg",
      text: null,
    };
  }
  let text: string;
  if (ext === ".pdf") {
    if (Buffer.from(bytes).toString("ascii", 0, 5) !== "%PDF-")
      throw new AppError("This file is not a valid PDF.");
    const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // Next may relocate the external ESM package, so resolve the explicitly traced worker independently.
    const runtimeRequire = createRequire(
      resolve(process.cwd(), "package.json"),
    );
    pdf.GlobalWorkerOptions.workerSrc = pathToFileURL(
      runtimeRequire.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).href;
    const loading = pdf.getDocument({
      // PDF.js transfers its buffer to the worker; preserve the original for private storage.
      data: bytes.slice(),
      useSystemFonts: true,
    });
    const document = await loading.promise;
    try {
      if (document.numPages > 100)
        throw new AppError("PDFs may contain at most 100 pages.");
      const pages: string[] = [];
      let length = 0;
      for (let i = 1; i <= document.numPages; i++) {
        const page = await document.getPage(i),
          content = await page.getTextContent();
        const value = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ");
        if (!value.trim())
          throw new AppError(
            `Page ${i} has no readable text. Scanned PDFs need OCR, which is not included.`,
          );
        length += value.length;
        if (length > MAX_TEXT_CHARS)
          throw new AppError(
            "Extracted document exceeds 200,000 characters. Split it into smaller files.",
          );
        pages.push(`Page ${i}
${value}`);
      }
      text = pages.join("\n\n");
    } finally {
      await loading.destroy();
    }
  } else if (ext === ".docx") {
    // Bound expanded OOXML before mammoth processes it to reject ZIP bombs.
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(bytes);
    let expanded = 0;
    for (const item of Object.values(zip.files)) {
      const size =
        (item as unknown as { _data?: { uncompressedSize: number } })._data
          ?.uncompressedSize || 0;
      expanded += size;
      if (expanded > 30 * 1024 * 1024)
        throw new AppError("Expanded Word document is too large.");
    }
    if (!zip.file("word/document.xml"))
      throw new AppError("This file is not a valid Word document.");
    const mammoth = await import("mammoth");
    text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
  } else if ([".txt", ".md", ".csv", ".json"].includes(ext)) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new AppError("Text documents must use UTF-8 encoding.");
    }
    if (text.includes("\u0000"))
      throw new AppError("This file contains binary data.");
  } else
    throw new AppError(
      "Use PNG, JPEG, WebP, text PDF, DOCX, TXT, Markdown, CSV, or JSON.",
    );
  if (!text.trim())
    throw new AppError("This document contains no readable text.");
  if (text.length > MAX_TEXT_CHARS)
    throw new AppError(
      "Extracted document exceeds 200,000 characters. Split it into smaller files.",
    );
  return { type: "text/plain", text };
}
export async function upload(conversationId: string, file: File) {
  detail(conversationId);
  if (file.size > MAX_FILE_BYTES || file.size === 0)
    throw new AppError(
      "Each attachment must be nonempty and no larger than 10 MB.",
      413,
    );
  const id = randomUUID(),
    a: Attachment = {
      id,
      conversationId,
      name: file.name.slice(0, 200),
      size: file.size,
      type: "application/octet-stream",
      status: "ready",
      text: null,
      error: null,
      path: resolve(dataDir(), "attachments", id),
    };
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    Object.assign(a, await extract(file.name, bytes));
    await mkdir(resolve(dataDir(), "attachments"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(a.path, bytes, { mode: 0o600 });
  } catch (error) {
    a.status = "failed";
    a.error =
      error instanceof AppError
        ? error.message
        : "Could not read this file. It may be encrypted, damaged, or unsupported.";
    a.path = "";
  }
  addAttachment(a);
  return a;
}
export async function attachmentContent(a: Attachment) {
  if (a.status !== "ready")
    throw new AppError(
      `Remove the unreadable attachment ${a.name} before sending.`,
    );
  if (a.type.startsWith("image/"))
    return {
      type: "image_url",
      image_url: {
        url: `data:${a.type};base64,${(await readFile(a.path)).toString("base64")}`,
      },
    };
  return {
    type: "text",
    text: `Attached document: ${a.name}
<document>
${a.text}
</document>`,
  };
}
export async function removeFiles(files: Attachment[]) {
  for (const a of files) if (a.path) await unlink(a.path).catch(() => {});
}
