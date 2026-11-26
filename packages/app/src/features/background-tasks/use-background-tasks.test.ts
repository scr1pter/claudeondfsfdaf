import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import type { Task } from "@vectordevai/schema/task"
import type { BackgroundTasks } from "./background-tasks"

const compiler = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = compiler("@babel/core") as {
  transformSync(source: string, options: object): { code?: string | null } | null
}
const local = { type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } } as const
const remote = { type: "http", http: { url: "https://engine.example.test" } } as const
const engines = { local, remote }
const fixture = { route: remote as typeof local | typeof remote, selected: local as typeof local | typeof remote }
const opened: string[] = []
const localFolder = "/local/logs"
const remoteFolder = "/remote/logs"
const shell = (folder: string): Task.Shell => ({
  id: "shl_fixture",
  title: "Run checks",
  command: "check",
  status: "completed",
  startedAt: 1,
  completedAt: 2,
  exitCode: 0,
  outputBytes: 1,
  outputPath: `${folder}/output.log`,
})

// Use the real provider and board. Only the router, engine connections, and file manager are fake.
let provider: typeof import("./use-background-tasks")
let solid: typeof import("solid-js")
beforeAll(async () => {
  const browserSolid = "solid-js/dist/solid.js"
  solid = await import(browserSolid)
  mock.module("solid-js", () => solid)
  Bun.plugin({
    name: "background task provider Solid fixture",
    setup(build) {
      build.onLoad({ filter: /use-background-tasks\.tsx$/ }, async ({ path }) => ({
        contents:
          babel.transformSync(await Bun.file(path).text(), {
            filename: path,
            babelrc: false,
            configFile: false,
            parserOpts: { plugins: ["typescript", "jsx"] },
            presets: [[compiler.resolve("babel-preset-solid"), { generate: "dom", hydratable: false }]],
          })?.code ?? "",
        loader: "ts",
      }))
    },
  })
  const server = await import("@/context/server")
  mock.module("@/context/server", () => ({
    ...server,
    useServer: () => ({ isLocal: () => server.ServerConnection.local(fixture.selected) }),
  }))
  mock.module("@solidjs/router", () => ({ useNavigate: () => () => {}, useParams: () => ({}) }))
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "desktop", openPath: async (path: string) => void opened.push(path) }),
  }))
  mock.module("@/context/sdk", () => ({
    useSDK: () => () => ({
      directory: "/repo",
      client: {
        session: { children: async () => ({ data: [] }) },
        experimental: {
          task: {
            list: async () => ({
              data: {
                tasks: [],
                shells: [shell(fixture.route === local ? localFolder : remoteFolder)],
                truncated: false,
              },
            }),
          },
        },
      },
    }),
  }))
  mock.module("@/context/server-sdk", () => ({
    useServerSDK: () => () => ({ server: fixture.route, scope: "fixture", event: { listen: () => () => {} } }),
  }))
  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({ capabilities: () => ({ backgroundShells: true }), reconnects: () => 0 }),
  }))
  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { session: [], session_status: {}, permission: {}, question: {}, message: {}, part: {} },
      session: { get: () => undefined },
    }),
  }))
  mock.module("@/context/prompt", () => ({ usePrompt: () => ({}) }))
  mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
  provider = await import("./use-background-tasks")
})

afterAll(() => {
  Bun.plugin.clearAll()
  mock.restore()
})

test.each([
  { route: "remote", selected: "local", folder: remoteFolder, expected: [] },
  { route: "local", selected: "remote", folder: localFolder, expected: [localFolder] },
] as const)(
  "Open output uses the $route tab when $selected is selected",
  async ({ route, selected, folder, expected }) => {
    fixture.route = engines[route]
    fixture.selected = engines[selected]
    opened.length = 0
    let tasks: BackgroundTasks | undefined
    const dispose = solid.createRoot((dispose) => {
      solid.createComponent(provider.BackgroundTasksProvider, {
        sessionID: () => "ses_fixture",
        get children() {
          tasks = provider.useBackgroundTasks()
          return undefined
        },
      })
      return dispose
    })
    try {
      for (let attempt = 0; !tasks?.shells().length && attempt < 200; attempt++) await Bun.sleep(10)
      const output = tasks?.shells()[0]
      expect(output?.outputPath).toBe(`${folder}/output.log`)
      if (!tasks || !output) throw new Error("The tab did not load its command")
      const allowed = tasks.canOpenOutput(output)
      tasks.openOutput(output)
      expect({ allowed, opened }).toEqual({ allowed: route === "local", opened: [...expected] })
    } finally {
      dispose()
    }
  },
)
