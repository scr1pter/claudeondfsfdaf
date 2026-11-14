import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Result } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { LayerNodePlatform } from "@vectordevai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { PlaybookClient } from "@/orchestration/playbooks"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem])))
const bytes = Buffer.from(JSON.stringify({ version: 1, title: "Check changes", stages: [{ id: "check", prompt: "Run `bun test`." }] }))
const entry = { name: "vector-check", version: "1.0.0", sha256: createHash("sha256").update(bytes).digest("hex"), url: "https://downloads.example/checked" }
const auth = { get: () => Effect.succeed({ type: "api" as const, key: "vct_fixture" }) }

describe("owner Playbooks client", () => {
  it.live("installs exactly the selected current release and never forwards account auth to a signed link", () => Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    let listed = 0
    let downloaded = 0
    const client = PlaybookClient.make({ auth, directory, environment: () => undefined,
      request: async (url, init) => {
        expect(init?.redirect).toBe("error")
        if (url.endsWith("/api/account/playbooks")) {
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer vct_fixture")
          listed++
          return Response.json([entry])
        }
        expect(url).toBe(entry.url)
        expect(init?.headers).toBeUndefined()
        downloaded++
        return new Response(bytes)
      },
    })
    expect(yield* client.list()).toEqual([{ name: entry.name, version: entry.version, sha256: entry.sha256, installed: false, current: false }])
    expect(yield* client.install(entry)).toEqual({ name: entry.name, version: entry.version })
    expect((yield* client.list())[0]).toMatchObject({ installed: true, current: true })
    expect(downloaded).toBe(1)
    expect(listed).toBe(3)
    expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "workflows/vector-check.json")))).toEqual(bytes)
    // The browser never receives the signed download URL from this local API.
    expect(JSON.stringify(yield* client.list())).not.toContain("downloads.example")
  }))
  it.live("a changed version or digest requires a new selection before any file download", () => Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    let downloaded = 0
    const client = PlaybookClient.make({ auth, directory, environment: () => undefined,
      request: async (url) => {
        if (url.endsWith("/api/account/playbooks")) return Response.json([{ ...entry, version: "1.0.1" }])
        downloaded++
        return new Response(bytes)
      },
    })
    const result = yield* client.install(entry).pipe(Effect.result)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toContain("Refresh")
    expect(downloaded).toBe(0)
    expect(yield* Effect.promise(() => fs.readdir(directory))).toEqual([])
  }))
})
