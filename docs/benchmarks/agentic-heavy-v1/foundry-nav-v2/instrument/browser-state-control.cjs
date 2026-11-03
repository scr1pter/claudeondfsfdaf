"use strict";
// Synthetic HTML and in-page state only. No Foundry app, API or network server.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

async function stateControl(options) {
  for (const key of ["instrument", "playwright", "chrome", "out"]) assert.ok(options[key] && path.isAbsolute(options[key]), `${key} must be absolute`);
  const instrument = require(options.instrument);
  const source = await fs.readFile(options.instrument, "utf8");
  const baseline = !instrument.waitForWorkspaceSelection;
  if (baseline) {
    assert.ok(source.includes('me = await api("/api/auth/me");\n      requireTrue(me.activeWorkspaceId === state.workspace.id, "Switching back did not select the original workspace");'));
    assert.ok(source.includes('await page.getByText(identity.name, { exact: false }).first().waitFor();'));
  }
  const { chromium } = require(options.playwright);
  const prefix = path.join(os.tmpdir(), "foundry-state-control-");
  const profile = await fs.mkdtemp(prefix);
  const checks = [], blockedRequests = [];
  let context, profileRemoved = false;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: options.chrome, headless: true, viewport: { width: 1440, height: 960 }, args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update"] });
    await context.route("**/*", async route => { blockedRequests.push(route.request().url()); await route.abort(); });
    const page = context.pages()[0] || await context.newPage(); page.setDefaultTimeout(250);
    async function check(name, fn) {
      try { checks.push({ name, status: "passed", evidence: await fn() }); }
      catch (error) { checks.push({ name, status: "failed", reason: String(error.message || error).slice(0, 900) }); }
    }
    const selected = () => page.getByLabel("Workspace", { exact: true }).inputValue();
    async function workspaceProbe() {
      const readMe = async () => ({ activeWorkspaceId: await page.evaluate(() => window.backendWorkspace) });
      if (baseline) { assert.equal((await readMe()).activeWorkspaceId, "original", "Switching back did not select the original workspace"); return; }
      return instrument.waitForWorkspaceSelection(page, "original", readMe, { timeout: 180, interval: 5 });
    }
    for (const behavior of ["delayed-valid", "wrong-backend", "never-backend", "stale-ui"]) {
      await check(`workspace-${behavior}`, async () => {
        await page.goto("about:blank");
        await page.setContent(`<label for="workspace">Workspace</label><select id="workspace"><option value="other">Other</option><option value="original">Original</option></select><script>
          window.backendWorkspace = 'other';
          document.querySelector('select').onchange = event => {
            const behavior = ${JSON.stringify(behavior)};
            if (behavior === 'stale-ui') event.target.value = 'other';
            setTimeout(() => { window.backendWorkspace = behavior === 'never-backend' ? 'other' : behavior === 'wrong-backend' ? 'wrong' : 'original'; }, 35);
          };
        </script>`);
        await instrument.choose(page, "Workspace", "Original");
        if (behavior === "delayed-valid") { await workspaceProbe(); return { backend: await page.evaluate(() => window.backendWorkspace), selected: await selected() }; }
        await assert.rejects(workspaceProbe());
        return { expectedRejection: true, backend: await page.evaluate(() => window.backendWorkspace), selected: await selected() };
      });
    }
    async function activityProbe() {
      const content = await page.locator("main").count() ? page.locator("main").first() : page.locator("body");
      if (baseline) {
        await page.getByText("Alex Foundry", { exact: false }).first().waitFor({ timeout: 180 });
        assert.match(await content.innerText(), /created|stock|fulfilled|paid|comment|attachment/i); return;
      }
      await instrument.waitForVisibleActivity(content, "Alex Foundry", { timeout: 180, interval: 5 });
    }
    const hiddenOption = '<select aria-label="Workspace"><option>Alex Foundry workspace</option></select>';
    const activityCases = [
      ["hidden-option-before-visible-author", `<aside>${hiddenOption}</aside><main><p>Alex Foundry created customer</p></main>`, true],
      ["hidden-option-only-inside-content", `<main>${hiddenOption}<p>created customer</p></main>`, false],
      ["sidebar-author-outside-content", '<aside>Alex Foundry</aside><main><p>created customer</p></main>', false],
      ["hidden-author-inside-content", '<main><p hidden>Alex Foundry</p><p>created customer</p></main>', false],
      ["missing-events", '<main><p>Alex Foundry</p></main>', false],
      ["hidden-only-events", '<main><p>Alex Foundry</p><p hidden>created customer</p></main>', false],
      ["body-fallback-visible-activity", '<article>Alex Foundry created customer</article>', true],
    ];
    for (const [name, html, valid] of activityCases) {
      await check(`activity-${name}`, async () => {
        await page.goto("about:blank"); await page.setContent(html);
        if (valid) await activityProbe(); else await assert.rejects(activityProbe());
        return { expectedValid: valid, expectedRejection: !valid };
      });
    }
    assert.deepEqual(blockedRequests, []);
  } finally {
    if (context) await context.close();
    const resolved = path.resolve(profile);
    assert.ok(resolved.startsWith(path.resolve(prefix)) && path.dirname(resolved) === path.resolve(os.tmpdir()));
    await fs.rm(resolved, { recursive: true, force: true }); profileRemoved = true;
  }
  const summary = { passed: checks.filter(row => row.status === "passed").length, failed: checks.filter(row => row.status === "failed").length };
  const result = { kind: "Foundry synthetic real-DOM workspace/activity control", modelCalls: 0, baseline, baselineMethod: baseline ? "Preserved source-verified immediate backend assertion and global first text visibility assertion; select helper imported unchanged" : "Exported repaired instrument helpers", instrumentSha256: crypto.createHash("sha256").update(source).digest("hex"), controlSha256: crypto.createHash("sha256").update(await fs.readFile(__filename)).digest("hex"), summary, checks, blockedRequests, profileRemoved, scope: "about:blank HTML and in-page state only; no app/API/Bun/model calls; controls are not product passes" };
  await fs.writeFile(options.out, JSON.stringify(result, null, 2) + "\n", "utf8"); return result;
}
module.exports = { stateControl };
if (require.main === module) {
  const arg = flag => process.argv[process.argv.indexOf(flag) + 1];
  stateControl({ instrument: arg("--instrument"), playwright: arg("--playwright"), chrome: arg("--chrome"), out: arg("--out") }).then(result => { console.log(JSON.stringify({ ...result.summary, baseline: result.baseline, profileRemoved: result.profileRemoved, blockedRequests: result.blockedRequests.length })); process.exitCode = result.summary.failed ? 1 : 0; }).catch(error => { console.error(String(error.stack || error)); process.exitCode = 1; });
}
