import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { devNull } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)

/** A smoke child inherits executable lookup only, never Git routing, configuration or credentials. */
export function connectSmokeGitEnvironment(directory: string, parent: NodeJS.ProcessEnv = process.env) {
  return {
    ...(parent.PATH ? { PATH: parent.PATH } : {}),
    ...(parent.SystemRoot ? { SystemRoot: parent.SystemRoot } : {}),
    ...(parent.SYSTEMROOT ? { SYSTEMROOT: parent.SYSTEMROOT } : {}),
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: directory,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  }
}

/** A separate clean Git fixture reaches real owner consent, then completes without model work or a changed diff. */
export async function prepareConnectSmokeRepository(directory: string) {
  await mkdir(directory)
  const template = await mkdtemp(path.join(path.dirname(directory), "connect-git-template-"))
  const git = async (args: string[]) =>
    (
      await execute("git", args, {
        cwd: directory,
        env: connectSmokeGitEnvironment(directory),
        timeout: 5000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      })
    ).stdout.trim()
  try {
    // A fresh empty template prevents system/user hooks or default template files entering this disposable repo.
    await git(["init", "--quiet", "--initial-branch=main", `--template=${template}`])
    await writeFile(path.join(directory, "review-fixture.txt"), "Connected review smoke fixture.\n")
    await git(["add", "--", "review-fixture.txt"])
    await git([
      "-c",
      "user.name=Vector",
      "-c",
      "user.email=bot@vectordev.ai",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "Connected review smoke fixture",
    ])
    if (
      !/^[0-9a-f]{40}$/.test(await git(["rev-parse", "--verify", "HEAD^{commit}"])) ||
      (await git(["status", "--porcelain=v1", "--untracked-files=all"]))
    )
      throw new Error("The connected review smoke Git fixture is not clean and committed.")
    return directory
  } finally {
    await rm(template, { recursive: true, force: true })
  }
}
