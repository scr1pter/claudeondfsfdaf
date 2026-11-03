"use strict";

// Synthetic DOM control only: no application server, API, credentials or model calls.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

async function navigationControl(options) {
  for (const name of ["instrument", "playwright", "chrome", "out"])
    assert.ok(options[name] && path.isAbsolute(options[name]), `${name} must be an absolute path`);
  const { navigateAction } = require(options.instrument);
  const { chromium } = require(options.playwright);
  const profilePrefix = path.join(os.tmpdir(), "foundry-navigation-control-");
  const profile = await fs.mkdtemp(profilePrefix);
  const checks = [], blockedRequests = [];
  let context, profileRemoved = false;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: options.chrome, headless: true,
      viewport: { width: 1440, height: 960 }, reducedMotion: "reduce",
      args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update"],
    });
    await context.route("**/*", async route => {
      blockedRequests.push(route.request().url());
      await route.abort("blockedbyclient");
    });
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(400);
    page.setDefaultNavigationTimeout(1000);
    async function fixture({ role = "link", label = "Orders", badge = "", mode = "desktop", behavior = "orders" }) {
      await page.setViewportSize(mode === "desktop" ? { width: 1440, height: 960 } : { width: 390, height: 844 });
      await page.goto("about:blank");
      const tag = role === "link" ? "a" : role === "button" ? "button" : "div";
      const attributes = role === "link" ? 'href="#orders"' : role === "button" ? 'type="button"' : "";
      const menuStyle = mode === "collapsed" ? "display:none" : mode === "offcanvas" ? "transform:translateX(-300px)" : "";
      const toggleStyle = mode === "desktop" ? "display:none" : "";
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
        body { margin: 0; font: 16px sans-serif; } aside { width:240px; height:200px; position:absolute; top:50px; left:0; }
        #candidate { display:block; width:200px; padding:10px; } #toggle { width:44px; height:44px; }
        main { position:absolute; top:300px; }
      </style></head><body><button id="toggle" aria-label="Open navigation" style="${toggleStyle}">Menu</button>
      <aside id="menu" style="${menuStyle}"><${tag} id="candidate" ${attributes}><span>${label}</span>${badge}</${tag}></aside>
      <main><h1 id="destination">Home</h1></main><script>
        window.controlClicks = [];
        document.getElementById('toggle').onclick = () => {
          window.controlClicks.push('Open navigation');
          const menu = document.getElementById('menu'); menu.style.display = 'block'; menu.style.transform = 'none';
        };
        document.getElementById('candidate').onclick = event => {
          window.controlClicks.push('candidate');
          event.preventDefault();
          const behavior = ${JSON.stringify(behavior)};
          if (behavior === 'dead') return;
          const destination = behavior === 'wrong-route' ? 'Inventory' : 'Orders';
          document.getElementById('destination').textContent = destination;
          location.hash = destination.toLowerCase();
        };
      </script></body></html>`);
    }
    async function outcome() {
      return page.evaluate(() => ({ destination: document.getElementById("destination").textContent, hash: location.hash, clicks: window.controlClicks }));
    }
    async function check(name, fn) {
      const started = Date.now();
      try { checks.push({ name, status: "passed", evidence: await fn(), elapsedMs: Date.now() - started }); }
      catch (error) { checks.push({ name, status: "failed", reason: String(error.message || error).slice(0, 1200), elapsedMs: Date.now() - started }); }
    }
    for (const role of ["link", "button"]) {
      for (const [variant, badge] of [["plain", ""], ["spaced-badge", "<span> 1</span>"], ["joined-badge", "<span>12</span>"]]) {
        for (const mode of ["desktop", "inline-mobile", "collapsed", "offcanvas"]) {
          await check(`${role}-${variant}-${mode}`, async () => {
            await fixture({ role, badge, mode });
            await navigateAction(page, "Orders");
            const observed = await outcome();
            assert.equal(observed.destination, "Orders"); assert.equal(observed.hash, "#orders");
            assert.deepEqual(observed.clicks, ["collapsed", "offcanvas"].includes(mode) ? ["Open navigation", "candidate"] : ["candidate"]);
            return { ...observed, ariaSnapshot: await page.locator("#candidate").ariaSnapshot() };
          });
        }
      }
    }
    for (const label of ["Preorders", "New orders", "Orders archive", "Orders 1 archive", "OrdersX", "Orders -1", "Orders 1.5"]) {
      await check(`reject-near-label-${label}`, async () => {
        await fixture({ label });
        await assert.rejects(navigateAction(page, "Orders"), /Timeout|strict mode|locator/);
        const observed = await outcome(); assert.deepEqual(observed.clicks, []); assert.equal(observed.destination, "Home");
        return observed;
      });
    }
    await check("reject-text-only-non-control", async () => {
      await fixture({ role: "text", badge: "<span>1</span>" });
      await assert.rejects(navigateAction(page, "Orders"), /Timeout|strict mode|locator/);
      const observed = await outcome(); assert.deepEqual(observed.clicks, []); return observed;
    });
    for (const behavior of ["dead", "wrong-route"]) {
      await check(`downstream-destination-rejects-${behavior}`, async () => {
        await fixture({ behavior });
        await navigateAction(page, "Orders");
        const observed = await outcome();
        assert.deepEqual(observed.clicks, ["candidate"]);
        // A successful locator click is not a successful workflow. Existing evaluator
        // business assertions remain responsible for detecting dead or wrong routing.
        assert.throws(() => assert.equal(observed.destination, "Orders"));
        return { ...observed, navigationResolved: true, workflowVerified: false };
      });
    }
    await check("regex-metacharacters-in-label-are-literal", async () => {
      await fixture({ label: "Orders (west)+" });
      await navigateAction(page, "Orders (west)+");
      assert.equal((await outcome()).destination, "Orders");
      await fixture({ label: "Orders west" });
      await assert.rejects(navigateAction(page, "Orders (west)+"), /Timeout|strict mode|locator/);
      return { literalMatched: true, regexLikeNearLabelRejected: true };
    });
    assert.deepEqual(blockedRequests, [], "Synthetic control attempted a network request");
  } finally {
    if (context) await context.close();
    const resolvedProfile = path.resolve(profile);
    assert.ok(resolvedProfile.startsWith(path.resolve(profilePrefix)) && path.dirname(resolvedProfile) === path.resolve(os.tmpdir()), "Unexpected temporary profile path");
    await fs.rm(resolvedProfile, { recursive: true, force: true });
    profileRemoved = true;
  }
  const summary = { passed: checks.filter(row => row.status === "passed").length, failed: checks.filter(row => row.status === "failed").length };
  const result = {
    kind: "Foundry synthetic real-DOM navigation control", modelCalls: 0,
    instrument: options.instrument,
    instrumentSha256: crypto.createHash("sha256").update(await fs.readFile(options.instrument)).digest("hex"),
    controlSha256: crypto.createHash("sha256").update(await fs.readFile(__filename)).digest("hex"),
    summary, checks, blockedRequests, profileRemoved,
    scope: "Synthetic about:blank HTML only; no Foundry app/API or paid/model process. This is instrument evidence, not a product workflow pass.",
  };
  await fs.writeFile(options.out, JSON.stringify(result, null, 2) + "\n", "utf8");
  return result;
}

module.exports = { navigationControl };
if (require.main === module) {
  const value = flag => process.argv[process.argv.indexOf(flag) + 1];
  navigationControl({ instrument: value("--instrument"), playwright: value("--playwright"), chrome: value("--chrome"), out: value("--out") }).then(result => {
    console.log(JSON.stringify({ ...result.summary, profileRemoved: result.profileRemoved, blockedRequests: result.blockedRequests.length }));
    process.exitCode = result.summary.failed ? 1 : 0;
  }).catch(error => { console.error(String(error.stack || error)); process.exitCode = 1; });
}
