export * as EverywhereGit from "./git"

import os from "node:os"
import { isJobId } from "@vectordevai/schema/everywhere"

/*
 * How Vector everywhere runs git in a user's repository (contract 5, E5): which repository config it accepts, the
 * hardening flags and the minimal environment. Both the laptop runner's git (desktop everywhere-git.ts) and the
 * engine's unattended checkout (engine worktree `createUnattended`) use these, so the two accept the same repositories
 * and agree on line endings: with no system or global config, core.autocrlf is the same when the checkout is made and
 * when the runner commits, on Windows too. No I/O, but Node-only (node:os, process.env): for desktop main and the
 * engine, never browser code.
 */

/**
 * Local keys git and common tools write that never run a command, rewrite a URL, filter content or name a helper.
 * Git for Windows writes core.symlinks, gh writes remote.<n>.gh-resolved and branch.<b>.gh-merge-base, VS Code writes
 * branch.<b>.vscode-merge-base, and partial clones write the promisor keys. Everything else stays refused, including
 * submodule.<n>.update, filter.*, include*, url.*, http.*, credential.*, core.editor/pager/askpass and gpg.*.
 */
const SAFE_CONFIG = new RegExp(
  "^(?:" +
    [
      "core\\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|worktree|hookspath|fsmonitor|sshcommand|longpaths|symlinks|autocrlf)",
      "extensions\\.(?:worktreeconfig|objectformat|partialclone)",
      "user\\.(?:name|email)",
      "(?:commit|tag)\\.gpgsign",
      "pull\\.rebase",
      "maintenance\\.(?:auto|strategy|[a-z-]+\\.(?:enabled|schedule))",
      "remote\\.[a-z0-9_.-]+\\.(?:url|pushurl|fetch|tagopt|prune|gh-resolved|promisor|partialclonefilter)",
      "branch\\.[a-z0-9_./-]+\\.(?:remote|merge|pushremote|rebase|vscode-merge-base|gh-merge-base|github-pr-owner-number)",
      "submodule\\.[a-z0-9_./-]+\\.(?:url|active)",
    ].join("|") +
    ")$",
  "i",
)

/** Repository config cannot introduce a filter, include, URL rewrite, proxy, command, or credential helper. */
export function safeRepositoryConfig(text: string) {
  return text
    .split("\0")
    .filter(Boolean)
    .every((item) => SAFE_CONFIG.test(item.split("\n", 1)[0]!))
}

export const GIT_HARDENING = [
  "-c",
  `core.hooksPath=${os.devNull}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.sshCommand=",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "credential.helper=",
  "-c",
  "core.pager=cat",
] as const

export function runnerGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH,
    HOME: source.HOME,
    USERPROFILE: source.USERPROFILE,
    SYSTEMROOT: source.SYSTEMROOT,
    TMPDIR: source.TMPDIR,
    TEMP: source.TEMP,
    SSH_AUTH_SOCK: source.SSH_AUTH_SOCK,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
  }
}

/** The ref the runner fetches a job's base into, and the engine's unattended checkout reads that base back from. */
export function fetchRef(jid: string) {
  if (!isJobId(jid)) throw new RangeError("A fetch ref needs a job id.")
  return `refs/vector-everywhere/${jid}`
}
