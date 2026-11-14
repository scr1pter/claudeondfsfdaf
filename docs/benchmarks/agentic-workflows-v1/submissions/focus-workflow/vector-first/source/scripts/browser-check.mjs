import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

assert(process.env.PLAYWRIGHT_MODULE && process.env.CHROME_PATH && process.env.VERIFICATION_DIR,
  "Set PLAYWRIGHT_MODULE, CHROME_PATH and an outside-source VERIFICATION_DIR");
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE);
const base = `http://127.0.0.1:${process.env.PORT || 8088}`;
const output = process.env.VERIFICATION_DIR;
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true,
  args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const errors = [], outside = [];
await context.route("**/*", route => {
  if (new URL(route.request().url()).origin !== base) { outside.push(route.request().url()); return route.abort(); }
  return route.continue();
});
const page = await context.newPage();
page.on("pageerror", error => errors.push(error.message));
const unique = Date.now().toString();
async function workflow(name) {
  const response = await fetch(base + "/api/workflows");
  return (await response.json()).workflows.find(w => w.name === name);
}
async function waitFor(check, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(message);
}
try {
  await page.goto(base);
  await page.getByRole("heading", { name: "Workflow Runner", exact: true }).waitFor();
  await page.getByRole("button", { name: "Create workflow", exact: true }).click();
  await page.locator("#workflow-error").filter({ hasText: /.+/ }).waitFor();
  const name = `Browser retry ${unique}`;
  await page.getByLabel("Workflow name", { exact: true }).fill(name);
  const definition = page.getByLabel("Workflow definition", { exact: true });
  const original = await definition.inputValue();
  await definition.fill("[");
  await page.getByRole("button", { name: "Create workflow", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "must be valid JSON" }).waitFor();
  assert.equal(await workflow(name), undefined);
  await definition.fill(original);
  await page.getByLabel("Concurrency", { exact: true }).selectOption("2");
  await page.getByRole("button", { name: "Create workflow", exact: true }).click();
  const card = page.getByRole("article", { name: "Workflow " + name, exact: true });
  await card.getByTestId("workflow-status").filter({ hasText: "succeeded" }).waitFor();
  assert.equal(await card.locator(".attempt").count(), 3);
  const created = await workflow(name);
  assert.equal((await (await fetch(base + "/api/workflows")).json()).workflows.filter(w => w.name === name).length, 1);
  assert.equal(await card.getAttribute("data-workflow-id"), created.id);
  await card.getByRole("button", { name: "View events " + name, exact: true }).click();
  const region = card.getByRole("region", { name: "Events for " + name, exact: true });
  await region.getByText(/workflow.succeeded/).waitFor();
  const backendEvents = await (await fetch(base + `/api/workflows/${created.id}/events`)).json();
  assert.equal(await region.locator("li").count(), backendEvents.events.length);
  for (const [i, event] of backendEvents.events.entries()) assert((await region.locator("li").nth(i).innerText()).includes(event.type));

  // A separate HTTP client changes state while the page remains open.
  const externalName = `External <img src=x onerror=alert(1)> ${unique}`;
  const response = await fetch(base + "/api/workflows", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ name: externalName, concurrency: 1, jobs: [{ key: "failure", name: "Failure detail", kind: "fail" }] }) });
  assert.equal(response.status, 201);
  const externalCard = page.getByRole("article", { name: "Workflow " + externalName, exact: true });
  const pollingStarted = Date.now();
  await waitFor(async () => await externalCard.count() > 0 && await externalCard.getByTestId("workflow-status").textContent() === "failed", "External status did not appear within three seconds");
  const pollingLatencyMs = Date.now() - pollingStarted;
  assert(pollingLatencyMs < 3000);
  await externalCard.getByRole("alert").filter({ hasText: "Synthetic worker requested failure" }).waitFor();
  assert.equal(await externalCard.locator("img").count(), 0);

  const cancelName = `Browser cancel ${unique}`;
  await page.getByLabel("Workflow name", { exact: true }).fill(cancelName);
  await page.getByLabel("Concurrency", { exact: true }).selectOption("1");
  await definition.fill(JSON.stringify([{ key: "done", name: "Preserved step", kind: "succeed" },
    { key: "waiting", name: "Wait for release", kind: "block", dependsOn: ["done"] },
    { key: "pending", name: "Pending step", kind: "succeed", dependsOn: ["waiting"] }]));
  await page.getByRole("button", { name: "Create workflow", exact: true }).click();
  const cancelCard = page.getByRole("article", { name: "Workflow " + cancelName, exact: true });
  await cancelCard.locator(".attempt").filter({ hasText: "running" }).waitFor();
  await cancelCard.getByRole("button", { name: "Cancel workflow " + cancelName, exact: true }).click();
  await cancelCard.getByTestId("workflow-status").filter({ hasText: "cancelled" }).waitFor();
  const cancelled = await workflow(cancelName);
  assert.deepEqual(cancelled.jobs.map(j => j.status), ["succeeded", "cancelled", "cancelled"]);
  await cancelCard.getByRole("button", { name: "View events " + cancelName, exact: true }).click();
  await cancelCard.getByRole("region", { name: "Events for " + cancelName, exact: true }).getByText(/workflow.cancelled/).waitFor();

  const legacyName = `Browser legacy ${unique}`;
  await page.getByLabel("Job name", { exact: true }).fill(legacyName);
  await page.getByRole("button", { name: "Create job", exact: true }).click();
  const legacyCard = page.getByRole("region", { name: "Legacy jobs", exact: true }).getByRole("article", { name: "Legacy job " + legacyName, exact: true });
  await legacyCard.locator('[data-status="succeeded"]').waitFor();
  await page.screenshot({ path: join(output, "desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Horizontal overflow at 390px");
  await page.getByLabel("Workflow name", { exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").getAttribute("id"), "concurrency");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.getByLabel("Concurrency", { exact: true }).inputValue(), "2");
  await page.screenshot({ path: join(output, "mobile.png"), fullPage: true });
  await page.reload();
  await cancelCard.getByTestId("workflow-status").filter({ hasText: "cancelled" }).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, [], "Browser JavaScript errors");
  assert.deepEqual(outside, [], "Application requested external resources");
  const result = { ok: true, pollingLatencyMs, checks: ["desktop creation", "JSON validation", "retry history", "actual ordered events", "cross-client polling under 3 seconds", "failure alerts", "safe text rendering", "running cancellation", "legacy creation", "390px overflow", "keyboard select", "reload persistence", "no external app requests", "no JS errors"], screenshots: [join(output, "desktop.png"), join(output, "mobile.png")] };
  writeFileSync(join(output, "browser-results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
