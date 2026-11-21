import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { GIT_HARDENING, runnerGitEnvironment } from "../../src/everywhere/git"

// The environment and flags both the runner's git (desktop everywhere-git.ts) and the engine's unattended checkout start
// git with.
describe("EverywhereGit", () => {
  test("the environment passes only the named variables and turns off system and global config", () => {
    const source = {
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      USERPROFILE: "C:\\Users\\fixture",
      SYSTEMROOT: "C:\\Windows",
      TMPDIR: "/fixture/tmp",
      TEMP: "C:\\Temp",
      SSH_AUTH_SOCK: "/fixture/agent.sock",
      GIT_DIR: "/fixture/elsewhere",
      GIT_CONFIG_GLOBAL: "/fixture/home/.gitconfig",
      GIT_CONFIG_COUNT: "1",
      XDG_CONFIG_HOME: "/fixture/home/.config",
      GITHUB_TOKEN: "generated-test-secret",
    }
    expect(runnerGitEnvironment(source)).toEqual({
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      USERPROFILE: "C:\\Users\\fixture",
      SYSTEMROOT: "C:\\Windows",
      TMPDIR: "/fixture/tmp",
      TEMP: "C:\\Temp",
      SSH_AUTH_SOCK: "/fixture/agent.sock",
      GIT_CONFIG_NOSYSTEM: "1",
      // The same on every platform: Git for Windows refuses os.devNull (\\.\nul) as a config file.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0",
    })
  })

  test("hooks are looked up under the null device, which can hold none", () => {
    expect(GIT_HARDENING.slice(0, 2)).toEqual(["-c", `core.hooksPath=${os.devNull}`])
  })

  test("real git started with them reads a repository and sees only its config and the command line", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "everywhere-git-environment-"))
    const git = (...args: string[]) =>
      execFileSync("git", [...GIT_HARDENING, ...args], {
        cwd: directory,
        env: runnerGitEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      }).toString()
    try {
      git("init", "-q")
      expect(git("rev-parse", "--git-common-dir").trim()).toBe(".git")
      const scopes = git("config", "--list", "--show-scope")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t", 1)[0])
      expect(new Set(scopes)).toEqual(new Set(["local", "command"]))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
