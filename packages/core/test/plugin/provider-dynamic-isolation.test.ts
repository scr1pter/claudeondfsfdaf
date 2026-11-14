import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { AISDK } from "../../src/aisdk"
import { ModelV2 } from "../../src/model"
import { ProviderV2 } from "../../src/provider"
import { PluginV2 } from "../../src/plugin"
import { PluginHost } from "../../src/plugin/host"
import { DynamicProviderPlugin } from "../../src/plugin/provider/dynamic"
import { OpenAICompatiblePlugin } from "../../src/plugin/provider/openai-compatible"
import { Npm } from "../../src/npm"
import { ProcessIsolation } from "../../src/process-isolation"
import { ConfigExternalPlugin } from "../../src/config/plugin/external"
import { oauthPluginContext } from "../../src/plugin/oauth"
import {
  activateOAuthApproval,
  inspectOAuthPlugin,
  pluginCredentialMetadata,
  revokeOAuthApproval,
  writeOAuthApproval,
} from "../../src/plugin/oauth-approval"
import { Credential } from "../../src/credential"
import { Integration } from "../../src/integration"
import { untrustedChildEnvironment } from "../../src/child-environment"
import { NetworkGuard } from "../lib/network-guard"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const modes = [
  "ordinary",
  "protected",
  "cache",
  "pending",
  "hooks-cold",
  "hooks-cache",
  "hooks-pending",
  "hooks-child",
  "integration-cache",
  "integration-authorize-pending",
  "integration-code-pending",
  "integration-auto-pending",
  "integration-refresh-pending",
  "oauth-transport-pending",
] as const
const mode = modes.find((value) => value === process.env.VECTOR_TEST_DYNAMIC_CODE_ISOLATION)
const refusal = "cannot load external executable modules"
NetworkGuard.use()

if (!mode) {
  for (const selected of modes)
    test(`real dynamic SDK boundary: ${selected}`, async () => {
      const child = Bun.spawn([process.execPath, "test", "--timeout", "25000", import.meta.path], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...untrustedChildEnvironment(process.env), VECTOR_TEST_DYNAMIC_CODE_ISOLATION: selected },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill("SIGKILL"), 28_000)
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
    }, 32_000)
} else {
  const it = testEffect(PluginTestLayer)
  it.live(
    "actual SDK imports and both caches obey monotonic external-code provenance",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "vector-held-sdk-"))),
          (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
        )
        const counter = path.join(directory, "top-level.txt")
        for (const name of ["file-provider", "npm-provider"])
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(directory, name + ".mjs"),
              [
                "import fs from 'node:fs';",
                `fs.appendFileSync(${JSON.stringify(counter)}, ${JSON.stringify(name + "\n")});`,
                "export function createFixture() { return { languageModel(id) { return { specificationVersion: 'v3', provider: 'fixture', modelId: id, supportedUrls: {}, doGenerate() { throw Error('No model request in loader fixture') }, doStream() { throw Error('No model request in loader fixture') } } } } }",
                "",
              ].join("\n"),
            ),
          )
        const model = (provider: string, pkg: string) =>
          ModelV2.Info.make({
            ...ModelV2.Info.empty(ProviderV2.ID.make(provider), ModelV2.ID.make("fixture")),
            api: { id: ModelV2.ID.make("fixture"), type: "aisdk", package: pkg },
          })
        const file = model("file-fixture", pathToFileURL(path.join(directory, "file-provider.mjs")).href)
        const npmModel = model("npm-fixture", "fixture-never-download")
        const bundled = model("bundled-fixture", "@ai-sdk/openai-compatible")
        const observed = () =>
          Effect.promise(() =>
            fs.readFile(counter, "utf8").catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return ""
              throw error
            }),
          )
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let resolutions = 0
        const resolve = Effect.gen(function* () {
          resolutions++
          if (mode === "pending") {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }
          return { directory, entrypoint: path.join(directory, "npm-provider.mjs") }
        })
        const npm = Npm.Service.of({
          add: () => resolve,
          addAs: () => resolve,
          install: () => Effect.die("No installer runs in the fixed SDK fixture"),
          which: () => Effect.succeed(undefined),
          whichAs: () => Effect.succeed(undefined),
        })
        const plugin = yield* PluginV2.Service
        const host = yield* PluginHost.make(plugin)
        const aisdk = yield* AISDK.Service
        yield* OpenAICompatiblePlugin.effect(host)
        yield* DynamicProviderPlugin.effect(host).pipe(Effect.provideService(Npm.Service, npm))
        const trusted = yield* aisdk.language(bundled)
        expect(trusted.modelId).toBe("fixture")
        expect(ProcessIsolation.isExternalCode(trusted)).toBe(false)
        if (mode === "oauth-transport-pending") {
          const integrations = yield* Integration.Service
          const credentials = yield* Credential.Service
          const id = Integration.ID.make("oauth-transport-fixture")
          const root = path.join(directory, "oauth-package")
          yield* Effect.promise(() => fs.mkdir(root))
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(root, "package.json"),
              JSON.stringify({
                name: "@fixture/held-oauth",
                version: "1.0.0",
                type: "module",
                vectorOAuth: [
                  {
                    provider: id,
                    clientId: "fixture-client",
                    issuer: "https://identity.example",
                    apiOrigins: ["https://inference.example"],
                  },
                ],
              }),
            ),
          )
          const file = path.join(root, "plugin.mjs")
          yield* Effect.promise(() =>
            fs.writeFile(
              file,
              [
                `import fs from 'node:fs'; const note = (value) => fs.appendFileSync(${JSON.stringify(counter)}, value + '\\n');`,
                "note('oauth-module'); export default { id: 'fixture-oauth-transport', effect: (host) => host.aisdk.sdk((event) => {",
                "  event.options.fetch = async () => { note('send'); return Response.json({ fixture: true }); };",
                "}) };",
              ].join("\n"),
            ),
          )
          const approval = inspectOAuthPlugin(file)[0]
          writeOAuthApproval(approval)
          const deactivate = activateOAuthApproval(approval)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              deactivate()
              revokeOAuthApproval(approval.id)
            }),
          )
          yield* host.integration.transform((draft) =>
            draft.update(id, (value) => {
              value.name = "Fixture OAuth transport"
            }),
          )
          yield* credentials.create({
            integrationID: id,
            value: Credential.Key.make({ type: "key", key: "fixture", metadata: pluginCredentialMetadata(approval) }),
          })
          let gate = false
          const gated = {
            ...host,
            integration: {
              ...host.integration,
              connection: {
                ...host.integration.connection,
                resolve: (connection: Parameters<typeof host.integration.connection.resolve>[0]) =>
                  host.integration.connection
                    .resolve(connection)
                    .pipe(
                      Effect.tap(() =>
                        gate
                          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                          : Effect.void,
                      ),
                    ),
              },
            },
          }
          const loaded = yield* Effect.promise(() =>
            ConfigExternalPlugin.loadExternalEntry(pathToFileURL(file).href, true),
          )
          expect(loaded.approvals).toHaveLength(1)
          yield* loaded.run(oauthPluginContext(gated, loaded.approvals))
          const event = yield* aisdk.runSDK({
            model: model(id, "@ai-sdk/openai-compatible"),
            package: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://inference.example/v1" },
          })
          const send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = event.options.fetch
          expect(yield* Effect.promise(async () => (await send("https://inference.example/v1/chat")).json())).toEqual({
            fixture: true,
          })
          expect(yield* observed()).toContain("send")
          gate = true
          const running = yield* Effect.promise(() => send("https://inference.example/v1/chat")).pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          const before = yield* observed()
          const saved = yield* credentials.list(id)
          ProcessIsolation.requireIsolation()
          yield* Deferred.succeed(release, undefined)
          const result = yield* Fiber.join(running).pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(refusal)
          expect(yield* observed()).toBe(before)
          expect(yield* credentials.list(id)).toEqual(saved)
          expect(yield* aisdk.language(bundled)).toBe(trusted)
          return
        }
        if (mode.startsWith("integration-")) {
          const integrations = yield* Integration.Service
          const credentials = yield* Credential.Service
          const id = Integration.ID.make("fixture-held-oauth")
          const methodID = Integration.MethodID.make("fixture")
          const builtinID = Integration.ID.make("fixture-builtin-oauth")
          let builtinCalls = 0
          yield* host.integration.transform((draft) =>
            draft.method.update({
              integrationID: builtinID,
              method: { id: "builtin", type: "oauth", label: "Compiled builtin" },
              authorize: () =>
                Effect.sync(() => {
                  builtinCalls++
                  return {
                    mode: "code" as const,
                    url: "https://example.invalid/builtin",
                    instructions: "Fixture",
                    callback: () =>
                      Effect.sync(() => {
                        builtinCalls++
                        return {
                          type: "oauth" as const,
                          access: "builtin",
                          refresh: "builtin",
                          expires: 1,
                          methodID: "builtin",
                        }
                      }),
                  }
                }),
              refresh: (value) =>
                Effect.sync(() => {
                  builtinCalls++
                  return { ...value, access: "builtin-refreshed", expires: 1 }
                }),
              label: () => {
                builtinCalls++
                return "Compiled builtin"
              },
            }),
          )
          const file = path.join(directory, "external-integration.mjs")
          yield* Effect.promise(() =>
            fs.writeFile(
              file,
              [
                `import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};`,
                "import fs from 'node:fs';",
                `const note = (value) => fs.appendFileSync(${JSON.stringify(counter)}, value + '\\n');`,
                "note('integration-module');",
                "export default { id: 'fixture-integration', effect: (host) => host.integration.transform((draft) => {",
                "  const wait = (kind) => Effect.gen(function* () { if (host.options.pending === kind) { yield* host.options.enter; yield* host.options.wait; } });",
                "  const credential = () => ({ type: 'oauth', methodID: 'fixture', access: 'fixture-access', refresh: 'fixture-refresh', expires: 1 });",
                "  draft.method.update({ integrationID: 'fixture-held-oauth', method: { id: 'fixture', type: 'oauth', label: 'External' },",
                "    authorize: (inputs) => Effect.gen(function* () { note('authorize'); yield* wait('authorize');",
                "      const callback = () => Effect.gen(function* () { note('callback'); yield* wait('callback'); return credential(); });",
                "      return inputs.auto === 'true' ? { mode: 'auto', url: 'https://example.invalid/auto', instructions: 'Fixture', callback: callback() } : { mode: 'code', url: 'https://example.invalid/code', instructions: 'Fixture', callback };",
                "    }),",
                "    refresh: (value) => Effect.gen(function* () { note('refresh'); yield* wait('refresh'); return { ...value, access: 'fixture-refreshed', expires: 1 }; }),",
                "    label: () => { note('label'); return 'External fixture'; },",
                "  });",
                "}) };",
              ].join("\n"),
            ),
          )
          const loaded = yield* Effect.promise(() =>
            ConfigExternalPlugin.loadExternalEntry(pathToFileURL(file).href, true),
          )
          yield* loaded.run({
            ...oauthPluginContext(host, []),
            options: {
              pending:
                mode === "integration-authorize-pending"
                  ? "authorize"
                  : mode === "integration-refresh-pending"
                    ? "refresh"
                    : mode === "integration-cache"
                      ? ""
                      : "callback",
              enter: Deferred.succeed(entered, undefined),
              wait: Deferred.await(release),
            },
          })
          expect((yield* integrations.get(id))?.methods[0]).toMatchObject({ id: methodID, type: "oauth" })
          const start = (auto = false) =>
            integrations.connection.oauth({ integrationID: id, methodID, inputs: auto ? { auto: "true" } : {} })
          if (mode === "integration-cache") {
            const ordinary = yield* start()
            yield* integrations.attempt.complete({ attemptID: ordinary.attemptID, code: "fixture" })
            const stored = (yield* credentials.list(id))[0]
            expect(stored.label).toBe("External fixture")
            expect(
              (yield* integrations.connection.resolve({ type: "credential", id: stored.id, label: stored.label }))
                ?.type,
            ).toBe("oauth")
            const pending = yield* start()
            const before = yield* observed()
            const saved = yield* credentials.list(id)
            for (const label of ["integration-module", "authorize", "callback", "label", "refresh"])
              expect(before).toContain(label)
            ProcessIsolation.requireIsolation()
            for (const operation of [
              start().pipe(Effect.asVoid),
              integrations.attempt.complete({ attemptID: pending.attemptID, code: "fixture" }),
              integrations.connection
                .resolve({ type: "credential", id: stored.id, label: stored.label })
                .pipe(Effect.asVoid),
            ]) {
              const result = yield* operation.pipe(Effect.exit)
              expect(Exit.isFailure(result)).toBe(true)
              if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(refusal)
            }
            expect(yield* observed()).toBe(before)
            expect(yield* credentials.list(id)).toEqual(saved)
          } else if (mode === "integration-auto-pending") {
            const attempt = yield* start(true)
            yield* Deferred.await(entered)
            const before = yield* observed()
            const saved = yield* credentials.list(id)
            ProcessIsolation.requireIsolation()
            yield* Deferred.succeed(release, undefined)
            const status = yield* Effect.gen(function* () {
              while (true) {
                const value = yield* integrations.attempt.status(attempt.attemptID)
                if (value.status !== "pending") return value
                yield* Effect.yieldNow
              }
            }).pipe(Effect.timeout("3 seconds"))
            expect(status.status).toBe("failed")
            expect(yield* observed()).toBe(before)
            expect(yield* credentials.list(id)).toEqual(saved)
          } else {
            const operation =
              mode === "integration-authorize-pending"
                ? start().pipe(Effect.asVoid)
                : yield* Effect.gen(function* () {
                    const attempt = yield* start()
                    if (mode === "integration-code-pending")
                      return integrations.attempt.complete({ attemptID: attempt.attemptID, code: "fixture" })
                    yield* integrations.attempt.complete({ attemptID: attempt.attemptID, code: "fixture" })
                    const stored = (yield* credentials.list(id))[0]
                    return integrations.connection
                      .resolve({ type: "credential", id: stored.id, label: stored.label })
                      .pipe(Effect.asVoid)
                  })
            const running = yield* operation.pipe(Effect.forkChild)
            yield* Deferred.await(entered)
            const before = yield* observed()
            const saved = yield* credentials.list(id)
            ProcessIsolation.requireIsolation()
            yield* Deferred.succeed(release, undefined)
            const result = yield* Fiber.join(running).pipe(Effect.exit)
            expect(Exit.isFailure(result)).toBe(true)
            if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(refusal)
            expect(yield* observed()).toBe(before)
            expect(yield* credentials.list(id)).toEqual(saved)
          }
          const builtin = yield* integrations.connection.oauth({
            integrationID: builtinID,
            methodID: Integration.MethodID.make("builtin"),
            inputs: {},
          })
          yield* integrations.attempt.complete({ attemptID: builtin.attemptID, code: "fixture" })
          const stored = (yield* credentials.list(builtinID))[0]
          expect(stored.label).toBe("Compiled builtin")
          expect(
            (yield* integrations.connection.resolve({ type: "credential", id: stored.id, label: stored.label }))?.type,
          ).toBe("oauth")
          expect(builtinCalls).toBe(4)
          expect(yield* aisdk.language(bundled)).toBe(trusted)
          return
        }
        if (mode.startsWith("hooks-")) {
          const pluginFile = path.join(directory, "external-hooks.mjs")
          yield* Effect.promise(() =>
            fs.writeFile(
              pluginFile,
              [
                `import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};`,
                "import fs from 'node:fs';",
                `const note = (value) => fs.appendFileSync(${JSON.stringify(counter)}, value + '\\n');`,
                "note('hooks-module');",
                "const install = (host) => host.aisdk.sdk((event) => Effect.gen(function* () {",
                "  note('sdk-hook'); if (host.options.enter) yield* host.options.enter; if (host.options.wait) yield* host.options.wait;",
                "  event.options.fixtureExternal = true; // Deliberately keep the earlier compiled SDK object unchanged.",
                "}));",
                "export default { id: 'fixture-external-hooks', effect: (host) => Effect.gen(function* () {",
                "  if (host.options.child) { yield* host.plugin.add({ id: 'fixture-external-child', effect: (child) => install(child) }); return; }",
                "  yield* install(host);",
                "  yield* host.aisdk.language((event) => { note('language-hook'); event.language = Object.freeze({",
                "    specificationVersion: 'v3', provider: 'fixture', get modelId() { note('getter'); return 'fixture'; }, supportedUrls: {},",
                "    doGenerate() { note('method'); return Promise.resolve({ fixture: true }); }, doStream() { note('method'); return Promise.resolve({ fixture: true }); }",
                "  }); });",
                "}) };",
              ].join("\n"),
            ),
          )
          const loaded = yield* Effect.promise(() =>
            ConfigExternalPlugin.loadExternalEntry(pathToFileURL(pluginFile).href, true),
          )
          yield* loaded.run({
            ...oauthPluginContext(host, []),
            options: {
              child: mode === "hooks-child",
              ...(mode === "hooks-pending"
                ? { enter: Deferred.succeed(entered, undefined), wait: Deferred.await(release) }
                : {}),
            },
          })
          const selected = model("hook-fixture", "@ai-sdk/openai-compatible")
          if (mode === "hooks-pending") {
            const running = yield* aisdk.language(selected).pipe(Effect.forkChild)
            yield* Deferred.await(entered)
            const before = yield* observed()
            ProcessIsolation.requireIsolation()
            yield* Deferred.succeed(release, undefined)
            const exit = yield* Fiber.join(running).pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(refusal)
            expect(yield* observed()).toBe(before)
            expect(before).toContain("sdk-hook")
            expect(before).not.toContain("language-hook")
          } else if (mode === "hooks-cache") {
            const language = yield* aisdk.language(selected)
            expect(language.modelId).toBe("fixture")
            const captured = language.doGenerate
            const getter = Object.getOwnPropertyDescriptor(language, "modelId")?.get
            expect(typeof getter).toBe("function")
            // Frozen source and frozen facade must both retain guarded reflection and captured-call behavior.
            Object.freeze(language)
            expect(getter?.()).toBe("fixture")
            expect(yield* Effect.promise(() => language.doGenerate({ prompt: [] }))).toMatchObject({ fixture: true })
            const before = yield* observed()
            expect(before).toContain("sdk-hook")
            expect(before).toContain("language-hook")
            expect(before).toContain("getter")
            expect(before).toContain("method")
            ProcessIsolation.requireIsolation()
            expect(() => language.modelId).toThrow(refusal)
            expect(() => getter?.()).toThrow(refusal)
            expect(() => captured({ prompt: [] })).toThrow(refusal)
            for (const id of ["fixture", "alias"]) {
              const copy = ModelV2.Info.make({ ...selected, id: ModelV2.ID.make(id) })
              const exit = yield* aisdk.language(copy).pipe(Effect.exit)
              expect(Exit.isFailure(exit)).toBe(true)
              if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(refusal)
            }
            expect(yield* observed()).toBe(before)
          } else {
            const before = yield* observed()
            ProcessIsolation.requireIsolation()
            const exit = yield* aisdk.language(selected).pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(refusal)
            expect(yield* observed()).toBe(before)
            expect(before).toContain("hooks-module")
            expect(before).not.toContain("sdk-hook")
          }
          expect(yield* aisdk.language(bundled)).toBe(trusted)
          return
        }
        if (mode === "pending") {
          const running = yield* aisdk.language(npmModel).pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          ProcessIsolation.requireIsolation()
          yield* Deferred.succeed(release, undefined)
          const exit = yield* Fiber.join(running).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(refusal)
          expect(resolutions).toBe(1)
          expect(yield* observed()).toBe("")
          expect(yield* aisdk.language(bundled)).toBe(trusted)
          return
        }
        if (mode !== "protected") {
          const first = yield* aisdk.language(file)
          const second = yield* aisdk.language(npmModel)
          expect(first.modelId).toBe("fixture")
          expect(second.modelId).toBe("fixture")
          expect(ProcessIsolation.isExternalCode(first)).toBe(true)
          expect(ProcessIsolation.isExternalCode(second)).toBe(true)
          expect(resolutions).toBe(1)
          expect(yield* observed()).toContain("file-provider\n")
          expect(yield* observed()).toContain("npm-provider\n")
          if (mode === "ordinary") return
        }
        const before = yield* observed()
        const beforeResolutions = resolutions
        ProcessIsolation.requireIsolation()
        process.env.GITHUB_ACTIONS = "false"
        process.env.VECTOR_MODE = "own-key"
        process.env.VECTOR_PURE = "0"
        expect(ProcessIsolation.required()).toBe(true)
        // Exact model hits the language cache; a changed model id keeps the SDK key but misses the language cache.
        for (const original of [file, npmModel]) {
          for (const selected of [
            original,
            ModelV2.Info.make({ ...original, id: ModelV2.ID.make("alias") }),
            ...(mode === "cache"
              ? [
                  ModelV2.Info.make({
                    ...original,
                    api: { ...original.api, type: "aisdk", package: "@ai-sdk/openai-compatible" },
                  }),
                ]
              : []),
          ]) {
            const exit = yield* aisdk.language(selected).pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(refusal)
          }
        }
        expect(yield* aisdk.language(bundled)).toBe(trusted)
        expect(resolutions).toBe(beforeResolutions)
        expect(yield* observed()).toBe(before)
      }),
    25_000,
  )
}
