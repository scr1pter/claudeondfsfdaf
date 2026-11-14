import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { getEventListeners } from "node:events"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { Npm } from "@vectordevai/core/npm"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { LocalPluginSdk } from "@vectordevai/core/plugin/local-sdk"
import { ConfigExternalPlugin } from "@vectordevai/core/config/plugin/external"
import { ModelSlots } from "@vectordevai/core/local-mode/model-slots"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { ConfigDependencies } from "@/config/dependencies"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { PluginLoader } from "@/plugin/loader"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { Git } from "@/git"
import { PrivateAccess } from "@/tool/private-access"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const modes = [
  "ordinary",
  "protected",
  "transition",
  "plugin-cold",
  "plugin-cache",
  "plugin-pending",
  "plugin-auth-pending",
  "import-pending-v1",
  "import-pending-v2",
  "auth-code-cache",
  "auth-auto-cache",
  "auth-authorize-pending",
  "auth-code-pending",
  "auth-auto-pending",
  "auth-builtin",
  "plugin-fit-generate",
  "plugin-fit-stream",
  "plugin-fetch-pending",
  "tool-pending",
  "tool-screen-pending",
] as const
const mode = modes.find((value) => value === process.env.VECTOR_TEST_HOLDER_CODE_LOADING)
const refusal = "cannot load external executable modules"

if (!mode) {
  for (const selected of modes)
    test(`actual executable loaders: ${selected}`, async () => {
      // A fresh test process preserves the monotonic production authority and the normal strict network preload.
      const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", import.meta.path], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...untrustedChildEnvironment(process.env), VECTOR_TEST_HOLDER_CODE_LOADING: selected },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill("SIGKILL"), 35_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(code, `${stdout}\n${stderr}`).toBe(0)
        expect(stderr).toContain("1 pass")
        expect(stderr).toContain("0 fail")
      } finally {
        clearTimeout(timer)
        child.kill("SIGKILL")
        await child.exited
      }
    }, 40_000)
} else {
  const pluginMode = mode.startsWith("plugin-") || (mode.startsWith("auth-") && mode !== "auth-builtin")
  let builtinCallbacks = 0
  let fetchGate = false
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const config = TestConfig.layer({
    directories: () => InstanceState.directory.pipe(Effect.map((directory) => [path.join(directory, "global")])),
    get: () =>
      InstanceState.directory.pipe(
        Effect.map((directory) => ({
          ...(pluginMode
            ? {
                plugin_origins: [
                  {
                    spec: [
                      pathToFileURL(path.join(directory, "provider-plugin.mjs")).href,
                      {
                        pending: mode === "plugin-pending",
                        authPending: mode === "plugin-auth-pending",
                        authorizePending: mode === "auth-authorize-pending",
                        callbackPending: mode === "auth-code-pending" || mode === "auth-auto-pending",
                        enter: () => entered.resolve(),
                        wait: () => release.promise,
                      },
                    ] as [string, Record<string, unknown>],
                    source: path.join(directory, "vector.json"),
                    scope: "global" as const,
                  },
                ],
              }
            : {}),
          provider: {
            fixture: {
              npm: pathToFileURL(path.join(directory, "provider.mjs")).href,
              options: { apiKey: "fixture-no-network", baseURL: "http://127.0.0.1:9/v1" },
              models: { fixture: { name: "Fixture" } },
            },
            bundled: {
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "fixture-no-network", baseURL: "http://127.0.0.1:9/v1" },
              models: { fixture: { name: "Bundled" } },
            },
            "hook-fixture": {
              npm: "@ai-sdk/openai-compatible",
              options: {
                apiKey: "fixture-no-network",
                baseURL: mode === "plugin-fetch-pending" ? "https://openrouter.ai/api/v1" : "http://127.0.0.1:9/v1",
                ...(mode.startsWith("plugin-fit-") ? { concurrency: 1 } : {}),
              },
              models: { fixture: { name: "External hook with bundled SDK" } },
            },
          },
        })),
      ),
  })
  const plugins = Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      init: () => Effect.void,
      list: () =>
        Effect.succeed(
          mode === "auth-builtin"
            ? [
                {
                  auth: {
                    provider: "fixture-builtin",
                    methods: [
                      {
                        type: "oauth" as const,
                        label: "Compiled fixture",
                        authorize: async () => {
                          builtinCallbacks++
                          return {
                            method: "code" as const,
                            url: "https://example.invalid/builtin",
                            instructions: "Fixture",
                            callback: async () => {
                              builtinCallbacks++
                              return { type: "success" as const, key: "fixture-builtin" }
                            },
                          }
                        },
                      },
                    ],
                  },
                },
              ]
            : [],
        ),
      trigger: (_name, _input, output) => Effect.succeed(output),
    }),
  )
  const it = testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        ToolRegistry.node,
        Agent.node,
        Provider.node,
        ProviderAuth.node,
        Auth.node,
        Plugin.node,
        ModelSlots.node,
        SessionAudience.node,
        Git.node,
      ]),
      [
        [Config.node, config],
        ...(pluginMode ? [] : [[Plugin.node, plugins] as const]),
        ...(mode === "plugin-fetch-pending"
          ? [
              [
                FreeModelGuests.node,
                Layer.succeed(FreeModelGuests.Service, {
                  mark: () => Effect.void,
                  marked: () =>
                    Effect.promise(async () => {
                      if (fetchGate) {
                        entered.resolve()
                        await release.promise
                      }
                      return false
                    }),
                }),
              ] as const,
            ]
          : []),
        [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
        [ConfigDependencies.node, Layer.succeed(ConfigDependencies.Service, { prepare: () => Effect.void })],
        [RuntimeFlags.node, RuntimeFlags.layer({ pure: !pluginMode, disableDefaultPlugins: true })],
      ],
    ),
  )
  afterEach(disposeAllInstances)
  it.instance(
    "fixed local modules cross the actual registry/plugin/provider boundaries",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const counter = path.join(tmp.directory, "top-level.txt")
        const module = (name: string, body: string) =>
          Effect.promise(async () => {
            const file = path.join(tmp.directory, name)
            await fs.mkdir(path.dirname(file), { recursive: true })
            await fs.writeFile(
              file,
              `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(counter)}, ${JSON.stringify(name + "\n")});\n${body}\n`,
            )
            return file
          })
        const observed = () =>
          Effect.promise(() =>
            fs.readFile(counter, "utf8").catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return ""
              throw error
            }),
          )
        if (mode === "tool-pending" || mode === "tool-screen-pending") {
          const bridge = path.join(tmp.directory, "tool-barrier.mjs")
          yield* Effect.promise(() =>
            fs.writeFile(
              bridge,
              "export const entered = Promise.withResolvers(); export const release = Promise.withResolvers();\n",
            ),
          )
          const barrier = yield* Effect.promise(() => import(pathToFileURL(bridge).href))
          yield* module(
            "global/tools/pending-counter.js",
            [
              `import { entered, release } from ${JSON.stringify(pathToFileURL(bridge).href)};`,
              `const note = (value) => fs.appendFileSync(${JSON.stringify(counter)}, value + '\\n'); let calls = 0;`,
              `export default { description: 'fixture', args: {}, execute: async () => { note('execute'); if (++calls === 2 && ${mode === "tool-pending"}) { entered.resolve(); await release.promise; } return { get output() { note('output-getter'); return 'fixture output'; }, ${mode === "tool-screen-pending" ? "get toJSON() { note('tojson-getter'); }, get then() { note('then-getter'); }, metadata: { get nested() { note('nested-getter'); return 'fixture'; } }," : "metadata: {},"} title: 'Fixture' }; } };`,
            ].join("\n"),
          )
          const registry = yield* ToolRegistry.Service
          const audience = yield* SessionAudience.Service
          const git = yield* Git.Service
          let screenGate = false
          let screened: unknown
          const access = PrivateAccess.make({
            guest: true,
            instance: tmp,
            git,
            audience: {
              ...audience,
              hasPrivateDirectories: Effect.promise(async () => {
                if (screenGate) {
                  barrier.entered.resolve()
                  await barrier.release.promise
                }
                return true
              }),
            },
          })
          const tool = (yield* registry.all()).find((value) => value.id === "pending-counter")
          if (!tool) throw new Error("The actual custom-tool fixture did not load")
          const context = {
            sessionID: SessionID.make("ses_loader_fixture"),
            messageID: MessageID.make("msg_loader_fixture"),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
            ...(mode === "tool-screen-pending"
              ? {
                  assertOutput: (value: unknown) => {
                    screened = value
                    return access.output(value).pipe(Effect.asVoid, Effect.orDie)
                  },
                }
              : {}),
          } satisfies Tool.Context
          expect((yield* tool.execute({}, context)).output).toBe("fixture output")
          expect(yield* observed()).toContain("output-getter")
          if (mode === "tool-screen-pending") {
            expect(yield* observed()).toContain("tojson-getter")
            expect(yield* observed()).toContain("nested-getter")
            expect(yield* observed()).toContain("then-getter")
            screenGate = true
          }
          const running = yield* tool.execute({}, context).pipe(Effect.forkChild)
          yield* Effect.promise(() => barrier.entered.promise)
          const before = yield* observed()
          ProcessIsolation.requireIsolation()
          barrier.release.resolve()
          const result = yield* Fiber.join(running).pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).toContain(
              mode === "tool-screen-pending" ? "could expose private task data" : refusal,
            )
          if (mode === "tool-screen-pending") {
            const snapshot = screened
            if (!snapshot || typeof snapshot !== "object")
              throw new Error("The actual screen did not capture the guarded result")
            for (const read of [
              () => Object.keys(snapshot),
              () => Reflect.get(snapshot, "toJSON"),
              () => Reflect.get(Reflect.get(snapshot, "metadata"), "nested"),
            ])
              expect(read).toThrow(refusal)
            const thenable = yield* Effect.promise(async () => Promise.resolve(snapshot)).pipe(Effect.exit)
            expect(Exit.isFailure(thenable)).toBe(true)
            if (Exit.isFailure(thenable)) expect(Cause.pretty(thenable.cause)).toContain(refusal)
          }
          expect(yield* observed()).toBe(before)
          return
        }
        if (mode === "auth-builtin") {
          const oauth = yield* ProviderAuth.Service
          const auth = yield* Auth.Service
          const providerID = ProviderV2.ID.make("fixture-builtin")
          for (const protectedState of [false, true]) {
            if (protectedState) ProcessIsolation.requireIsolation()
            expect((yield* oauth.methods())[providerID]?.[0].label).toBe("Compiled fixture")
            expect((yield* oauth.authorize({ providerID, method: 0 }))?.method).toBe("code")
            yield* oauth.callback({ providerID, method: 0, code: "fixture" })
            expect(yield* auth.get(providerID)).toMatchObject({ type: "api", key: "fixture-builtin" })
          }
          expect(builtinCallbacks).toBe(4)
          expect(yield* observed()).toBe("")
          return
        }
        if (mode.startsWith("import-pending-")) {
          const bridge = path.join(tmp.directory, "import-barrier.mjs")
          yield* Effect.promise(() =>
            fs.writeFile(
              bridge,
              "export const entered = Promise.withResolvers(); export const release = Promise.withResolvers();\n",
            ),
          )
          const barrier = yield* Effect.promise(() => import(pathToFileURL(bridge).href))
          const file = yield* module(
            "pending-import.mjs",
            `import { entered, release } from ${JSON.stringify(pathToFileURL(bridge).href)}; entered.resolve(); await release.promise; export const marker = 'complete';`,
          )
          if (mode === "import-pending-v1") {
            const running = yield* Effect.promise(() =>
              PluginLoader.load({
                spec: file,
                target: file,
                entry: pathToFileURL(file).href,
                source: "npm",
                options: undefined,
                deprecated: false,
              }),
            ).pipe(Effect.forkChild)
            yield* Effect.promise(() => barrier.entered.promise)
            const before = yield* observed()
            ProcessIsolation.requireIsolation()
            barrier.release.resolve()
            const result = yield* Fiber.join(running)
            expect(result.ok).toBe(false)
            if (!result.ok) expect(String(result.error)).toContain(refusal)
            expect(yield* observed()).toBe(before)
            expect(before).toContain("pending-import.mjs")
            return
          }
          const running = yield* Effect.promise(() =>
            ConfigExternalPlugin.loadExternalEntry(pathToFileURL(file).href, false),
          ).pipe(Effect.forkChild)
          yield* Effect.promise(() => barrier.entered.promise)
          const before = yield* observed()
          ProcessIsolation.requireIsolation()
          barrier.release.resolve()
          const result = yield* Fiber.join(running).pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(refusal)
          expect(yield* observed()).toBe(before)
          expect(before).toContain("pending-import.mjs")
          return
        }
        if (pluginMode) {
          yield* module(
            "provider-plugin.mjs",
            [
              `const note = (value) => fs.appendFileSync(${JSON.stringify(counter)}, value + '\\n');`,
              "export default { id: 'fixture.holder-provider', server: async (_input, options) => {",
              "  note('factory'); return {",
              "    provider: { id: 'hook-fixture', models: async (provider) => {",
              "      note('models'); if (options.pending) { options.enter(); await options.wait(); } return provider.models;",
              "    } },",
              "    auth: { provider: 'hook-fixture', methods: [{ type: 'oauth', label: 'Fixture',",
              "      get prompts() { note('prompt-getter'); return [{ type: 'text', key: 'fixture', message: 'Fixture', validate() { note('validate'); } }]; },",
              "      authorize: async (inputs) => { note('authorize'); if (options.authorizePending) { options.enter(); await options.wait(); } return {",
              "        url: 'https://example.invalid/authorize', instructions: 'Fixture', method: inputs?.auto === 'true' ? 'auto' : 'code',",
              "        callback: async () => { note('callback'); if (options.callbackPending) { options.enter(); await options.wait(); } return { type: 'success', access: 'fixture-access', refresh: 'fixture-refresh', expires: 1 }; },",
              "      }; } }], loader: async (getAuth) => {",
              "      note('auth'); await getAuth(); if (options.authPending) { options.enter(); await options.wait(); } return { fetch: async () => {",
              "        note('fetch'); return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture',",
              "          choices: [{ index: 0, message: { role: 'assistant', content: 'fixture' }, finish_reason: 'stop' }],",
              "          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });",
              "      } }; } },",
              "  }; } };",
            ].join("\n"),
          )
          const auth = yield* Auth.Service
          yield* auth.set("hook-fixture", { type: "api", key: "fixture-no-network" })
          const plugins = yield* Plugin.Service
          const providers = yield* Provider.Service
          yield* plugins.init()
          expect(yield* observed()).toContain("provider-plugin.mjs")
          expect(yield* observed()).toContain("factory")
          if (mode.startsWith("auth-")) {
            const oauth = yield* ProviderAuth.Service
            const providerID = ProviderV2.ID.make("hook-fixture")
            expect((yield* oauth.methods())[providerID]?.[0]).toMatchObject({ type: "oauth", label: "Fixture" })
            const inputs = { fixture: "fixture", ...(mode.startsWith("auth-auto") ? { auto: "true" } : {}) }
            if (mode === "auth-authorize-pending") {
              const running = yield* oauth.authorize({ providerID, method: 0, inputs }).pipe(Effect.forkChild)
              yield* Effect.promise(() => entered.promise)
              const before = yield* observed()
              const saved = yield* auth.get(providerID)
              ProcessIsolation.requireIsolation()
              release.resolve()
              const result = yield* Fiber.join(running).pipe(Effect.exit)
              expect(Exit.isFailure(result)).toBe(true)
              if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(refusal)
              expect(yield* observed()).toBe(before)
              expect(yield* auth.get(providerID)).toEqual(saved)
              return
            }
            expect((yield* oauth.authorize({ providerID, method: 0, inputs }))?.method).toBe(
              mode.startsWith("auth-auto") ? "auto" : "code",
            )
            if (mode === "auth-code-pending" || mode === "auth-auto-pending") {
              const running = yield* oauth.callback({ providerID, method: 0, code: "fixture" }).pipe(Effect.forkChild)
              yield* Effect.promise(() => entered.promise)
              const before = yield* observed()
              const saved = yield* auth.get(providerID)
              ProcessIsolation.requireIsolation()
              release.resolve()
              const result = yield* Fiber.join(running).pipe(Effect.exit)
              expect(Exit.isFailure(result)).toBe(true)
              if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(refusal)
              expect(yield* observed()).toBe(before)
              expect(yield* auth.get(providerID)).toEqual(saved)
              return
            }
            yield* oauth.callback({ providerID, method: 0, code: "fixture" })
            expect(yield* auth.get(providerID)).toMatchObject({ type: "oauth", access: "fixture-access" })
            yield* oauth.authorize({ providerID, method: 0, inputs })
            const saved = yield* auth.get(providerID)
            const before = yield* observed()
            expect(before).toContain("prompt-getter")
            expect(before).toContain("validate")
            expect(before).toContain("authorize")
            expect(before).toContain("callback")
            ProcessIsolation.requireIsolation()
            for (const operation of [
              oauth.methods().pipe(Effect.asVoid),
              oauth.authorize({ providerID, method: 0, inputs }).pipe(Effect.asVoid),
              oauth.callback({ providerID, method: 0, code: "fixture" }),
            ]) {
              const result = yield* operation.pipe(Effect.exit)
              expect(Exit.isFailure(result)).toBe(true)
              if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(refusal)
            }
            expect(yield* observed()).toBe(before)
            expect(yield* auth.get(providerID)).toEqual(saved)
            return
          }
          if (mode === "plugin-pending" || mode === "plugin-auth-pending") {
            const running = yield* providers
              .getModel(ProviderV2.ID.make("hook-fixture"), ModelV2.ID.make("fixture"))
              .pipe(Effect.forkChild)
            yield* Effect.promise(() => entered.promise)
            const before = yield* observed()
            expect(before).toContain("models")
            if (mode === "plugin-auth-pending") expect(before).toContain("auth")
            else expect(before).not.toContain("auth")
            expect(before).not.toContain("fetch")
            ProcessIsolation.requireIsolation()
            release.resolve()
            const exit = yield* Fiber.join(running).pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(refusal)
            expect(yield* observed()).toBe(before)
            return
          }
          if (mode === "plugin-cold") {
            const before = yield* observed()
            ProcessIsolation.requireIsolation()
            const exit = yield* providers
              .getModel(ProviderV2.ID.make("hook-fixture"), ModelV2.ID.make("fixture"))
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(refusal)
            expect(yield* observed()).toBe(before)
            expect(before).not.toContain("models")
            expect(before).not.toContain("auth")
            return
          }
          const selected = yield* providers.getModel(ProviderV2.ID.make("hook-fixture"), ModelV2.ID.make("fixture"))
          expect(selected.api.npm).toBe("@ai-sdk/openai-compatible")
          const language = yield* providers.getLanguage(
            mode === "plugin-fetch-pending"
              ? {
                  ...selected,
                  api: { ...selected.api, id: ModelV2.ID.make("openrouter/auto") },
                }
              : selected,
          )
          if (mode === "plugin-fetch-pending") {
            const options = {
              prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "fixture" }] }],
            }
            expect((yield* Effect.promise(() => language.doGenerate(options))).content).toContainEqual({
              type: "text",
              text: "fixture",
            })
            expect(yield* observed()).toContain("fetch")
            fetchGate = true
            const running = yield* Effect.promise(() => language.doGenerate(options)).pipe(Effect.forkChild)
            yield* Effect.promise(() => entered.promise)
            const before = yield* observed()
            ProcessIsolation.requireIsolation()
            release.resolve()
            const result = yield* Fiber.join(running).pipe(Effect.exit)
            expect(Exit.isFailure(result)).toBe(true)
            if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(refusal)
            expect(yield* observed()).toBe(before)
            return
          }
          if (mode === "plugin-fit-generate" || mode === "plugin-fit-stream") {
            const slots = yield* ModelSlots.Service
            const line = yield* providers.line(selected)
            if (!line) throw new Error("The fixture model did not enter the actual fitted path")
            expect(line.permits).toBe(1)
            const held = yield* Effect.promise(() =>
              slots.acquire({ origin: line.origin, permits: 1, priority: "user" }),
            )
            yield* Effect.addFinalizer(() => Effect.sync(held))
            const controller = new AbortController()
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
            const request: Promise<unknown> =
              mode === "plugin-fit-generate"
                ? Promise.resolve(language.doGenerate({ prompt: [], abortSignal: controller.signal }))
                : Promise.resolve(language.doStream({ prompt: [], abortSignal: controller.signal }))
            const pending = request.then(
              () => ({ ok: true as const }),
              (error: unknown) => ({ ok: false as const, error }),
            )
            expect(slots.queue(line.origin)).toMatchObject({ running: 1, waiting: 1 })
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(1)
            const before = yield* observed()
            expect(before).not.toContain("fetch")
            ProcessIsolation.requireIsolation()
            held()
            const result = yield* Effect.promise(() => pending)
            expect(result.ok).toBe(false)
            if (!result.ok) expect(String(result.error)).toContain(refusal)
            expect(slots.queue(line.origin)).toMatchObject({ running: 0, waiting: 0 })
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
            expect(yield* observed()).toBe(before)
            return
          }
          expect(language.modelId).toBe("fixture")
          const captured = language.doGenerate
          const answer = yield* Effect.promise(() =>
            language.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "fixture" }] }] }),
          )
          expect(answer.content).toContainEqual({ type: "text", text: "fixture" })
          const before = yield* observed()
          expect(before).toContain("models")
          expect(before).toContain("auth")
          expect(before).toContain("fetch")
          ProcessIsolation.requireIsolation()
          expect(() => language.modelId).toThrow(refusal)
          expect(() => captured({ prompt: [] })).toThrow(refusal)
          for (const id of ["fixture", "alias"]) {
            const exit = yield* providers.getLanguage({ ...selected, id: ModelV2.ID.make(id) }).pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(refusal)
          }
          const listed = yield* plugins.list().pipe(Effect.exit)
          expect(Exit.isFailure(listed)).toBe(true)
          if (Exit.isFailure(listed)) expect(Cause.pretty(listed.cause)).toContain(refusal)
          expect(yield* observed()).toBe(before)
          return
        }
        const external = yield* module("external.mjs", "export const marker = 'loaded'")
        const blocked = yield* module("blocked.mjs", "export const marker = 'blocked'")
        const computed = yield* module("computed.mjs", "export const marker = 'computed'")
        const required = path.join(tmp.directory, "required.cjs")
        yield* Effect.promise(() =>
          fs.writeFile(
            required,
            `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(counter)}, 'required.cjs\\n'); module.exports = { marker: 'required' };\n`,
          ),
        )
        const outer = yield* module(
          "outer.mjs",
          `const target = ${JSON.stringify(pathToFileURL(computed).href)}; const required = ${JSON.stringify(required)}; export const load = () => import(target); export const readRequired = () => import.meta.require(required); export const resolveRequired = () => import.meta.resolve(required);`,
        )
        yield* module(
          "global/tools/top-counter.js",
          "export default { description: 'fixture', args: {}, execute: async () => 'ordinary tool' }",
        )
        const providerFile = yield* module(
          "provider.mjs",
          "export function createFixture() { return { languageModel(id) { return { specificationVersion: 'v3', provider: 'fixture', modelId: id, supportedUrls: {}, doGenerate() { throw Error('No model request in loader fixture') }, doStream() { throw Error('No model request in loader fixture') } } } } }",
        )
        const load = (file: string, source: "file" | "npm" = "file") =>
          PluginLoader.load({
            spec: file,
            target: file,
            entry: pathToFileURL(file).href,
            source,
            options: undefined,
            deprecated: false,
          })
        const registry = yield* ToolRegistry.Service
        const providers = yield* Provider.Service
        // Service/model setup is passive; no custom factory/import has run before the authority is selected below.
        const model = yield* providers.getModel(ProviderV2.ID.make("fixture"), ModelV2.ID.make("fixture"))
        const bundled = yield* providers.getModel(ProviderV2.ID.make("bundled"), ModelV2.ID.make("fixture"))
        let npmCalls = 0
        const install = spyOn(Npm, "addAs").mockImplementation(async () => {
          npmCalls++
          return { directory: tmp.directory, entrypoint: providerFile }
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => install.mockRestore()))
        let cachedTool: Tool.Def | undefined
        let cachedOuter: Record<string, unknown> | undefined
        // Populate the trusted cache before activation with a real SDK initialization, never a model request.
        const trustedBefore = mode === "transition" ? yield* providers.getLanguage(bundled) : undefined
        if (mode !== "protected") {
          expect((yield* Effect.promise(() => load(external))).ok).toBe(true)
          expect((yield* Effect.promise(() => load(external, "npm"))).ok).toBe(true)
          expect(
            (yield* Effect.promise(() => ConfigExternalPlugin.loadExternalEntry(pathToFileURL(external).href, true)))
              .mod.marker,
          ).toBe("loaded")
          const loaded = yield* Effect.promise(() => load(outer))
          if (!loaded.ok) throw loaded.error
          cachedOuter = loaded.value.mod
          cachedTool = (yield* registry.all()).find((tool) => tool.id === "top-counter")
          expect(cachedTool).toBeDefined()
          expect((yield* providers.getLanguage(model)).modelId).toBe("fixture")
          expect(
            (yield* providers.getLanguage({
              ...model,
              id: ModelV2.ID.make("npm"),
              api: { ...model.api, npm: "fixture-provider" },
            })).modelId,
          ).toBe("fixture")
          expect(npmCalls).toBeGreaterThan(0)
          expect(yield* observed()).toContain("external.mjs")
          expect(yield* observed()).toContain("global/tools/top-counter.js")
          expect(yield* observed()).toContain("provider.mjs")
          if (mode === "ordinary") {
            const run = cachedOuter.load
            if (typeof run !== "function") throw new Error("The ordinary computed import control did not load")
            expect(yield* Effect.promise(() => run())).toMatchObject({ marker: "computed" })
            expect(yield* observed()).toContain("computed.mjs")
            const readRequired = cachedOuter.readRequired
            const resolveRequired = cachedOuter.resolveRequired
            if (typeof readRequired !== "function" || typeof resolveRequired !== "function")
              throw new Error("The ordinary metadata require control did not load")
            expect(readRequired()).toMatchObject({ marker: "required" })
            expect(resolveRequired()).toBe(pathToFileURL(required).href)
            expect(yield* observed()).toContain("required.cjs")
            return
          }
        }
        const before = yield* observed()
        const beforeNpm = npmCalls
        ProcessIsolation.requireIsolation()
        process.env.GITHUB_ACTIONS = "false"
        process.env.VECTOR_MODE = "own-key"
        process.env.VECTOR_PURE = "0"
        expect(ProcessIsolation.required()).toBe(true)
        for (const source of ["file", "npm"] as const) {
          const result = yield* Effect.promise(() => load(blocked, source))
          expect(result.ok).toBe(false)
          if (!result.ok) expect(String(result.error)).toContain(refusal)
        }
        const resolved = yield* Effect.promise(() =>
          PluginLoader.resolve(
            { spec: "fixture-never-install", options: undefined, deprecated: false },
            "server",
            "global",
          ),
        )
        expect(resolved.ok).toBe(false)
        if (!resolved.ok && "error" in resolved) expect(String(resolved.error)).toContain(refusal)
        for (const operation of [
          Effect.promise(() => LocalPluginSdk.prepare(pathToFileURL(blocked).href)).pipe(Effect.asVoid),
          Effect.promise(() => ConfigExternalPlugin.loadExternalEntry(pathToFileURL(blocked).href, false)).pipe(
            Effect.asVoid,
          ),
        ]) {
          const result = yield* operation.pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(refusal)
        }
        expect(yield* registry.ids()).toContain("read")
        expect(yield* registry.ids()).not.toContain("top-counter")
        const context = {
          sessionID: SessionID.make("ses_loader_fixture"),
          messageID: MessageID.make("msg_loader_fixture"),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context
        if (cachedTool) {
          const exit = yield* cachedTool.execute({}, context).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(refusal)
        }
        if (cachedOuter) {
          const run = cachedOuter.load
          if (typeof run !== "function") throw new Error("The ordinary computed import control did not load")
          const imported = yield* Effect.promise(async () => run()).pipe(Effect.exit)
          expect(Exit.isFailure(imported)).toBe(true)
          if (Exit.isFailure(imported)) expect(Cause.pretty(imported.cause)).toContain(refusal)
          const readRequired = cachedOuter.readRequired
          const resolveRequired = cachedOuter.resolveRequired
          if (typeof readRequired !== "function" || typeof resolveRequired !== "function")
            throw new Error("The ordinary metadata require control did not load")
          expect(() => readRequired()).toThrow(refusal)
          expect(() => resolveRequired()).toThrow(refusal)
        }
        for (const selected of [
          model,
          { ...model, id: ModelV2.ID.make("alias") },
          ...(mode === "transition" ? [{ ...model, api: { ...model.api, npm: "@ai-sdk/openai-compatible" } }] : []),
          { ...model, id: ModelV2.ID.make("new-package"), api: { ...model.api, npm: "fixture-never-install" } },
        ]) {
          const exit = yield* providers.getLanguage(selected).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(refusal)
        }
        const trusted = yield* providers.getLanguage(bundled)
        expect(trusted.modelId).toBe("fixture")
        if (trustedBefore) expect(trusted.modelId).toBe(trustedBefore.modelId)
        expect(npmCalls).toBe(beforeNpm)
        expect(yield* observed()).toBe(before)
        expect(yield* observed()).not.toContain("blocked.mjs")
        expect(yield* observed()).not.toContain("computed.mjs")
        expect(yield* observed()).not.toContain("required.cjs")
      }),
    30_000,
  )
}
