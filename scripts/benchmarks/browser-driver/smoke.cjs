"use strict"

const assert = require("node:assert/strict")
const http = require("node:http")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawn, execFile } = require("node:child_process")
const { promisify } = require("node:util")
const { createInterface } = require("node:readline")

const execute = promisify(execFile)

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return "http://127.0.0.1:" + server.address().port
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name) => {
    const index = args.indexOf(name)
    return index < 0 ? undefined : args[index + 1]
  }
  if (!option("--playwright-module") || !option("--chrome"))
    throw new Error("Use --playwright-module <package> --chrome <executable> [--out <new-directory>].")
  const out = option("--out")
    ? path.resolve(option("--out"))
    : await fs.mkdtemp(path.join(os.tmpdir(), "vector-browser-smoke-"))
  await fs.mkdir(out, { recursive: true })
  const token = crypto.randomBytes(24).toString("hex")
  const checks = []
  let deniedRequests = 0
  const denied = http.createServer((_, response) => {
    deniedRequests++
    response.end("unexpected request")
  })
  denied.on("upgrade", (_, socket) => {
    deniedRequests++
    socket.destroy()
  })
  const deniedOrigin = await listen(denied)
  const app = http.createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: deniedOrigin + "/redirect-target" })
      response.end()
      return
    }
    response.setHeader("Content-Type", "text/html")
    if (["/layout-wide", "/layout-contained"].includes(request.url)) {
      response.end(`<!doctype html><html><head><title>Owned layout fixture</title><style>html,body{margin:0;padding:0}body{min-height:1400px}h1{margin:0}.wrapper{width:100%;${request.url === "/layout-contained" ? "overflow-x:auto" : ""}}table{width:548px;min-width:548px}td{height:40px}</style></head><body><main><h1>Layout fixture</h1><div class="wrapper"><table><tr><td>Wide table</td></tr></table></div></main></body></html>`)
      return
    }
    if (request.url === "/focus") {
      response.end(
        '<!doctype html><html><head><title>Owned focus fixture</title></head><body><main><label>Focus text <input type="text"></label><label>Password <input type="password" value="private-focus-fixture"></label><button>Last control</button></main></body></html>',
      )
      return
    }
    response.end(`<!doctype html><html><head><title>Owned browser fixture</title></head><body><main>
      <h1>Workflow fixture</h1><form id="form"><label>Researcher <input name="researcher" required></label>
      <label>Status <select name="status"><option value="draft">Draft</option><option value="done">Done</option></select></label>
      <button>Save</button></form><p id="result" role="status">Ready</p>
      <button type="button">Duplicate</button><button type="button">Duplicate</button>
      <a href="${deniedOrigin}/external">External link</a>
      ${request.url === "/many" ? Array.from({ length: 250 }, (_, i) => `<button type="button">Item ${i}</button>`).join("") : ""}
      </main><script>document.querySelector('#form').addEventListener('submit', event => {event.preventDefault(); const data=new FormData(event.target); document.querySelector('#result').textContent='Saved '+data.get('researcher')+' / '+data.get('status')});console.log('fixture-ready');fetch('${deniedOrigin}/blocked-fetch').catch(()=>{});new WebSocket('${deniedOrigin.replace("http:", "ws:")}/blocked-socket').addEventListener('error',()=>{});</script></body></html>`)
  })
  const appOrigin = await listen(app)
  const driver = spawn(
    process.execPath,
    [
      path.join(__dirname, "server.cjs"),
      "--playwright-module",
      option("--playwright-module"),
      "--chrome",
      option("--chrome"),
      "--out",
      path.join(out, "driver"),
      "--allow-origin",
      appOrigin,
      "--token-stdin",
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  )
  driver.stdin.end(token + "\n")
  let stderr = ""
  driver.stderr.on("data", (chunk) => {
    stderr += chunk
  })
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Driver startup timed out: " + stderr.slice(0, 300))), 20_000)
      driver.once("error", reject)
      driver.once("exit", (code) => {
        clearTimeout(timer)
        reject(new Error("Driver exited during startup: " + code + ": " + stderr.slice(0, 300)))
      })
      const lines = createInterface({ input: driver.stdout })
      lines.once("line", (line) => {
        clearTimeout(timer)
        try {
          resolve(JSON.parse(line))
        } catch (error) {
          reject(error)
        }
      })
    })
    async function call(action, ok = true) {
      let output
      try {
        output = await execute(
          process.execPath,
          [
            path.join(__dirname, "client.cjs"),
            "--endpoint",
            ready.endpoint,
            "--token-env",
            "BENCH_BROWSER_TOKEN",
            JSON.stringify(action),
          ],
          {
            env: { ...process.env, BENCH_BROWSER_TOKEN: token },
            windowsHide: true,
            timeout: 30_000,
            maxBuffer: 100_000,
          },
        )
      } catch (error) {
        if (ok) throw error
        output = error
        assert.equal(error.code, 1)
      }
      const parsed = JSON.parse(output.stdout)
      assert.equal(parsed.ok, ok)
      assert.ok(Buffer.byteLength(output.stdout) < 64_000)
      return parsed
    }
    let state = await call({ action: "open", url: appOrigin })
    assert.ok(state.snapshot.text.includes("Workflow fixture"))
    checks.push("real browser opens owned fixture and observes semantic controls")
    const oldRef = state.snapshot.controls.find((item) => item.name === "Researcher").ref
    state = await call({ action: "type", ref: oldRef, text: "Jordan" })
    assert.equal(state.snapshot.controls.find((item) => item.name === "Researcher").value, "Jordan")
    checks.push("reference fill updates live DOM")
    const stale = await call({ action: "type", ref: oldRef, text: "wrong" }, false)
    assert.match(stale.error, /Stale/)
    assert.ok(stale.snapshot)
    checks.push("stale references fail with fresh observation")
    state = await call({ action: "select", role: "combobox", name: "Status", values: ["done"] })
    state = await call({ action: "click", role: "button", name: "Save" })
    assert.ok(state.snapshot.text.includes("Saved Jordan / done"))
    checks.push("exact role and name selection and submit reach real app state")
    const ambiguous = await call({ action: "click", role: "button", name: "Duplicate" }, false)
    assert.match(ambiguous.error, /ambiguous/)
    checks.push("ambiguous role and name never chooses arbitrary match")
    await call({ action: "press", key: "Tab" })
    await call({ action: "press", key: "Control+V" }, false)
    checks.push("safe keyboard action works and clipboard shortcut is refused")
    await call({ action: "viewport", width: 390, height: 844 })
    const image = await call({ action: "screenshot", filename: "mobile.png" })
    assert.equal(image.result.viewport.width, 390)
    assert.equal(image.result.viewport.height, 844)
    assert.ok(
      (await fs.readFile(image.result.file)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    )
    checks.push("mobile screenshot is an owned PNG file without base64 output")
    await call({ action: "screenshot", filename: "../escape.png" }, false)
    checks.push("screenshot traversal is refused")
    const logs = await call({ action: "console" })
    assert.ok(logs.result.entries.some((item) => item.text.includes("fixture-ready")))
    checks.push("console diagnostics are available")
    await call({ action: "open", url: deniedOrigin }, false)
    await call({ action: "open", url: appOrigin + "/redirect" }, false)
    await call({ action: "open", url: appOrigin })
    assert.equal(deniedRequests, 0)
    checks.push("external origin, redirected requests, fetch and websocket never reach denied server")
    const many = await call({ action: "open", url: appOrigin + "/many" })
    assert.ok(many.snapshot.controlsTruncated)
    assert.ok(many.snapshot.controls.length <= 80)
    checks.push("large control inventory is bounded")
    state = await call({ action: "open", url: appOrigin + "/focus" })
    state = await call({ action: "click", role: "textbox", name: "Focus text" })
    const focused = (snapshot, name) => {
      assert.equal(snapshot.focus.documentHasFocus, true)
      assert.equal(snapshot.focus.activeKind, "control")
      assert.equal(snapshot.focus.tag, "input")
      assert.equal(snapshot.focus.tabIndex, 0)
      assert.equal(snapshot.controls.find((item) => item.ref === snapshot.focus.focusedRef)?.name, name)
    }
    focused(state.snapshot, "Focus text")
    state = await call({ action: "observe" })
    focused(state.snapshot, "Focus text")
    checks.push("focused input metadata uses a current ref and observe preserves focus")
    state = await call({ action: "click", role: "textbox", name: "Password" })
    focused(state.snapshot, "Password")
    assert.equal(state.snapshot.focus.type, "password")
    assert.ok(!JSON.stringify(state.snapshot).includes("private-focus-fixture"))
    state = await call({ action: "observe" })
    focused(state.snapshot, "Password")
    assert.ok(!JSON.stringify(state.snapshot).includes("private-focus-fixture"))
    checks.push("focused password metadata and observations never expose its value")
    await call({ action: "click", role: "button", name: "Last control" })
    await call({ action: "viewport", width: 390, height: 844 })
    state = await call({ action: "press", key: "Tab" })
    assert.equal(state.snapshot.focus.documentHasFocus, false)
    assert.equal(state.snapshot.focus.activeKind, "body")
    assert.equal(state.snapshot.focus.focusedRef, undefined)
    state = await call({ action: "observe" })
    assert.equal(state.snapshot.focus.documentHasFocus, false)
    assert.equal(state.snapshot.focus.activeKind, "body")
    state = await call({ action: "press", key: "Tab" })
    focused(state.snapshot, "Focus text")
    checks.push("Tab leaving and re-entering the document is observed without changing focus")
    for (const contained of [false, true]) {
      state = await call({ action: "open", url: appOrigin + (contained ? "/layout-contained" : "/layout-wide") })
      assert.equal(state.snapshot.untrustedPageData, true)
      assert.equal(state.snapshot.layout.viewportWidth, 390)
      assert.equal(state.snapshot.layout.viewportHeight, 844)
      assert.equal(state.snapshot.layout.documentWidth, contained ? 390 : 548)
      assert.equal(state.snapshot.layout.documentHeight, 1400)
      assert.equal(Math.max(0, state.snapshot.layout.documentWidth - state.snapshot.layout.viewportWidth), contained ? 0 : 158)
      const previous = state.snapshot.layout
      state = await call({ action: "observe" })
      assert.deepEqual(state.snapshot.layout, previous)
      assert.equal(state.snapshot.untrustedPageData, true)
      checks.push(contained ? "contained scrolling table does not report document overflow" : "uncontained table reports 158px document overflow at viewport390")
    }
    const unauthorized = await new Promise((resolve, reject) => {
      http
        .get(ready.endpoint + "/health", { headers: { Authorization: "Bearer invalid" } }, (response) => {
          response.resume()
          resolve(response.statusCode)
        })
        .on("error", reject)
    })
    assert.equal(unauthorized, 401)
    checks.push("missing valid local token cannot access driver")
    const report = {
      passed: checks.length,
      failed: 0,
      checks,
      deniedServerRequests: deniedRequests,
      providerCalls: 0,
      cloudActions: 0,
    }
    await fs.writeFile(path.join(out, "smoke-results.json"), JSON.stringify(report, null, 2) + "\n")
    process.stdout.write(JSON.stringify({ ...report, output: out }) + "\n")
  } finally {
    driver.kill("SIGTERM")
    await new Promise((resolve) => {
      if (driver.exitCode !== null) resolve()
      else {
        driver.once("exit", resolve)
        setTimeout(resolve, 5000).unref()
      }
    })
    app.closeAllConnections()
    denied.closeAllConnections()
    await Promise.all([new Promise((resolve) => app.close(resolve)), new Promise((resolve) => denied.close(resolve))])
  }
}

main().catch((error) => {
  process.stderr.write(error.stack + "\n")
  process.exitCode = 1
})
