import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { gitEnv, loadManifest, type Manifest } from "./dataset"
import { ADAPTERS, main, prepareCheckout, replayPlan } from "./replay"

// The replay driver without any model or network: the plan it builds from the seed manifest, and checkouts prepared
// from a local repository whose later history holds the fix.

const root = mkdtempSync(join(tmpdir(), "vectorscope-replay-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const mirror = buildMirror(join(root, "mirror"))

function buildMirror(dir: string) {
  mkdirSync(dir, { recursive: true })
  const env = {
    ...gitEnv(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  }
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", dir, ...args], { env, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
    return result.stdout.toString().trim()
  }
  const commit = (message: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    git("add", "--all")
    git("commit", "--quiet", "-m", message)
    return git("rev-parse", "HEAD")
  }
  git("init", "--quiet", "--initial-branch=main")
  const base = commit("base", { "app.py": "def total(items):\n    return sum(items)\n" })
  const head = commit("candidate", { "app.py": "def total(items):\n    return sum(items[1:])\n" })
  const fix = commit("fix", { "app.py": "def total(items):\n    # every item counts\n    return sum(items)\n" })
  return { dir, base, head, fix }
}

const view = { repository: "https://github.com/example/fixture", base: mirror.base, head: mirror.head }

function inCheckout(dir: string, ...args: string[]) {
  return Bun.spawnSync(["git", "-C", dir, ...args], { env: gitEnv(), stdout: "pipe", stderr: "pipe" })
}

describe("the replay plan", () => {
  test("builds each case's replay input from its view alone, untrusted, on a writer's request", async () => {
    const seed = (await loadManifest()) as Manifest
    const plan = replayPlan(seed, { split: "development" })
    const development = seed.cases.filter((item) => item.split === "development")
    expect(plan.map((entry) => entry.id)).toEqual(development.map((item) => item.id))
    for (const [index, entry] of plan.entries()) {
      const item = development[index]!
      expect(entry.case).toEqual({
        label: item.id,
        base: item.candidate.base,
        head: item.candidate.head,
        trust: "untrusted",
        trigger: "command",
        repository: {
          owner: item.repository.url.split("/")[3],
          repo: item.repository.url.split("/")[4],
          url: item.repository.url,
        },
      })
      // Nothing of the fix or the labels reaches the replay input.
      const sent = JSON.stringify(entry.case)
      if (item.fix) expect(sent).not.toContain(item.fix.sha)
      for (const defect of item.labels.defects) {
        expect(sent).not.toContain(defect.cause)
        expect(sent).not.toContain(defect.summary)
      }
      expect(entry.mirror).toBeUndefined()
    }
  })

  test("refuses held-out cases from a manifest that is not frozen, and names an unready adapter", async () => {
    const heldOut = await main(["--split", "held-out"])
    expect(heldOut.code).toBe(1)
    expect(heldOut.stderr).toContain("frozen")
    const desktop = await main(["--adapter", "desktop"])
    expect(desktop.code).toBe(2)
    expect(desktop.stderr).toContain(ADAPTERS.desktop.detail)
    expect(ADAPTERS.desktop.ready).toBe(false)
  })

  test("the dry run lists the development cases and says nothing was sent", async () => {
    const result = await main([])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("development case(s)")
    expect(result.stdout).toMatch(/Manifest sha256 [0-9a-f]{64}/)
    expect(result.stdout).toContain("Dry run: no model request was sent.")
  })
})

describe("replay checkouts", () => {
  test("hold the candidate and its history but not the fix, with the base checked out", () => {
    const directory = join(root, "checkout")
    expect(prepareCheckout({ mirror: mirror.dir, view, directory })).toEqual([])
    expect(inCheckout(directory, "cat-file", "-e", `${mirror.head}^{commit}`).exitCode).toBe(0)
    expect(inCheckout(directory, "cat-file", "-e", `${mirror.base}^{commit}`).exitCode).toBe(0)
    expect(inCheckout(directory, "cat-file", "-e", `${mirror.fix}^{commit}`).exitCode).not.toBe(0)
    expect(inCheckout(directory, "rev-parse", "HEAD").stdout.toString().trim()).toBe(mirror.base)
    expect(readFileSync(join(directory, "app.py"), "utf8")).toBe("def total(items):\n    return sum(items)\n")
    expect(inCheckout(directory, "remote").stdout.toString().trim()).toBe("")
  })

  test("refuse an existing directory, a remote URL and abbreviated commits", () => {
    expect(prepareCheckout({ mirror: mirror.dir, view, directory: mirror.dir })).toEqual([
      `${mirror.dir} already exists`,
    ])
    expect(prepareCheckout({ mirror: "https://github.com/example/fixture", view, directory: join(root, "a") })).toEqual(
      ["https://github.com/example/fixture is not a local mirror directory"],
    )
    expect(
      prepareCheckout({
        mirror: mirror.dir,
        view: { ...view, head: mirror.head.slice(0, 7) },
        directory: join(root, "b"),
      }),
    ).toEqual([`not full commit SHAs: ${mirror.head.slice(0, 7)}`])
  })
})
