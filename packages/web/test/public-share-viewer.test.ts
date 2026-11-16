import { expect, test } from "bun:test"
import { readSnapshot, shareID } from "../src/components/share/snapshot"
import { PublicSession } from "@vectordevai/schema/public-session"

const id = "a".repeat(32)
const snapshot: PublicSession.Snapshot = {
  id,
  url: `https://vectordev.ai/s/${id}`,
  expiresAt: Date.now() + 86_400_000,
  updatedAt: Date.now(),
  revision: 1,
  updates: false,
  archive: {
    version: 1,
    engine: "v2",
    title: "Visible history",
    messages: [{ id: "message-1", role: "user", createdAt: 1, parts: [{ type: "text", text: "Hello" }] }],
  },
}
const signal = () => new AbortController().signal

test("viewer accepts only exact public IDs and fixed credential-free Vector fetches", async () => {
  expect(shareID(`/s/${id}`)).toBe(id)
  expect(shareID(`/s/${id}/`)).toBe(id)
  for (const path of ["/s/../secret", `/s/${id}/extra`, `/s/${id.toUpperCase()}`, `/s/${id}?api=evil`, "/s/"])
    expect(shareID(path)).toBeUndefined()
  const result = await readSnapshot(id, signal(), async (input, init) => {
    expect(input).toBe(`https://vectordev.ai/api/shares/${id}`)
    expect(init).toMatchObject({
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
    })
    return Response.json(snapshot)
  })
  expect(result).toEqual(snapshot)
})

test("public reader rejects malformed, private, mismatched and oversized snapshots", async () => {
  for (const value of [
    { ...snapshot, id: "b".repeat(32) },
    { ...snapshot, url: `https://vectordev.ai/s/${"b".repeat(32)}` },
    { ...snapshot, secret: "private-management-key" },
    {
      ...snapshot,
      archive: { ...snapshot.archive, messages: [{ ...snapshot.archive.messages[0], directory: "/private/work" }] },
    },
    { ...snapshot, archive: { ...snapshot.archive, version: 42 } },
  ])
    await expect(readSnapshot(id, signal(), async () => Response.json(value))).rejects.toThrow()
  await expect(readSnapshot(id, signal(), async () => new Response("{"))).rejects.toThrow()
  await expect(
    readSnapshot(id, signal(), async () => new Response(" ".repeat(PublicSession.MAX_RESPONSE_BYTES + 1))),
  ).rejects.toThrow("size")
})

test("opted-in computer screenshots pass the viewer boundary only as exact, bounded embedded images", async () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
  const computer = (screenshots: unknown[]) => ({
    ...snapshot,
    archive: {
      ...snapshot.archive,
      messages: [
        {
          id: "message-2",
          role: "assistant",
          createdAt: 2,
          parts: [
            {
              type: "tool",
              name: "computer",
              callID: "call",
              status: "completed",
              input: "{}",
              output: "Notes is open",
              screenshots,
            },
          ],
        },
      ],
    },
  })
  const shot = { name: "screen.png", mediaType: "image/png", url: png }
  expect<unknown>(await readSnapshot(id, signal(), async () => Response.json(computer([shot])))).toEqual(
    computer([shot]),
  )
  // The viewer refuses fields the public schema does not define, such as a local path beside the image.
  await expect(
    readSnapshot(id, signal(), async () => Response.json(computer([{ ...shot, path: "/Users/me/screen.png" }]))),
  ).rejects.toThrow()
  // Each image fits the schema, but together they pass the response limit, which still applies before decoding.
  const half = { ...shot, url: `data:image/png;base64,${"A".repeat(PublicSession.MAX_RESPONSE_BYTES / 2)}` }
  await expect(readSnapshot(id, signal(), async () => Response.json(computer([half, half])))).rejects.toThrow("size")
})

test("expired and removed copies expose no transcript; temporary failures remain errors", async () => {
  for (const status of [404, 410])
    expect(await readSnapshot(id, signal(), async () => new Response(null, { status }))).toBeUndefined()
  expect(await readSnapshot(id, signal(), async () => Response.json({ ...snapshot, expiresAt: 1 }))).toBeUndefined()
  await expect(readSnapshot(id, signal(), async () => new Response(null, { status: 503 }))).rejects.toThrow()
})

test("production shell survives the actual prune script and has the owned rewrite and privacy headers", async () => {
  const { mkdtemp, mkdir, cp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = await mkdtemp(join(tmpdir(), "vector-share-prune-"))
  try {
    const dist = join(root, "packages/web/dist")
    await mkdir(join(root, "script"), { recursive: true })
    await mkdir(join(dist, "s"), { recursive: true })
    await mkdir(join(dist, "_astro"), { recursive: true })
    await mkdir(join(dist, "unpublished"), { recursive: true })
    await Bun.write(join(dist, "index.html"), "landing")
    await Bun.write(join(dist, "s/index.html"), "public viewer")
    await Bun.write(join(dist, "_astro/viewer.js"), "viewer asset")
    await cp(
      new URL("../../../script/prune-vector-site.mjs", import.meta.url),
      join(root, "script/prune-vector-site.mjs"),
    )
    const process = Bun.spawn(["node", join(root, "script/prune-vector-site.mjs")], { stdout: "pipe", stderr: "pipe" })
    expect(await process.exited).toBe(0)
    expect(await Bun.file(join(dist, "s/index.html")).text()).toBe("public viewer")
    expect(await Bun.file(join(dist, "_astro/viewer.js")).exists()).toBe(true)
    expect(await Bun.file(join(dist, "unpublished")).exists()).toBe(false)
    const config = await Bun.file(new URL("../../../vercel.json", import.meta.url)).json()
    expect(config.rewrites).toContainEqual({ source: "/s/:id([a-f0-9]{32})", destination: "/s/index.html" })
    const headers = config.headers.find((entry: { source: string }) => entry.source === "/s/:path*").headers
    expect(headers).toContainEqual({ key: "Cache-Control", value: "no-store" })
    expect(headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" })
    expect(headers).toContainEqual({ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
