// Independent browser acceptance; mutations use documented visible controls only.
const fs = require("node:fs/promises")
const path = require("node:path")
const crypto = require("node:crypto")
const http = require("node:http")
const { startProxy } = require("./local-proxy.cjs")

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, list) => index % 2 === 0 ? [...pairs, [value.replace(/^--/, ""), list[index + 1]]] : pairs, []))
const base = new URL(args.base)
if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !args.out || !args.chrome || !args["playwright-module"]) throw new Error("explicit loopback base and owned tooling required")
const out = path.resolve(args.out)
const names = [
  "navigation_actor", "project_create", "project_edit_search", "environment_create_edit",
  "runbook_create_steps", "runbook_cycle_validation", "runbook_version_edit", "release_create_snapshot",
  "release_draft_edit", "release_submit", "approval_role_switch", "release_approve",
  "release_run_live_jobs", "release_artifact_download", "job_log_detail", "release_deep_link_reload",
  "failure_runbook_create", "failure_release_run", "failure_retry", "second_release_success",
  "rollback_restore_active", "incident_create_link", "incident_note_timeline", "incident_resolve",
  "incident_reopen_filter", "audit_filter", "viewer_restrictions", "escaped_user_text",
  "inline_error_preserves_form", "keyboard_focus", "mobile_layout", "console_local_assets",
]
const report = { kind: "harbor-browser-v1", checks: names.map(name => ({ name, status: "not_run" })), screenshots: [], consoleErrors: [], blockedRequests: [], proxyBlocks: [] }
const byName = Object.fromEntries(report.checks.map(row => [row.name, row]))
const state = {}
let browser, context, page, proxy
function assert(value, message) { if (!value) throw new Error(message) }
async function write() {
  report.summary = Object.fromEntries(["failed", "not_run", "passed"].map(status => [status, report.checks.filter(row => row.status === status).length]))
  await fs.writeFile(path.join(out, "browser.json"), JSON.stringify(report, null, 2) + "\n")
}
async function screenshot(name) {
  const filename = name + ".png"
  await page.screenshot({ path: path.join(out, filename), fullPage: false })
  report.screenshots.push({ file: filename, sha256: crypto.createHash("sha256").update(await fs.readFile(path.join(out, filename))).digest("hex") })
}
async function check(name, dependencies, action) {
  const row = byName[name]
  if (dependencies.some(dependency => byName[dependency].status !== "passed")) {
    row.error = "Earlier browser fixture unavailable: " + dependencies.filter(dependency => byName[dependency].status !== "passed").join(", ")
    await write(); return
  }
  const started = Date.now()
  try { await action(); row.status = "passed" }
  catch (error) {
    row.status = "failed"; row.error = String(error.message || error).slice(0, 1200)
    await screenshot("failure-" + name).catch(() => {})
  }
  row.wallMs = Date.now() - started
  await write()
}
async function read(api) {
  assert(api.startsWith("/api/"), "read-only API assertion path")
  const cookies = await context.cookies(base.origin)
  // APIRequestContext may use CONNECT even for an HTTP proxy. Independent reads
  // instead use one explicit loopback GET, without redirects or app-side fetch.
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port: base.port, path: api,
      headers: { Cookie: cookies.map(cookie => cookie.name + "=" + cookie.value).join("; ") } }, response => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", chunk => { body += chunk; if (body.length > 4_194_304) request.destroy(new Error("API assertion response too large")) })
      response.on("end", () => {
        try { assert(response.statusCode === 200, "GET " + api + " returned " + response.statusCode); resolve(JSON.parse(body)) }
        catch (error) { reject(error) }
      })
      response.on("error", reject)
    })
    request.setTimeout(12000, () => request.destroy(new Error("Loopback API assertion timed out")))
    request.on("error", reject)
  })
}
async function eventually(action, predicate, message, milliseconds = 12000) {
  const end = Date.now() + milliseconds
  let latest
  while (Date.now() < end) {
    try {
      latest = await action()
      if (predicate(latest)) return latest
    } catch (error) { latest = { transientError: String(error.message || error).slice(0, 300) } }
    await new Promise(resolve => setTimeout(resolve, 75))
  }
  throw new Error(message + ": " + JSON.stringify(latest).slice(0, 400))
}
async function visible(text) { await page.getByText(text, { exact: true }).first().waitFor({ state: "visible" }) }
async function visibleStatus(status) {
  const pattern = new RegExp("\\b" + status.split("_").join("[ _-]+") + "\\b", "i")
  await eventually(() => page.locator("body").innerText(), text => pattern.test(text), "status not visibly displayed: " + status)
}
async function button(name) { await page.getByRole("button", { name, exact: true }).click() }
async function link(name) { await page.getByRole("link", { name, exact: true }).first().click() }
async function field(name, value) { await page.getByLabel(name, { exact: true }).fill(value) }
async function select(name, value) {
  const control = page.getByLabel(name, { exact: true })
  await control.waitFor({ state: "visible" })
  await eventually(() => control.locator("option").evaluateAll(options => options.map(option => option.value)), values => values.includes(value), "select option missing: " + name + "=" + value)
  await control.selectOption(value)
}
async function actor(value) {
  await select("Actor", value)
  await eventually(() => read("/api/session"), body => body.actor.id === value, "actor session did not change")
  assert(await page.getByLabel("Actor", { exact: true }).inputValue() === value, "actor selector did not retain current actor")
}
async function nav(name) { await link(name) }
async function project() { await select("Project", state.project.id) }
function p(kind, id) { return "/api/projects/" + state.project.id + "/" + kind + (id ? "/" + id : "") }
async function findRelease(title) {
  return eventually(() => read(p("releases")), body => body.releases.some(release => release.title === title), "release missing").then(body => body.releases.find(release => release.title === title))
}
async function releaseStatus(release, status) {
  return eventually(() => read(p("releases", release.id)), body => body.release.status === status, "release status did not become " + status, 20000).then(body => body.release)
}
async function openRelease(release) { await nav("Releases"); await project(); await link(release.title) }
async function fillStep(index, key, dependencies = "", failure = "never", duration = "300", kind = "check") {
  await field(`Step ${index} key`, key); await field(`Step ${index} name`, "UI " + key + " task")
  await select(`Step ${index} kind`, kind); await field(`Step ${index} dependencies`, dependencies)
  await field(`Step ${index} duration`, duration); await select(`Step ${index} failure mode`, failure)
}
async function newRelease(title, version, runbookId, environment = state.prod.id) {
  await nav("Releases"); await project(); await button("New release")
  await field("Release title", title); await field("Version label", version); await field("Release notes", "Synthetic browser release")
  await select("Environment", environment); await select("Runbook", runbookId)
  await button("Save release")
  return findRelease(title)
}
async function submitApproveRun(release) {
  await openRelease(release); await button("Submit for approval")
  if (release.environmentId === state.prod.id) {
    await actor("admin"); await openRelease(release); await button("Approve release")
    await field("Approval comment", "Independent synthetic browser approval"); await button("Confirm approve")
  }
  await button("Run release")
  await releaseStatus(release, "succeeded")
}

;(async () => {
  await fs.mkdir(out, { recursive: true })
  await write()
  try {
    const playwright = require(path.resolve(args["playwright-module"]))
    // The forwarding proxy enforces the origin before a network connection. Browser
    // routing alone does not intercept every transport (notably WebSockets).
    proxy = await startProxy(new Set([base.origin]), (target, transport) => {
      let origin = "invalid"
      try { origin = new URL(target).origin } catch {}
      // Chromium's own updater/autofill requests also pass through this proxy.
      // Retain every denial, but attribute application requests through the
      // context route and page WebSocket events rather than browser services.
      report.proxyBlocks.push({ origin, transport })
    })
    browser = await playwright.chromium.launch({ executablePath: path.resolve(args.chrome), headless: true,
      proxy: { server: proxy.url },
      args: ["--proxy-bypass-list=<-loopback>", "--no-first-run", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps"] })
    context = await browser.newContext({ viewport: { width: 1365, height: 900 }, acceptDownloads: true, serviceWorkers: "block" })
    await context.route("**/*", route => {
      const url = new URL(route.request().url())
      if (url.origin === base.origin || url.protocol === "data:" || url.protocol === "blob:") return route.continue()
      report.blockedRequests.push({ origin: url.origin, resourceType: route.request().resourceType() })
      return route.abort("blockedbyclient")
    })
    page = await context.newPage()
    page.setDefaultTimeout(8000)
    page.on("pageerror", error => report.consoleErrors.push(String(error.message).slice(0, 500)))
    page.on("console", message => { if (message.type() === "error" && !message.text().includes("status of 4")) report.consoleErrors.push(message.text().slice(0, 500)) })
    page.on("response", response => {
      const url = new URL(response.url())
      if (url.origin === base.origin && !url.pathname.startsWith("/api/") && response.status() >= 400) report.consoleErrors.push("Local asset HTTP " + response.status() + ": " + url.pathname)
    })
    page.on("popup", popup => popup.close().catch(() => {}))
    page.on("websocket", socket => {
      const url = new URL(socket.url())
      url.protocol = url.protocol === "ws:" ? "http:" : "https:"
      if (url.origin !== base.origin) report.blockedRequests.push({ origin: url.origin, resourceType: "websocket" })
    })
    await page.goto(base.origin, { waitUntil: "networkidle" })

    await check("navigation_actor", [], async () => {
      for (const name of ["Overview", "Projects", "Runbooks", "Releases", "Jobs", "Incidents", "Audit"]) {
        assert(await page.getByRole("link", { name, exact: true }).count() >= 1, "missing navigation " + name)
      }
      await actor("operator"); await nav("Overview")
    })
    await check("project_create", ["navigation_actor"], async () => {
      await nav("Projects"); await button("New project")
      await field("Project name", "UI Borealis"); await field("Project slug", "ui-borealis"); await field("Project description", "Synthetic browser operations")
      await button("Save project")
      state.project = (await eventually(() => read("/api/projects"), body => body.projects.some(p => p.slug === "ui-borealis"), "UI project not persisted")).projects.find(p => p.slug === "ui-borealis")
      await visible("UI Borealis")
    })
    await check("project_edit_search", ["project_create"], async () => {
      await nav("Projects"); await field("Search projects", "BOREALIS"); await link("UI Borealis")
      await button("Edit project"); await field("Project description", "Edited synthetic description"); await button("Save project")
      const data = await eventually(() => read("/api/projects/" + state.project.id), body => body.project.description === "Edited synthetic description", "project edit not persisted")
      assert(data.project.description === "Edited synthetic description", "project edit did not persist")
      await page.getByRole("link", { name: "Export project", exact: true }).waitFor({ state: "visible" })
    })
    await check("environment_create_edit", ["project_create"], async () => {
      await nav("Projects"); await link("UI Borealis"); await button("New environment")
      await field("Environment name", "UI Production"); await page.getByLabel("Protected environment", { exact: true }).check(); await button("Save environment")
      state.prod = (await eventually(() => read(p("environments")), body => body.environments.some(e => e.name === "UI Production"), "environment missing")).environments.find(e => e.name === "UI Production")
      assert(state.prod.protected === true, "protected checkbox not persisted")
      await button("New environment"); await field("Environment name", "UI Preview"); await button("Save environment")
      state.stage = (await eventually(() => read(p("environments")), body => body.environments.some(e => e.name === "UI Preview"), "preview environment not persisted")).environments.find(e => e.name === "UI Preview")
      await button("Edit environment UI Preview"); await field("Environment name", "UI Staging"); await button("Save environment")
      await eventually(() => read(p("environments", state.stage.id)), body => body.environment.name === "UI Staging", "environment edit did not persist")
    })
    await check("runbook_create_steps", ["environment_create_edit"], async () => {
      await nav("Runbooks"); await project(); await button("New runbook")
      await field("Runbook name", "UI Safe Pipeline"); await field("Runbook description", "Three connected steps")
      await fillStep(1, "verify"); await button("Add step"); await fillStep(2, "bundle", "verify", "never", "300", "build")
      await button("Add step"); await fillStep(3, "deploy", "bundle", "never", "300", "deploy"); await button("Save runbook")
      state.runbook = (await eventually(() => read(p("runbooks")), body => body.runbooks.some(r => r.name === "UI Safe Pipeline"), "runbook missing")).runbooks.find(r => r.name === "UI Safe Pipeline")
      assert(state.runbook.steps.length === 3 && state.runbook.steps[2].dependsOn[0] === "bundle", "structured DAG did not persist")
    })
    await check("runbook_cycle_validation", ["runbook_create_steps"], async () => {
      await nav("Runbooks"); await project(); await button("New runbook"); await field("Runbook name", "UI Invalid Cycle")
      await fillStep(1, "loop-a", "loop-b"); await button("Add step"); await fillStep(2, "loop-b", "loop-a"); await button("Save runbook")
      await page.getByRole("alert").first().waitFor({ state: "visible" })
      assert(await page.getByLabel("Runbook name", { exact: true }).inputValue() === "UI Invalid Cycle", "validation cleared runbook form")
      assert(!(await read(p("runbooks"))).runbooks.some(r => r.name === "UI Invalid Cycle"), "invalid cycle was persisted")
    })
    await check("runbook_version_edit", ["runbook_create_steps"], async () => {
      await nav("Runbooks"); await project(); await link("UI Safe Pipeline"); await button("Edit runbook")
      await field("Runbook description", "Version two synthetic plan"); await button("Save runbook")
      state.runbook = (await eventually(() => read(p("runbooks", state.runbook.id)), body => body.runbook.version === 2, "runbook edit not persisted")).runbook
      assert(state.runbook.version === 2 && state.runbook.steps.length === 3, "runbook version/steps not preserved")
      await eventually(() => page.locator("body").innerText(), text => /version\D{0,12}2\b/i.test(text), "runbook version not visible")
    })
    await check("release_create_snapshot", ["runbook_version_edit"], async () => {
      state.release = await newRelease("UI Aurora Release", "ui-aurora-v1", state.runbook.id)
      assert(state.release.runbookVersion === 2 && state.release.steps.length === 3 && state.release.status === "draft", "release not created from runbook snapshot")
      await visible("ui-aurora-v1"); await visible("verify")
    })
    await check("release_draft_edit", ["release_create_snapshot"], async () => {
      await openRelease(state.release); await button("Edit release"); await field("Release notes", "UI draft notes updated"); await button("Save release")
      state.release = (await eventually(() => read(p("releases", state.release.id)), body => body.release.revision === 2 && body.release.notes === "UI draft notes updated", "draft edit not persisted")).release
      assert(state.release.revision === 2 && state.release.notes === "UI draft notes updated", "draft revision edit not persisted")
    })
    await check("release_submit", ["release_draft_edit"], async () => {
      await openRelease(state.release); await button("Submit for approval")
      await releaseStatus(state.release, "awaiting_approval"); await visibleStatus("awaiting_approval")
      assert(await page.getByRole("button", { name: "Edit release", exact: true }).count() === 0 || await page.getByRole("button", { name: "Edit release", exact: true }).isDisabled(), "submitted plan editor remains available")
    })
    await check("approval_role_switch", ["release_submit"], async () => {
      const approval = page.getByRole("button", { name: "Approve release", exact: true })
      assert(await approval.count() === 0 || await approval.isDisabled(), "operator can approve via UI")
      await actor("admin"); await openRelease(state.release); await page.getByRole("button", { name: "Approve release", exact: true }).waitFor({ state: "visible" })
    })
    await check("release_approve", ["approval_role_switch"], async () => {
      await button("Approve release"); await field("Approval comment", "UI independent approval"); await button("Confirm approve")
      await releaseStatus(state.release, "ready"); await visible("UI independent approval")
    })
    await check("release_run_live_jobs", ["release_approve"], async () => {
      await button("Run release")
      await eventually(() => read(p("releases", state.release.id) + "/jobs"), body => body.jobs.length === 3, "UI run admitted no jobs")
      state.release = await releaseStatus(state.release, "succeeded")
      await eventually(() => page.locator("body").innerText(), text => text.toLowerCase().includes("succeeded") && text.includes("verify"), "live release UI did not update")
      assert((await read(p("environments", state.prod.id))).environment.activeReleaseId === state.release.id, "successful release not active")
    })
    await check("release_artifact_download", ["release_run_live_jobs"], async () => {
      const artifacts = (await read(p("releases", state.release.id) + "/artifacts")).artifacts
      assert(artifacts.length === 3, "release artifacts absent")
      const artifact = artifacts[0]
      await page.getByRole("link", { name: "Download " + artifact.name, exact: true }).waitFor({ state: "visible" })
      const downloadWait = page.waitForEvent("download"); await link("Download " + artifact.name); const download = await downloadWait
      const target = path.join(out, "browser-artifact.txt"); await download.saveAs(target)
      const bytes = await fs.readFile(target)
      assert(bytes.length === artifact.size && crypto.createHash("sha256").update(bytes).digest("hex") === artifact.sha256, "browser artifact differs from metadata")
      assert(bytes.includes(Buffer.from(state.release.versionLabel)), "browser downloaded wrong release")
    })
    await check("job_log_detail", ["release_run_live_jobs"], async () => {
      await link("View jobs")
      const jobs = (await read(p("releases", state.release.id) + "/jobs")).jobs
      await link(jobs[0].name)
      await visible("started"); await visible("succeeded")
      assert((await page.locator("body").innerText()).toLowerCase().includes("attempt"), "job attempts not displayed")
    })
    await check("release_deep_link_reload", ["release_run_live_jobs"], async () => {
      await openRelease(state.release); const url = page.url(); await page.reload({ waitUntil: "networkidle" })
      assert(page.url() === url, "detail URL changed after reload"); await visible("UI Aurora Release"); await visible("ui-aurora-v1")
    })
    await check("failure_runbook_create", ["environment_create_edit"], async () => {
      await actor("operator"); await nav("Runbooks"); await project(); await button("New runbook")
      await field("Runbook name", "UI Retry Pipeline"); await fillStep(1, "flaky", "", "once")
      await button("Add step"); await fillStep(2, "after-flaky", "flaky"); await button("Save runbook")
      state.retryBook = (await eventually(() => read(p("runbooks")), body => body.runbooks.some(r => r.name === "UI Retry Pipeline"), "failure runbook not persisted")).runbooks.find(r => r.name === "UI Retry Pipeline")
      assert(state.retryBook && state.retryBook.steps[0].failureMode === "once", "failure mode not persisted")
    })
    await check("failure_release_run", ["failure_runbook_create"], async () => {
      state.retry = await newRelease("UI Retry Release", "ui-retry-v1", state.retryBook.id, state.stage.id)
      await button("Submit for approval"); await releaseStatus(state.retry, "ready"); await button("Run release")
      await releaseStatus(state.retry, "failed"); await eventually(() => page.locator("body").innerText(), text => text.toLowerCase().includes("failed") && text.toLowerCase().includes("blocked"), "failure/blocked state absent from UI")
    })
    await check("failure_retry", ["failure_release_run"], async () => {
      await button("Retry release"); await releaseStatus(state.retry, "succeeded")
      const jobs = (await read(p("releases", state.retry.id) + "/jobs")).jobs
      assert(jobs.find(j => j.stepKey === "flaky").attempts === 2, "retry attempts did not increment")
      await eventually(() => page.locator("body").innerText(), text => text.toLowerCase().includes("succeeded"), "retry success not live")
    })
    await check("second_release_success", ["release_run_live_jobs"], async () => {
      await actor("operator"); state.second = await newRelease("UI Aurora Followup", "ui-aurora-v2", state.runbook.id)
      await submitApproveRun(state.second)
      state.second = (await read(p("releases", state.second.id))).release
      assert(state.second.previousReleaseId === state.release.id, "second release lost active predecessor")
    })
    await check("rollback_restore_active", ["second_release_success"], async () => {
      await button("Rollback release"); await field("Action reason", "UI synthetic regression"); await button("Confirm rollback")
      await releaseStatus(state.second, "rolled_back")
      assert((await read(p("environments", state.prod.id))).environment.activeReleaseId === state.release.id, "rollback did not restore predecessor")
      await visibleStatus("rolled_back")
    })
    await check("incident_create_link", ["release_run_live_jobs"], async () => {
      await actor("operator"); await nav("Incidents"); await project(); await button("New incident")
      await field("Incident title", "UI Synthetic Latency"); await select("Incident environment", state.prod.id); await select("Related release", state.release.id)
      await select("Severity", "sev2"); await field("Incident summary", "Synthetic latency after release"); await button("Save incident")
      state.incident = (await eventually(() => read(p("incidents")), body => body.incidents.some(i => i.title === "UI Synthetic Latency"), "incident missing")).incidents.find(i => i.title === "UI Synthetic Latency")
      assert(state.incident.releaseId === state.release.id, "incident release link not persisted")
      await page.getByRole("link", { name: state.release.title, exact: true }).waitFor({ state: "visible" })
    })
    await check("incident_note_timeline", ["incident_create_link"], async () => {
      await field("Incident note", "UI diagnostic note is durable"); await button("Add note"); await visible("UI diagnostic note is durable")
      const notes = (await eventually(() => read(p("incidents", state.incident.id) + "/notes"), body => body.notes.some(n => n.body === "UI diagnostic note is durable"), "UI note did not persist")).notes
      assert(notes.some(n => n.body === "UI diagnostic note is durable"), "UI note did not persist")
      await page.reload({ waitUntil: "networkidle" }); await visible("UI diagnostic note is durable")
    })
    await check("incident_resolve", ["incident_create_link"], async () => {
      await button("Edit incident"); await select("Incident status", "resolved"); await field("Resolution", "UI rollback verified"); await button("Save incident")
      state.incident = (await eventually(() => read(p("incidents", state.incident.id)), body => body.incident.status === "resolved" && body.incident.resolvedAt, "incident resolution not persisted")).incident
      assert(state.incident.status === "resolved" && state.incident.resolvedAt, "incident resolution not persisted")
      await visible("resolved"); await visible("UI rollback verified")
    })
    await check("incident_reopen_filter", ["incident_resolve"], async () => {
      await button("Edit incident"); await select("Incident status", "open"); await button("Save incident")
      await eventually(() => read(p("incidents", state.incident.id)), body => body.incident.status === "open" && body.incident.resolvedAt === null, "reopen timestamp not cleared")
      await nav("Incidents"); await project(); await field("Search incidents", "SYNTHETIC"); await select("Incident status filter", "open"); await select("Severity filter", "sev2")
      await page.getByRole("link", { name: "UI Synthetic Latency", exact: true }).waitFor({ state: "visible" })
    })
    await check("audit_filter", ["project_create"], async () => {
      await nav("Audit"); await project()
      const events = (await read("/api/audit?projectId=" + state.project.id)).events
      const event = events.find(e => /incident/.test(e.type)) || events[0]
      const filter = page.getByLabel("Audit type", { exact: true })
      if (await filter.evaluate(element => element.tagName === "SELECT")) await select("Audit type", event.type)
      else await field("Audit type", event.type)
      await visible(event.type)
      await screenshot("desktop-audit")
    })
    await check("viewer_restrictions", ["project_create"], async () => {
      await actor("viewer"); await nav("Projects")
      const create = page.getByRole("button", { name: "New project", exact: true })
      assert(await create.count() === 0 || await create.isDisabled(), "viewer project mutation enabled")
      await nav("Releases"); await project()
      const release = page.getByRole("button", { name: "New release", exact: true })
      assert(await release.count() === 0 || await release.isDisabled(), "viewer release mutation enabled")
      assert(await page.getByLabel("Actor", { exact: true }).inputValue() === "viewer", "viewer actor is not selected")
    })
    await check("escaped_user_text", ["project_create"], async () => {
      await actor("operator"); await nav("Projects"); await link("UI Borealis"); await button("Edit project")
      const literal = '<img src=x onerror="window.__harborInjected=1">'
      await field("Project description", literal); await button("Save project"); await visible(literal)
      assert(await page.evaluate(() => window.__harborInjected === undefined), "user text executed as HTML")
    })
    await check("inline_error_preserves_form", ["project_create"], async () => {
      await actor("operator"); await nav("Projects"); await button("New project")
      await field("Project name", "UI duplicate slug preserved"); await field("Project slug", "ui-borealis"); await button("Save project")
      await page.getByRole("alert").first().waitFor({ state: "visible" })
      assert(await page.getByLabel("Project name", { exact: true }).inputValue() === "UI duplicate slug preserved", "error lost entered values")
      assert(await page.getByLabel("Project slug", { exact: true }).inputValue() === "ui-borealis", "error lost slug")
    })
    await check("keyboard_focus", ["navigation_actor"], async () => {
      await nav("Overview"); await page.getByLabel("Actor", { exact: true }).focus(); await page.keyboard.press("Tab")
      const focus = await page.evaluate(() => {
        const element = document.activeElement
        if (!element || element === document.body) return { valid: false }
        const style = getComputedStyle(element)
        return { valid: ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(element.tagName) || element.tabIndex >= 0,
          visible: element.getBoundingClientRect().width > 0, outlined: style.outlineStyle !== "none" || style.boxShadow !== "none" }
      })
      assert(focus.valid && focus.visible && focus.outlined, "keyboard focus is absent, invisible or unmarked")
    })
    await check("mobile_layout", ["release_run_live_jobs"], async () => {
      await page.setViewportSize({ width: 390, height: 844 }); await openRelease(state.release)
      await visible("UI Aurora Release")
      const dimensions = await page.evaluate(() => ({ inner: innerWidth, scroll: document.documentElement.scrollWidth }))
      assert(dimensions.scroll <= dimensions.inner + 2, "page-wide horizontal overflow at 390px")
      for (const name of ["Overview", "Projects", "Releases", "Jobs", "Incidents", "Audit"]) {
        const navLink = page.getByRole("link", { name, exact: true }).first()
        await navLink.scrollIntoViewIfNeeded(); assert(await navLink.isVisible(), "mobile navigation unreachable " + name)
      }
      await screenshot("mobile-release")
      await page.setViewportSize({ width: 1365, height: 900 })
    })
    await check("console_local_assets", ["navigation_actor"], async () => {
      assert(report.consoleErrors.length === 0, "browser console/page errors: " + report.consoleErrors.join(" | "))
      assert(report.blockedRequests.length === 0, "application requested external assets/services")
      await nav("Overview"); await screenshot("desktop-overview")
    })
  } catch (error) {
    await fs.writeFile(path.join(out, "instrument-error.log"), String(error.stack || error) + "\n")
    report.instrumentError = String(error.stack || error).slice(0, 1800)
  } finally {
    await browser?.close().catch(() => {})
    if (proxy) await proxy.close()
    await write()
  }
  process.exitCode = report.instrumentError ? 2 : report.checks.every(row => row.status === "passed") ? 0 : 1
})().catch(async error => { report.instrumentError = String(error); await write(); process.exitCode = 2 })
