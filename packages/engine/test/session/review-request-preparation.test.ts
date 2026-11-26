import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { reviewPermissionRules } from "@vectordevai/core/review/permission"
import { PINNED_SESSION_PREFIX, SCOPE } from "@vectordevai/core/review/prompt"
import { SessionTable } from "@vectordevai/core/session/sql"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Provider } from "@/provider/provider"
import { SessionPrompt } from "@/session/prompt"
import { TestInstance, trustWorkspace } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      Provider.node,
      Database.node,
      FSUtil.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.loopback, deps: [] }),
    ]),
  ),
)
const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }

function request(text: string, options?: { pinned?: boolean; checks?: boolean }): SessionPrompt.ReviewFirstRequest {
  return {
    route: { agent: "review", policy: { privacy: "standard", attested: [] } },
    session: {
      internal: (options?.pinned ? PINNED_SESSION_PREFIX : "vectorscope.") + "verify",
      permission: reviewPermissionRules({ checks: options?.checks }),
    },
    prompt: {
      model: ref,
      agent: "review",
      format: new SessionV1.OutputFormatJsonSchema({
        type: "json_schema",
        retryCount: 0,
        schema: { type: "object", properties: { decision: { type: "string" } } },
      }),
      parts: [
        {
          type: "text",
          text,
          metadata: {
            [SCOPE]: {
              trust: "untrusted",
              paths: ["src/one.ts"],
              ...(options?.pinned ? { instructions: "provided" } : {}),
            },
          },
        },
      ],
    },
  }
}

it.instance(
  "sizes a resolved stock review with its instructions, effective tool list and conditional user text before any session or send",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const fs = yield* FSUtil.Service
      const server = yield* TestLLMServer
      const provider = yield* Provider.Service
      const prompts = yield* SessionPrompt.Service
      const { db } = yield* Database.Service
      yield* fs.writeWithDirs(path.join(directory, "vector.json"), JSON.stringify(testProviderConfig(server.url)))
      yield* Effect.promise(() => trustWorkspace(directory))
      // Real selection, as at the command entry point. The preview itself cannot start a catalog refresh.
      yield* provider.getModel(ref.providerID, ref.modelID)
      const sessionRows = () => db.select({ id: SessionTable.id }).from(SessionTable).all()
      const before = yield* sessionRows()
      const measure = prompts.reviewFirstRequest!
      const text = "Review the change in src/one.ts."
      const plain = yield* measure(request(text))
      const pinned = yield* measure(request(text, { pinned: true }))
      expect(plain?.promptTokens).toBeGreaterThan(0)
      expect(pinned?.promptTokens).toBeGreaterThan(0)
      const added = "Only cite reviewed lines. ".repeat(700)
      yield* fs.writeWithDirs(path.join(directory, "AGENTS.md"), added)
      const withInstruction = yield* measure(request(text))
      expect(withInstruction!.promptTokens - plain!.promptTokens).toBeGreaterThan(added.length / 4)
      expect(yield* measure(request(text, { pinned: true }))).toEqual(pinned)
      const withShell = yield* measure(request(text, { checks: true }))
      expect(withShell!.promptTokens).toBeGreaterThan(withInstruction!.promptTokens)
      const userChars = JSON.stringify(text).length
      const conditional = { pass: "verify", candidateLimit: 10, maxSerializedTextChars: userChars + 3500 } as const
      const bounded = yield* measure({ ...request(text), conditional })
      expect(bounded!.promptTokens - withInstruction!.promptTokens).toBe(1000)
      expect(
        yield* measure({ ...request(text), conditional: { ...conditional, maxSerializedTextChars: userChars - 1 } }),
      ).toBeUndefined()
      const missing = request(text)
      expect(yield* measure({ ...missing, session: { ...missing.session, permission: [] } })).toBeUndefined()
      // A newly changed Brain source hasn't been mirrored. Preflight must neither import nor count it as used.
      yield* fs.writeWithDirs(path.join(directory, ".vector", "BRAIN.md"), "New unsynchronized review rule.")
      expect(yield* measure(request(text))).toBeUndefined()
      expect(yield* measure(request(text, { pinned: true }))).toEqual(pinned)
      expect(yield* sessionRows()).toEqual(before)
      expect(yield* server.hits).toHaveLength(0)
    }),
  { git: true },
  60000,
)
