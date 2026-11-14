"use strict";
// Synthetic about:blank HTML only; no Foundry app, Bun, API or model calls.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

async function invoiceControl(options) {
  for (const key of ["instrument", "playwright", "chrome", "out"]) assert.ok(options[key] && path.isAbsolute(options[key]), `${key} must be absolute`);
  const instrument = require(options.instrument), source = await fs.readFile(options.instrument, "utf8");
  const baseline = !instrument.openInvoiceDetails;
  if (baseline) assert.ok(source.includes('async function invoiceDetails() { await nav("Invoices"); await action("Open invoice " + state.invoice.number); return dialog("Invoice details"); }'));
  const { chromium } = require(options.playwright), prefix = path.join(os.tmpdir(), "foundry-invoice-control-");
  const profile = await fs.mkdtemp(prefix); let context, profileRemoved = false;
  const checks = [], requests = [];
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: options.chrome, headless: true, viewport: { width: 1440, height: 960 }, reducedMotion: "reduce", args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update"] });
    await context.route("**/*", async route => { requests.push(route.request().url()); await route.abort(); });
    const page = context.pages()[0] || await context.newPage(); page.setDefaultTimeout(300);
    async function fixture(mode) {
      await page.goto("about:blank");
      const delayed = mode === "delayed-auto-open", automatic = delayed || ["synchronous-auto-open", "unclosable"].includes(mode);
      await page.setContent(`<!doctype html><html><head><style>
        @keyframes settle { from { transform:translateY(8px) } to { transform:translateY(0) } }
        #invoices { ${delayed ? "animation:settle .18s linear" : ""} } dialog{width:450px;padding:30px} dialog::backdrop{background:#3338}
      </style></head><body><button id="invoices">Invoices</button><main><h1>Orders</h1><button id="open" style="display:none">Open invoice INV-1</button></main>
      <dialog id="order" aria-label="Order details"><p>Order ORD-1</p><button>Creating invoice…</button></dialog>
      <dialog id="automatic" aria-label="Invoice details"><h2>Automatically opened invoice</h2><p>INV-1</p><button onclick="document.getElementById('automatic').close()">Close dialog</button></dialog>
      <dialog id="final" aria-label="${mode === "wrong-dialog" ? "Customer details" : "Invoice details"}"><h2>${mode === "wrong-workflow" ? "INV-other" : "INV-1"}</h2><button id="sent">Mark sent</button><button id="paid">Mark paid</button></dialog>
      <script>
        window.invoiceState={expected:'draft',other:'draft'};window.expectedOpens=0;window.escapeCount=0;window.backendInvoiceVisible=true;
        document.addEventListener('keydown',event=>{if(event.key==='Escape')window.escapeCount++});
        const mode=${JSON.stringify(mode)};
        const navButton=document.getElementById('invoices'),opener=document.getElementById('open'),finalDialog=document.getElementById('final'),autoDialog=document.getElementById('automatic'),orderDialog=document.getElementById('order');
        navButton.onclick=()=>{document.querySelector('h1').textContent='Invoices';opener.style.display='block'};
        if(mode==='missing-target')opener.textContent='Open invoice INV-other';
        opener.onclick=()=>{window.expectedOpens++;finalDialog.showModal()};
        document.getElementById('sent').onclick=()=>{const key=mode==='wrong-workflow'?'other':'expected';window.invoiceState[key]='sent'};
        document.getElementById('paid').onclick=()=>{if(mode!=='broken-paid')window.invoiceState.expected='paid'};
        if(mode==='unclosable')autoDialog.addEventListener('cancel',event=>event.preventDefault());
        ${automatic && !delayed ? "autoDialog.showModal();" : "orderDialog.showModal();"}
        ${delayed ? "setTimeout(()=>{orderDialog.remove();autoDialog.showModal()},15);" : ""}
      </script></body></html>`);
    }
    async function openExpected() {
      if (!baseline) return instrument.openInvoiceDetails(page, "INV-1", { timeout: 650, attemptTimeout: 90 });
      // Source-verified equivalents of the original nested closeDialogs/nav/invoiceDetails.
      for (let count = 0; count < 3 && await page.getByRole("dialog").count(); count++) { const current = page.getByRole("dialog").last(); if (!(await current.isVisible())) break; await page.keyboard.press("Escape"); await current.waitFor({ state: "hidden" }); }
      await instrument.navigateAction(page, "Invoices");
      await page.getByRole("button", { name: "Open invoice INV-1", exact: true }).or(page.getByRole("link", { name: "Open invoice INV-1", exact: true })).first().click();
      return page.getByRole("dialog", { name: "Invoice details", exact: true });
    }
    async function workflow() {
      const view = await openExpected(); await view.waitFor({ state: "visible" });
      await view.getByRole("button", { name: "Mark sent", exact: true }).click(); assert.equal(await page.evaluate(() => window.invoiceState.expected), "sent", "Actual expected invoice was not marked sent");
      await view.getByRole("button", { name: "Mark paid", exact: true }).click(); assert.equal(await page.evaluate(() => window.invoiceState.expected), "paid", "Actual expected invoice was not marked paid");
      assert.equal(await page.evaluate(() => window.expectedOpens), 1, "Exact invoice opener was not used once");
      return page.evaluate(() => ({ ...window.invoiceState, escapeCount: window.escapeCount, expectedOpens: window.expectedOpens }));
    }
    async function check(name, mode, rejects) {
      const started = Date.now();
      try { await fixture(mode); let evidence; if (rejects) { await assert.rejects(workflow()); evidence = { expectedWorkflowRejection: true }; } else evidence = await workflow(); checks.push({ name, status: "passed", evidence, elapsedMs: Date.now() - started }); }
      catch (error) { checks.push({ name, status: "failed", reason: String(error.message || error).slice(0, 1400), elapsedMs: Date.now() - started }); }
    }
    await check("delayed-native-auto-open-after-backend-readback", "delayed-auto-open", false);
    await check("synchronous-auto-open-is-closed-and-exact-invoice-reopened", "synchronous-auto-open", false);
    await check("no-auto-open-remains-supported", "no-auto-open", false);
    await check("unclosable-native-modal-stays-red", "unclosable", true);
    await check("missing-exact-invoice-target-stays-red", "missing-target", true);
    await check("wrong-dialog-workflow-stays-red", "wrong-dialog", true);
    await check("wrong-invoice-status-mutation-stays-red", "wrong-workflow", true);
    await check("broken-mark-paid-workflow-stays-red", "broken-paid", true);
    assert.deepEqual(requests, []);
  } finally {
    if (context) await context.close();
    const resolved = path.resolve(profile); assert.ok(resolved.startsWith(path.resolve(prefix)) && path.dirname(resolved) === path.resolve(os.tmpdir())); await fs.rm(resolved, { recursive: true, force: true }); profileRemoved = true;
  }
  const summary = { passed: checks.filter(row => row.status === "passed").length, failed: checks.filter(row => row.status === "failed").length };
  const result = { kind: "Foundry synthetic native-dialog invoice transition control", modelCalls: 0, baseline, baselineMethod: baseline ? "Preserved-source-verified nested invoiceDetails/nav/closeDialogs sequence plus imported original navigateAction" : "Exported repaired openInvoiceDetails helper", instrumentSha256: crypto.createHash("sha256").update(source).digest("hex"), controlSha256: crypto.createHash("sha256").update(await fs.readFile(__filename)).digest("hex"), summary, checks, networkRequests: requests.length, profileRemoved, scope: "Synthetic HTML/in-page state only; no app/API/Bun/model calls. Negative controls pass only by observing real workflow rejection." };
  await fs.writeFile(options.out, JSON.stringify(result, null, 2) + "\n"); return result;
}
module.exports = { invoiceControl };
if (require.main === module) { const arg = flag => process.argv[process.argv.indexOf(flag) + 1]; invoiceControl({ instrument: arg("--instrument"), playwright: arg("--playwright"), chrome: arg("--chrome"), out: arg("--out") }).then(result => { console.log(JSON.stringify({ ...result.summary, baseline: result.baseline, profileRemoved: result.profileRemoved, networkRequests: result.networkRequests })); process.exitCode = result.summary.failed ? 1 : 0; }).catch(error => { console.error(String(error.stack || error)); process.exitCode = 1; }); }
