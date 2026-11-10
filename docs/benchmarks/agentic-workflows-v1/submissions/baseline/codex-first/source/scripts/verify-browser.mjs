// Run against an already-started disposable instance; this script never starts a server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const base = `http://127.0.0.1:${process.env.PORT || 4123}`;
const artifacts = resolve(".verification", "browser");
mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true,
  args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] });
const report = { checks: [], externalRequests: [], errors: [], expectedValidationConsole: [], screenshots: [] };
let expectingValidationFailure = false;
let context;
const check = (description) => { report.checks.push(description); console.log(`PASS ${description}`); };
async function poll(read, accept, timeout = 3000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise((done) => setTimeout(done, 30));
  } while (Date.now() < end);
  throw new Error(`Timed out: ${JSON.stringify(value)}`);
}
async function api(path, method = "GET", body) {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  assert(response.ok, JSON.stringify(result));
  return result;
}
try {
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== base) {
      report.externalRequests.push(route.request().url());
      await route.abort();
    } else await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() !== "error") return;
    if (expectingValidationFailure && /status of 400/.test(entry.text()) && entry.location().url === base + "/api/workflows")
      report.expectedValidationConsole.push(entry.text());
    else report.errors.push(entry.text());
  });
  await page.goto(base);
  await page.getByRole("heading", { name: "Workflow Runner", exact: true }).waitFor();
  await page.getByText("Local instance", { exact: true }).waitFor();
  assert.equal(await page.getByRole("region", { name: "Workflow list", exact: true }).count(), 1);
  assert.equal(await page.getByRole("region", { name: "Legacy jobs", exact: true }).count(), 1);
  check("desktop app and both accessible regions load from the production start command");
  const name = page.getByLabel("Workflow name", { exact: true });
  const definition = page.getByLabel("Workflow definition", { exact: true });
  const concurrency = page.getByLabel("Concurrency", { exact: true });
  const submit = page.getByRole("button", { name: "Create workflow" });
  expectingValidationFailure = true;
  await submit.click();
  await page.locator("#workflow-error").waitFor({ state: "visible" });
  assert.match(await page.locator("#workflow-error").textContent(), /nonempty/);
  expectingValidationFailure = false;
  await name.fill("Browser checks");
  await definition.fill("{broken");
  await submit.click();
  await page.locator("#workflow-error").waitFor({ state: "visible" });
  assert.match(await page.locator("#workflow-error").textContent(), /valid JSON/);
  await definition.fill(JSON.stringify([{ key: "a", name: "A", kind: "succeed", dependsOn: ["missing"] }]));
  expectingValidationFailure = true;
  await submit.click();
  await poll(() => page.locator("#workflow-error").textContent(), (text) => text.includes("missing predecessor"));
  expectingValidationFailure = false;
  check("empty names, malformed JSON and invalid dependencies are shown as accessible inline alerts");
  await definition.fill(JSON.stringify([
    { key: "lint", name: "Lint", kind: "succeed" },
    { key: "tests", name: "Tests", kind: "fail_once", dependsOn: ["lint"], maxAttempts: 2 },
  ], null, 2));
  await concurrency.selectOption("2");
  const before = (await api("/api/workflows")).workflows.length;
  await submit.dblclick();
  const card = page.getByRole("article", { name: "Workflow Browser checks", exact: true });
  await card.waitFor();
  await poll(() => card.getByTestId("workflow-status").textContent(), (status) => status === "succeeded");
  assert.equal((await api("/api/workflows")).workflows.length, before + 1);
  const id = await card.getAttribute("data-workflow-id");
  const workflow = (await api(`/api/workflows/${id}`)).workflow;
  assert.deepEqual(workflow.jobs[1].attempts.map((attempt) => attempt.status), ["failed", "succeeded"]);
  assert.match(await card.textContent(), /Attempt 1 · failed/);
  assert.match(await card.textContent(), /Attempt 2 · succeeded/);
  check("double-click submits one real workflow, polls to success, and renders both retry attempts");
  await card.getByRole("button", { name: "View events Browser checks", exact: true }).click();
  const events = page.getByRole("region", { name: "Events for Browser checks", exact: true });
  await events.waitFor();
  await poll(() => events.locator("li").count(), (count) => count === 9);
  const actualEvents = (await api(`/api/workflows/${id}/events`)).events.map((event) => event.type);
  assert.deepEqual(await events.locator(".event-type").allTextContents(), actualEvents);
  assert.equal(await page.getByRole("dialog").count(), 0);
  check("inline event region displays the exact durable event order without dialogs");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: join(artifacts, "desktop.png"), fullPage: true });
  await page.screenshot({ path: join(artifacts, "desktop-viewport.png") });
  report.screenshots.push("desktop.png");

  await name.fill("Browser cancellation");
  await concurrency.selectOption("1");
  await definition.fill(JSON.stringify([{ key: "hold", name: "Wait here", kind: "block" },
    { key: "never", name: "Waiting successor", kind: "succeed", dependsOn: ["hold"] }]));
  await submit.click();
  const cancelling = page.getByRole("article", { name: "Workflow Browser cancellation", exact: true });
  await cancelling.waitFor();
  await poll(() => cancelling.getByTestId("workflow-status").textContent(), (status) => status === "running");
  await cancelling.getByRole("button", { name: "Cancel workflow Browser cancellation", exact: true }).click();
  await poll(() => cancelling.getByTestId("workflow-status").textContent(), (status) => status === "cancelled");
  assert.equal(await cancelling.getByRole("button", { name: "Cancel workflow Browser cancellation" }).count(), 0);
  await cancelling.getByRole("button", { name: "View events Browser cancellation", exact: true }).click();
  await poll(() => page.getByRole("region", { name: "Events for Browser cancellation" }).textContent(), (text) => text.includes("workflow.cancelled"));
  check("browser cancel terminates a real blocked worker and shows cancellation events");

  const liveStart = Date.now();
  const remote = await api("/api/workflows", "POST", { name: "Other client", concurrency: 1,
    jobs: [{ key: "remote", name: "Remote job", kind: "succeed" }] });
  const remoteCard = page.locator(`[data-workflow-id="${remote.workflow.id}"]`);
  await remoteCard.waitFor({ timeout: 3000 });
  await poll(() => remoteCard.getByTestId("workflow-status").textContent(), (status) => status === "succeeded");
  assert(Date.now() - liveStart < 3000);
  check("an open page reflects another client's workflow and completion within 3 seconds");

  const unsafeName = '<img src=x onerror="window.__workflowXss=1">';
  const failed = await api("/api/workflows", "POST", { name: unsafeName, concurrency: 1,
    jobs: [{ key: "failure", name: unsafeName, kind: "fail" }] });
  const failedCard = page.locator(`[data-workflow-id="${failed.workflow.id}"]`);
  await failedCard.waitFor();
  await poll(() => failedCard.getByTestId("workflow-status").textContent(), (status) => status === "failed");
  assert.match(await failedCard.getByRole("alert").textContent(), /Synthetic worker requested failure/);
  assert.equal(await failedCard.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => window.__workflowXss), undefined);
  check("failed workers have visible error alerts and names render as harmless text");

  await page.getByLabel("Job name", { exact: true }).fill("Browser legacy");
  await page.getByRole("button", { name: "Create job" }).click();
  const legacy = page.getByRole("article", { name: "Legacy job Browser legacy", exact: true });
  await legacy.waitFor();
  await poll(() => legacy.locator(".status").textContent(), (status) => status === "succeeded");
  check("legacy form still creates and displays a completed job");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), Boolean);
  await name.focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").getAttribute("id"), "concurrency");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").getAttribute("id"), "definition");
  await name.fill("Mobile check");
  await concurrency.selectOption("1");
  await definition.fill(JSON.stringify([{ key: "mobile", name: "Mobile gate", kind: "block" }]));
  await submit.focus();
  await page.keyboard.press("Enter");
  const mobileCard = page.getByRole("article", { name: "Workflow Mobile check", exact: true });
  await mobileCard.waitFor();
  await poll(() => mobileCard.getByTestId("workflow-status").textContent(), (status) => status === "running");
  await mobileCard.getByRole("button", { name: "Cancel workflow Mobile check", exact: true }).click();
  await poll(() => mobileCard.getByTestId("workflow-status").textContent(), (status) => status === "cancelled");
  await mobileCard.getByRole("button", { name: "View events Mobile check", exact: true }).click();
  await poll(() => page.getByRole("region", { name: "Events for Mobile check" }).textContent(), (text) => text.includes("workflow.cancelled"));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: join(artifacts, "mobile.png"), fullPage: true });
  await page.screenshot({ path: join(artifacts, "mobile-viewport.png") });
  report.screenshots.push("mobile.png");
  check("390px page has no horizontal overflow; labelled controls, create, cancel and events work by keyboard/touch");
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.errors, []);
  check("no application page errors, unexpected console errors or external network requests (intentional validation HTTP 400 recorded separately)");
} catch (failure) {
  report.failure = failure.stack;
  throw failure;
} finally {
  writeFileSync(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  await context?.close();
  await browser.close();
}
