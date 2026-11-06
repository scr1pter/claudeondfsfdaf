export * as ConfigAgent from "./agent"

import path from "path"
import { Exit, Schema } from "effect"
import { Glob } from "@vectordevai/core/util/glob"
import { ConfigAgentV1 } from "@vectordevai/core/v1/config/agent"
import { InvalidError } from "@vectordevai/core/v1/config/error"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse"

/** Engine-owned names cannot be replaced by user or repository agent definitions. */
export const RESERVED: readonly string[] = ["fork", "workflow"]

function refuseReserved(name: string, file: string) {
  if (RESERVED.includes(name))
    throw new InvalidError({
      path: file,
      message: `An agent cannot be named ${name}; the engine reserves that name.`,
    })
}

// `allowed` leaves out a prompt file that changed since the owner last approved it (PromptTrust).
export async function load(dir: string, allowed: (file: string) => boolean) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{agent,agents}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    if (!allowed(item)) continue
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])

    const config = {
      name,
      ...md.data,
      prompt: md.content.trim(),
    }
    refuseReserved(String(config.name), item)
    result[config.name] = ConfigParse.schema(ConfigAgentV1.Info, config, item)
  }
  return result
}

export async function loadMode(dir: string, allowed: (file: string) => boolean) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{mode,modes}/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    if (!allowed(item)) continue
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const config = {
      name: configEntryNameFromPath(path.relative(dir, item), ["mode/", "modes/"]),
      ...md.data,
      prompt: md.content.trim(),
    }
    refuseReserved(config.name, item)
    const parsed = Schema.decodeUnknownExit(ConfigAgentV1.Info)(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = {
        ...parsed.value,
        mode: "primary" as const,
      }
    }
  }
  return result
}
