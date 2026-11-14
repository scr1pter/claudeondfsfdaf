import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { VaultError } from "@vectordevai/core/vault/error"
import { VaultGitHub } from "@vectordevai/core/vault/github"
import type { VaultStore } from "@vectordevai/core/vault/store"
import { Vault } from "@vectordevai/schema/vault"

// Brain Vault's free backend in the desktop app (WP A45): a private GitHub repository the person owns, written over
// their own git and git credentials, so nothing goes to Vector. The store itself is core's (vault/github.ts, A43):
// each backup is one commit with no parent that git pushes as a packfile with a lease on the commit it replaces, the
// repository is checked to be private through GitHub's API before every push (anything but a 404 or an answer that
// says private refuses it), and it keeps the 7 newest versions. This file gives it the desktop's git and labels its
// one request of its own: the privacy check is the brain-vault source, which Vector Local blocks, and git's fetches
// and pushes are decided as git-remote on github.com before git starts, as the engine's own git requests are.

export const GITHUB_API = "https://api.github.com"
/** Above this the Backup page warns that the repository is getting large (GitHub's recommended size). */
export const SIZE_WARNING_BYTES = 1_000_000_000

const GIT_TIMEOUT_MS = 10 * 60_000
// The subcommands the store runs that reach the remote; everything else reads and writes the local copy.
const CONNECTS = new Set(["ls-remote", "fetch", "push"])

/** The vault's one request of its own: GitHub's API, to check the repository is private. */
export const send: VaultGitHub.Send = (url, init) => Egress.fetch("brain-vault", url, init)

/** The git subcommand in `args`, past `--git-dir=…` and `-c name=value`. */
export function subcommand(args: readonly string[]) {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === "-c" || word === "-C") {
      index++
      continue
    }
    if (word.startsWith("-")) continue
    return word
  }
  return undefined
}

/**
 * Why Vector Local blocks a git request to `remote` before git starts, or undefined when it may go. A remote on this
 * computer (a path, which only tests use) is never decided. Nothing is decided with Vector Local off.
 */
export function remoteRefusal(remote: string) {
  if (!Egress.policy().enabled) return undefined
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(remote) || !URL.canParse(remote)) return undefined
  const url = new URL(remote)
  const decided = Egress.decide({ source: "git-remote", url: `https://${url.host}/` })
  if (decided.decision === "allow") return undefined
  return `Vector Local blocked a git request to ${url.hostname}. ${decided.reason}`
}

/**
 * git as the desktop runs it for the vault: the person's own git and credentials, with Vector's own secrets kept out
 * of its environment, never a terminal prompt (a credential helper answers, or git fails and says why), and a refusal
 * before any command that would reach a remote Vector Local blocks.
 */
export function desktopGit(options: {
  readonly remote: string
  readonly cwd: string
  readonly timeoutMs?: number
}): VaultGitHub.Git {
  return async (args, more) => {
    if (CONNECTS.has(subcommand(args) ?? "")) {
      const refused = remoteRefusal(options.remote)
      if (refused) return { exitCode: 128, stdout: Buffer.alloc(0), stderr: refused }
    }
    await mkdir(options.cwd, { recursive: true })
    const policy = Egress.policy()
    const env = {
      ...untrustedChildEnvironment(process.env),
      GIT_TERMINAL_PROMPT: "0",
      // With Web access None, git may use only remotes on this computer.
      ...(policy.enabled && policy.web === "none" ? { GIT_ALLOW_PROTOCOL: "file" } : {}),
      ...more?.env,
    }
    return new Promise<{ exitCode: number; stdout: Buffer; stderr: string }>((resolve) => {
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let settled = false
      const finish = (result: { exitCode: number; stdout: Buffer; stderr: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const child = spawn("git", [...args], {
        cwd: options.cwd,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
      const timer = setTimeout(() => {
        child.kill()
        finish({ exitCode: 124, stdout: Buffer.concat(stdout), stderr: "git took too long and was stopped." })
      }, options.timeoutMs ?? GIT_TIMEOUT_MS)
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
      child.on("error", (error: NodeJS.ErrnoException) =>
        finish({
          exitCode: 127,
          stdout: Buffer.alloc(0),
          stderr:
            error.code === "ENOENT"
              ? "Git isn't installed on this computer. Install Git, then try again."
              : `git could not start: ${error.message}`,
        }),
      )
      child.on("close", (code) =>
        finish({ exitCode: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") }),
      )
      child.stdin.on("error", () => undefined)
      if (more?.input !== undefined) child.stdin.end(more.input)
      else child.stdin.end()
    })
  }
}

/**
 * The GitHub backend for `repo` (owner/repo). The local copy is a bare repository under `cache`. `remote`, `api`,
 * `git` and `send` are for tests; the app always pushes to github.com over https and checks api.github.com.
 */
export function githubVaultStore(options: {
  readonly repo: string
  readonly cache: string
  readonly remote?: string
  readonly api?: string
  readonly git?: VaultGitHub.Git
  readonly send?: VaultGitHub.Send
}): VaultStore.Store {
  const repo = VaultGitHub.parseRepo(options.repo)
  if (!repo) throw new VaultError("unavailable", "Name the repository as owner/repo, for example octocat/brain-vault.")
  const remote = options.remote ?? `https://github.com/${repo.owner}/${repo.name}.git`
  return VaultGitHub.store({
    repo: repo.full,
    remote,
    api: options.api ?? GITHUB_API,
    dir: join(options.cache, "github", repo.owner, `${repo.name}.git`),
    git: options.git ?? desktopGit({ remote, cwd: options.cache }),
    send: options.send ?? send,
    keep: Vault.LIMIT.githubVersions,
  })
}

/** The warning the Backup page shows once the vault takes more than 1 GB of the repository, or undefined. */
export function sizeWarning(storedBytes: number | undefined, repo: string) {
  if (storedBytes === undefined || storedBytes <= SIZE_WARNING_BYTES) return undefined
  return `Your vault takes ${gigabytes(storedBytes)} in ${repo}, more than the 1 GB GitHub recommends for a repository. Forget older versions, or back up to a new private repository.`
}

function gigabytes(bytes: number) {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`
}
