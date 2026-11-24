import { afterEach, expect } from "bun:test"
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { BrainRunBundle } from "@vectordevai/core/brain/run-bundle"
import { BrainRunProposals } from "@vectordevai/core/brain/run-proposals"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { ConfigProvider, Context, Effect, Layer } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createGithubAgentsBrain } from "../../../desktop/src/main/github-agents-brain"
import { encryptConversation } from "../../src/cli/cmd/github.session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

const run = { repositoryId: "41", thread: "dispatch-99", rid: "gh-41-99-1-7" }
const lesson = "Run the parser fixtures after changing a delimiter."
const sessionText = "This synthetic session stays inside its encrypted archive."
const ownerAuth = `Basic ${Buffer.from("vector:fixture-owner").toString("base64")}`
const it = testEffect(
  httpApiLayer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ VECTOR_SERVER_USERNAME: "vector", VECTOR_SERVER_PASSWORD: "fixture-owner" }),
      ),
    ),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

async function artifact() {
  const memory = { format: "vector-memory", version: 1, scope: "repository", exportedAt: 30, documents: [] } as const
  const bundle = await BrainRunBundle.pack({
    ownerStartedDesktop: true,
    includeBrain: true,
    publicRepository: false,
    memory: { ...memory, entries: [] },
    shareableSkills: [],
    insights: { format: "vector-workflow-insights", version: 1, rows: [] },
    screen: async () => [],
  })
  const proposals = await BrainRunProposals.pack({
    memory: {
      ...memory,
      entries: [
        {
          id: "fixture-parser-delimiter",
          scope: "repository",
          kind: "lesson",
          status: "proposed",
          text: lesson,
          paths: [],
          pinned: false,
          evidence: [],
          createdAt: 20,
        },
      ],
    },
    startedAt: 10,
    publicRepository: false,
    maxBytes: BrainRunProposals.MAX_BYTES - bundle.bytes.byteLength,
    screen: async () => [true],
  })
  if (!proposals) throw new Error("The fixture did not pack a returned Brain proposal")
  const key = { key: Buffer.alloc(32, 9).toString("base64url"), keyId: "0123456789abcdef" }
  const sealed = await encryptConversation({
    identity: run,
    key,
    session: { messages: [sessionText] },
    brain: {
      path: BrainRunBundle.PATH,
      bytes: bundle.bytes,
      approval: {
        source: "desktop",
        audience: "owner-desktop",
        repositoryId: run.repositoryId,
        publicRepository: false,
        sha256: bundle.sha256,
        approvedAt: 5,
      },
    },
    proposals: { ...proposals, path: BrainRunProposals.PATH },
  })
  const writer = new ZipWriter(new Uint8ArrayWriter())
  await writer.add(GithubAgents.SESSION_FILE, new Uint8ArrayReader(sealed), {
    level: 0,
    useWebWorkers: false,
    useCompressionStream: false,
  })
  return { key, zip: await writer.close(), proposals }
}

const fixture = Effect.fn("ReturnedBrainHttpTest.fixture")(function* () {
  const directory = yield* tmpdirScoped({ git: true, trusted: true })
  const engine = yield* HttpServer.HttpServer
  const origin = HttpServer.formatAddress(engine.address)
  const archive = yield* Effect.promise(artifact)

  // The local Engine is real. A second loopback server serves GitHub artifact metadata and the encrypted ZIP.
  const context = yield* Layer.build(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
  const github = Context.get(context, HttpServer.HttpServer)
  const githubOrigin = HttpServer.formatAddress(github.address)
  const metadataPath = "/repos/fixture/repository/actions/artifacts/7"
  yield* github.serve(
    HttpServerRequest.HttpServerRequest.use((request) => {
      if (request.method !== "GET" || request.headers.authorization !== "Bearer fixture-github")
        return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
      if (request.url === metadataPath)
        return HttpServerResponse.json({
          id: 7,
          name: GithubAgents.sessionArtifact(run.thread),
          expired: false,
          workflow_run: { id: 99, repository_id: 41 },
        })
      if (request.url === `${metadataPath}/zip`)
        return Effect.succeed(HttpServerResponse.uint8Array(archive.zip, { contentType: "application/zip" }))
      return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
    }),
  )

  const receipt = { artifactId: "7", reads: 0 }
  const desktopToken = "fixture-desktop-account"
  const authorityId = "fixture-repository-authority"
  const imports: Array<{ body: string; authorization: string | null }> = []
  const fetchLocal: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.origin === origin) {
        expect(url.pathname).toBe("/experimental/brain/run-proposals/import")
        expect(url.searchParams.get("directory")).toBe(directory)
        imports.push({ body: await request.clone().text(), authorization: request.headers.get("authorization") })
      } else {
        expect(url.origin).toBe(githubOrigin)
      }
      return fetch(request)
    },
    {
      preconnect: () => {
        throw new Error("Unexpected eager connection")
      },
    },
  )
  const desktop = createGithubAgentsBrain({
    token: async () => desktopToken,
    context: async (cwd) => {
      expect(cwd).toBe(directory)
      return {
        authority: authorityId,
        access: { token: "fixture-github", source: "vector", apiUrl: githubOrigin },
        info: { id: 41, full_name: "fixture/repository", private: true, permissions: { push: true } },
      }
    },
    vector: async (path, body, account, scope) => {
      expect(path).toBe("/api/cloud-agents/owner-artifact-key")
      expect(body).toEqual({ rid: run.rid, artifactId: "7" })
      expect(account).toBe(new Bun.CryptoHasher("sha256").update(desktopToken).digest("hex"))
      expect(scope).toEqual({ cwd: directory, authorityId })
      receipt.reads++
      return {
        ...run,
        ...archive.key,
        artifactId: receipt.artifactId,
        publicRepository: false,
        historicalPublicRepository: false,
      }
    },
    engine: async () => ({ url: origin, username: "vector", password: "fixture-owner" }),
    fetch: fetchLocal,
  })
  yield* Effect.addFinalizer(() => Effect.sync(desktop.clear))

  const preview = () => desktop.previewReturned({ cwd: directory, rid: run.rid, artifactId: "7" })
  const refusedImport = (input: Parameters<typeof desktop.importReturned>[0]) =>
    Effect.flip(Effect.tryPromise({ try: () => desktop.importReturned(input), catch: String }))
  const memory = (filter: "review" | "active" | "all") =>
    Effect.promise(async () => {
      const response = await fetch(new URL(`/memory?scope=repository&filter=${filter}`, origin), {
        headers: { "x-vector-directory": directory, authorization: ownerAuth },
      })
      expect(response.status).toBe(200)
      return response.json()
    })
  return { desktop, preview, refusedImport, memory, receipt, imports, proposals: archive.proposals }
})

it.live("returned Brain import requires the previewed digest and a current owner receipt", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const preview = yield* Effect.promise(f.preview)
    expect(preview.sha256).toBe(f.proposals.sha256)
    expect(f.imports).toEqual([])
    expect(yield* f.memory("all")).toMatchObject({ entries: [] })
    expect(yield* f.refusedImport({ previewId: preview.id, approvedSha256: "0".repeat(64) })).toContain(
      "Review and approve this exact attachment again",
    )
    expect(f.receipt.reads).toBe(1)

    f.receipt.artifactId = "8"
    expect(yield* f.refusedImport({ previewId: preview.id, approvedSha256: preview.sha256 })).toContain(
      "no longer authorized",
    )
    expect(f.receipt.reads).toBe(2)
    expect(f.imports).toEqual([])
    expect(yield* f.memory("all")).toMatchObject({ entries: [] })
  }),
)

it.live("the real owner Engine stages the decrypted draft only once at its approved digest", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const preview = yield* Effect.promise(f.preview)
    expect(JSON.parse(preview.text)).toMatchObject({ memory: { entries: [{ text: lesson }] } })
    expect(preview.text).not.toContain(sessionText)
    const consent = { previewId: preview.id, approvedSha256: preview.sha256 }
    expect(yield* Effect.promise(() => f.desktop.importReturned(consent))).toEqual({
      proposed: 1,
      known: 0,
      refused: 0,
      over: 0,
    })
    expect(yield* f.refusedImport(consent)).toContain("Review and approve this exact attachment again")
    expect(f.receipt.reads).toBe(2)
    expect(f.imports).toHaveLength(1)
    expect(f.imports[0].authorization).toBe(ownerAuth)
    expect(JSON.parse(f.imports[0].body)).toEqual({
      path: f.proposals.path,
      sha256: f.proposals.sha256,
      base64url: f.proposals.bytes.toString("base64url"),
      publicRepository: false,
    })
    expect(yield* f.memory("review")).toMatchObject({
      entries: [{ text: lesson, status: "proposed", pinned: false, scope: "repository", origin: "import" }],
    })
    expect(yield* f.memory("active")).toMatchObject({ entries: [] })
  }),
)
