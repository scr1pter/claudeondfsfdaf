"use strict";

// Independent hidden evaluator. Never copy this instrument into an app fixture.
// It uses synthetic identities, owned profiles/files and loopback traffic only.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

function csvRows(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], value = "", state = "start";
  const cell = () => { row.push(value); value = ""; state = "start"; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (state === "quoted") {
      if (char !== '"') { value += char; continue; }
      if (text[index + 1] === '"') { value += '"'; index++; continue; }
      state = "closed"; continue;
    }
    if (char === ",") { cell(); continue; }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      cell(); rows.push(row); row = []; continue;
    }
    if (state === "closed") throw new Error("CSV has text after a closing quote");
    if (char === '"') {
      if (state !== "start") throw new Error("CSV has a quote inside an unquoted field");
      state = "quoted"; continue;
    }
    value += char; state = "plain";
  }
  if (state === "quoted") throw new Error("CSV has an unterminated quoted field");
  if (row.length || value || state === "closed" || text.endsWith(",")) { cell(); rows.push(row); }
  return rows;
}

function namedAction(scope, name) {
  return scope.getByRole("button", { name, exact: true }).or(scope.getByRole("link", { name, exact: true })).first();
}

function namedNavigation(scope, label) {
  // The public contract fixes the visible label; a numeric badge may also be
  // included in a navigation control's accessible name. Keep other actions exact.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const name = new RegExp("^" + escaped + "(?:\\s*\\d+)?$");
  return scope.getByRole("button", { name }).or(scope.getByRole("link", { name })).first();
}

async function actionVisible(target, control) {
  if (!(await control.isVisible().catch(() => false))) return false;
  const viewport = target.viewportSize();
  const box = await control.boundingBox();
  // An offcanvas menu can be CSS-visible while wholly outside the viewport.
  return !viewport || !box || box.x < viewport.width && box.y < viewport.height && box.x + box.width > 0 && box.y + box.height > 0;
}

async function navigateAction(target, name, { timeout } = {}) {
  const deadline = timeout === undefined ? undefined : Date.now() + timeout;
  const clickOptions = () => {
    if (deadline === undefined) return {};
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Navigation deadline exceeded");
    return { timeout: remaining };
  };
  const control = namedNavigation(target, name);
  if (!(await actionVisible(target, control))) {
    const toggle = namedAction(target, "Open navigation");
    if (await actionVisible(target, toggle)) await toggle.click(clickOptions());
  }
  await control.click(clickOptions());
}

function retryableTimeout(error) {
  return error.name === "TimeoutError" || /Timeout.*exceeded|deadline exceeded/i.test(String(error.message));
}

async function dismissDialogs(target, { timeout = 10_000, attemptTimeout = 100 } = {}) {
  const deadline = Date.now() + timeout;
  const budget = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Dialog dismissal deadline exceeded");
    return Math.max(1, Math.min(remaining, attemptTimeout));
  };
  while (await target.getByRole("dialog").count()) {
    const current = target.getByRole("dialog").last();
    if (!(await current.isVisible())) return;
    let element;
    try {
      // A short ignored Escape while a committed action finishes refreshing is
      // retried normally. Bind the node so .last() cannot retarget this wait.
      element = await current.elementHandle({ timeout: budget() });
      if (!element) continue;
      await target.keyboard.press("Escape");
      await element.waitForElementState("hidden", { timeout: budget() });
    } catch (error) {
      if (!retryableTimeout(error)) throw error;
      budget();
    } finally {
      if (element) await element.dispose();
    }
  }
}

async function navigateWithDialogs(target, name, { timeout = 10_000, attemptTimeout = 500 } = {}) {
  const deadline = Date.now() + timeout;
  const budget = (cap = Infinity) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Navigation deadline exceeded");
    return Math.max(1, Math.min(remaining, cap));
  };
  while (Date.now() < deadline) {
    await dismissDialogs(target, { timeout: budget() });
    try { await navigateAction(target, name, { timeout: budget(attemptTimeout) }); return; }
    catch (error) { if (!retryableTimeout(error)) throw error; }
  }
  throw new Error("Navigation deadline exceeded");
}

async function openInvoiceDetails(target, number, { timeout = 10_000, attemptTimeout = 500 } = {}) {
  const deadline = Date.now() + timeout;
  const budget = (cap = Infinity) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Invoice opening deadline exceeded");
    return Math.max(1, Math.min(remaining, cap));
  };
  let navigated = false;
  while (Date.now() < deadline) {
    await dismissDialogs(target, { timeout: budget() });
    try {
      if (!navigated) { await navigateAction(target, "Invoices", { timeout: budget(attemptTimeout) }); navigated = true; }
      // Always use the exact public opener instead of reusing an unidentified
      // auto-opened invoice. No invoice-number markup inside details is assumed.
      await namedAction(target, "Open invoice " + number).click({ timeout: budget(attemptTimeout) });
      const view = target.getByRole("dialog", { name: "Invoice details", exact: true });
      await view.waitFor({ state: "visible", timeout: budget(attemptTimeout) });
      return view;
    } catch (error) {
      if (!retryableTimeout(error)) throw error;
      // Retry only navigation/opening within the original deadline. A newly
      // arrived modal is closed and verified on the next iteration; unclosable
      // dialogs fail above. Business mutations are never retried here.
    }
  }
  throw new Error("Invoice opening deadline exceeded");
}

function nativeSelect(scope, label) {
  const selects = scope.locator("select:not([inert]):not([inert] select)").and(scope.getByRole("combobox").or(scope.getByRole("listbox")));
  const named = scope.getByRole("combobox", { name: label, exact: true }).or(scope.getByRole("listbox", { name: label, exact: true }));
  return named.or(scope.getByLabel(label, { exact: true })).and(selects).filter({ visible: true });
}

async function choose(scope, label, text, contains = false, { timeout = 5000, interval = 75 } = {}) {
  const select = nativeSelect(scope, label);
  await select.waitFor({ state: "visible" });
  const end = Date.now() + timeout;
  let found = [];
  do {
    const options = await select.locator("option").evaluateAll(nodes => nodes.map(node => ({ label: node.label, value: node.value })));
    found = options.filter(option => contains ? option.label.includes(text) : option.label === text);
    if (found.length === 1) { await select.selectOption(found[0].value); return; }
    if (Date.now() >= end) break;
    await new Promise(resolve => setTimeout(resolve, interval));
  } while (true);
  throw new Error(`Select ${label}: expected one option for ${text}, found${found.length} after waiting for options`);
}

async function waitForWorkspaceSelection(target, expectedId, readMe, { timeout = 3000, interval = 75 } = {}) {
  const end = Date.now() + Math.min(timeout, 3000);
  const select = nativeSelect(target, "Workspace");
  while (Date.now() < end) {
    const remaining = Math.max(1, end - Date.now());
    const [me, selectedId] = await Promise.all([readMe(remaining), select.inputValue({ timeout: remaining })]);
    if (me.activeWorkspaceId === expectedId && selectedId === expectedId) return me;
    const delay = Math.min(interval, end - Date.now());
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error("Workspace selection did not persist and display the expected workspace within3seconds");
}

async function waitForVisibleActivity(content, actorName, { timeout = 5000, interval = 75 } = {}) {
  const end = Date.now() + timeout;
  let text = "", visibleActor = false;
  while (Date.now() < end) {
    text = await content.innerText({ timeout: Math.max(1, end - Date.now()) });
    const authors = content.getByText(actorName, { exact: false });
    visibleActor = false;
    for (let index = 0; index < await authors.count(); index++) {
      if (await authors.nth(index).isVisible()) { visibleActor = true; break; }
    }
    if (visibleActor && /created|stock|fulfilled|paid|comment|attachment/i.test(text)) return;
    const delay = Math.min(interval, end - Date.now());
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }
  if (!visibleActor) throw new Error("Activity page lacks the visible actor name");
  throw new Error("Activity page lacks human-readable events");
}

async function browserEvaluate(options) {
  const base = new URL(options.baseURL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error("Only a loopback app may be evaluated");
  const modulePath = options.playwrightModule || process.env.PLAYWRIGHT_MODULE;
  const chromePath = options.chromePath || process.env.CHROME_PATH;
  if (!modulePath || !path.isAbsolute(modulePath) || !chromePath || !path.isAbsolute(chromePath)) throw new Error("Absolute Playwright module and Chrome executable paths are required; no browser is downloaded");
  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const { chromium } = require(modulePath);
  const profile = await fs.mkdtemp(path.join(outDir, "profile-"));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chromePath, headless: true, viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1, acceptDownloads: true, reducedMotion: "reduce",
    args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update"],
  });
  const page = context.pages()[0] || await context.newPage();
  const browser = context.browser();
  const extraContexts = [];
  const checks = [], screenshots = [], passed = new Set();
  const diagnostics = { pageErrors: [], consoleErrors: [], failedRequests: [], serverErrors: [], blockedExternalOrigins: [] };
  const runID = crypto.randomBytes(5).toString("hex");
  const identity = { name: "Alex Foundry", email: `foundry-ui-${runID}@example.invalid`, password: "Synthetic-Foundry!2026" };
  const invitee = { name: "Riley", email: `foundry-team-${runID}@example.invalid`, password: "Synthetic-Foundry!2026" };
  const state = { customerName: "Northstar Research", projectName: "Delivery launch", taskTitle: 'Research, then "deliver"' };
  let secondary, secondaryPage;

  async function instrument(targetContext) {
    await targetContext.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (["data:", "blob:"].includes(url.protocol) || url.origin === base.origin) return route.continue();
      diagnostics.blockedExternalOrigins.push(url.origin);
      return route.abort("blockedbyclient");
    });
    const attach = target => {
      target.setDefaultTimeout(10_000); target.setDefaultNavigationTimeout(20_000);
      target.on("pageerror", error => diagnostics.pageErrors.push(String(error.message).slice(0, 700)));
      target.on("console", message => { if (message.type() === "error") diagnostics.consoleErrors.push(message.text().slice(0, 700)); });
      target.on("requestfailed", request => {
        const failure = request.failure()?.errorText || "unknown";
        if (!failure.includes("ERR_ABORTED")) diagnostics.failedRequests.push({ url: request.url(), failure });
      });
      target.on("response", response => { if (response.status() >= 500) diagnostics.serverErrors.push({ url: response.url(), status: response.status() }); });
    };
    targetContext.pages().forEach(attach); targetContext.on("page", attach);
  }
  await instrument(context);
  async function shot(name, target = page) {
    const file = path.join(outDir, name + ".png");
    await target.screenshot({ path: file, fullPage: true, animations: "disabled" });
    screenshots.push(file); return file;
  }
  async function check(name, fn, dependencies = ["signup-and-workspace"]) {
    const missing = dependencies.filter(dependency => !passed.has(dependency));
    if (missing.length) { checks.push({ name, status: "not_run", reason: "Prerequisite failed: " + missing.join(", ") }); return; }
    const start = Date.now();
    try {
      const evidence = await fn();
      passed.add(name); checks.push({ name, status: "passed", elapsedMs: Date.now() - start, ...(evidence === undefined ? {} : { evidence }) });
    } catch (error) {
      let screenshot;
      try { screenshot = await shot("failure-" + name); } catch {}
      checks.push({ name, status: "failed", elapsedMs: Date.now() - start, reason: String(error.message || error).slice(0, 1800), screenshot });
    }
    // Preserve completed work if a later broken flow exceeds the outer deadline.
    await fs.writeFile(path.join(outDir, "browser-progress.json"), JSON.stringify({ checks, diagnostics }, null, 2));
  }
  function requireTrue(value, message) { if (!value) throw new Error(message); }
  async function poll(fn, message, timeout = 5000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
    throw new Error(message);
  }
  async function api(route, method = "GET", body, target = context, expected = 200, timeout = 10_000) {
    const response = await target.request.fetch(new URL(route, base).href, { method, ...(body === undefined ? {} : { data: body }), maxRedirects: 0, timeout });
    requireTrue(response.status() === expected, `${method} ${route}: expected${expected}, received${response.status()}`);
    return expected === 204 ? undefined : response.json();
  }
  async function waitStatus(route, expected, target = context, timeout = 5000) {
    await poll(async () => (await target.request.get(new URL(route, base).href, { maxRedirects: 0, timeout: 10_000 })).status() === expected, `GET ${route} did not become${expected}`, timeout);
  }
  async function alerts() { return (await page.getByRole("alert").allTextContents()).map(text => text.trim()).filter(Boolean); }
  async function freshAlert(previous) {
    let messages;
    await poll(async () => { messages = (await alerts()).filter(text => !previous.includes(text)); return messages.length > 0; }, "Rejected input produced no new visible role=alert error");
    return messages;
  }
  const w = suffix => "/api/w/" + encodeURIComponent(state.workspace.id) + suffix;
  async function action(name, scope = page) {
    await namedAction(scope, name).click();
  }
  async function closeDialogs(target = page) { await dismissDialogs(target); }
  async function nav(name, target = page) { await navigateWithDialogs(target, name); }
  function dialog(name, target = page) { return target.getByRole("dialog", { name, exact: true }); }
  async function fill(scope, label, value) { await scope.getByLabel(label, { exact: true }).fill(String(value)); }
  async function submitDialog(name, button, target = page) {
    const current = dialog(name, target); await action(button, current); await current.waitFor({ state: "hidden" });
  }
  async function confirmDelete(button, target = page) {
    let native = false;
    const accept = async question => { if (question.type() === "confirm") { native = true; await question.accept(); } else await question.dismiss(); };
    target.on("dialog", accept);
    try {
      await action(button, target);
      if (!native) { const confirm = target.getByRole("button", { name: "Confirm delete", exact: true }); await confirm.click(); await confirm.waitFor({ state: "hidden" }); }
    } finally { target.off("dialog", accept); }
  }
  async function customerCreate(name, email) {
    await action("New customer"); const form = dialog("New customer");
    await fill(form, "Name", name); await fill(form, "Email", email); await fill(form, "Company", "Synthetic Operations"); await fill(form, "Notes", "Independent browser fixture.");
    await submitDialog("New customer", "Create customer");
  }
  async function productCreate(sku, name, price, target = page) {
    await action("New product", target); const form = dialog("New product", target);
    await fill(form, "SKU", sku); await fill(form, "Product name", name); await fill(form, "Description", "Synthetic stocked item."); await fill(form, "Unit price (USD)", price);
    await submitDialog("New product", "Create product", target);
  }
  async function stockAdjust(sku, delta, reason) {
    await action("Adjust stock " + sku); const form = dialog("Adjust stock");
    await fill(form, "Quantity change", delta); await fill(form, "Reason", reason); await submitDialog("Adjust stock", "Save stock change");
  }
  async function findOne(route, listName, predicate) {
    let value;
    await poll(async () => { value = (await api(w(route)))[listName].find(predicate); return Boolean(value); }, `Real API did not persist the expected ${listName}`);
    return value;
  }
  async function taskCreate(title, status, priority) {
    await action("New task"); const form = dialog("New task");
    await fill(form, "Title", title); await fill(form, "Description", "Synthetic project delivery check.");
    await choose(form, "Status", status); await choose(form, "Priority", priority); await choose(form, "Assignee", identity.name, true);
    await fill(form, "Due date", "2027-01-15"); await submitDialog("New task", "Create task");
    await page.getByRole("button", { name: "Edit task " + title, exact: true }).waitFor();
  }
  async function taskFiltersClear() {
    await fill(page, "Search tasks", ""); await choose(page, "Status filter", "All statuses"); await choose(page, "Priority filter", "All priorities");
  }
  async function openProject() { await nav("Projects"); await action("Open project " + state.projectName); await page.getByRole("button", { name: "New task", exact: true }).waitFor(); }
  async function orderDetails() {
    if (!(await dialog("Order details").isVisible().catch(() => false))) { await nav("Orders"); await action("Open order " + state.order.number); }
    return dialog("Order details");
  }
  async function invoiceDetails() { return openInvoiceDetails(page, state.invoice.number); }
  async function download(button, file, target = page) {
    const pending = target.waitForEvent("download", { timeout: 12_000 }); await action(button, target); const result = await pending;
    const destination = path.join(outDir, file); await result.saveAs(destination);
    return { bytes: await fs.readFile(destination), filename: result.suggestedFilename(), destination };
  }
  async function forbiddenAction(name, target) {
    const controls = target.getByRole("button", { name, exact: true }).or(target.getByRole("link", { name, exact: true }));
    const rows = await controls.all(); return !rows.length || (await Promise.all(rows.map(async item => !(await item.isVisible()) || !(await item.isEnabled())))).every(Boolean);
  }
  async function layout(target, width, height) {
    await target.setViewportSize({ width, height });
    await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return target.evaluate(() => ({ viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth - innerWidth }));
  }

  try {
    await check("signup-and-workspace", async () => {
      await page.goto(new URL("/signup", base).href, { waitUntil: "domcontentloaded" });
      await fill(page, "Name", identity.name); await fill(page, "Email", identity.email); await fill(page, "Password", identity.password); await action("Create account");
      await nativeSelect(page, "Workspace").waitFor();
      const me = await api("/api/auth/me"); state.user = me.user; state.workspace = me.workspaces.find(item => item.name === identity.name + " workspace");
      requireTrue(state.workspace && state.workspace.role === "owner", "Signup did not create the authenticated owner's workspace");
      await choose(page, "Workspace", state.workspace.name);
      return { syntheticIdentity: identity.email, workspaceRole: state.workspace.role };
    }, []);

    await check("multiple-workspaces-and-isolated-selection", async () => {
      await action("New workspace"); await fill(dialog("New workspace"), "Workspace name", "Independent warehouse"); await submitDialog("New workspace", "Create workspace");
      await choose(page, "Workspace", "Independent warehouse"); await nav("Customers");
      let me = await api("/api/auth/me"); state.otherWorkspace = me.workspaces.find(item => item.name === "Independent warehouse");
      requireTrue(state.otherWorkspace, "Created workspace is missing from memberships");
      await waitForWorkspaceSelection(page, state.otherWorkspace.id, remaining => api("/api/auth/me", "GET", undefined, context, 200, remaining));
      requireTrue((await api("/api/w/" + state.otherWorkspace.id + "/customers")).customers.length === 0, "Fresh workspace inherited another workspace's customers");
      await choose(page, "Workspace", state.workspace.name);
      await waitForWorkspaceSelection(page, state.workspace.id, remaining => api("/api/auth/me", "GET", undefined, context, 200, remaining));
    });

    await check("customer-create-real-api", async () => {
      await choose(page, "Workspace", state.workspace.name); await nav("Customers");
      await customerCreate(state.customerName, "northstar-" + runID + "@example.invalid");
      state.customer = await findOne("/customers", "customers", row => row.name === state.customerName);
      await page.getByRole("button", { name: "Edit customer " + state.customerName, exact: true }).waitFor();
    });

    await check("customer-edit-keeps-real-data", async () => {
      await nav("Customers"); await action("Edit customer " + state.customerName); const form = dialog("Edit customer");
      await fill(form, "Company", "Northstar Synthetic Labs"); await fill(form, "Notes", "Two teams, one launch."); await submitDialog("Edit customer", "Save changes");
      state.customer = (await api(w("/customers/" + state.customer.id))).customer;
      requireTrue(state.customer.company === "Northstar Synthetic Labs" && state.customer.notes === "Two teams, one launch.", "Customer edit was not persisted");
    }, ["customer-create-real-api"]);

    await check("customer-search", async () => {
      await nav("Customers"); await fill(page, "Search customers", "NORTHSTAR");
      await page.getByRole("button", { name: "Open customer " + state.customerName, exact: true }).waitFor();
      await fill(page, "Search customers", "missing-" + runID);
      await page.getByRole("button", { name: "Open customer " + state.customerName, exact: true }).waitFor({ state: "hidden" });
      await fill(page, "Search customers", "");
    }, ["customer-create-real-api"]);

    await check("unused-customer-delete-confirmation", async () => {
      await nav("Customers"); const name = "Temporary customer"; await customerCreate(name, "temporary-" + runID + "@example.invalid");
      const value = await findOne("/customers", "customers", row => row.name === name);
      await confirmDelete("Delete customer " + name); await waitStatus(w("/customers/" + value.id), 404);
      await page.getByRole("button", { name: "Delete customer " + name, exact: true }).waitFor({ state: "hidden" });
    }, ["customer-create-real-api"]);

    await check("quoted-customer-csv-import", async () => {
      await nav("Customers"); await action("Import customers"); const form = dialog("Import customers");
      state.csvName = 'Research, then "deliver"'; state.csvNotes = 'First line\nSecond, "quoted" line';
      const csv = 'name,email,company,notes\r\n"Research, then ""deliver""",csv-' + runID + '@example.invalid,Imports,"First line\nSecond, ""quoted"" line"\r\n"  =SUM(1,2)",formula-' + runID + '@example.invalid,CSV,@command\r\n';
      await form.getByLabel("CSV file", { exact: true }).setInputFiles({ name: "synthetic-customers.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
      await submitDialog("Import customers", "Import CSV");
      state.csvCustomer = await findOne("/customers", "customers", row => row.email === "csv-" + runID + "@example.invalid");
      state.formulaCustomer = await findOne("/customers", "customers", row => row.email === "formula-" + runID + "@example.invalid");
      requireTrue(state.csvCustomer.name === state.csvName && state.csvCustomer.notes === state.csvNotes, "CSV import lost quoted commas, quotes or multiline values");
      requireTrue(!state.formulaCustomer.name.startsWith("'") && state.formulaCustomer.notes === "@command", "CSV import altered stored formula-looking strings");
    });

    await check("customer-export-escaping-and-formula-safety", async () => {
      await nav("Customers"); const file = await download("Export customers", "customers.csv"); const rows = csvRows(file.bytes.toString("utf8"));
      requireTrue(rows[0]?.join(",") === "id,name,email,company,notes", "Customer export header differs from contract");
      const normal = rows.find(row => row[0] === state.csvCustomer.id); const formula = rows.find(row => row[0] === state.formulaCustomer.id);
      requireTrue(normal?.[1] === state.csvName && normal?.[4] === state.csvNotes, "CSV export did not preserve quotes/newlines");
      requireTrue(formula?.[1].startsWith("'") && formula?.[4] === "'@command", "CSV export did not neutralize formula-looking strings");
      return { file: file.destination, rows: rows.length - 1 };
    }, ["quoted-customer-csv-import"]);

    await check("product-creation-and-exact-cents", async () => {
      await nav("Inventory"); await productCreate("KIT-A", "Assay kit", "12.49"); await productCreate("KIT-B", "Sample tubes", "3.50");
      state.productA = await findOne("/products", "products", row => row.sku === "KIT-A"); state.productB = await findOne("/products", "products", row => row.sku === "KIT-B");
      requireTrue(state.productA.priceCents === 1249 && state.productB.priceCents === 350 && state.productA.stock === 0 && state.productB.stock === 0, "Product dollar inputs did not persist exact cents or zero initial stock");
    });

    await check("product-search-and-export", async () => {
      await nav("Inventory"); await fill(page, "Search products", "assay");
      await page.getByRole("button", { name: "Edit product KIT-A", exact: true }).waitFor();
      await page.getByRole("button", { name: "Edit product KIT-B", exact: true }).waitFor({ state: "hidden" });
      await fill(page, "Search products", "");
      const rows = csvRows((await download("Export products", "products.csv")).bytes.toString("utf8"));
      requireTrue(rows[0]?.join(",") === "id,sku,name,description,priceCents,stock" && rows.some(row => row[0] === state.productA.id && row[1] === "KIT-A"), "Product export lacks its real product/header");
    }, ["product-creation-and-exact-cents"]);

    await check("stock-receipt-real-movements", async () => {
      await nav("Inventory"); await stockAdjust("KIT-A", 10, "Initial kit receipt"); await stockAdjust("KIT-B", 8, "Initial tube receipt");
      requireTrue((await api(w("/products/" + state.productA.id))).product.stock === 10 && (await api(w("/products/" + state.productB.id))).product.stock === 8, "Stock adjustment did not update real inventory");
      const rows = (await api(w("/stock-movements?productId=" + state.productA.id))).movements;
      requireTrue(rows.some(row => row.delta === 10 && row.reason === "Initial kit receipt" && row.kind === "adjustment"), "Stock adjustment has no matching immutable movement");
    }, ["product-creation-and-exact-cents"]);

    await check("stock-history-visible-reason-delta-date", async () => {
      await nav("Inventory"); await action("Stock history KIT-A"); const view = dialog("Stock history");
      await view.getByText("Initial kit receipt", { exact: false }).first().waitFor();
      const text = await view.innerText();
      const dated = await view.locator("time[datetime]").count() > 0 || /\d{1,2}:\d{2}|\d{4}|\b\d{1,2}\/\d{1,2}\b|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|ago|today|now/i.test(text);
      requireTrue(/\+?10\b/.test(text) && dated, "Visible stock history lacks actual delta/date");
      await closeDialogs();
    }, ["stock-receipt-real-movements"]);

    await check("negative-stock-visible-error-no-write", async () => {
      await nav("Inventory"); const before = (await api(w("/stock-movements?productId=" + state.productA.id))).movements.length;
      await action("Adjust stock KIT-A"); const form = dialog("Adjust stock");
      const previous = await alerts();
      await fill(form, "Quantity change", -100); await fill(form, "Reason", "Rejected overdraw");
      const save = form.getByRole("button", { name: "Save stock change", exact: true }); if (await save.isEnabled()) await save.click();
      const messages = await freshAlert(previous);
      requireTrue((await api(w("/products/" + state.productA.id))).product.stock === 10 && (await api(w("/stock-movements?productId=" + state.productA.id))).movements.length === before, "Rejected stock overdraw changed inventory/history");
      await closeDialogs();
      return { visibleError: messages };
    }, ["stock-receipt-real-movements"]);

    await check("multi-line-order-price-snapshots", async () => {
      await nav("Orders"); await action("New order"); const form = dialog("New order");
      await choose(form, "Customer", state.customerName, true);
      await choose(form, "Product", "KIT-A — Assay kit"); await fill(form, "Quantity", 2); await action("Add line", form);
      await choose(form, "Product", "KIT-B — Sample tubes"); await fill(form, "Quantity", 3); await action("Add line", form);
      await submitDialog("New order", "Create order");
      state.order = await findOne("/orders", "orders", row => row.customerId === state.customer.id && row.status === "draft");
      requireTrue(state.order.items.length === 2 && state.order.totalCents === 3548, "Order line snapshots or integer total are incorrect");
      await page.getByRole("button", { name: "Open order " + state.order.number, exact: true }).waitFor();
    }, ["customer-create-real-api", "stock-receipt-real-movements"]);

    await check("order-status-filter-and-export", async () => {
      await nav("Orders"); await choose(page, "Order status filter", "Fulfilled");
      await page.getByRole("button", { name: "Open order " + state.order.number, exact: true }).waitFor({ state: "hidden" });
      await choose(page, "Order status filter", "Draft"); await page.getByRole("button", { name: "Open order " + state.order.number, exact: true }).waitFor();
      await choose(page, "Order status filter", "All statuses");
      const rows = csvRows((await download("Export orders", "orders.csv")).bytes.toString("utf8"));
      requireTrue(rows[0]?.join(",") === "id,number,customerId,status,totalCents" && rows.some(row => row[0] === state.order.id && row[4] === "3548"), "Order export lacks its real total/header");
    }, ["multi-line-order-price-snapshots"]);

    await check("order-fulfillment-updates-stock-once", async () => {
      const details = await orderDetails(); await action("Fulfill order", details);
      await poll(async () => (await api(w("/orders/" + state.order.id))).order.status === "fulfilled", "UI fulfillment did not fulfill the real order");
      state.order = (await api(w("/orders/" + state.order.id))).order;
      requireTrue((await api(w("/products/" + state.productA.id))).product.stock === 8 && (await api(w("/products/" + state.productB.id))).product.stock === 5, "Fulfillment did not decrement all products exactly once");
      const movements = (await api(w("/stock-movements"))).movements.filter(row => row.orderId === state.order.id);
      requireTrue(movements.length === 2 && movements.every(row => row.kind === "fulfillment"), "Fulfillment movement history is incorrect");
      const view = await orderDetails(); requireTrue(await forbiddenAction("Fulfill order", view), "Fulfilled order still offers another fulfillment action");
    }, ["multi-line-order-price-snapshots"]);

    await check("invoice-issued-from-fulfilled-order", async () => {
      await action("Create invoice", await orderDetails());
      await poll(async () => (await api(w("/invoices"))).invoices.some(row => row.orderId === state.order.id), "UI did not create a real invoice");
      state.invoice = await findOne("/invoices", "invoices", row => row.orderId === state.order.id);
      requireTrue(state.invoice.status === "draft" && state.invoice.totalCents === 3548 && state.invoice.subtotalCents === 3548, "Invoice status or integer totals are wrong");
      const view = await invoiceDetails(); await view.getByText(state.customerName, { exact: false }).first().waitFor();
    }, ["order-fulfillment-updates-stock-once"]);

    await check("invoice-sent-paid-workflow", async () => {
      await action("Mark sent", await invoiceDetails());
      await poll(async () => (await api(w("/invoices/" + state.invoice.id))).invoice.status === "sent", "UI did not mark invoice sent");
      await action("Mark paid", await invoiceDetails());
      await poll(async () => (await api(w("/invoices/" + state.invoice.id))).invoice.status === "paid", "UI did not mark invoice paid");
      state.invoice = (await api(w("/invoices/" + state.invoice.id))).invoice;
      requireTrue(Boolean(state.invoice.paidAt), "Paid invoice has no payment timestamp");
      await nav("Invoices"); await choose(page, "Invoice status filter", "Paid"); await page.getByRole("button", { name: "Open invoice " + state.invoice.number, exact: true }).waitFor();
      const rows = csvRows((await download("Export invoices", "invoices.csv")).bytes.toString("utf8"));
      requireTrue(rows[0]?.join(",") === "id,number,orderId,status,totalCents" && rows.some(row => row[0] === state.invoice.id && row[3] === "paid" && row[4] === "3548"), "Invoice export lacks real paid invoice/header");
      await choose(page, "Invoice status filter", "All statuses");
    }, ["invoice-issued-from-fulfilled-order"]);

    await check("invoice-immutable-after-catalog-customer-edits", async () => {
      await nav("Inventory"); await action("Edit product KIT-A"); const productForm = dialog("Edit product");
      await fill(productForm, "Product name", "Revised assay kit"); await fill(productForm, "Unit price (USD)", "99.99"); await submitDialog("Edit product", "Save changes");
      requireTrue((await api(w("/products/" + state.productA.id))).product.priceCents === 9999, "Catalog edit did not persist");
      await nav("Customers"); await action("Edit customer " + state.customerName); await fill(dialog("Edit customer"), "Name", "Northstar Revised"); await submitDialog("Edit customer", "Save changes");
      const originalName = state.customerName; state.customerName = "Northstar Revised";
      const current = (await api(w("/invoices/" + state.invoice.id))).invoice;
      requireTrue(current.billTo.name === originalName && current.totalCents === 3548 && current.items.some(row => row.name === "Assay kit" && row.unitPriceCents === 1249), "Issued invoice snapshots changed with catalog/customer edits");
      const view = await invoiceDetails(); await view.getByText(originalName, { exact: false }).first().waitFor(); await view.getByText("Assay kit", { exact: false }).first().waitFor();
    }, ["invoice-issued-from-fulfilled-order"]);

    await check("project-create-and-board", async () => {
      await nav("Projects"); await action("New project"); const form = dialog("New project");
      await fill(form, "Project name", state.projectName); await fill(form, "Description", "Synthetic order-to-delivery project."); await submitDialog("New project", "Create project");
      state.project = await findOne("/projects", "projects", row => row.name === state.projectName); await openProject();
      for (const name of ["Todo", "In progress", "Done"]) await page.getByRole("region", { name, exact: true }).waitFor();
    });

    await check("tasks-created-with-assignee-date-and-priority", async () => {
      await openProject(); await taskCreate(state.taskTitle, "Todo", "High"); await taskCreate("Follow-up checklist", "In progress", "Low");
      state.task = await findOne("/tasks", "tasks", row => row.title === state.taskTitle);
      requireTrue(state.task.assigneeId === state.user.id && state.task.dueDate === "2027-01-15" && state.task.priority === "high", "Task fields/assignment/date were not persisted");
      await page.getByRole("region", { name: "Todo", exact: true }).getByRole("button", { name: "Edit task " + state.taskTitle, exact: true }).waitFor();
      const card = page.getByRole("article").or(page.getByRole("listitem")).filter({ has: page.getByRole("button", { name: "Edit task " + state.taskTitle, exact: true }) });
      requireTrue(await card.count() > 0, "Task card is not an article/listitem");
    }, ["project-create-and-board"]);

    await check("task-edit-moves-kanban-column", async () => {
      await openProject(); await action("Edit task " + state.taskTitle); const form = dialog("Edit task");
      await choose(form, "Status", "Done"); await choose(form, "Priority", "Medium"); await submitDialog("Edit task", "Save changes");
      await page.getByRole("region", { name: "Done", exact: true }).getByRole("button", { name: "Edit task " + state.taskTitle, exact: true }).waitFor();
      const task = (await api(w("/tasks/" + state.task.id))).task;
      requireTrue(task.status === "done" && task.priority === "medium", "Kanban edit did not persist status/priority");
    }, ["tasks-created-with-assignee-date-and-priority"]);

    await check("task-search-and-composed-filters", async () => {
      await openProject(); await fill(page, "Search tasks", "research"); await choose(page, "Status filter", "Done"); await choose(page, "Priority filter", "Medium");
      await page.getByRole("button", { name: "Edit task " + state.taskTitle, exact: true }).waitFor();
      await page.getByRole("button", { name: "Edit task Follow-up checklist", exact: true }).waitFor({ state: "hidden" });
      await choose(page, "Priority filter", "Low"); await page.getByRole("button", { name: "Edit task " + state.taskTitle, exact: true }).waitFor({ state: "hidden" }); await taskFiltersClear();
      const rows = csvRows((await download("Export tasks", "tasks.csv")).bytes.toString("utf8"));
      requireTrue(rows[0]?.join(",") === "id,projectId,title,description,status,priority,assigneeId,dueDate" && rows.some(row => row[0] === state.task.id && row[2] === state.taskTitle), "Task export lacks its real task/header");
    }, ["task-edit-moves-kanban-column"]);

    await check("task-comment-safe-rendering", async () => {
      await openProject(); await action("Open task " + state.taskTitle); const view = dialog("Task details");
      state.comment = '<img src=x onerror="window.__foundryInjected=1"> Synthetic launch note';
      await fill(view, "Comment", state.comment); await action("Add comment", view); await view.getByText("Synthetic launch note", { exact: false }).first().waitFor();
      await view.getByText(identity.name, { exact: false }).first().waitFor();
      const comments = (await api(w("/tasks/" + state.task.id + "/comments"))).comments;
      requireTrue(comments.some(row => row.body === state.comment && row.author.id === state.user.id), "UI comment is not stored with its true author");
      requireTrue(!(await page.evaluate(() => window.__foundryInjected)), "Comment HTML executed in the browser");
    }, ["tasks-created-with-assignee-date-and-priority"]);

    await check("task-attachment-upload-download-exact-bytes", async () => {
      await openProject(); await action("Open task " + state.taskTitle); const view = dialog("Task details");
      state.fileBytes = Buffer.from("# Synthetic launch brief\nNo company or customer data.\n");
      await view.getByLabel("Attachment", { exact: true }).setInputFiles({ name: "launch-brief.md", mimeType: "text/markdown", buffer: state.fileBytes }); await action("Upload attachment", view);
      await view.getByRole("button", { name: "Download attachment launch-brief.md", exact: true }).or(view.getByRole("link", { name: "Download attachment launch-brief.md", exact: true })).waitFor();
      state.attachment = await findOne("/attachments?entityType=task&entityId=" + state.task.id, "attachments", row => row.fileName === "launch-brief.md");
      const file = await download("Download attachment launch-brief.md", "downloaded-launch-brief.md");
      requireTrue(file.bytes.equals(state.fileBytes), "Downloaded attachment differs from uploaded original bytes");
    }, ["tasks-created-with-assignee-date-and-priority"]);

    await check("unsupported-attachment-visible-error-no-persistence", async () => {
      await openProject(); await action("Open task " + state.taskTitle); const view = dialog("Task details");
      const before = (await api(w("/attachments?entityType=task&entityId=" + state.task.id))).attachments.length;
      const previous = await alerts();
      await view.getByLabel("Attachment", { exact: true }).setInputFiles({ name: "rejected.exe", mimeType: "application/octet-stream", buffer: Buffer.from("synthetic non-executable test bytes") });
      const upload = view.getByRole("button", { name: "Upload attachment", exact: true }); if (await upload.isEnabled()) await upload.click();
      const messages = await freshAlert(previous);
      requireTrue((await api(w("/attachments?entityType=task&entityId=" + state.task.id))).attachments.length === before, "Rejected attachment was persisted");
      return { visibleError: messages };
    }, ["task-attachment-upload-download-exact-bytes"]);

    await check("attachment-delete-removes-download", async () => {
      await openProject(); await action("Open task " + state.taskTitle); await confirmDelete("Delete attachment launch-brief.md");
      await waitStatus(w("/attachments/" + state.attachment.id + "/download"), 404);
      requireTrue(!(await api(w("/attachments?entityType=task&entityId=" + state.task.id))).attachments.some(row => row.id === state.attachment.id), "Deleted attachment remains listed");
    }, ["task-attachment-upload-download-exact-bytes"]);

    await check("task-delete-confirmation-real-api", async () => {
      await openProject(); await taskCreate("Temporary deletion check", "Todo", "High");
      const task = await findOne("/tasks", "tasks", row => row.title === "Temporary deletion check");
      await confirmDelete("Delete task Temporary deletion check"); await waitStatus(w("/tasks/" + task.id), 404);
      await page.getByRole("button", { name: "Edit task Temporary deletion check", exact: true }).waitFor({ state: "hidden" });
    }, ["project-create-and-board"]);

    await check("overview-real-workspace-analytics", async () => {
      await nav("Overview"); const summary = await api(w("/summary"));
      requireTrue(summary.revenueCents === 3548 && summary.fulfilledOrders === 1 && summary.completedTasks >= 1 && summary.openTasks >= 1, "Overview API does not reflect completed business workflow");
      for (const name of ["Revenue", "Unpaid invoices", "Open orders", "Low stock", "Open tasks", "Customers"]) await page.getByRole("region", { name, exact: true }).waitFor();
      await poll(async () => (await page.getByRole("region", { name: "Revenue", exact: true }).innerText()).includes("35.48"), "Visible revenue card does not show paid invoice total");
      await shot("desktop-overview");
    }, ["invoice-sent-paid-workflow", "task-edit-moves-kanban-column"]);

    await check("activity-real-events-and-author", async () => {
      await nav("Activity"); const rows = (await api(w("/activity?limit=50"))).activity;
      for (const actionName of ["customer.created", "stock.adjusted", "order.fulfilled", "invoice.paid", "task.created", "comment.created", "attachment.created"]) requireTrue(rows.some(row => row.action === actionName && row.actorId === state.user.id), "Missing real activity: " + actionName);
      const content = await page.locator("main").count() ? page.locator("main").first() : page.locator("body");
      await waitForVisibleActivity(content, identity.name);
    }, ["invoice-sent-paid-workflow", "task-comment-safe-rendering", "task-attachment-upload-download-exact-bytes"]);

    await check("owner-invite-and-read-only-join", async () => {
      await nav("Team"); await action("Invite member"); const form = dialog("Invite member");
      await fill(form, "Email", invitee.email); await choose(form, "Role", "Read only"); await action("Create invite", form);
      const token = await page.getByLabel("Invite token", { exact: true }).inputValue(); requireTrue(token.length >= 32, "Invite UI does not expose a sufficiently long local token");
      await closeDialogs();
      secondary = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" }); extraContexts.push(secondary); await instrument(secondary);
      await api("/api/auth/signup", "POST", invitee, secondary, 201); secondaryPage = await secondary.newPage();
      await secondaryPage.goto(new URL("/join", base).href, { waitUntil: "domcontentloaded" }); await fill(secondaryPage, "Invite token", token); await action("Join workspace", secondaryPage);
      await nativeSelect(secondaryPage, "Workspace").waitFor();
      await poll(async () => (await api("/api/auth/me", "GET", undefined, secondary)).workspaces.some(row => row.id === state.workspace.id && row.role === "read_only"), "Invitee did not gain the invited read_only membership");
      await choose(secondaryPage, "Workspace", state.workspace.name);
      const members = (await api(w("/members"))).members; state.invitee = members.find(row => row.email === invitee.email); requireTrue(state.invitee?.role === "read_only", "Owner member listing does not contain accepted invitee");
    });

    await check("read-only-ui-permissions", async () => {
      await nav("Inventory", secondaryPage); await poll(() => forbiddenAction("New product", secondaryPage), "Read_only UI offers inventory creation", 3000);
      await nav("Customers", secondaryPage); requireTrue(await forbiddenAction("New customer", secondaryPage) && await forbiddenAction("Import customers", secondaryPage), "Read_only UI offers customer mutations");
      await nav("Team", secondaryPage); requireTrue(await forbiddenAction("Invite member", secondaryPage), "Read_only UI offers invitation administration");
      await api(w("/products"), "POST", { sku: "DENIED", name: "Denied", priceCents: 1 }, secondary, 403);
    }, ["owner-invite-and-read-only-join"]);

    await check("live-role-promotion", async () => {
      await nav("Inventory", secondaryPage); await nav("Team");
      await choose(page, "Role for " + invitee.email, "Manager"); await action("Save role for " + invitee.email);
      await poll(async () => !(await forbiddenAction("New product", secondaryPage)), "Open invitee page did not gain manager controls within3seconds", 3000);
      requireTrue((await api(w("/members"))).members.find(row => row.email === invitee.email)?.role === "manager", "Role update was not persisted");
    }, ["read-only-ui-permissions"]);

    await check("cross-client-live-product-update", async () => {
      await nav("Inventory"); await nav("Inventory", secondaryPage);
      await productCreate("LIVE-C", "Live team supply", "1.49", secondaryPage);
      await poll(async () => page.getByRole("button", { name: "Edit product LIVE-C", exact: true }).isVisible(), "Owner's open Inventory page did not show another client's product within3seconds", 3000);
      state.liveProduct = await findOne("/products", "products", row => row.sku === "LIVE-C");
      requireTrue(state.liveProduct.priceCents === 149, "Live product was not backed by real persisted data");
    }, ["live-role-promotion"]);

    await check("membership-revocation-reacts-live", async () => {
      await nav("Inventory", secondaryPage); await nav("Team"); await confirmDelete("Remove member " + invitee.email);
      await waitStatus(w("/products"), 404, secondary, 3000);
      await poll(async () => {
        const select = nativeSelect(secondaryPage, "Workspace");
        const selected = await select.locator("option:checked").textContent().catch(() => "");
        return selected !== state.workspace.name || await secondaryPage.getByRole("alert").first().isVisible().catch(() => false);
      }, "Open removed-member page did not react to revoked membership within3seconds", 3000);
    }, ["live-role-promotion"]);

    await check("session-refresh-sign-out-sign-in", async () => {
      await closeDialogs(); await page.reload({ waitUntil: "domcontentloaded" }); await nativeSelect(page, "Workspace").waitFor();
      requireTrue((await api("/api/auth/me")).activeWorkspaceId === state.workspace.id, "Active workspace did not survive refresh");
      await action("Sign out"); await api("/api/auth/me", "GET", undefined, context, 401);
      await page.goto(new URL("/signin", base).href, { waitUntil: "domcontentloaded" }); await fill(page, "Email", identity.email); await fill(page, "Password", identity.password); await action("Sign in");
      await nativeSelect(page, "Workspace").waitFor(); const me = await api("/api/auth/me");
      requireTrue(me.user.id === state.user.id && me.activeWorkspaceId === state.workspace.id, "Sign in did not restore same account and selected workspace");
    });

    await check("keyboard-dialog-escape-and-focus-return", async () => {
      await nav("Customers"); const opener = page.getByRole("button", { name: "New customer", exact: true }); await opener.focus(); await opener.press("Enter");
      const form = dialog("New customer"); await form.waitFor();
      requireTrue(await form.evaluate(element => element.contains(document.activeElement)), "Dialog did not receive keyboard focus");
      await page.keyboard.press("Escape"); await form.waitFor({ state: "hidden" });
      requireTrue(await opener.evaluate(element => element === document.activeElement), "Escape did not restore focus to the opener");
    });

    await check("accessible-controls-and-desktop-evidence", async () => {
      await nav("Customers");
      const unnamed = await page.evaluate(() => Array.from(document.querySelectorAll("button,input:not([type=hidden]),select,textarea,[role=button]")).filter(element => element.getClientRects().length && !element.closest('[aria-hidden="true"]')).flatMap(element => {
        const referenced = (element.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ");
        const labels = Array.from(element.labels || []).map(label => label.textContent || "").join(" ");
        const name = element.getAttribute("aria-label") || referenced || labels || element.getAttribute("title") || (element.matches("button,[role=button]") ? element.textContent : "");
        return (name || "").trim() ? [] : [element.tagName.toLowerCase()];
      }));
      requireTrue(!unnamed.length, "Visible controls lack accessible names: " + unnamed.join(", "));
      const size = await layout(page, 1440, 960); await shot("desktop-customers"); requireTrue(size.overflow <= 2, "Desktop document horizontal overflow: " + size.overflow);
      if (passed.has("project-create-and-board")) { await openProject(); await shot("desktop-project-board"); }
      await nav("Inventory"); await shot("desktop-inventory");
      return { unnamedVisibleControls: 0, ...size };
    });

    await check("mobile-responsive-pages-and-evidence", async () => {
      const measurements = [];
      for (const name of ["Overview", "Customers", "Inventory", "Orders"]) {
        await nav(name); const size = await layout(page, 390, 844); measurements.push({ page: name, ...size }); await shot("mobile-" + name.toLowerCase());
      }
      if (passed.has("project-create-and-board")) { await openProject(); const size = await layout(page, 390, 844); measurements.push({ page: "Project board", ...size }); await shot("mobile-project-board"); }
      requireTrue(measurements.every(size => size.overflow <= 2), "Mobile document overflow (contained tables/boards allowed): " + JSON.stringify(measurements));
      await layout(page, 1440, 960); return measurements;
    });

    await check("browser-runtime-diagnostics", async () => {
      requireTrue(!diagnostics.pageErrors.length && !diagnostics.serverErrors.length && !diagnostics.blockedExternalOrigins.length,
        `Uncaught browser errors:${diagnostics.pageErrors.length}; HTTP5xx:${diagnostics.serverErrors.length}; external origins:${diagnostics.blockedExternalOrigins.length}`);
      return { pageErrors: 0, http5xx: 0, blockedExternalOrigins: 0, consoleErrorCount: diagnostics.consoleErrors.length, failedRequestCount: diagnostics.failedRequests.length };
    }, []);
  } finally {
    for (const extra of extraContexts) await extra.close().catch(() => {});
    await context.close();
  }
  const summary = { passed: checks.filter(row => row.status === "passed").length, failed: checks.filter(row => row.status === "failed").length, notRun: checks.filter(row => row.status === "not_run").length };
  const result = { kind: "foundry-independent-browser-evaluation", modelCalls: 0, checks, summary, screenshots, diagnostics,
    scope: "40 UI workflow/accessibility/responsive checks with real API readback; durable restart/concurrency/negative security/storage coverage is in the separate API evaluator",
    visualQuality: "Screenshots require blinded human review using visual-rubric.md; no automatic visual score is asserted" };
  await fs.writeFile(path.join(outDir, "browser-results.json"), JSON.stringify(result, null, 2));
  return result;
}

module.exports = { browserEvaluate, csvRows, navigateAction, dismissDialogs, navigateWithDialogs, openInvoiceDetails, nativeSelect, choose, waitForWorkspaceSelection, waitForVisibleActivity };
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  browserEvaluate({ baseURL: get("--base-url"), outDir: get("--out"), playwrightModule: get("--playwright"), chromePath: get("--chrome") }).then(result => {
    console.log(JSON.stringify(result)); process.exitCode = result.summary.failed || result.summary.notRun ? 1 : 0;
  }).catch(error => { console.error(JSON.stringify({ status: "harness_error", error: String(error.message || error) })); process.exitCode = 2; });
}
