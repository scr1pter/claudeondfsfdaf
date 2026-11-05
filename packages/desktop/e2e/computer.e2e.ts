import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { createServer, type ServerResponse } from "node:http"
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Hands } from "@vectordevai/schema/hands"
import type { ElectronAPI } from "../src/preload/types"

type FixtureWindow = Window & { api: ElectronAPI }
type ModelRequest = {
  stream?: boolean
  messages?: { role?: string; tool_call_id?: string; content?: unknown }[]
  tools?: { function?: { name?: string } }[]
}

const directory = fileURLToPath(new URL("../", import.meta.url))
const marker = "VECTOR_HANDS_E2E_VIRTUAL_BANK"
const dock = '[data-component="dock-prompt"][data-kind="permission"]'

test("Linux reports its actual unsupported Hands platform in the dev Electron", async () => {
  test.skip(process.platform !== "linux", "This assertion concerns the actual Linux product platform.")
  await desktop(async ({ page, model }) => {
    const status = await page.evaluate(() => (window as FixtureWindow).api.computer.status())
    expect(status.available).toBe(false)
    expect(status.reason).toBe("unsupported_os")
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const settings = page.locator(".settings-v2-workspace")
    await expect(settings).toBeVisible()
    await settings.getByRole("tab", { name: Hands.NAME, exact: true }).click()
    await expect(settings).toContainText("Linux")
    expect(model.computerCalls).toBe(0)
  })
})

test("Hands onboarding, app approval, sensitive approval and UI Stop use the real dev app and engine", async () => {
  test.skip(
    process.platform !== "darwin" && process.platform !== "win32",
    "The product does not support Hands on Linux; the preceding test asserts that actual state.",
  )
  await desktop(async ({ page, model, json, newSession, closeMainWithOverlays }) => {
    const status = await page.evaluate(() => (window as FixtureWindow).api.computer.status())
    // An identified product prerequisite can skip this virtual UI lane. A missing build, unknown
    // helper failure, broken onboarding or failed assertion must remain a failure.
    test.skip(
      !status.available && (status.reason === "unsupported_os" || status.reason === "elevated"),
      "The actual product reported an unsupported OS or administrator process.",
    )
    expect(status.available || status.reason === "permissions").toBe(true)

    const composer = page.locator('[data-component="prompt-input"]').filter({ visible: true }).first()
    await expect(composer).toBeVisible()
    await composer.pressSequentially(`@${Hands.MENTION}`)
    await page.locator('[data-computer-row="feature"]').click()
    const onboarding = page.locator('[data-component="computer-onboarding"]')
    await expect(onboarding).toBeVisible()
    await onboarding.getByRole("button", { name: `Turn on ${Hands.NAME}`, exact: true }).click()
    if (process.platform === "darwin") {
      await expect(onboarding.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible()
      await onboarding.getByRole("button", { name: "Check again", exact: true }).click()
      await onboarding.getByRole("button", { name: "Continue", exact: true }).click()
    }
    await expect(onboarding.getByRole("heading", { name: "Try it", exact: true })).toBeVisible()
    await onboarding.getByRole("button", { name: "Finish", exact: true }).click()
    await expect(onboarding).toHaveCount(0)
    await expect
      .poll(async () => (await page.evaluate(() => (window as FixtureWindow).api.computer.prefs())).prefs.enabled)
      .toBe(true)
    await expect
      .poll(async () => (await page.evaluate(() => (window as FixtureWindow).api.computer.status())).available)
      .toBe(true)
    // The real engine caches its bridge capability read for 30 seconds. Observe its actual
    // refreshed availability rather than mutating that cache or submitting against stale facts.
    await expect
      .poll(
        async () =>
          ((await json("/experimental/capabilities")) as { computer?: { available?: boolean } }).computer?.available,
        { timeout: 35_000 },
      )
      .toBe(true)

    await composer.focus()
    await composer.press("End")
    await composer.pressSequentially(` ${marker}: inspect Northwind Bank and click its Send payment button.`)
    await composer.press("Enter")
    const appAsk = page.locator(dock)
    await expect(
      appAsk.getByRole("heading", { name: `Allow ${Hands.NAME} to use Northwind Bank?`, exact: true }),
    ).toBeVisible()
    await expect(appAsk.getByRole("button", { name: "Always allow", exact: true })).toHaveCount(0)
    await appAsk.getByRole("button", { name: "Allow", exact: true }).click()

    const sensitive = page.locator(dock)
    await expect(sensitive.getByRole("heading")).toContainText("Send payment")
    await expect(sensitive.getByRole("heading")).toContainText("Northwind Bank")
    await expect(sensitive.getByRole("button", { name: "Always allow", exact: true })).toHaveCount(0)
    const allow = sensitive.getByRole("button", { name: "Allow once", exact: true })
    await allow.focus()
    await allow.press("Enter")
    await expect(sensitive).toBeVisible()
    expect(model.clickResultSeen).toBe(false)
    await allow.click()
    await expect.poll(() => model.clickResultSeen).toBe(true)
    expect(model.screenshotResultSeen).toBe(true)
    expect(model.computerCalls).toBe(2)
    const sessionID = await page.evaluate(() =>
      (window as FixtureWindow).api.computer.state().then((state) => state.holder?.sessionID),
    )
    if (typeof sessionID !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionID))
      throw new Error("The controlled computer task has no actual session scope.")
    const messages = (await json(`/session/${sessionID}/message`)) as {
      parts?: {
        type?: string
        tool?: string
        state?: { status?: string; metadata?: { action?: string; code?: unknown }; attachments?: { mime?: string }[] }
      }[]
    }[]
    const tools = messages
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === "tool" && part.tool === "computer")
    expect(
      tools.length === 2 &&
        tools[0]?.state?.metadata?.action === "screenshot" &&
        tools[1]?.state?.metadata?.action === "click",
    ).toBe(true)
    expect(
      tools.every(
        (part) =>
          part.state?.status === "completed" &&
          part.state.metadata?.code === undefined &&
          part.state.attachments?.some((file) => file.mime === "image/png"),
      ),
    ).toBe(true)

    // Playwright's renderer click tests the actual product UI/controller/engine integration.
    // The separate overlay smoke supplies independently observed native OS Stop evidence.
    await page.locator("[data-vector-bg-tasks-launch]").filter({ visible: true }).first().click()
    const holder = page.locator('#vector-bg-tasks [data-computer-card="holder"]')
    await expect(holder.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
    await holder.getByRole("button", { name: "Stop", exact: true }).click()
    await expect
      .poll(async () => !!(await page.evaluate(() => (window as FixtureWindow).api.computer.state())).holder)
      .toBe(false)
    await expect.poll(async () => ((await json("/permission")) as unknown[]).length).toBe(0)
    await expect.poll(() => model.heldResponseClosed).toBe(true)
    expect(model.failed).toBe(false)

    // Start a distinct real task so its real registered overlays are present when the main
    // window closes. The index.ts/window registry wiring, rather than a manually emitted event,
    // must deliver window-all-closed while those overlay BrowserWindows remain.
    await newSession()
    const secondComposer = page.locator('[data-component="prompt-input"]').filter({ visible: true }).first()
    await secondComposer.pressSequentially(`@${Hands.MENTION}`)
    await page.locator('[data-computer-row="feature"]').click()
    await secondComposer.pressSequentially(` ${marker}: inspect the isolated virtual bank for the window-close check.`)
    await secondComposer.press("Enter")
    await expect(
      page.locator(dock).getByRole("heading", { name: `Allow ${Hands.NAME} to use Northwind Bank?`, exact: true }),
    ).toBeVisible()
    await closeMainWithOverlays()
  })
})

/** Every path, helper, model request, profile and engine belongs to this isolated virtual fixture. */
async function desktop(
  run: (fixture: {
    page: Page
    model: ReturnType<typeof fakeModel>
    json: (route: string, body?: Record<string, unknown>) => Promise<unknown>
    newSession: () => Promise<void>
    closeMainWithOverlays: () => Promise<void>
  }) => Promise<void>,
) {
  if (process.versions.bun) throw new Error("Desktop e2e requires an actual Node Playwright host.")
  if (process.env.CI !== "true" && process.env.VECTOR_COMPUTER_TEST_ISOLATED !== "1")
    throw new Error("Desktop e2e requires an explicitly isolated test environment.")
  const require = createRequire(import.meta.url)
  const electronDirectory = path.dirname(require.resolve("electron/package.json"))
  const installed = JSON.parse(await readFile(path.join(electronDirectory, "package.json"), "utf8")) as {
    version?: unknown
  }
  const desktopPackage = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as {
    main?: unknown
    devDependencies?: { electron?: unknown }
  }
  if (typeof installed.version !== "string" || installed.version !== desktopPackage.devDependencies?.electron)
    throw new Error("Desktop e2e requires the repository's exact pinned Electron.")
  const distribution = await realpath(path.join(electronDirectory, "dist"))
  const executablePath = await realpath(
    path.join(distribution, (await readFile(path.join(electronDirectory, "path.txt"), "utf8")).trim()),
  )
  if (!executablePath.startsWith(distribution + path.sep))
    throw new Error("The pinned Electron executable escaped its distribution.")
  if (desktopPackage.main !== "./out/main/index.js")
    throw new Error("The dev app entry changed from the fixed e2e contract.")
  const appPath = await realpath(directory)
  const main = path.join(directory, "out/main/index.js")
  if (!(await lstat(main)).isFile()) throw new Error("Desktop e2e requires the actual prebuilt dev app.")
  const helperPath = process.env.VECTOR_COMPUTER_E2E_FAKE_HELPER
  if (!helperPath || path.basename(helperPath) !== "computer-fake-helper.mjs")
    throw new Error("Desktop e2e requires its explicitly prebuilt virtual helper bundle.")
  const helperInfo = await lstat(helperPath)
  if (!helperInfo.isFile() || helperInfo.isSymbolicLink() || helperInfo.size < 1 || helperInfo.size > 16 * 1024 * 1024)
    throw new Error("The desktop e2e virtual helper bundle is invalid.")
  const helper = await realpath(helperPath)
  const root = await mkdtemp(path.join(tmpdir(), "vector-computer-e2e-"))
  const model = fakeModel()
  let application: ElectronApplication | undefined
  const watchdog = setTimeout(() => {
    model.server.closeAllConnections()
    application?.process().kill("SIGKILL")
  }, 110_000)
  try {
    const project = path.join(root, "project")
    await Promise.all(
      ["home", "data", "config", "cache", "state", "appdata", "localappdata", "tmp", "project"].map((name) =>
        mkdir(path.join(root, name), { recursive: true }),
      ),
    )
    await new Promise<void>((resolve, reject) => {
      model.server.once("error", reject)
      model.server.listen(0, "127.0.0.1", resolve)
    })
    const address = model.server.address()
    if (!address || typeof address === "string") throw new Error("The isolated model did not bind its local endpoint.")
    application = await _electron.launch({
      executablePath,
      args: [
        appPath,
        ...(process.platform === "linux" && process.env.VECTOR_COMPUTER_E2E_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
      ],
      cwd: project,
      timeout: 30_000,
      env: {
        PATH: process.env.PATH ?? "",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        HOME: path.join(root, "home"),
        USERPROFILE: path.join(root, "home"),
        APPDATA: path.join(root, "appdata"),
        LOCALAPPDATA: path.join(root, "localappdata"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        TMPDIR: path.join(root, "tmp"),
        TEMP: path.join(root, "tmp"),
        TMP: path.join(root, "tmp"),
        ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        VECTOR_CONFIG_CONTENT: JSON.stringify(providerConfig(`http://127.0.0.1:${address.port}/v1`)),
        ...(process.platform === "darwin" || process.platform === "win32"
          ? {
              VECTOR_COMPUTER_HELPER_COMMAND: JSON.stringify([
                process.execPath,
                helper,
                "--scenario",
                "sensitive",
                "--platform",
                process.platform === "win32" ? "windows" : "macos",
              ]),
            }
          : {}),
        VECTOR_DISABLE_DEFAULT_PLUGINS: "true",
      },
    })
    expect(await application.evaluate(() => process.versions.electron)).toBe(installed.version)
    expect(
      await application.evaluate(
        ({ app }, input) => {
          const inside = (value: string) => value.startsWith(input.root + "/") || value.startsWith(input.root + "\\")
          return (
            app.getAppPath() === input.appPath &&
            (["home", "appData", "userData", "sessionData"] as const).every((name) => inside(app.getPath(name)))
          )
        },
        { root, appPath },
      ),
    ).toBe(true)
    const page = await application.firstWindow()
    await page.waitForFunction(() => typeof (window as FixtureWindow).api?.awaitInitialization === "function")
    const ready = await page.evaluate(() => (window as FixtureWindow).api.awaitInitialization())
    const endpoint = new URL(ready.url)
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))
      throw new Error("The dev app did not expose an isolated local engine.")
    const authorization =
      ready.username && ready.password
        ? `Basic ${Buffer.from(`${ready.username}:${ready.password}`).toString("base64")}`
        : undefined
    const json = async (route: string, body?: Record<string, unknown>): Promise<unknown> => {
      const response = await fetch(new URL(route, endpoint), {
        method: body ? "POST" : "GET",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "content-type": "application/json",
          "x-vector-directory": encodeURIComponent(project),
          ...(authorization ? { authorization } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (!response.ok) throw new Error("The isolated engine rejected a fixed e2e request.")
      return response.json()
    }
    const newSession = async () => {
      const session = (await json("/session", { title: "Isolated Hands virtual desktop" })) as { id?: unknown }
      if (typeof session.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(session.id))
        throw new Error("The isolated engine did not create its session.")
      const route = `/${Buffer.from(project).toString("base64url")}/session/${session.id}`
      await page.evaluate(
        async ({ route }) => {
          const id = await (window as FixtureWindow).api.getWindowID()
          localStorage.setItem(`vector.desktop.window.${id}.last-active-url`, route)
          localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
          localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
        },
        { route },
      )
      await page.reload()
      await expect(page.locator('[data-component="prompt-input"]').filter({ visible: true }).first()).toBeVisible()
    }
    await newSession()
    const closeMainWithOverlays = async () => {
      if (!application) throw new Error("The controlled Electron process is unavailable.")
      const current = application
      const mainWindow = await current.browserWindow(page)
      const mainID = await mainWindow.evaluate((window) => window.id)
      await expect
        .poll(() =>
          current.evaluate(
            ({ BrowserWindow, session, screen }) =>
              BrowserWindow.getAllWindows().filter(
                (window) =>
                  !window.isDestroyed() && window.webContents.session === session.fromPartition("computer-overlay"),
              ).length >=
              screen.getAllDisplays().length * 4 + 1,
          ),
        )
        .toBe(true)
      const proofFile = path.join(root, "window-close-proof.json")
      await current
        .evaluate(
          ({ app, BrowserWindow, session }, input) => {
            const fs = process.getBuiltinModule("fs")
            if (typeof fs?.writeFileSync !== "function")
              throw new Error("The fixed main-process receipt writer is unavailable.")
            const main = BrowserWindow.fromId(input.mainID)
            if (!main || main.isDestroyed()) throw new Error("The controlled main window is unavailable.")
            const overlaySession = session.fromPartition("computer-overlay")
            app.prependOnceListener("window-all-closed", () => {
              const remaining = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
              fs.writeFileSync(
                input.proofFile,
                JSON.stringify({
                  observed: true,
                  mainClosed: BrowserWindow.fromId(input.mainID) === null,
                  overlaysRemain: remaining.some((window) => window.webContents.session === overlaySession),
                  ordinaryVisible: remaining.some(
                    (window) => window.webContents.session !== overlaySession && window.isVisible(),
                  ),
                }),
                { flag: "wx", mode: 0o600 },
              )
            })
            main.close()
          },
          { mainID, proofFile },
        )
        .catch(() => {
          // Windows may finish its normal quit before the evaluation reply crosses CDP. Only
          // the synchronously written actual event receipt below can establish success.
        })
      await expect
        .poll(async () => {
          const bytes = await readFile(proofFile).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined
            throw error
          })
          if (!bytes) return undefined
          if (bytes.length > 1024) throw new Error("The actual window-close receipt exceeded its fixed bound.")
          return JSON.parse(bytes.toString("utf8")) as unknown
        })
        .toEqual({ observed: true, mainClosed: true, overlaysRemain: true, ordinaryVisible: false })
      if (process.platform === "darwin") expect(await current.evaluate(({ app }) => app.isReady())).toBe(true)
    }
    await run({ page, model, json, newSession, closeMainWithOverlays })
  } finally {
    clearTimeout(watchdog)
    if (application) {
      const child = application.process()
      const kill = setTimeout(() => {
        child.kill("SIGKILL")
      }, 5000)
      const limit = { timer: undefined as ReturnType<typeof setTimeout> | undefined }
      await Promise.race([
        application.close().catch(() => {}),
        new Promise<void>((resolve) => {
          limit.timer = setTimeout(resolve, 6000)
        }),
      ])
      clearTimeout(limit.timer)
      clearTimeout(kill)
    }
    model.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      model.server.close(() => resolve())
    })
    await rm(root, { recursive: true, force: true })
  }
}

function providerConfig(baseURL: string) {
  return {
    $schema: "https://vectordev.ai/config.json",
    model: "hands-e2e/fixture",
    small_model: "hands-e2e/fixture",
    formatter: false,
    lsp: false,
    permission: {
      computer_observe: "allow",
      computer_interact: "allow",
      computer_app: "ask",
      computer_sensitive: "ask",
    },
    provider: {
      "hands-e2e": {
        name: "Isolated Hands fixture",
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "isolated-fixture", baseURL },
        models: {
          fixture: {
            id: "fixture",
            name: "Isolated Hands fixture",
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
  }
}

function fakeModel() {
  const state = {
    computerCalls: 0,
    screenshotResultSeen: false,
    clickResultSeen: false,
    heldResponseClosed: false,
    failed: false,
  }
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
        response.writeHead(404)
        response.end()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 8 * 1024 * 1024) throw new Error("The fixture model request exceeded its bound.")
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelRequest
      // Title and compaction requests may include the same prompt without tools. They must
      // receive ordinary fixture text rather than starting or hanging the computer sequence.
      const computer =
        JSON.stringify(body.messages ?? []).includes(marker) &&
        body.tools?.some((tool) => tool.function?.name === "computer") === true
      const screenshot =
        body.messages?.some(
          (message) => message.role === "tool" && message.tool_call_id === "call_hands_e2e_screenshot",
        ) === true
      const clicked =
        body.messages?.some((message) => message.role === "tool" && message.tool_call_id === "call_hands_e2e_click") ===
        true
      if (computer && clicked) {
        state.clickResultSeen = true
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        response.write(": isolated provider wait for actual UI Stop\n\n")
        response.once("close", () => {
          state.heldResponseClosed = true
        })
        return
      }
      if (computer) {
        state.screenshotResultSeen ||= screenshot
        state.computerCalls++
      }
      reply(
        response,
        body.stream === true,
        computer
          ? {
              id: screenshot ? "call_hands_e2e_click" : "call_hands_e2e_screenshot",
              args: screenshot
                ? { action: "click", x: 550, y: 510, intent: "Send the isolated virtual payment." }
                : { action: "screenshot", app: "Northwind Bank", intent: "Inspect the isolated virtual bank." },
            }
          : undefined,
      )
    })().catch(() => {
      state.failed = true
      if (response.headersSent) {
        response.destroy()
        return
      }
      response.writeHead(500, { "content-type": "application/json" })
      response.end('{"error":{"message":"The isolated fixture model failed."}}')
    })
  })
  return Object.assign(state, { server })
}

function reply(response: ServerResponse, stream: boolean, call?: { id: string; args: Record<string, unknown> }) {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  const finish = call ? "tool_calls" : "stop"
  const message = call
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: call.id, type: "function", function: { name: "computer", arguments: JSON.stringify(call.args) } },
        ],
      }
    : { role: "assistant", content: "Isolated Hands fixture" }
  const base = { id: "chatcmpl-hands-e2e", created: 1, model: "fixture" }
  if (!stream) {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      }),
    )
    return
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  const chunk = (delta: Record<string, unknown>, finish_reason?: string) =>
    `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish_reason ? { finish_reason } : {}) }], ...(finish_reason ? { usage } : {}) })}\n\n`
  response.write(chunk({ role: "assistant" }))
  if (call) {
    response.write(
      chunk({
        tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: "computer", arguments: "" } }],
      }),
    )
    response.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(call.args) } }] }))
  }
  if (!call) response.write(chunk({ content: "Isolated Hands fixture" }))
  response.write(chunk({}, finish))
  response.end("data: [DONE]\n\n")
}
