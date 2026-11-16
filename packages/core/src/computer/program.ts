import { createHash } from "node:crypto"
import path from "node:path"
import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"

/** Artifact identity is separate from an app key and never constitutes permission to observe or send input. */
export function key(program: Pick<Computer.ProgramLaunch, "platform" | "path" | "binding">) {
  return `program:${program.platform}:${createHash("sha256")
    .update(JSON.stringify([program.platform, program.path, program.binding]))
    .digest("hex")}`
}

export function valid(program: Computer.ProgramLaunch) {
  const fs = program.platform === "macos" ? path.posix : path.win32
  return (
    Schema.is(Computer.ProgramLaunch)(program) &&
    fs.isAbsolute(program.path) &&
    fs.normalize(program.path) === program.path &&
    (program.platform !== "windows" || /^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+)/i.test(program.path)) &&
    !program.path.includes("\0") &&
    key(program) === program.key &&
    Computer.clean(program.name, 256) === program.name
  )
}

/** Deliberately omits the native resolution token from every engine-visible representation. */
export function publicLaunch(program: Computer.ProgramLaunch): Computer.ProgramLaunch {
  return {
    key: program.key,
    platform: program.platform,
    path: program.path,
    name: program.name,
    binding: program.binding,
  }
}

export function same(first: Computer.ProgramLaunch, second: Computer.ProgramLaunch) {
  return (
    valid(first) &&
    valid(second) &&
    first.key === second.key &&
    first.platform === second.platform &&
    first.path === second.path &&
    first.name === second.name &&
    first.binding === second.binding
  )
}

export function digest(program: Computer.ProgramLaunch) {
  // The canonical open-step keys are fixed in this order; helpers need no broader screen classifier dependency.
  return createHash("sha256")
    .update(JSON.stringify({ kind: "open", path: program.path }))
    .digest("hex")
}

export * as ComputerProgram from "./program"
