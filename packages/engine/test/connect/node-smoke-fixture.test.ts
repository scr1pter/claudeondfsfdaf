import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { devNull } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { connectSmokeGitEnvironment, prepareConnectSmokeRepository } from "../../script/smoke-connect-fixture"
import { tmpdir } from "../../../core/test/fixture/tmpdir"

const execute = promisify(execFile)

test("the Connect smoke fixture is an actual clean committed Git repository before any engine request", async () => {
  await using root = await tmpdir()
  const ordinary = path.join(root.path, "project")
  await mkdir(ordinary)
  await writeFile(path.join(ordinary, "notes.txt"), "ordinary smoke unchanged")
  const directory = path.join(root.path, "connect-project")
  expect(await prepareConnectSmokeRepository(directory)).toBe(directory)
  const git = async (args: string[]) =>
    (
      await execute("git", args, { cwd: directory, env: connectSmokeGitEnvironment(root.path), timeout: 5000 })
    ).stdout.trim()
  expect(await git(["rev-parse", "--show-toplevel"])).toBe(directory)
  expect(await git(["rev-parse", "--verify", "HEAD^{commit}"])).toMatch(/^[0-9a-f]{40}$/)
  expect(await git(["status", "--porcelain=v1", "--untracked-files=all"])).toBe("")
  expect(await git(["show", "HEAD:review-fixture.txt"])).toBe("Connected review smoke fixture.")
  expect(await git(["log", "-1", "--format=%an <%ae>"])).toBe("Vector <bot@vectordev.ai>")
  expect(await git(["remote"])).toBe("")
  await expect(access(path.join(ordinary, ".git"))).rejects.toThrow()
  expect(await readFile(path.join(ordinary, "notes.txt"), "utf8")).toBe("ordinary smoke unchanged")
})

test("Git fixture children exclude inherited credentials, redirects, config and trace settings", () => {
  const environment = connectSmokeGitEnvironment("/fixture/home", {
    PATH: "/fixture/bin",
    SystemRoot: "C:\\Windows",
    GIT_DIR: "/foreign/git",
    GIT_WORK_TREE: "/foreign/work",
    GIT_CONFIG_GLOBAL: "/foreign/config",
    GIT_CONFIG_PARAMETERS: "fixture poisoning",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/foreign/hooks",
    GIT_TRACE: "/foreign/trace",
    SSH_AUTH_SOCK: "/foreign/agent",
    GITHUB_TOKEN: "dummy-unusable-token",
  })
  expect(environment).toEqual({
    PATH: "/fixture/bin",
    SystemRoot: "C:\\Windows",
    HOME: "/fixture/home",
    USERPROFILE: "/fixture/home",
    XDG_CONFIG_HOME: "/fixture/home",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  })
})

test("Connect smoke setup refuses an existing directory without adopting or modifying its files", async () => {
  await using root = await tmpdir()
  const marker = path.join(root.path, "keep.txt")
  await writeFile(marker, "original fixture")
  await expect(prepareConnectSmokeRepository(root.path)).rejects.toThrow()
  expect(await readFile(marker, "utf8")).toBe("original fixture")
})
