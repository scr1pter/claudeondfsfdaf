import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@vectordevai/core/fs-util"
import type { AppProcess } from "@vectordevai/core/process"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { ForbiddenError } from "@vectordevai/protocol/errors"

const refused = () => new ForbiddenError({ message: "This filesystem selection could expose private task data." })

function existingDirectory(file: string): string {
  const current = fs.statSync(file, { throwIfNoEntry: false })
  if (current?.isDirectory()) return file
  const parent = path.dirname(file)
  if (parent === file) throw refused()
  return existingDirectory(parent)
}

/** Request policy for known private paths and shared Git metadata; it never marks an ordinary .git private. */
export function make(input: {
  audience: SessionAudience.Interface
  process: AppProcess.Interface
  platform?: NodeJS.Platform
}) {
  // Git prints the common directory in its own spelling, which on a volume that ignores case need not be the request's
  // (".GIT/objects"), so both sides are compared folded, as SessionAudience compares private roots.
  const fold = (value: string) => SessionAudience.foldPath(value, input.platform)
  return Effect.fn("FileAccess.read")(function* (file: string, owner: boolean, ancestors = false) {
    // Without any private root nothing can overlap one, so no Git probe runs (a host where Git cannot run still serves).
    if (owner || !(yield* input.audience.hasPrivateDirectories)) return
    const target = FSUtil.realpath(path.resolve(file))
    if (yield* ancestors ? input.audience.overlapsPrivateDirectory(target) : input.audience.isPrivateDirectory(target))
      return yield* refused()
    const directory = yield* Effect.try({ try: () => existingDirectory(target), catch: refused })
    // Probe the selected physical path, including inside .git/objects and bare repositories. Ambient Git routing
    // must not redirect this read-only discovery to another repository. The C locale keeps Git's "not a git
    // repository" in English, which is how a folder outside any repository is recognised.
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("GIT_"),
        ),
      ),
      LC_ALL: "C",
    }
    const result = yield* input.process
      .run(
        ChildProcess.make(
          "git",
          [
            "--no-pager",
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ],
          { cwd: directory, extendEnv: false, env, stdin: "ignore" },
        ),
        { maxOutputBytes: 16_384, maxErrorBytes: 16_384, timeout: "5 seconds" },
      )
      .pipe(Effect.mapError(refused))
    if (result.stdoutTruncated || result.stderrTruncated) return yield* refused()
    if (result.exitCode !== 0) {
      if (/not a git repository/i.test(result.stderr.toString("utf8"))) return
      return yield* refused()
    }
    const common = result.stdout.toString("utf8").replace(/\r?\n$/, "")
    if (!path.isAbsolute(common) || /[\x00\r\n]/.test(common)) return yield* refused()
    if (
      FSUtil.contains(fold(FSUtil.realpath(common)), fold(target)) &&
      (yield* input.audience.overlapsPrivateDirectory(common))
    )
      return yield* refused()
  })
}

export * as FileAccess from "./fs-access"
