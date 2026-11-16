import { expect, test } from "bun:test"
import path from "node:path"

// Notes written on a person's machine kept that machine's home folder, and with it the person's account name, in
// paths such as /Users/<name>/.cache/vector-connect/docs/... A file in this repository is named by its repository
// path, and anything else on a machine by ~/ or $HOME. Only the generic accounts of CI runners, sandboxes and
// containers may appear.
const root = path.resolve(import.meta.dir, "..")
// A web address such as example.com/news/home/123/ is not a home folder, so the path must not follow a word.
const home = /(?<![\w.-])(?:\/Users|\/home)\/([A-Za-z0-9._-]+)\//g
const generic = new Set(["runner", "runneradmin", "user", "vector"])
// Recorded benchmark runs are frozen evidence and are never edited.
const frozen = "docs/benchmarks/"

test("documentation names no person's home folder", async () => {
  const files = [
    ...new Bun.Glob("docs/**/*.{md,json}").scanSync({ cwd: root }),
    ...new Bun.Glob("**/{AGENTS,README,CLAUDE}.md").scanSync({ cwd: root }),
    ...new Bun.Glob("script/**/*.md").scanSync({ cwd: root }),
  ]
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.startsWith(frozen) && !file.includes("node_modules/"))
  expect(files).toContain("docs/vector/build/vector-everywhere-spec.md")
  const found = (
    await Promise.all(
      [...new Set(files)].map(async (file) =>
        [...(await Bun.file(path.join(root, file)).text()).matchAll(home)]
          .filter((match) => !generic.has(match[1]!))
          .map((match) => ({ file, path: match[0] })),
      ),
    )
  ).flat()
  expect(found).toEqual([])
})
