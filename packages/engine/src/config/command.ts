export * as ConfigCommand from "./command"

import path from "path"
import { Cause, Exit, Schema } from "effect"
import { Glob } from "@vectordevai/core/util/glob"
import { ConfigCommandV1 } from "@vectordevai/core/v1/config/command"
import { configEntryNameFromPath } from "./entry-name"
import { InvalidError } from "@vectordevai/core/v1/config/error"
import * as ConfigMarkdown from "./markdown"

const decodeInfo = Schema.decodeUnknownExit(ConfigCommandV1.Info)

// `allowed` leaves out a prompt file that changed since the owner last approved it (PromptTrust).
export async function load(dir: string, allowed: (file: string) => boolean) {
  const result: Record<string, ConfigCommandV1.Info> = {}
  for (const item of await Glob.scan("{command,commands}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    if (!allowed(item)) continue
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["command/", "commands/"])

    const config = {
      name,
      ...md.data,
      template: md.content.trim(),
    }
    const parsed = decodeInfo(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = parsed.value
      continue
    }
    throw new InvalidError({ path: item, message: Cause.pretty(parsed.cause) }, { cause: Cause.squash(parsed.cause) })
  }
  return result
}
