import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { ConnectPolicy } from "@vectordevai/core/connect/policy"
import { Wildcard } from "@vectordevai/core/util/wildcard"
import { readAuthority } from "@/review/read-authority"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  parentWorktree?: string
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  // Only a rule that grants the tool counts: a rule denying one specialist still leaves the rest denied by default.
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task" && rule.action !== "deny")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite" && rule.action !== "deny")
  // A connected fix acts for its requester, unlike ordinary specialist delegation. Carry read questions into its
  // session without granting any permission; keep its own effective denies last so a question cannot reopen one.
  const tree = input.parentWorktree
  const requester =
    input.subagent.name === ConnectPolicy.FIX_AGENT && tree
      ? input.parentSessionPermission.flatMap((rule) =>
          rule.action !== "allow" && Wildcard.match("read", rule.permission)
            ? [
                rule,
                ...readAuthority([rule.pattern], {
                  directory: tree,
                  worktree: tree,
                  readRoot: tree,
                }).patterns.map((pattern) => ({ ...rule, permission: "read", pattern })),
              ]
            : [rule],
        )
      : input.parentSessionPermission
  const asks =
    input.subagent.name === ConnectPolicy.FIX_AGENT
      ? requester
          .filter((rule) => rule.action === "ask" && Wildcard.match("read", rule.permission))
          .map((rule) => ({ ...rule, permission: "read" }))
      : []
  const denies = asks.length
    ? ConnectPolicy.readPatterns(input.subagent.permission, [])
        .filter((pattern) =>
          input.subagent.permission.some(
            (rule) => rule.action === "deny" && rule.pattern === pattern && Wildcard.match("read", rule.permission),
          ),
        )
        .map((pattern) => ({ permission: "read", pattern, action: "deny" as const }))
    : []
  return [
    ...asks,
    ...denies,
    ...requester.filter((rule) => rule.permission === "external_directory" || rule.action === "deny"),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
