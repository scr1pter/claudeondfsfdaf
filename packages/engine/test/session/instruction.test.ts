import { describe, expect } from "bun:test"
import { SessionV1 } from "@vectordevai/core/v1/session"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"

import { Instruction } from "../../src/session/instruction"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@vectordevai/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient, LayerNodePlatform } from "@vectordevai/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Config } from "@/config/config"
import { Brain } from "@vectordevai/core/brain/brain"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const configLayer = Layer.succeed(Config.Service, TestConfig.make())

const instructionLayer = (global: Partial<Global.Interface>, flags: Partial<RuntimeFlags.Info> = {}) =>
  AppNodeBuilder.build(LayerNode.group([Instruction.node, Brain.node]), [
    [Config.node, configLayer],
    [Global.node, Global.layerWith(global)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags)))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const withFiles = <A, E, R>(files: Record<string, string>, self: (dir: string) => Effect.Effect<A, E, R>) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      yield* writeFiles(dir, files)
      return yield* self(dir).pipe(provideInstruction({ home: dir, config: dir }))
    }),
  )

const tmpWithFiles = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* writeFiles(dir, files)
    return dir
  })

function loaded(filepath: string): SessionV1.WithParts[] {
  const sessionID = SessionID.make("session-loaded-1")
  const messageID = MessageID.make("msg_message-loaded-1")

  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("anthropic"),
          modelID: ModelV2.ID.make("claude-sonnet-4-20250514"),
        },
      },
      parts: [
        {
          id: PartID.make("prt_part-loaded-1"),
          messageID,
          sessionID,
          type: "tool",
          callID: "call-loaded-1",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "Read",
            metadata: { loaded: [filepath] },
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ]
}

describe("Instruction.resolve", () => {
  it.live("returns empty when AGENTS.md is at project root (already in systemPaths)", () =>
    withFiles({ "AGENTS.md": "# Root Instructions", "src/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "AGENTS.md"))).toBe(true)

        const results = yield* svc.resolve([], path.join(dir, "src", "file.ts"), MessageID.make("msg_message-test-1"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("returns AGENTS.md from subdirectory (not in systemPaths)", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "subdir", "AGENTS.md"))).toBe(false)

        const results = yield* svc.resolve(
          [],
          path.join(dir, "subdir", "nested", "file.ts"),
          MessageID.make("msg_message-test-2"),
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("doesn't reload AGENTS.md when reading it directly", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "AGENTS.md")
        const system = yield* svc.systemPaths()
        expect(system.has(filepath)).toBe(false)

        const results = yield* svc.resolve([], filepath, MessageID.make("msg_message-test-3"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("does not reattach the same nearby instructions twice for one message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-1")

        const first = yield* svc.resolve([], filepath, id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(first[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
        expect(second).toEqual([])
      }),
    ),
  )

  it.live("clear allows nearby instructions to be attached again for the same message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-2")

        const first = yield* svc.resolve([], filepath, id)
        yield* svc.clear(id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(1)
        expect(second[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("skips instructions already reported by prior read metadata", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const agents = path.join(dir, "subdir", "AGENTS.md")
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-3")

        const results = yield* svc.resolve(loaded(agents), filepath, id)
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("fetches the remote instructions the user configured, including an intranet page", () =>
    provideTmpdirInstance((dir) => {
      const requests: string[] = []
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url)
          return HttpClientResponse.fromWeb(request, new Response("Remote rules"))
        }),
      )
      const layer = AppNodeBuilder.build(LayerNode.group([Instruction.node, Brain.node]), [
        [
          Config.node,
          Layer.succeed(
            Config.Service,
            TestConfig.make({
              get: () => Effect.succeed({ instructions: ["https://1.1.1.1/rules", "http://127.0.0.1/private"] }),
            }),
          ),
        ],
        [Global.node, Global.layerWith({ home: dir, config: dir })],
        [RuntimeFlags.node, RuntimeFlags.layer({})],
        [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
      ])

      return Effect.gen(function* () {
        const instruction = yield* Instruction.Service
        const system = yield* instruction.system()
        expect(system).toContain("Instructions from: https://1.1.1.1/rules\nRemote rules")
        expect(system).toContain("Instructions from: http://127.0.0.1/private\nRemote rules")
        expect(requests.toSorted()).toEqual(["http://127.0.0.1/private", "https://1.1.1.1/rules"])
      }).pipe(Effect.provide(layer))
    }),
  )
})

describe("Instruction.system", () => {
  it.live("a directory named RULES.md adds no rules and does not break the instructions", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(path.join(dir, ".vector", "RULES.md"), { recursive: true })
        const svc = yield* Instruction.Service
        expect(yield* svc.system()).toEqual([])
        const digest = yield* (yield* Brain.Service).digest(yield* svc.place(), { personal: true, index: true })
        expect(digest.text).toBeUndefined()
      }).pipe(provideInstruction({ home: dir, config: dir })),
    ),
  )

  it.live("loads both project and global AGENTS.md when both exist", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Project Instructions" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(projectTmp, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)

        const rules = yield* svc.system()
        expect(rules).toHaveLength(2)
        expect(rules[0]).toBe(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}\n# Global Instructions`)
        expect(rules[1]).toBe(`Instructions from: ${path.join(projectTmp, "AGENTS.md")}\n# Project Instructions`)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("tells the repository's instruction files from the user's own, remote ones included", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const repositoryTmp = yield* tmpWithFiles({ "AGENTS.md": "# Repository Instructions" })
      const requests: string[] = []
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url)
          return HttpClientResponse.fromWeb(request, new Response("Remote rules"))
        }),
      )
      const layer = AppNodeBuilder.build(LayerNode.group([Instruction.node, Brain.node]), [
        [
          Config.node,
          Layer.succeed(
            Config.Service,
            TestConfig.make({ get: () => Effect.succeed({ instructions: ["https://1.1.1.1/rules"] }) }),
          ),
        ],
        [Global.node, Global.layerWith({ home: globalTmp, config: globalTmp })],
        [RuntimeFlags.node, RuntimeFlags.layer({})],
        [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
      ])

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const repository = `Instructions from: ${path.join(repositoryTmp, "AGENTS.md")}\n# Repository Instructions`
        const own = `Instructions from: ${path.join(globalTmp, "AGENTS.md")}\n# Global Instructions`
        // No prompt has been sent the remote instructions yet, and contents() fetches nothing itself.
        expect(yield* svc.contents()).toEqual({ work: [repository], private: [own] })
        expect(requests).toEqual([])
        yield* svc.system()
        expect(yield* svc.contents()).toEqual({
          work: [repository],
          private: [own, "Instructions from: https://1.1.1.1/rules\nRemote rules"],
        })
        expect(requests).toEqual(["https://1.1.1.1/rules"])
      }).pipe(provideInstance(repositoryTmp), Effect.provide(layer))
    }),
  )

  it.live("skips project and global CLAUDE.md when Claude Code prompt is disabled", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ ".claude/CLAUDE.md": "# Global Claude" })
      const projectTmp = yield* tmpWithFiles({ "CLAUDE.md": "# Project Claude" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, ".claude", "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, "CLAUDE.md"))).toBe(false)
        expect(yield* svc.system()).toEqual([])
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, { disableClaudeCodePrompt: true }),
      )
    }),
  )
})

// A repository can ship its instruction files as links to the user's secrets, and instruction files reach the model
// with the system prompt.
describe("Instruction project links", () => {
  for (const git of [false, true]) {
    it.live(`reads a project instruction file only where it lands inside the project [${git ? "git" : "folder"}]`, () =>
      Effect.gen(function* () {
        const home = yield* tmpWithFiles({ ".ssh/id_rsa": "PRIVATE KEY" })
        const secret = path.join(home, ".ssh", "id_rsa")
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem
              yield* writeFiles(dir, { "docs/rules.md": "# Shared rules", "src/nested/file.ts": "const x = 1" })
              yield* fs.makeDirectory(path.join(dir, ".vector"), { recursive: true })
              yield* fs.symlink(secret, path.join(dir, "AGENTS.md"))
              yield* fs.symlink(path.join("docs", "rules.md"), path.join(dir, "CLAUDE.md"))
              yield* fs.symlink(secret, path.join(dir, ".vector", "BRAIN.md"))
              yield* fs.symlink(secret, path.join(dir, "src", "AGENTS.md"))

              const svc = yield* Instruction.Service
              const rules = (yield* svc.system()).join("\n")
              expect(rules).not.toContain("PRIVATE KEY")
              // The first instruction file that stays in the project still wins, even through a link.
              expect(rules).toContain("# Shared rules")
              expect(
                yield* svc.resolve([], path.join(dir, "src", "nested", "file.ts"), MessageID.make("msg_message-link-1")),
              ).toEqual([])
            }).pipe(provideInstruction({ home, config: path.join(home, ".config", "vector") })),
          { git },
        )
      }),
    )
  }
})

describe("Instruction.systemPaths global config", () => {
  it.live("uses Global.Service config AGENTS.md", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("global Vector rules reach the model through the brain, beside AGENTS.md", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({
        "AGENTS.md": "# Global Instructions",
        "RULES.md": "# Global rules\n\n- Never commit generated credentials.",
      })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
        // Rules are no longer an instruction file loaded whole; the brain sends them in its digest.
        expect(paths.has(path.join(globalTmp, "RULES.md"))).toBe(false)
        const digest = yield* (yield* Brain.Service).digest(yield* svc.place(), { personal: true, index: true })
        expect(digest.text).toContain("Never commit generated credentials.")
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("local memory reaches the model through the brain, beside global instructions", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({
        "AGENTS.md": "# Global Instructions",
        "MEMORY.md": "# Working preferences\n\n- Use Bun for JavaScript projects.",
      })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(globalTmp, "MEMORY.md"))).toBe(false)
        expect((yield* svc.system()).join("\n")).not.toContain("Use Bun for JavaScript projects.")
        const brain = yield* Brain.Service
        const place = yield* svc.place()
        expect((yield* brain.digest(place, { personal: true, index: true })).text).toContain(
          "Use Bun for JavaScript projects.",
        )
        // A session an invited guest drives, or one on a model that may train on prompts, does not get it.
        expect((yield* brain.digest(place, { personal: false, index: true })).text).toBeUndefined()
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("a scoped repository rule is in the digest, and memory about a file comes with it once per conversation", () =>
    withFiles(
      {
        ".vector/RULES.md": "- Money is integer cents.\n- Keep handlers thin (applies to src/routes/**)\n",
        "src/routes/user.ts": "export const user = 1",
      },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const brain = yield* Brain.Service
          const place = yield* svc.place()
          // A scoped rule binds an edit, a write or a patch as much as a read, so every request carries it.
          const digest = yield* brain.digest(place, { personal: true, index: true })
          expect(digest.text).toContain("Keep handlers thin (applies to src/routes/**)")
          yield* brain.propose(place, {
            kind: "lesson",
            text: "Route handlers validate input with the shared schema helpers.",
            scope: "repository",
            origin: "user",
            paths: ["src/routes"],
          })
          const first = yield* svc.resolve([], path.join(dir, "src", "routes", "user.ts"), MessageID.make("msg_memory-1"))
          const attached = first.map((item) => item.content).join("\n")
          expect(attached).toContain("shared schema helpers")
          // The rule is already in the digest, so a read never repeats it.
          expect(attached).not.toContain("Keep handlers thin")
          // The same message reading the file again gets nothing more.
          expect(yield* svc.resolve([], path.join(dir, "src", "routes", "user.ts"), MessageID.make("msg_memory-1"))).toEqual(
            [],
          )
          // A later message sees the memory already attached in its history.
          const history = loaded(first.find((item) => item.filepath.startsWith("memory:"))!.filepath)
          expect(yield* svc.resolve(history, path.join(dir, "src", "routes", "user.ts"), MessageID.make("msg_memory-2"))).toEqual(
            [],
          )
        }),
    ),
  )

  it.live("an outward role's read brings the nearby instructions and no memory about the file", () =>
    withFiles(
      {
        "src/billing/AGENTS.md": "# Billing instructions",
        "src/billing/retry.ts": "export const attempts = 3",
      },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const brain = yield* Brain.Service
          yield* brain.propose(yield* svc.place(), {
            kind: "lesson",
            text: "Billing retries back off with jitter between attempts.",
            scope: "repository",
            origin: "user",
            paths: ["src/billing"],
          })
          const file = path.join(dir, "src", "billing", "retry.ts")
          const agents = path.join(dir, "src", "billing", "AGENTS.md")
          const asking: Instruction.Asking = {
            sessionID: "ses_outward_read",
            personal: false,
            tier: "standard",
            exclude: new Set(),
          }
          // An unattended session, a Vectorscope reviewer or a research lead the build agent started: the file's
          // nearby instructions still come, and nothing from memory comes with them.
          const outward = yield* svc.resolve([], file, MessageID.make("msg_outward-read-1"), {
            ...asking,
            outward: true,
          })
          expect(outward.map((item) => item.filepath)).toEqual([agents])
          expect(outward.map((item) => item.content).join("\n")).not.toContain("Vector's memory for")
          // The same read in another message, without `outward`, brings the instructions and the lesson.
          const owner = yield* svc.resolve([], file, MessageID.make("msg_outward-read-2"), asking)
          expect(owner.map((item) => item.filepath)).toEqual([agents, expect.stringMatching(/^memory:/)])
          expect(owner.map((item) => item.content).join("\n")).toContain(
            "Vector's memory for src/billing/retry.ts (rules bind; the rest is advisory):\n",
          )
          expect(owner.map((item) => item.content).join("\n")).toContain("back off with jitter")
        }),
    ),
  )
})
