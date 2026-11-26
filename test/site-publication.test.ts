import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pruneVectorSite } from "../script/prune-vector-site.mjs"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("publishes browser assets while excluding server code and nested private artifacts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vector-publication-"))
  directories.push(directory)
  await mkdir(path.join(directory, "_astro"))
  await mkdir(path.join(directory, "docs"))
  await mkdir(path.join(directory, "_worker.js"))
  await Promise.all(
    ["index.html", "_astro/browser.js", "_astro/browser.css", "docs/index.html"].map((file) =>
      writeFile(path.join(directory, file), "public"),
    ),
  )
  await Promise.all(
    ["_worker.js/server.js", "_astro/browser.js.map", "_astro/source.ts", "docs/.env", "docs/key.pem"].map((file) =>
      writeFile(path.join(directory, file), "private"),
    ),
  )
  await symlink(path.join(directory, "_worker.js"), path.join(directory, "_astro", "server-link"))

  await pruneVectorSite(directory)

  expect((await readdir(directory)).sort()).toEqual(["404.html", "_astro", "docs", "index.html"])
  expect((await readdir(path.join(directory, "_astro"))).sort()).toEqual(["browser.css", "browser.js"])
  expect(await readdir(path.join(directory, "docs"))).toEqual(["index.html"])
  expect(await readFile(path.join(directory, "404.html"), "utf8")).toBe("public")
})

test.each([
  ["a resolved path", (directory: string) => directory],
  ["a path with a trailing slash", (directory: string) => directory + path.sep],
])("keeps noindex pages and pages the prune deletes out of the published sitemap, given %s", async (_, given) => {
  const directory = await mkdtemp(path.join(tmpdir(), "vector-publication-"))
  directories.push(directory)
  await Promise.all(
    ["investors", "docs", "download", "dev/account-preview"].map((page) =>
      mkdir(path.join(directory, page), { recursive: true }),
    ),
  )
  await Promise.all(
    (
      [
        ["index.html", "<html><head><title>Vector</title></head></html>"],
        ["docs/index.html", "<html><head><title>Docs</title></head></html>"],
        ["download/index.html", "<html><head><title>Download</title></head></html>"],
        // /dev is not on the keep list, so the prune deletes this page even though it is indexable.
        ["dev/account-preview/index.html", "<html><head><title>Preview</title></head></html>"],
        ["investors/index.html", '<html><head><meta name="robots" content="noindex, nofollow"></head></html>'],
      ] satisfies [string, string][]
    ).map(([file, html]) => writeFile(path.join(directory, file), html)),
  )
  const url = (page: string) => `<url><loc>https://vectordev.ai/${page}</loc></url>`
  await writeFile(
    path.join(directory, "sitemap-0.xml"),
    `<?xml version="1.0" encoding="UTF-8"?><urlset>${["", "docs/", "investors/", "dev/account-preview/", "download/", "missing/"].map(url).join("")}</urlset>`,
  )

  await pruneVectorSite(given(directory))

  expect(await readFile(path.join(directory, "sitemap-0.xml"), "utf8")).toBe(
    `<?xml version="1.0" encoding="UTF-8"?><urlset>${["", "docs/", "download/"].map(url).join("")}</urlset>`,
  )
})
