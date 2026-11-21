import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Schema, SchemaAST } from "effect"
import { COMPUTER_CAPS } from "@vectordevai/schema/everywhere"
import { Config } from "@vectordevai/core/config"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { Location } from "@vectordevai/core/location"
import { Policy } from "@vectordevai/core/policy"
import { AbsolutePath } from "@vectordevai/core/schema"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { ConfigEverywhereV1 } from "@vectordevai/core/v1/config/everywhere"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// VE-40: the user config key `everywhere`. Pure decodes, plus one real load through core's config loader.
const it = testEffect(Layer.empty)
const user = {
  enabled: true,
  max_usd: 5,
  minutes: 30,
  at_once: 2,
  per_day: 10,
  model: "anthropic/claude-x",
  wait_for_computer: false,
  push: false,
  stay_awake: true,
  projects: [{ directory: "/home/u/repo", repository: "acme/widgets" }],
}
const accepted = (everywhere: unknown, options?: SchemaAST.ParseOptions) =>
  Exit.isSuccess(Schema.decodeUnknownExit(ConfigV1.Info)({ everywhere }, options))
const project = (directory: unknown, repository: unknown = "acme/widgets") => ({
  projects: [{ directory, repository }],
})

describe("everywhere config", () => {
  test("off unless the user turns it on", () => {
    expect(ConfigEverywhereV1.Defaults).toEqual({
      enabled: false,
      max_usd: 2,
      minutes: 45,
      at_once: 1,
      per_day: 20,
      wait_for_computer: true,
      push: true,
      stay_awake: false,
      projects: [],
    })
    expect(ConfigEverywhereV1.Defaults).toMatchObject({
      max_usd: COMPUTER_CAPS.maxUsd.default,
      minutes: COMPUTER_CAPS.minutes.default,
      at_once: COMPUTER_CAPS.atOnce.default,
      per_day: COMPUTER_CAPS.perDay.default,
    })
    // Every key but `model` has a default; an absent model means the user's own default model.
    expect(Object.keys(ConfigEverywhereV1.Defaults).sort()).toEqual(
      Object.keys(ConfigEverywhereV1.Info.fields)
        .filter((key) => key !== "model")
        .sort(),
    )
    const decode = Schema.decodeUnknownSync(ConfigV1.Info)
    expect(decode({}).everywhere).toBeUndefined()
    // A file stays as written: decoding writes no default back.
    expect(decode({ everywhere: {} }).everywhere).toEqual({})
    expect(decode({ everywhere: user }).everywhere).toEqual(user)
  })

  test("every key decodes at its bounds", () => {
    const low = {
      enabled: false,
      max_usd: 0.01,
      minutes: 1,
      at_once: 1,
      per_day: 1,
      model: "openrouter/a/b",
      wait_for_computer: true,
      push: true,
      stay_awake: false,
      projects: [
        { directory: "/home/u/repo", repository: "acme/widgets" },
        { directory: "C:\\Users\\u\\repo", repository: "a/b" },
        { directory: "D:/work/repo", repository: "a-b/c.d_e" },
        { directory: "\\\\server\\share\\repo", repository: "acme/widgets" },
      ],
    }
    const high = {
      ...user,
      max_usd: COMPUTER_CAPS.maxUsd.max,
      minutes: COMPUTER_CAPS.minutes.max,
      at_once: COMPUTER_CAPS.atOnce.max,
      per_day: COMPUTER_CAPS.perDay.max,
    }
    const decode = Schema.decodeUnknownSync(ConfigV1.Info)
    for (const everywhere of [low, high]) expect(decode({ everywhere }).everywhere).toEqual(everywhere)
  })

  test("caps outside the runner's bounds are refused", () => {
    const refused = {
      max_usd: [0, -1, COMPUTER_CAPS.maxUsd.max + 0.01, Infinity, NaN, "2"],
      minutes: [0, -1, COMPUTER_CAPS.minutes.max + 1, 1.5, "45"],
      at_once: [0, -1, COMPUTER_CAPS.atOnce.max + 1, 1.5],
      per_day: [0, -1, COMPUTER_CAPS.perDay.max + 1, 2.5],
    }
    for (const [key, values] of Object.entries(refused))
      for (const value of values) expect([key, value, accepted({ [key]: value })]).toEqual([key, value, false])
  })

  test("projects are absolute folders on one line, each with its repository", () => {
    for (const directory of [
      "repo",
      "./repo",
      "~/repo",
      "",
      "/",
      "C:\\",
      "C:",
      "C:repo",
      "\\repo",
      "\\\\server",
      "//server/share",
      "/a//b",
      "/a/",
      "C:\\a\\",
      // A drive-letter path keeps one separator throughout.
      "C:\\a/b",
      "D:/a\\b",
      "/a/./b",
      "/a/../b",
      "/a/..",
      "/a\nb",
      "/a\rb",
      "/a\u0000b",
      `/${"a".repeat(4096)}`,
      42,
      // `.` and `..` are refused as any folder name, under every root form.
      "/.",
      "/..",
      "/./a",
      "/../a",
      "C:\\..",
      "C:/.",
      "C:/../a",
      "\\\\..\\share",
      "\\\\server\\.",
      "\\\\server\\share\\..",
    ])
      expect([directory, accepted(project(directory))]).toEqual([directory, false])
    // Names that only start or end with dots are folders like any other.
    for (const directory of ["/.a", "/a.", "/...", "/..a", "C:\\.git", "D:/..x", "\\\\server\\..x", "\\\\.s\\share"])
      expect([directory, accepted(project(directory))]).toEqual([directory, true])
    for (const repository of ["widgets", "acme/", "/widgets", "acme/widgets/x", "acme/wid gets", "acme/w\nx", ""])
      expect([repository, accepted(project("/home/u/repo", repository))]).toEqual([repository, false])
    expect(accepted(project(`/${"a".repeat(4095)}`))).toBe(true)
    expect(accepted(project("/a/.git/..b/...c"))).toBe(true)
    expect(accepted({ projects: [{ directory: "/home/u/repo" }] })).toBe(false)
    expect(accepted({ projects: "/home/u/repo" })).toBe(false)
    expect(accepted({ projects: ["/home/u/repo"] })).toBe(false)
    // The same spelling listed twice is refused, whatever its repository. Case and links are not normalized (see
    // DIRECTORY), so this does not make each folder unique.
    expect(
      accepted({
        projects: [
          { directory: "/home/u/repo", repository: "acme/widgets" },
          { directory: "/home/u/repo", repository: "acme/other" },
        ],
      }),
    ).toBe(false)
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ directory: `/home/u/repo${index}`, repository: "acme/widgets" }))
    expect(accepted({ projects: many(64) })).toBe(true)
    expect(accepted({ projects: many(65) })).toBe(false)
  })

  test("model is provider/model", () => {
    for (const model of ["", "gpt", "/m", "p/", "p/m\nx", "p\r/m", 7])
      expect([model, accepted({ model })]).toEqual([model, false])
  })

  test("booleans are booleans", () => {
    for (const key of ["enabled", "wait_for_computer", "push", "stay_awake"])
      for (const value of ["true", 1, null])
        expect([key, value, accepted({ [key]: value })]).toEqual([key, value, false])
  })

  test("unknown keys are refused whatever the caller's option", () => {
    // Core's loader passes onExcessProperty "ignore" and the engine's parser passes errors "all"; the schema's own
    // option wins over both.
    const options = [
      undefined,
      { onExcessProperty: "ignore" },
      { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" },
      { errors: "all", propertyOrder: "original" },
    ] as const
    for (const option of options) {
      expect(accepted({ enabled: false, pushh: false }, option)).toBe(false)
      expect(accepted({ maxUsd: 5 }, option)).toBe(false)
      expect(
        accepted({ projects: [{ directory: "/home/u/repo", repository: "acme/widgets", base: "main" }] }, option),
      ).toBe(false)
      expect(Exit.isSuccess(Schema.decodeUnknownExit(ConfigEverywhereV1.Info)({ push: false, typo: 1 }, option))).toBe(
        false,
      )
      expect(accepted(user, option)).toBe(true)
    }
  })

  // The price of refusing unknown keys: an invalid block makes the whole file invalid, as an out-of-range value in any
  // other block already does. Core's loader then skips that file, its permission rules included.
  it.live("core's loader skips a user file whose everywhere block is invalid, and loads it once fixed", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const file = path.join(global, "vector.json")
        const permission = { bash: "deny" }
        const documents = Effect.gen(function* () {
          const config = yield* Config.Service
          return (yield* config.entries()).flatMap((entry) =>
            entry.type === "document" && entry.path === file ? [entry] : [],
          )
        }).pipe(Effect.provide(testLayer(tmp.path, global)))
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.writeFile(file, JSON.stringify({ permission, everywhere: { enabled: false, pushh: false } }))
          })
          expect(yield* documents).toEqual([])
          yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ permission, everywhere: { push: false } })))
          expect((yield* documents).length).toBe(1)
        })
      }),
    ),
  )
})

function testLayer(directory: string, globalDirectory: string) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(directory) }),
    ),
  )
  return AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
    [Location.node, locationLayer],
    [
      Global.node,
      Global.layerWith({
        config: globalDirectory,
        home: path.join(directory, "home"),
        state: path.join(path.dirname(globalDirectory), "state"),
      }),
    ],
  ])
}
