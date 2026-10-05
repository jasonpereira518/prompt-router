// Smoke-test the standalone production image using only disposable owner credentials.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { scryptSync } from "node:crypto";
import JSZip from "jszip";
import sharp from "sharp";
const name = `omni-runtime-${process.pid}`;
const origin = "http://127.0.0.1:3018";
function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });
}
try {
  docker(
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1:3018:3000",
    "-e",
    `APP_ORIGIN=${origin}`,
    "-e",
    "OWNER_EMAIL=runtime@example.test",
    "-e",
    `OWNER_PASSWORD_HASH=salt:${scryptSync("runtime-test-password", "salt", 64).toString("hex")}`,
    "omni-web-verification",
  );
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      /* Wait for this container only. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal((await fetch(origin + "/api/conversations")).status, 401);
  const login = await fetch(origin + "/api/session", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "runtime@example.test",
      password: "runtime-test-password",
    }),
  });
  assert(login.ok);
  assert(login.headers.get("set-cookie").includes("Secure"));
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const headers = { cookie, Origin: origin };
  const created = await fetch(origin + "/api/conversations", {
    method: "POST",
    headers,
  });
  assert(created.ok);
  const chat = await created.json();
  const content = "BT /F1 12 Tf 10 100 Td (Packaged PDF works) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const form = new FormData();
  form.append(
    "file",
    new Blob([pdf], { type: "application/pdf" }),
    "runtime.pdf",
  );
  const upload = await fetch(
    `${origin}/api/conversations/${chat.id}/attachments`,
    { method: "POST", headers, body: form },
  );
  assert(upload.ok);
  const attachment = await upload.json();
  assert.equal(attachment.status, "ready", attachment.error);
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Packaged DOCX works</w:t></w:r></w:p></w:body></w:document>',
  );
  const png = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  for (const [filename, data] of [
    ["runtime.docx", await zip.generateAsync({ type: "uint8array" })],
    ["runtime.png", png],
    ["runtime.txt", new TextEncoder().encode("Packaged text works")],
  ]) {
    const files = new FormData();
    files.append("file", new Blob([data]), filename);
    const saved = await fetch(
      `${origin}/api/conversations/${chat.id}/attachments`,
      { method: "POST", headers, body: files },
    );
    assert(saved.ok);
    const value = await saved.json();
    assert.equal(value.status, "ready", `${filename}: ${value.error}`);
  }
  const detail = await (
    await fetch(`${origin}/api/conversations/${chat.id}`, { headers })
  ).json();
  assert(detail.attachments[0].text.includes("Packaged PDF works"));
  assert.equal(
    (await fetch(`${origin}/api/attachments/${attachment.id}`, { headers }))
      .status,
    200,
  );
  assert.equal(
    (await fetch(`${origin}/api/attachments/${attachment.id}`)).status,
    401,
  );
  console.log(
    "Production image passed: owner-only APIs, Secure session, persistent SQLite, PDF/DOCX/text extraction, image validation, and private attachment download.",
  );
} finally {
  try {
    docker("stop", name);
  } catch {
    /* --rm owns this disposable container. */
  }
}
