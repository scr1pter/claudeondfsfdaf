import { ComputerCommunity } from "@vectordevai/core/computer/community"
import type { ConfigComputerV1 } from "@vectordevai/core/v1/config/computer"
import { Hands } from "@vectordevai/schema/hands"
import { McpCatalog } from "./catalog"

const WRAPPERS: Readonly<Record<string, readonly string[]>> = {
  env: ["-u", "--unset", "-C", "--chdir"],
  sudo: ["-u", "--user", "-g", "--group"],
  doas: ["-u", "-C"],
  command: [],
  exec: ["-a"],
  nohup: [],
  nice: ["-n", "--adjustment"],
}
const RUNNER_OPTIONS = [
  "--python",
  "--directory",
  "--project",
  "--index",
  "--index-url",
  "--default-index",
  "--extra-index-url",
  "--registry",
  "--cache",
  "--cache-dir",
  "--with",
  "--with-editable",
  "--with-requirements",
  "--from",
  "--package",
  "-p",
]

/** Config.computer contains company policy only; user and project sources are stripped by Config. */
export function refusal(command: readonly string[], policy: ConfigComputerV1.Info | undefined) {
  if (!ComputerCommunity.restricted(policy) || !communityCommand(command)) return
  return `${Hands.NAME} is the supported path for computer use. Your company's computer policy does not allow the community computer-control MCP.`
}

/**
 * Why a server name cannot be used, if it cannot. A server's tools are named `<server>_<tool>` after sanitizing
 * (McpCatalog.toolName), so a server named `computer` would raise `computer_app` and `computer_sensitive`, the ids
 * clients show as Hands asks (PermissionPolicy.handsAsk). Letter case is ignored because the ACP adapter lowercases
 * permission ids and Windows matches permission rules without case. A separator keeps a name usable: `computer-use`
 * and `computer use` give `computer-use_<tool>` and `computer_use_<tool>`. A refused name is exactly these eight
 * ASCII letters, so echoing it is safe.
 */
export function reservedName(name: string) {
  if (McpCatalog.sanitize(name).toLowerCase() !== Hands.ID) return
  return `MCP server "${name}" cannot be used: the name "${Hands.ID}", in any letter case, is reserved for ${Hands.NAME}. Rename the server to use it.`
}

// Match the known server's executable/distribution, including the catalog's versioned uvx launch.
// This intentionally identifies argv launchers; it does not inspect the contents of arbitrary scripts.
function communityCommand(command: readonly string[], depth = 0): boolean {
  if (!command.length || depth > 8) return false
  if (target(command[0])) return true
  const name = basename(command[0])
    .replace(/\.(?:exe|cmd|bat|com)$/i, "")
    .toLowerCase()
  const args = command.slice(1)
  if (Object.hasOwn(WRAPPERS, name)) return launched(args, WRAPPERS[name], [], depth)
  if (name === "uvx") return launched(args, RUNNER_OPTIONS, ["--from"], depth)
  if (["npx", "bunx", "pnpx"].includes(name)) return launched(args, RUNNER_OPTIONS, ["--package", "-p"], depth)
  if (name === "uv" && args[0] === "tool" && args[1] === "run")
    return launched(args.slice(2), RUNNER_OPTIONS, ["--from"], depth)
  if (name === "uv" && args[0] === "run") return launched(args.slice(1), RUNNER_OPTIONS, [], depth)
  if (["npm", "pnpm", "yarn", "bun"].includes(name) && ["exec", "dlx", "x"].includes(args[0]))
    return launched(args.slice(1), RUNNER_OPTIONS, ["--package", "-p"], depth)
  if (/^(?:python(?:\d+(?:\.\d+)*)?|py)$/.test(name)) {
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "-c") return false
      if (args[index] === "-m" || args[index] === "--") return target(args[index + 1] ?? "")
      if (["-W", "-X", "--check-hash-based-pycs"].includes(args[index])) {
        index++
        continue
      }
      if (!args[index].startsWith("-")) return target(args[index])
    }
  }
  return false
}

function launched(args: readonly string[], options: readonly string[], packages: readonly string[], depth: number) {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]
    if (word === "--") return communityCommand(args.slice(index + 1), depth + 1)
    const equals = word.indexOf("=")
    const option = equals < 0 ? word : word.slice(0, equals)
    if (packages.includes(option) && target(equals < 0 ? (args[index + 1] ?? "") : word.slice(equals + 1))) return true
    if (options.includes(word)) {
      index++
      continue
    }
    if (word.startsWith("-") || /^[A-Za-z_]\w*=/.test(word)) continue
    return communityCommand(args.slice(index), depth + 1)
  }
  return false
}

function basename(value: string) {
  return value.split(/[\\/]/).at(-1) ?? ""
}

function target(value: string) {
  return /^computer[-_]control[-_]mcp(?:\.(?:exe|cmd|bat|com|py))?(?:\[[\w,-]+\])?(?:@[^\s]+|(?:==|~=|>=|<=|>|<)[^\s]+)?$/i.test(
    basename(value),
  )
}

export * as McpComputerPolicy from "./computer-policy"
