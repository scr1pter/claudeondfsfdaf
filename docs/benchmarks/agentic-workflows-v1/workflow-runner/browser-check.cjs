"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const names = [
  "dashboard_boot",
  "legacy_jobs_visible",
  "browser_create_workflow",
  "external_changes_live",
  "browser_cancel_workflow",
  "worker_failure_visible",
  "durable_events_visible",
  "mobile_layout_and_keyboard",
];

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2)
    result[argv[i].replace(/^--/, "")] = argv[i + 1];
  return result;
}
function requireValue(value, message) {
  if (!value) throw new Error(message);
}
async function until(action, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  throw new Error("Timed out waiting for " + message);
}

async function keyboardFormReachability(page) {
  const targets = [
    ["Workflow name", page.getByLabel("Workflow name", { exact: true })],
    ["Concurrency", page.getByRole("combobox", { name: "Concurrency", exact: true })],
    ["Workflow definition", page.getByLabel("Workflow definition", { exact: true })],
    ["Create workflow", page.getByRole("button", { name: "Create workflow", exact: true })],
  ];
  const startingControl = await page.evaluate(() => ({
    tag: document.activeElement.tagName.toLowerCase(),
    text: (document.activeElement.getAttribute("aria-label") || document.activeElement.textContent || "").trim().slice(0, 100),
  }));
  // An ordinary pointer action establishes a user starting point; no DOM focus is forced.
  await page.getByRole("heading", { name: "Workflow Runner", exact: true }).click();
  const visibleCandidates = await page
    .locator('a[href],button,input,select,textarea,[tabindex],summary,iframe,[contenteditable="true"]')
    .evaluateAll((elements) => elements.filter((element) => {
      const style = getComputedStyle(element);
      return !element.disabled && element.getClientRects().length > 0 && style.visibility !== "hidden" && style.visibility !== "collapse";
    }).length);
  const tabLimit = Math.min(200, visibleCandidates + 2);
  const reached = new Set();
  let bodyTransitions = 0;
  let tabPresses = 0;
  for (; tabPresses < tabLimit && reached.size < targets.length;) {
    await page.keyboard.press("Tab");
    tabPresses += 1;
    if (await page.evaluate(() => document.activeElement === document.body)) bodyTransitions += 1;
    for (const [name, locator] of targets) {
      if (!reached.has(name) && await locator.count() === 1 && await locator.evaluate((element) => element === document.activeElement)) reached.add(name);
    }
  }
  return {
    startingControl,
    visibleCandidates,
    tabLimit,
    tabPresses,
    bodyTransitions,
    reachedControls: [...reached],
    missingControls: targets.map(([name]) => name).filter((name) => !reached.has(name)),
  };
}
function node(key, kind = "succeed", maxAttempts = 1) {
  return { key, name: "Job " + key, kind, dependsOn: [], maxAttempts };
}

async function main(argv) {
  const args = options(argv);
  const parsed = new URL(args["base-url"]);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.pathname !== "/"
  )
    throw new Error("Evaluator accepts a loopback HTTP origin only");
  const output = path.resolve(args.out);
  await fs.mkdir(output, { recursive: true });
  const checks = names.map((name) => ({ name, status: "not_run" }));
  let browser;
  let proxy;
  let blockedRequests = 0;
  let infrastructureReady = false;
  try {
    const { chromium } = require(path.resolve(args.playwright));
    const proxyModule =
      args["proxy-module"] ||
      process.env.VECTOR_BENCH_BROWSER_PROXY ||
      process.env.VECTOR_BENCH_BROWSER_PROXY_MODULE ||
      path.resolve(
        __dirname,
        "../../../../scripts/benchmarks/browser-driver/proxy.cjs",
      );
    const { startProxy } = require(proxyModule);
    proxy = await startProxy(new Set([parsed.origin]), () => {
      blockedRequests += 1;
    });
    const profileRoot = process.env.WORKFLOW_PROFILE_ROOT || os.tmpdir();
    const profile = await fs.mkdtemp(
      path.join(profileRoot, "workflow-profile-"),
    );
    const context = await chromium.launchPersistentContext(profile, {
      executablePath: path.resolve(args.chrome),
      headless: true,
      viewport: { width: 1440, height: 900 },
      timeout: 15000,
      serviceWorkers: "block",
      proxy: { server: proxy.url, bypass: "<-loopback>" },
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--proxy-bypass-list=<-loopback>",
      ],
    });
    browser = context;
    infrastructureReady = true;
    await context.route("**/*", (route) => {
      const address = new URL(route.request().url());
      return address.origin === parsed.origin
        ? route.continue()
        : route.abort();
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.setDefaultNavigationTimeout(10000);
    await page.goto(parsed.origin, { waitUntil: "domcontentloaded" });
    async function check(name, action) {
      const target = checks.find((item) => item.name === name);
      const start = Date.now();
      try {
        await action();
        target.status = "passed";
      } catch (error) {
        target.status = "failed";
        target.error = String(error.message || error).slice(0, 500);
      }
      target.elapsedMs = Date.now() - start;
    }
    async function api(method, route, body, key) {
      const response = await fetch(parsed.origin + route, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
      });
      requireValue(
        response.ok,
        method + " " + route + " returned " + response.status,
      );
      return response.json();
    }
    const workflowCard = (name) =>
      page.getByRole("article", { name: "Workflow " + name, exact: true });
    const workflowBody = (name, kind = "succeed") => ({
      name,
      concurrency: 2,
      jobs: [node("a", kind)],
    });
    await check("dashboard_boot", async () => {
      await page
        .getByRole("heading", { name: "Workflow Runner", exact: true })
        .waitFor({ state: "visible" });
      requireValue((await page.title()).length > 0, "Page title is empty");
    });
    await check("legacy_jobs_visible", async () => {
      const region = page.getByRole("region", {
        name: "Legacy jobs",
        exact: true,
      });
      const item = region.getByRole("article", {
        name: "Legacy job Legacy completed",
        exact: true,
      });
      await item.waitFor({ state: "visible" });
      requireValue(
        (await item.textContent()).includes("succeeded"),
        "Legacy completed status missing",
      );
    });
    let browserCreated;
    await check("browser_create_workflow", async () => {
      await page.getByLabel("Workflow name", { exact: true }).waitFor({ state: "visible", timeout: 5000 });
      await page
        .getByLabel("Workflow name", { exact: true })
        .fill("UI created");
      await page
        .getByRole("combobox", { name: "Concurrency", exact: true })
        .selectOption("2");
      await page
        .getByLabel("Workflow definition", { exact: true })
        .fill(JSON.stringify([node("a")]));
      const responsePromise = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/workflows" &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Create workflow", exact: true })
        .click();
      const response = await responsePromise;
      requireValue(
        response.status() === 201,
        "Workflow form did not create once with HTTP 201",
      );
      browserCreated = (await response.json()).workflow;
      requireValue(
        browserCreated && browserCreated.id,
        "Created workflow identity missing",
      );
      const card = workflowCard("UI created");
      await card.waitFor({ state: "visible" });
      requireValue(
        (await card.getAttribute("data-workflow-id")) === browserCreated.id,
        "UI workflow identity does not match backend",
      );
      await until(
        async () =>
          (await card.getByTestId("workflow-status").textContent()).trim() ===
          "succeeded",
        "created workflow completion",
      );
    });
    await check("external_changes_live", async () => {
      await api(
        "POST",
        "/api/workflows",
        workflowBody("UI external"),
        "ui-external",
      );
      const card = workflowCard("UI external");
      await card.waitFor({ state: "visible", timeout: 5000 });
      await until(
        async () =>
          (await card.getByTestId("workflow-status").textContent()).trim() ===
          "succeeded",
        "external workflow live update",
        5000,
      );
    });
    await check("browser_cancel_workflow", async () => {
      const value = (
        await api(
          "POST",
          "/api/workflows",
          workflowBody("UI cancellable", "block"),
          "ui-cancellable",
        )
      ).workflow;
      await until(
        async () =>
          (await api("GET", "/api/workflows/" + value.id)).workflow.jobs[0]
            .status === "running",
        "cancellable worker running",
      );
      const card = workflowCard("UI cancellable");
      await card.waitFor({ state: "visible" });
      const responsePromise = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            "/api/workflows/" + value.id + "/cancel" &&
          response.request().method() === "POST",
      );
      await card
        .getByRole("button", {
          name: "Cancel workflow UI cancellable",
          exact: true,
        })
        .click();
      requireValue(
        (await responsePromise).status() === 200,
        "Cancel UI request failed",
      );
      await until(
        async () =>
          (await card.getByTestId("workflow-status").textContent()).trim() ===
          "cancelled",
        "cancelled status",
      );
      requireValue(
        (await api("GET", "/api/workflows/" + value.id)).workflow.status ===
          "cancelled",
        "UI cancellation did not persist",
      );
    });
    await check("worker_failure_visible", async () => {
      await api(
        "POST",
        "/api/workflows",
        workflowBody("UI failed", "fail"),
        "ui-failed",
      );
      const card = workflowCard("UI failed");
      await card.waitFor({ state: "visible" });
      await until(
        async () =>
          (await card.getByTestId("workflow-status").textContent()).trim() ===
          "failed",
        "failed worker state",
      );
      const alert = card.getByRole("alert").first();
      await alert.waitFor({ state: "visible" });
      requireValue(
        (await alert.textContent()).trim().length > 0,
        "Visible failure error is empty",
      );
    });
    await check("durable_events_visible", async () => {
      requireValue(browserCreated, "Browser-created workflow is unavailable");
      await workflowCard("UI created")
        .getByRole("button", { name: "View events UI created", exact: true })
        .click();
      const region = page.getByRole("region", {
        name: "Events for UI created",
        exact: true,
      });
      await region.waitFor({ state: "visible" });
      await until(async () => {
        const text = await region.textContent();
        return [
          "workflow.created",
          "job.started",
          "job.succeeded",
          "workflow.succeeded",
        ].every((type) => text.includes(type));
      }, "actual durable event list");
    });
    await page.screenshot({
      path: path.join(output, "desktop.png"),
      fullPage: true,
    });
    await check("mobile_layout_and_keyboard", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      requireValue(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        "Page has horizontal mobile overflow",
      );
      const keyboard = await keyboardFormReachability(page);
      checks.find((item) => item.name === "mobile_layout_and_keyboard").keyboard = keyboard;
      requireValue(
        keyboard.missingControls.length === 0,
        "Required workflow controls are not reachable by native Tab: " + keyboard.missingControls.join(", "),
      );
      await page.screenshot({
        path: path.join(output, "mobile.png"),
        fullPage: true,
      });
    });
    const verdict = checks.every((check) => check.status === "passed")
      ? "passed"
      : "product_failure";
    await fs.writeFile(
      path.join(output, "results.json"),
      JSON.stringify(
        {
          kind: "workflow-runner-browser-v1",
          verdict,
          checks,
          modelCalls: 0,
          blockedNetworkRequests: blockedRequests,
        },
        null,
        2,
      ),
    );
    return verdict === "passed" ? 0 : 1;
  } catch (error) {
    console.error(String(error.message || error));
    const verdict = infrastructureReady
      ? "product_failure"
      : "instrument_failure";
    if (infrastructureReady)
      checks[0] = {
        name: names[0],
        status: "failed",
        error: String(error.message || error).slice(0, 500),
      };
    await fs.writeFile(
      path.join(output, "results.json"),
      JSON.stringify(
        {
          verdict,
          checks,
          error: String(error.message || error).slice(0, 500),
          modelCalls: 0,
        },
        null,
        2,
      ),
    );
    return verdict === "instrument_failure" ? 2 : 1;
  } finally {
    await browser?.close();
    await proxy?.close();
  }
}

if (require.main === module)
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 2;
    });
module.exports = { main, names, options, until, keyboardFormReachability };
