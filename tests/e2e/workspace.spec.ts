import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const owner = { email: "owner@example.test", password: "test-password-only" };
test.beforeAll(() =>
  rmSync(join(tmpdir(), "omni-e2e-data"), { recursive: true, force: true }),
);
async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(owner.email);
  await page.getByLabel("Password", { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
}
async function setup(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page
    .getByLabel("Billing type for Demo subscription")
    .selectOption("subscription");
  await page.getByRole("button", { name: "Routing", exact: true }).click();
  await page
    .locator(".route-section")
    .first()
    .getByRole("checkbox")
    .first()
    .check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByText("Settings saved.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to chat" }).click();
}
test("private chat, safe Markdown, cross-browser history, export and deletion", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  const unauth = await page.request.get("/api/conversations");
  expect(unauth.status()).toBe(401);
  await signIn(page);
  await setup(page);
  await page.getByLabel("Message", { exact: true }).fill("unsafe greeting");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".status.completed")).toBeVisible();
  await expect(page.getByText("12 in", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => Object.hasOwn(window, "omniUnsafe"))).toBe(
    false,
  );
  expect(await page.locator('.message a[href^="javascript:"]').count()).toBe(0);
  const response = await page.request.get("/api/catalog");
  expect(JSON.stringify(await response.json())).not.toContain("DO-NOT-EXPOSE");
  const chats = await (await page.request.get("/api/conversations")).json();
  const id = chats[0].id;
  const forged = await page.request.patch(`/api/conversations/${id}`, {
    headers: { Origin: "https://evil.test" },
    data: { title: "hacked" },
  });
  expect(forged.status()).toBe(403);
  const context = await browser.newContext();
  const second = await context.newPage();
  await signIn(second);
  await expect(
    second.getByRole("button", { name: "unsafe greeting", exact: true }),
  ).toBeVisible();
  await second
    .getByRole("button", { name: "unsafe greeting", exact: true })
    .click();
  await expect(second.locator(".status.completed")).toBeVisible();
  const exported = await page.request.get(
    `/api/conversations/${id}/export?format=json`,
  );
  const data = await exported.json();
  expect(data.generations[0].inputTokens).toBe(12);
  expect(JSON.stringify(data)).not.toContain("apiKey");
  expect(JSON.stringify(data)).not.toContain("fixture-");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({
    path: "test-results/omni-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/omni-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete conversation" }).click();
  await expect(
    page.getByRole("heading", { name: "What’s on your mind?" }),
  ).toBeVisible();
  await context.close();
});
test("Stop preserves partial text and retry creates a separate attempt", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "New conversation" }).click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("slow response please");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText("A partial response.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop response" }).click();
  await expect(page.locator(".status.stopped")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "slow response please", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "slow response please", exact: true })
    .click();
  await expect(
    page.getByText("A partial response.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".status.completed")).toBeVisible();
  expect(await page.locator(".message.user").count()).toBe(1);
  expect(await page.locator(".message.assistant").count()).toBe(2);
});
test("attachments and recovery from an unreadable file", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "New conversation" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Useful source text"),
  });
  await expect(page.locator(".file-chip")).toContainText("note.txt");
  await page.getByLabel("Message", { exact: true }).fill("Summarize this note");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".status.completed")).toBeVisible();
  await expect(page.locator(".message-files")).toContainText("note.txt");
  await page.locator('input[type="file"]').setInputFiles({
    name: "broken.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not a PDF"),
  });
  await expect(page.locator(".file-chip.failed")).toContainText(
    "not a valid PDF",
  );
  await page
    .getByRole("button", { name: "Remove broken.pdf from message" })
    .click();
  await expect(page.locator(".file-chip.failed")).toHaveCount(0);
});

test("malformed streams fail explicitly and simultaneous submissions cannot conflict", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "New conversation" }).click();
  await page.getByLabel("Message", { exact: true }).fill("malformed fixture");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".status.failed")).toBeVisible();
  await expect(
    page
      .getByText("Gateway sent malformed stream data.", { exact: true })
      .first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "New conversation" }).click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("slow simultaneous fixture");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText("A partial response.", { exact: false }),
  ).toBeVisible();
  const chats = await (await page.request.get("/api/conversations")).json();
  const id = chats[0].id;
  const overlap = await page.request.post("/api/chat", {
    headers: { Origin: "http://localhost:3017" },
    data: {
      conversationId: id,
      content: "conflicting request",
      attachmentIds: [],
    },
  });
  expect(overlap.status()).toBe(409);
  await page.getByRole("button", { name: "Stop response" }).click();
  await expect(page.locator(".status.stopped")).toBeVisible();
  const detail = await (
    await page.request.get(`/api/conversations/${id}`)
  ).json();
  expect(
    detail.messages.filter((m: { role: string }) => m.role === "user"),
  ).toHaveLength(1);
});
