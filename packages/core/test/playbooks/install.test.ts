import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PlaybookInstall } from "../../src/playbooks/install"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })
const bytes = Buffer.from(JSON.stringify({ version: 1, title: "Check changes", stages: [{ id: "check", prompt: "Run `bun test`." }] }))
const link = { name: "vector-check", version: "1.0.0", sha256: createHash("sha256").update(bytes).digest("hex"), url: "https://downloads.example/vector-check" }
const request: PlaybookInstall.Request = async (_url, init) => {
  expect(init?.headers).toBeUndefined()
  expect(init?.redirect).toBe("error")
  return new Response(bytes)
}
const directory = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "playbook-install-"))
  roots.push(root)
  return root
}

test("an authenticated listing's exact bytes install atomically in personal workflows", async () => {
  const root = await directory()
  const installed = await PlaybookInstall.install({ link, directory: root, request })
  expect(installed.path).toBe(path.join(root, "workflows", "vector-check.json"))
  expect(await fs.readFile(installed.path)).toEqual(bytes)
  await expect(PlaybookInstall.install({ link, directory: root, request })).rejects.toThrow("already")
  await PlaybookInstall.install({ link, directory: root, request, replace: true })
  expect(await fs.readdir(path.join(root, "workflows"))).toEqual(["vector-check.json"])
})

test("damaged, oversized and invalid workflow downloads leave no installed file", async () => {
  const root = await directory()
  await expect(PlaybookInstall.install({ link: { ...link, sha256: "0".repeat(64) }, directory: root, request })).rejects.toThrow("SHA-256")
  await expect(PlaybookInstall.download(link, async () => new Response(new Uint8Array(256 * 1024 + 1)))).rejects.toThrow("256 KiB")
  const invalid = Buffer.from('{"version":1,"title":"Invalid","stages":[]}')
  await expect(PlaybookInstall.download({ ...link, sha256: createHash("sha256").update(invalid).digest("hex") }, async () => new Response(invalid))).rejects.toThrow()
  expect(await fs.readdir(root)).toEqual([])
})

test("symlinks and project-shaped names cannot redirect a playbook write", async () => {
  const root = await directory()
  const outside = await directory()
  await fs.symlink(outside, path.join(root, "workflows"), process.platform === "win32" ? "junction" : "dir")
  await expect(PlaybookInstall.install({ link, directory: root, request })).rejects.toThrow("symbolic")
  expect(await fs.readdir(outside)).toEqual([])
  await expect(PlaybookInstall.download({ ...link, name: "../project" }, request)).rejects.toThrow("listing")
})
