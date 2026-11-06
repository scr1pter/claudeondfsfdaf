import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { open, rm, stat } from "node:fs/promises"
import path from "node:path"
import { AGENT_UID, BINARIES, GIT_STEP_MS, GIT_TOKEN_MAX_MS, GIT_UID, MIRROR_DIR, WORK_DIR } from "./limits"
import { runChecked, RunError, type Runner } from "./run"

/*
 * git's network steps on the cloud computer (contract WP A54, S7). The agent never holds a GitHub token. hostd clones,
 * fetches and pushes for it with a one-repository token that lives for one operation, and only while every agent
 * process is paused (a paused process can read nothing).
 *
 * The token never meets the agent's own repository either: its `.git/config` and hooks are the agent's to write, and
 * could send a token anywhere. Every step that carries a token runs as the git user in a bare mirror that only hostd
 * configures (`/var/lib/vector/git/<owner>/<name>.git`), with hooks, helpers, proxies and URL rewrites switched off on
 * the command line. Moving commits between the mirror and the agent's working copy is a local step with no token. The
 * token reaches git through its environment only (never the command line, never a file), as an HTTP header scoped to
 * https://github.com/, and is dropped when the step ends. Pushes go to `vector/…` branches only, never forced.
 *
 * No git process of the git user ever reads the agent's repository: a push starts with the agent's own git (as the
 * agent) writing the branch to a bundle file, which the git user then fetches into the mirror as plain data. The
 * mirrors are readable by the agent (it clones from them) and writable by the git user only.
 */

export type Repository = { owner: string; name: string }
export type Access = "read" | "write"
/** Where hostd gets a token for one repository (the run-API host); tests pass a fake. */
export type TokenSource = (repository: Repository, access: Access) => Promise<{ token: string; expiresAt: number }>

export type GitDeps = {
  run: Runner
  tokens: TokenSource
  /** Pauses every agent process; answers a function that lets them run again. */
  pauseAgent: () => Promise<() => Promise<void>>
  clock?: () => number
  mirrorDir?: string
  workDir?: string
  /** The remote's address; GitHub in production, a local path in tests. */
  remote?: (repository: Repository) => string
  /** The users each step runs as; undefined runs as the caller (tests). */
  gitUid?: number | undefined
  agentUid?: number | undefined
}

export class GitError extends Error {}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/
const BRANCH = /^vector\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
const DIRECTORY = /^[A-Za-z0-9._-]{1,100}$/

export function checkRepository(repository: Repository) {
  if (!OWNER.test(repository.owner) || !NAME.test(repository.name) || repository.name === "." || repository.name === "..")
    throw new GitError("That is not a GitHub repository name.")
  return repository
}

/** A branch hostd will push: `vector/…`, nothing git could read as an option or a range. */
export function checkBranch(branch: string) {
  if (!BRANCH.test(branch) || branch.includes("..") || branch.endsWith(".lock") || branch.endsWith("/") || branch.length > 200)
    throw new GitError("Vector pushes only to branches named vector/…")
  return branch
}

export const githubRemote = (repository: Repository) => `https://github.com/${repository.owner}/${repository.name}.git`

/**
 * Settings every token-carrying step passes on the command line, where they outrank any configuration file: no hooks,
 * no credential helper, no proxy, no URL rewriting, TLS verification on, no redirects, https only.
 */
export const LOCKED_CONFIG: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.askPass=",
  "core.sshCommand=",
  "credential.helper=",
  "http.proxy=",
  "https.proxy=",
  "http.sslVerify=true",
  "http.followRedirects=false",
  "protocol.allow=never",
  "protocol.https.allow=always",
  "protocol.file.allow=always",
  "transfer.fsckObjects=true",
  "fetch.recurseSubmodules=false",
  "submodule.recurse=false",
  "safe.directory=*",
]

/** git's environment for a step: no system or user configuration, no prompts, and the token header when given. */
export function gitEnv(home: string, token?: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    LANG: "C",
  }
  if (token !== undefined) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64")
    env.GIT_CONFIG_COUNT = "1"
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader"
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`
  }
  return env
}

function locked(args: readonly string[]) {
  return [...LOCKED_CONFIG.flatMap((setting) => ["-c", setting]), ...args]
}

export class HostGit {
  private readonly clock: () => number
  private readonly mirrorDir: string
  private readonly workDir: string
  private readonly remote: (repository: Repository) => string

  constructor(private readonly deps: GitDeps) {
    this.clock = deps.clock ?? Date.now
    this.mirrorDir = deps.mirrorDir ?? MIRROR_DIR
    this.workDir = deps.workDir ?? WORK_DIR
    this.remote = deps.remote ?? githubRemote
  }

  private gitUid() {
    return "gitUid" in this.deps ? this.deps.gitUid : GIT_UID
  }
  private agentUid() {
    return "agentUid" in this.deps ? this.deps.agentUid : AGENT_UID
  }

  mirrorPath(repository: Repository) {
    checkRepository(repository)
    return path.join(this.mirrorDir, repository.owner.toLowerCase(), `${repository.name.toLowerCase()}.git`)
  }

  /** The agent's working copy of a repository: a folder directly in its work, named by the agent. */
  checkoutPath(directory: string) {
    if (!DIRECTORY.test(directory) || directory === "." || directory === "..") throw new GitError("Choose a plain folder name.")
    return path.join(this.workDir, directory)
  }

  private async git(cwd: string, args: readonly string[], uid: number | undefined, token?: string) {
    try {
      return await runChecked(this.deps.run, BINARIES.git, locked(args), {
        cwd,
        env: gitEnv(this.mirrorDir, token),
        timeoutMs: GIT_STEP_MS,
        ...(uid !== undefined ? { uid, gid: uid } : {}),
      })
    } catch (error) {
      // git's own message may quote the URL; it never holds the token (that is a header), but stays out of answers.
      throw new GitError(error instanceof RunError ? "git could not finish this step." : "git could not start.")
    }
  }

  /**
   * One token-carrying step: every agent process paused first, the token fetched and handed to git's environment, then
   * dropped, and the agent resumed whatever happened.
   */
  private async withToken<T>(repository: Repository, access: Access, step: (token: string) => Promise<T>) {
    const resume = await this.deps.pauseAgent()
    try {
      const grant = await this.deps.tokens(repository, access)
      if (typeof grant?.token !== "string" || !/^[A-Za-z0-9_.-]{20,512}$/.test(grant.token))
        throw new GitError("No token for this repository.")
      if (!(grant.expiresAt > this.clock()) || grant.expiresAt - this.clock() > GIT_TOKEN_MAX_MS)
        throw new GitError("The token for this repository is not usable.")
      return await step(grant.token)
    } finally {
      await resume()
    }
  }

  /** Brings the mirror up to date with GitHub: every branch and tag, pruned. */
  private async updateMirror(repository: Repository, access: Access) {
    const mirror = this.mirrorPath(repository)
    const uid = this.gitUid()
    // Group-readable (0640): the mirror root's group is the agent's, so the agent can clone from it but not write it.
    if (!(await exists(mirror))) await this.git(this.mirrorDir, ["init", "--quiet", "--bare", "--shared=0640", "--", mirror], uid)
    const head = await this.withToken(repository, access, async (token) => {
      const listed = await this.git(mirror, ["ls-remote", "--symref", "--", this.remote(repository), "HEAD"], uid, token)
      await this.git(
        mirror,
        ["fetch", "--quiet", "--prune", "--no-recurse-submodules", this.remote(repository), "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"],
        uid,
        token,
      )
      return defaultBranch(listed.stdout.toString("utf8"))
    })
    // The mirror's HEAD follows GitHub's default branch, so a clone checks that branch out.
    if (head) await this.git(mirror, ["symbolic-ref", "HEAD", `refs/heads/${head}`], uid)
    return mirror
  }

  /** Clones a repository into the agent's work as `directory`. */
  async clone(repository: Repository, directory: string) {
    const target = this.checkoutPath(directory)
    if (await exists(target)) throw new GitError("That folder already exists.")
    const mirror = await this.updateMirror(repository, "read")
    const agent = this.agentUid()
    await this.git(this.workDir, ["clone", "--quiet", "--no-hardlinks", "--", mirror, target], agent)
    // The working copy names GitHub as its remote, for the agent's own reading; it holds no credential.
    await this.git(target, ["remote", "set-url", "origin", this.remote(repository)], agent)
    return target
  }

  /** Fetches GitHub's branches into the agent's working copy as `origin/…`. */
  async fetch(repository: Repository, directory: string) {
    const target = this.checkoutPath(directory)
    if (!(await exists(path.join(target, ".git")))) throw new GitError("There is no repository in that folder.")
    const mirror = await this.updateMirror(repository, "read")
    await this.git(target, ["fetch", "--quiet", "--prune", "--no-recurse-submodules", "--", mirror, "+refs/heads/*:refs/remotes/origin/*"], this.agentUid())
  }

  /**
   * Pushes a `vector/…` branch of the agent's working copy to GitHub: the agent's git writes the branch to a bundle, the
   * git user fetches the bundle into the mirror (no token, and nothing of the agent's runs), and only then does the
   * token come out, for the push itself.
   */
  async push(repository: Repository, directory: string, branch: string) {
    checkBranch(branch)
    const target = this.checkoutPath(directory)
    if (!(await exists(path.join(target, ".git")))) throw new GitError("There is no repository in that folder.")
    const mirror = this.mirrorPath(repository)
    if (!(await exists(mirror))) await this.updateMirror(repository, "read")
    const bundle = path.join(this.workDir, `.vector-push-${randomBytes(8).toString("hex")}.bundle`)
    try {
      await this.git(target, ["bundle", "create", "--quiet", bundle, `refs/heads/${branch}`], this.agentUid())
      await this.shareBundle(bundle)
      const uid = this.gitUid()
      await this.git(mirror, ["fetch", "--quiet", "--no-tags", "--", bundle, `+refs/heads/${branch}:refs/heads/${branch}`], uid)
      await this.withToken(repository, "write", (token) =>
        this.git(mirror, ["push", "--quiet", "--", this.remote(repository), `refs/heads/${branch}:refs/heads/${branch}`], uid, token),
      )
    } finally {
      await rm(bundle, { force: true })
    }
  }

  /**
   * Makes the agent's bundle readable by the git user. The file is opened without following links and must be a plain
   * file of the agent's, so the agent cannot swap in a link and have hostd open up some other file.
   */
  private async shareBundle(bundle: string) {
    const handle = await open(bundle, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined)
    if (!handle) throw new GitError("git could not finish this step.")
    try {
      const info = await handle.stat()
      const agent = this.agentUid()
      if (!info.isFile() || (agent !== undefined && info.uid !== agent)) throw new GitError("git could not finish this step.")
      await handle.chmod(0o644)
    } finally {
      await handle.close()
    }
  }

  /** Forgets a repository's mirror (the job is over, or the repository went away). */
  async forget(repository: Repository) {
    await rm(this.mirrorPath(repository), { recursive: true, force: true })
  }
}

/** The default branch from `git ls-remote --symref <remote> HEAD`, when it is a plain branch name. */
export function defaultBranch(listing: string) {
  const match = /^ref: refs\/heads\/([A-Za-z0-9._/-]{1,200})\tHEAD$/m.exec(listing)
  const branch = match?.[1]
  return branch && !branch.includes("..") && !branch.startsWith("-") ? branch : undefined
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  )
}
