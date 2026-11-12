import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { heldBack } from "@vectordevai/core/everywhere/publish"
import { BRANCH_PATTERN, HEAD_SHA_PATTERN, JOB_ID_PATTERN, isRepositoryName } from "@vectordevai/schema/everywhere"
import { parseGithubRemote } from "./github-api"

const SAFE_CONFIG = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|worktree|hookspath|fsmonitor|sshcommand|longpaths)|extensions\.(?:worktreeconfig|objectformat)|user\.(?:name|email)|(?:commit|tag)\.gpgsign|remote\.[a-z0-9_.-]+\.(?:url|pushurl|fetch|tagopt|prune)|branch\.[a-z0-9_./-]+\.(?:remote|merge|pushremote))$/i

/** Repository config cannot introduce a filter, include, URL rewrite, proxy, command, or credential helper. */
export function safeRepositoryConfig(text: string) {
  return text.split("\0").filter(Boolean).every((item) => SAFE_CONFIG.test(item.split("\n", 1)[0]!))
}

function mapsRepository(config: string, repository: string) {
  return config.split("\0").some((entry) => {
    const newline = entry.indexOf("\n")
    if (newline < 0 || !/^remote\.[a-z0-9_.-]+\.url$/i.test(entry.slice(0, newline))) return false
    const remote = parseGithubRemote(entry.slice(newline + 1))
    return remote !== undefined && `${remote.owner}/${remote.name}`.toLowerCase() === repository.toLowerCase()
  })
}

export const GIT_HARDENING = [
  "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", "-c", "core.sshCommand=",
  "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false", "-c", "credential.helper=", "-c", "core.pager=cat",
] as const

export function runnerGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH, HOME: source.HOME, USERPROFILE: source.USERPROFILE, SYSTEMROOT: source.SYSTEMROOT,
    TMPDIR: source.TMPDIR, TEMP: source.TEMP, SSH_AUTH_SOCK: source.SSH_AUTH_SOCK,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1", GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0",
  }
}

export type GitExec = (input: { readonly directory: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv; readonly signal?: AbortSignal }) => Promise<string>

const execute: GitExec = (input) => new Promise((resolve, reject) => {
  execFile("git", [...input.args], { cwd: input.directory, env: input.env, timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024, signal: input.signal }, (error, stdout) => {
    // Child-process errors quote their arguments. Never carry authentication or repository output into an error.
    if (error) return reject(new Error("The Everywhere git operation failed"))
    resolve(stdout)
  })
})

export type GitSnapshot = { readonly config: readonly { readonly file: string; readonly hash: string }[]; readonly pushUrl: string; readonly baseSha: string }

/** Git receives authentication in its own child environment only; it is never inherited by the engine. */
export function createEverywhereGit(input: {
  readonly directory: string
  readonly repository: string
  readonly execute?: GitExec
  readonly authenticate?: () => Promise<string | undefined>
  readonly identity: { readonly name: string; readonly email: string }
  readonly signal?: AbortSignal
}) {
  if (!isRepositoryName(input.repository)) throw new Error("Invalid Everywhere repository")
  const run = async (args: readonly string[], directory = input.directory, network = false) => {
    const authorization = network ? await input.authenticate?.() : undefined
    const env = runnerGitEnvironment()
    if (authorization) env.VECTOR_EVERYWHERE_GIT_AUTH = authorization
    return (input.execute ?? execute)({ directory, env, signal: input.signal,
      args: [...GIT_HARDENING, ...(authorization ? ["--config-env=http.https://github.com/.extraHeader=VECTOR_EVERYWHERE_GIT_AUTH"] : []), ...args] })
  }
  const hash = async (file: string) => {
    try {
      const value = await readFile(file)
      if (value.length > 256 * 1024) throw new Error("Everywhere git metadata is too large")
      return createHash("sha256").update(value).digest("hex")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"
      throw error
    }
  }
  const unchanged = async (snapshot: GitSnapshot) => {
    for (const item of snapshot.config) if (await hash(item.file) !== item.hash) return false
    return true
  }
  return {
    run,
    unchanged,
    async mapped() {
      const config = await run(["config", "--null", "--list", "--local", "--no-includes"])
      return safeRepositoryConfig(config) && mapsRepository(config, input.repository)
    },
    async snapshot(cwd = input.directory): Promise<GitSnapshot> {
      const config = await run(["config", "--null", "--list", "--local", "--no-includes"], cwd)
      if (!safeRepositoryConfig(config)) throw new Error("Everywhere refuses executable repository configuration")
      if (!mapsRepository(config, input.repository)) throw new Error("The Everywhere project remote does not match")
      const directory = (await run(["rev-parse", "--absolute-git-dir"], cwd)).trim()
      const common = path.resolve(cwd, (await run(["rev-parse", "--git-common-dir"], cwd)).trim())
      const files = [path.join(common, "config"), path.join(directory, "config.worktree"), path.join(common, "info", "attributes")]
      const baseSha = (await run(["rev-parse", "HEAD"], cwd)).trim()
      if (!HEAD_SHA_PATTERN.test(baseSha)) throw new Error("Invalid Everywhere base")
      return { config: await Promise.all(files.map(async (file) => ({ file, hash: await hash(file) }))),
        pushUrl: `https://github.com/${input.repository}.git`, baseSha }
    },
    async fetch(snapshot: GitSnapshot, base: string, jid: string) {
      if (!JOB_ID_PATTERN.test(jid) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(base) || base.includes("..") || !await unchanged(snapshot)) throw new Error("Everywhere git authority changed")
      const ref = `refs/vector-everywhere/${jid}`
      await run(["fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", snapshot.pushUrl, `refs/heads/${base}:${ref}`], input.directory, true)
      const from = (await run(["rev-parse", ref])).trim()
      if (!HEAD_SHA_PATTERN.test(from)) throw new Error("Invalid Everywhere fetched base")
      return from
    },
    async stage(snapshot: GitSnapshot, directory: string) {
      if (!await unchanged(snapshot)) return undefined
      await run(["add", "-A", "--", "."], directory)
      const files = (await run(["diff", "--cached", "--name-only", "-z"], directory)).split("\0").filter(Boolean)
      if (files.some((file) => file.startsWith("/") || file.split(/[\\/]/).includes(".."))) throw new Error("Invalid Everywhere changed path")
      const held = heldBack(files)
      for (const file of held) {
        const tracked = (await run(["ls-tree", "--name-only", "HEAD", "--", file], directory)).trim() !== ""
        if (tracked) await run(["restore", "--source=HEAD", "--staged", "--worktree", "--", file], directory)
        else {
          await run(["rm", "--cached", "-f", "--", file], directory)
          await rm(path.join(directory, file), { force: true, recursive: true })
        }
      }
      return { held, files: files.length - held.length, diff: await run(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary"], directory) }
    },
    async commit(snapshot: GitSnapshot, directory: string, message: string) {
      if (!await unchanged(snapshot) || !input.identity.name.trim() || !input.identity.email.trim() || /[\r\n\0]/.test(input.identity.name + input.identity.email)) return undefined
      await run(["-c", `user.name=${input.identity.name}`, "-c", `user.email=${input.identity.email}`, "commit", "--no-verify", "-m", message], directory)
      return (await run(["rev-parse", "HEAD"], directory)).trim()
    },
    async push(snapshot: GitSnapshot, directory: string, branch: string) {
      if (!BRANCH_PATTERN.test(branch) || !await unchanged(snapshot)) return false
      await run(["push", "--no-verify", "--", snapshot.pushUrl, `HEAD:refs/heads/${branch}`], directory, true)
      return true
    },
  }
}

export type RunnerGit = ReturnType<typeof createEverywhereGit>
