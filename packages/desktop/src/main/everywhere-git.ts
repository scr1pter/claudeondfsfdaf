import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { GIT_HARDENING, fetchRef, runnerGitEnvironment, safeRepositoryConfig } from "@vectordevai/core/everywhere/git"
import { heldBack } from "@vectordevai/core/everywhere/publish"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { BRANCH_PATTERN, HEAD_SHA_PATTERN, JOB_ID_PATTERN, isRepositoryName } from "@vectordevai/schema/everywhere"
import { parseGithubRemote } from "./github-api"

// The allowlist, flags and environment are shared with the engine's unattended checkout (EV-12).
export { GIT_HARDENING, runnerGitEnvironment, safeRepositoryConfig } from "@vectordevai/core/everywhere/git"

/** Why a declared project folder can or cannot take a job. The reason is local only: the job declines `not-mapped`. */
export type RepositoryMapping = "mapped" | "unsafe-config" | "other-repository" | "unavailable"
class UnsafeConfig extends Error {
  constructor() { super("Everywhere refuses executable repository configuration") }
}
class OtherRepository extends Error {
  constructor() { super("The Everywhere workspace remote does not match") }
}

function mapsRepository(config: string, repository: string) {
  const remotes = new Map<string, string[]>()
  for (const entry of config.split("\0")) {
    const newline = entry.indexOf("\n")
    const key = entry.slice(0, newline).toLowerCase()
    if (newline < 0 || !/^remote\.[a-z0-9_.-]+\.url$/.test(key)) continue
    remotes.set(key, [...(remotes.get(key) ?? []), entry.slice(newline + 1)])
  }
  return [...remotes.values()].some((urls) => urls.every((url) => {
    const remote = parseGithubRemote(url)
    return remote !== undefined && `${remote.owner}/${remote.name}`.toLowerCase() === repository.toLowerCase()
  }))
}

/**
 * Whether Vector Local blocks git's request to `remote` now. git is a child process the backstop guard never sees, so
 * each fetch and push is decided as git-remote on the remote's host before git starts, and the decision is logged, as
 * the vault's git does (vault-github.ts remoteRefusal). A push is logged as POST, the request that carries its
 * commits, so the network log tells it from a fetch (GET). Nothing is decided with Vector Local off.
 */
function localBlocks(remote: string, method: "GET" | "POST") {
  if (!Egress.policy().enabled) return false
  if (!URL.canParse(remote)) return true
  return Egress.decide({ source: "git-remote", url: `${new URL(remote).origin}/`, method }).decision !== "allow"
}

export type GitExec = (input: { readonly directory: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv; readonly signal?: AbortSignal }) => Promise<string>

const execute: GitExec = (input) => new Promise((resolve, reject) => {
  execFile("git", [...input.args], { cwd: input.directory, env: input.env, timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024, signal: input.signal }, (error, stdout, stderr) => {
    // Child-process errors quote their arguments (identity, commit message, the --config-env name), and stdout is
    // repository content, so neither is carried. git's own stderr is, at most 2 KB of it: the authorization reaches git
    // only through the variable --config-env names, git prints header values only under GIT_TRACE_CURL or
    // GIT_CURL_VERBOSE, which runnerGitEnvironment never passes, and the runner keeps these errors on this computer.
    if (!error) return resolve(stdout)
    const detail = stderr.slice(0, 2048).trim()
    reject(new Error(detail ? `The Everywhere git operation failed: ${detail}` : "The Everywhere git operation failed"))
  })
})

export type GitSnapshot = { readonly directory: string; readonly gitDirectory: string; readonly commonDirectory: string; readonly config: readonly { readonly file: string; readonly hash: string }[]; readonly pushUrl: string; readonly baseSha: string }

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
  const canonical = async (cwd: string) => {
    const reported = (await run(["rev-parse", "--show-toplevel"], cwd)).trim()
    if (!path.isAbsolute(reported)) throw new Error("Invalid Everywhere working directory")
    const [expected, actual] = await Promise.all([realpath(cwd), realpath(reported)])
    if (actual !== expected) throw new Error("The Everywhere working directory does not match")
    return expected
  }
  const configuration = async (cwd: string) => {
    // --local alone omits config.worktree when extensions.worktreeConfig is enabled.
    const local = await run(["config", "--null", "--list", "--local", "--no-includes"], cwd)
    if (!safeRepositoryConfig(local)) throw new UnsafeConfig()
    const file = path.resolve(cwd, (await run(["rev-parse", "--git-path", "config.worktree"], cwd)).trim())
    // Git's --worktree --list fails when an enabled worktree has no optional config file yet.
    // Only proved absence is empty; unreadable, oversized or malformed files still refuse the operation.
    const worktree = await hash(file) === "absent" ? "" : await run(["config", "--null", "--list", "--file", file, "--no-includes"], cwd)
    if (!safeRepositoryConfig(worktree)) throw new UnsafeConfig()
    const config = local + worktree
    if (!mapsRepository(config, input.repository)) throw new OtherRepository()
    return config
  }
  const authority = async (cwd: string) => {
    const directory = await canonical(cwd)
    const gitDirectory = await realpath((await run(["rev-parse", "--absolute-git-dir"], cwd)).trim())
    const commonDirectory = await realpath(path.resolve(cwd, (await run(["rev-parse", "--git-common-dir"], cwd)).trim()))
    return { directory, gitDirectory, commonDirectory }
  }
  const unchanged = async (snapshot: GitSnapshot, cwd = snapshot.directory) => {
    try {
      for (const item of snapshot.config) if (await hash(item.file) !== item.hash) return false
      await configuration(cwd)
      // Old hashes alone do not notice a changed .git pointer into a different repository.
      const current = await authority(cwd)
      return current.directory === snapshot.directory && current.gitDirectory === snapshot.gitDirectory &&
        current.commonDirectory === snapshot.commonDirectory
    } catch { return false }
  }
  return {
    run,
    unchanged,
    async mapping(): Promise<RepositoryMapping> {
      return await configuration(input.directory).then(() => "mapped" as const, (error: unknown) =>
        error instanceof UnsafeConfig ? "unsafe-config" : error instanceof OtherRepository ? "other-repository" : "unavailable")
    },
    async snapshot(cwd = input.directory): Promise<GitSnapshot> {
      await configuration(cwd)
      const identity = await authority(cwd)
      const files = [path.join(identity.commonDirectory, "config"), path.join(identity.gitDirectory, "config.worktree"), path.join(identity.commonDirectory, "info", "attributes")]
      const baseSha = (await run(["rev-parse", "HEAD"], cwd)).trim()
      if (!HEAD_SHA_PATTERN.test(baseSha)) throw new Error("Invalid Everywhere base")
      return { ...identity, config: await Promise.all(files.map(async (file) => ({ file, hash: await hash(file) }))),
        pushUrl: `https://github.com/${input.repository}.git`, baseSha }
    },
    async fetch(snapshot: GitSnapshot, base: string, jid: string) {
      if (!JOB_ID_PATTERN.test(jid) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(base) || base.includes("..") || !await unchanged(snapshot, input.directory)) throw new Error("Everywhere git authority changed")
      if (localBlocks(snapshot.pushUrl, "GET")) throw new Error("Vector Local blocks the Everywhere git fetch")
      const ref = fetchRef(jid)
      await run(["fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", snapshot.pushUrl, `refs/heads/${base}:${ref}`], input.directory, true)
      const from = (await run(["rev-parse", ref])).trim()
      if (!HEAD_SHA_PATTERN.test(from)) throw new Error("Invalid Everywhere fetched base")
      return from
    },
    async stage(snapshot: GitSnapshot, directory: string) {
      if (!await unchanged(snapshot, directory)) return undefined
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
      if (!await unchanged(snapshot, directory) || !input.identity.name.trim() || !input.identity.email.trim() || /[\r\n\0]/.test(input.identity.name + input.identity.email)) return undefined
      await run(["-c", `user.name=${input.identity.name}`, "-c", `user.email=${input.identity.email}`, "commit", "--no-verify", "-m", message], directory)
      return (await run(["rev-parse", "HEAD"], directory)).trim()
    },
    async push(snapshot: GitSnapshot, directory: string, branch: string) {
      // A refusal is a push that never started, so the runner keeps the branch on this computer and settles `held`.
      if (!BRANCH_PATTERN.test(branch) || !await unchanged(snapshot, directory) || localBlocks(snapshot.pushUrl, "POST")) return false
      await run(["push", "--no-verify", "--", snapshot.pushUrl, `HEAD:refs/heads/${branch}`], directory, true)
      return true
    },
  }
}

export type RunnerGit = ReturnType<typeof createEverywhereGit>
