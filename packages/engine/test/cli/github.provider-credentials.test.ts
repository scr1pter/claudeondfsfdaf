import { beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer, Stream } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { FreeModels } from "@vectordevai/core/free-models"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { Auth } from "@/auth"
import { verifyGithubRun } from "@/cli/cmd/github.cloud"
import { GithubSecrets } from "@/cli/cmd/github.secrets"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { Env } from "@/env"
import { Provider } from "@/provider/provider"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { testEffect } from "../lib/effect"

const cases = ["environment", "access-key", "bearer", "codium"] as const
const selected = process.env.VECTOR_TEST_GITHUB_PROVIDER_CREDENTIALS
const mode = cases.find((value) => value === selected)
const keys = {
  ANTHROPIC_API_KEY: "fixture-anthropic-channel-key",
  AWS_ACCESS_KEY_ID: "fixture-bedrock-access-id",
  AWS_SECRET_ACCESS_KEY: "fixture-bedrock-secret-key",
  AWS_SESSION_TOKEN: "fixture-bedrock-session-token",
  AWS_BEARER_TOKEN_BEDROCK: "fixture-bedrock-channel-bearer",
  V15_PROVIDER_CREDENTIAL: "fixture-nonsuffix-channel-credential",
}
const credentials = {
  ...keys,
  ...(mode === "access-key" ? { AWS_BEARER_TOKEN_BEDROCK: undefined } : {}),
}
const channel: GithubSecrets.Channel =
  mode === "codium"
    ? { v: 1, githubToken: "fixture-github-channel-token", runToken: "vrt_fixture.signature", keys: {} }
    : {
        v: 1,
        githubToken: "fixture-github-channel-token",
        cliToken: "vct_fixture.signature",
        keys: Object.fromEntries(
          Object.entries(credentials).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      }
const privateNames = [
  ...Object.keys(keys),
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "VECTOR_CLI_TOKEN",
  "VECTOR_RUN_TOKEN",
  "OPENROUTER_API_KEY",
]

// CI runs the real startup holder in fresh processes: its deliberately process-long lifetime must not leak into
// unrelated tests. Each child is still `bun test`, retaining the engine preload and strict network guard.
if (!mode) {
  for (const value of cases) {
    test(`GitHub channel ${value} credentials stay in memory through real engine resolution`, async () => {
      const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", import.meta.path], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !privateNames.includes(name))),
          VECTOR_TEST_GITHUB_PROVIDER_CREDENTIALS: value,
          VECTOR_SECRET_CHANNEL: "stdin",
          VECTOR_SECRET_ENV_NAMES: "",
          VECTOR_MODE: value === "codium" ? "codium" : "own-key",
          GITHUB_ACTIONS: "true",
          VECTOR_CONFIG_CONTENT: "{}",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill("SIGKILL"), 27_000)
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
    }, 30_000)
  }
} else {
  const network = NetworkGuard.use()
  const freeReads: string[] = []
  const planTokens: (string | undefined)[] = []
  const root = LayerNode.group([Provider.node, Env.node, Auth.node, FreeModels.credentialsNode])
  const it = testEffect(
    mode === "codium"
      ? AppNodeBuilderV1.build(root, [
          [
            FreeModels.node,
            Layer.succeed(FreeModels.Service, {
              catalog: () =>
                Effect.sync(() => {
                  freeReads.push("catalog")
                  return { enabled: true, updatedAt: 1, models: [...FREE_MODEL_FALLBACKS] }
                }),
              forKey: () =>
                Effect.sync(() => {
                  freeReads.push("own-key")
                  return [...FREE_MODEL_FALLBACKS]
                }),
              trainingConsent: () => Effect.succeed(true),
              setTrainingConsent: (accepted) => Effect.succeed(accepted),
              changes: Stream.empty,
            }),
          ],
          [
            ModelPlans.node,
            Layer.succeed(ModelPlans.Service, {
              catalog: (token) =>
                Effect.sync(() => {
                  planTokens.push(token)
                  return { enabled: false, models: [] }
                }),
              request: async () => {
                throw new Error("The credential fixture must never make an inference request")
              },
            }),
          ],
        ])
      : LayerNode.compile(root),
  )

  beforeAll(async () => {
    for (const name of privateNames) expect(process.env[name]).toBeUndefined()
    expect(GithubSecrets.credentials.loaded()).toBe(false)
    await GithubSecrets.credentials.load(
      process.env,
      (async function* () {
        yield JSON.stringify(channel) + "\n"
      })(),
    )
    expect(GithubSecrets.credentials.loaded()).toBe(true)
    expect(GithubSecrets.credentials.githubToken()).toBe(channel.githubToken)
    expect(GithubSecrets.credentials.cliToken()).toBe(channel.cliToken)
  })

  it.instance(
    `isolated ${mode} channel fixture`,
    () =>
      Effect.gen(function* () {
        const env = yield* Env.Service
        const memory = yield* env.all()
        for (const [name, value] of Object.entries(channel.keys)) {
          expect(yield* env.get(name)).toBe(value)
          expect(memory[name]).toBe(value)
        }
        expect(memory.VECTOR_SECRET_ENV_NAMES?.split(",").filter(Boolean).toSorted()).toEqual(
          Object.keys(channel.keys).toSorted(),
        )
        for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "VECTOR_CLI_TOKEN", "VECTOR_RUN_TOKEN"])
          expect(memory[name]).toBeUndefined()

        if (mode === "codium") {
          // Only catalog services are substituted above. This service is the real engine builder replacement,
          // with real stored account keys available to catch an accidental fallback before or after authorization.
          const auth = yield* Auth.Service
          yield* auth.set("vector", { type: "api", key: "vct_stored-fallback.signature" })
          yield* auth.set("openrouter", { type: "api", key: "fixture-stored-openrouter-key" })
          expect(yield* auth.get("vector")).toMatchObject({ key: "vct_stored-fallback.signature" })
          expect(yield* auth.get("openrouter")).toMatchObject({ key: "fixture-stored-openrouter-key" })
          const resolved = yield* FreeModels.CredentialsService
          expect(GithubSecrets.credentials.pendingRunToken()).toBe(channel.runToken)
          expect(GithubSecrets.credentials.runToken()).toBeUndefined()
          expect(yield* resolved.get("vector")).toBeUndefined()
          expect(yield* resolved.get("openrouter")).toBeUndefined()
          expect(Object.values(memory)).not.toContain(channel.runToken)

          const provider = yield* Provider.Service
          expect((yield* provider.list())[ProviderV2.ID.vector]).toBeUndefined()
          expect(planTokens.length).toBeGreaterThan(0)
          expect(planTokens.every((token) => token === undefined)).toBe(true)
          expect(freeReads).toEqual([])

          const requests: Request[] = []
          expect(
            yield* Effect.promise(() =>
              verifyGithubRun(GithubSecrets.credentials, {
                request: async (url, init) => {
                  const request = new Request(url, init)
                  requests.push(request)
                  expect(request.url).toBe(`https://vectordev.ai${GithubAgents.ENDPOINT.heartbeat}`)
                  expect(request.method).toBe("POST")
                  expect(request.headers.get("authorization")).toBe(`Bearer ${channel.runToken}`)
                  expect(await request.json()).toEqual({ state: "starting" })
                  expect(await Effect.runPromise(resolved.get("vector"))).toBeUndefined()
                  expect(await Effect.runPromise(resolved.get("openrouter"))).toBeUndefined()
                  return Response.json({ ok: true, stop: false })
                },
                oidc: async () => {
                  throw new Error("Run validation must not request another identity or account credential")
                },
                mask: () => {},
                notice: () => {},
                now: () => 0,
                monotonic: () => 0,
                wait: async () => {
                  throw new Error("Run validation must not retry")
                },
              }),
            ),
          ).toBe(true)
          expect(requests).toHaveLength(1)
          expect(yield* resolved.get("vector")).toBe(channel.runToken)
          expect(yield* resolved.get("openrouter")).toBeUndefined()
          expect((yield* provider.list())[ProviderV2.ID.vector]).toBeUndefined()
          expect(planTokens.at(-1)).toBe(channel.runToken)
          expect(freeReads).toEqual([])
        } else if (mode === "environment") {
          // A project's later source cannot lower the Actions floor or empty the credential names recovered from
          // the channel. Nonsuffix names and Windows-style alternate casing must remain hidden too.
          const child = ChildEnvironment.untrustedChildEnvironment(memory, {
            GITHUB_ACTIONS: "false",
            VECTOR_SECRET_ENV_NAMES: "",
            ANTHROPIC_API_KEY: "fixture-project-override",
            aws_access_key_id: "fixture-project-access-override",
            v15_provider_credential: "fixture-project-nonsuffix-override",
            ORDINARY_PROJECT_VALUE: "kept",
          })
          for (const name of privateNames) expect(child[name]).toBeUndefined()
          expect(child.aws_access_key_id).toBeUndefined()
          expect(child.v15_provider_credential).toBeUndefined()
          expect(child.ORDINARY_PROJECT_VALUE).toBe("kept")
        } else {
          const provider = yield* Provider.Service
          const providers = yield* provider.list()
          const anthropic = providers[ProviderV2.ID.anthropic]
          expect(anthropic.source).toBe("env")
          expect(anthropic.key).toBe(keys.ANTHROPIC_API_KEY)
          const model = yield* provider.getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-sonnet-4-20250514"))
          const language = yield* provider.getLanguage(model)
          expect(language.modelId).toBe("claude-sonnet-4-20250514")

          const bedrock = providers[ProviderV2.ID.make("amazon-bedrock")]
          expect(bedrock).toBeDefined()
          if (mode === "bearer") {
            // The bearer takes precedence even though access credentials also arrived in this channel.
            expect(bedrock.options.apiKey).toBe(keys.AWS_BEARER_TOKEN_BEDROCK)
            expect(bedrock.options.credentialProvider).toBeUndefined()
          } else {
            expect(bedrock.options.apiKey).toBeUndefined()
            const resolve = bedrock.options.credentialProvider
            expect(typeof resolve).toBe("function")
            if (typeof resolve !== "function") throw new Error("Missing channel credential provider")
            expect(yield* Effect.promise(() => resolve())).toEqual({
              accessKeyId: keys.AWS_ACCESS_KEY_ID,
              secretAccessKey: keys.AWS_SECRET_ACCESS_KEY,
              sessionToken: keys.AWS_SESSION_TOKEN,
            })
          }
        }

        for (const name of privateNames) expect(process.env[name]).toBeUndefined()
        expect(network.outside()).toEqual([])
      }),
    {
      trusted: true,
      config: { enabled_providers: mode === "codium" ? ["vector"] : ["anthropic", "amazon-bedrock"] },
    },
  )
}
