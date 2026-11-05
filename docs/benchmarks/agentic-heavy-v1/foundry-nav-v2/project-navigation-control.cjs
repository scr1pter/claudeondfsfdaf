"use strict";

// Real Chromium controls over synthetic DOM only. No app, API or model runs.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

async function projectNavigationControl(options) {
  for (const name of ["playwright", "chrome", "out"])
    assert.ok(options[name] && path.isAbsolute(options[name]), `${name} must be absolute`);
  const instrument = path.join(__dirname, "instrument/browser-eval.cjs");
  const { openProjectBoard } = require(instrument);
  const { chromium } = require(options.playwright);
  await fs.mkdir(options.out);
  const profile = await fs.mkdtemp(path.join(options.out, "profile-"));
  const checks = [], blockedRequests = [];
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: options.chrome, headless: true, viewport: { width: 1100, height: 780 }, reducedMotion: "reduce",
      args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update"],
    });
    await context.route("**/*", async route => {
      blockedRequests.push(route.request().url());
      await route.abort("blockedbyclient");
    });
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(600);
    async function fixture(config = {}) {
      const value = { initial: "listing", back: "works", opener: "works", ...config };
      await page.goto("about:blank");
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>Project navigation control</title></head>
      <body><nav><button id="projects">Projects</button></nav><main id="main"></main><script>
        const config = ${JSON.stringify(value)};
        window.controlClicks = [];
        window.board = config.initial === 'listing' ? null : config.initial;
        function showListing() {
          window.board = null;
          document.querySelector('#main').innerHTML = '<h1>Projects</h1>' +
            (config.opener === 'missing' ? '<button>Open project Other project</button>' :
              '<button id="open">' + (config.opener === 'near-label' ? 'Open project Delivery launch archive' : 'Open project Delivery launch') + '</button>');
          const open = document.querySelector('#open');
          if (open) open.onclick = () => {
            window.controlClicks.push(open.textContent);
            if (config.opener !== 'dead') showBoard('Delivery launch');
          };
        }
        function showBoard(name) {
          window.board = name;
          document.querySelector('#main').innerHTML = '<h1>' + name + '</h1><button id="new-task">New task</button>' +
            (config.back === 'missing' ? '' : '<button id="back"' + (config.back === 'hidden' ? ' hidden' : '') + '>All projects</button>');
          const back = document.querySelector('#back');
          if (back) back.onclick = () => {
            window.controlClicks.push('All projects');
            if (config.back !== 'dead') showListing();
          };
        }
        document.querySelector('#projects').onclick = () => window.controlClicks.push('Projects');
        if (window.board) showBoard(window.board); else showListing();
      </script></body></html>`);
    }
    async function state() { return page.evaluate(() => ({ board: window.board, clicks: window.controlClicks })); }
    async function check(name, fn) {
      const started = Date.now();
      try { checks.push({ name, status: "passed", evidence: await fn(), elapsedMs: Date.now() - started }); }
      catch (error) { checks.push({ name, status: "failed", reason: String(error.message || error).slice(0, 1600), elapsedMs: Date.now() - started }); }
    }
    for (const initial of ["listing", "Delivery launch", "Other project"]) {
      await check(`opens-exact-target-from-${initial}`, async () => {
        await fixture({ initial });
        await openProjectBoard(page, "Delivery launch", { timeout: 1200 });
        const observed = await state();
        assert.equal(observed.board, "Delivery launch");
        assert.deepEqual(observed.clicks, initial === "listing" ? ["Projects", "Open project Delivery launch"] :
          ["Projects", "All projects", "Open project Delivery launch"]);
        return observed;
      });
    }
    const rejected = [
      ["missing-exact-opener", { opener: "missing" }],
      ["wrong-board-without-return-control", { initial: "Other project", back: "missing" }],
      ["no-op-return-control", { initial: "Other project", back: "dead" }],
      ["hidden-return-control-is-not-used", { initial: "Other project", back: "hidden" }],
      ["target-opener-does-not-open-board", { opener: "dead" }],
      ["near-label-is-not-target-opener", { opener: "near-label" }],
    ];
    for (const [name, config] of rejected) {
      await check(`rejects-${name}`, async () => {
        await fixture(config);
        await assert.rejects(openProjectBoard(page, "Delivery launch", { timeout: 700 }), /Timeout|deadline|locator/);
        const observed = await state();
        if (config.opener === "dead") assert.ok(observed.clicks.includes("Open project Delivery launch"));
        else assert.ok(!observed.clicks.includes("Open project Delivery launch"));
        if (config.back === "hidden") assert.ok(!observed.clicks.includes("All projects"));
        assert.notEqual(observed.board, "Delivery launch");
        return observed;
      });
    }
    await check("no-external-network-request", async () => { assert.deepEqual(blockedRequests, []); return { blockedRequests: 0 }; });
  } finally {
    if (context) await context.close();
  }
  const summary = { kind: "foundry-project-navigation-chromium-controls-v2", modelCalls: 0, appRuns: 0,
    instrumentSha256: crypto.createHash("sha256").update(await fs.readFile(instrument)).digest("hex"),
    checks, passed: checks.filter(row => row.status === "passed").length, failed: checks.filter(row => row.status === "failed").length,
    profileRetainedPrivate: true, skippedBenchmarkChecksRelabelled: false };
  await fs.writeFile(path.join(options.out, "control-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

module.exports = { projectNavigationControl };
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  projectNavigationControl({ playwright: get("--playwright"), chrome: get("--chrome"), out: get("--out") }).then(summary => {
    console.log(JSON.stringify(summary)); process.exitCode = summary.failed ? 1 : 0;
  }).catch(error => { console.error(String(error.stack || error)); process.exitCode = 2; });
}
