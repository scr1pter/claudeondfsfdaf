import type { Computer } from "@vectordevai/schema/computer"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { ServerScope } from "@/utils/server-scope"

/**
 * Whether the desktop owns a page's Hands runs: only on its own built-in engine, the canonical local server, which
 * alone receives the desktop's Hands bridge. Any other server, a loopback one included, keeps the engine's
 * `computer.state` event and the renderer's notifications.
 */
export function desktopOwns(computer: Pick<Computer.ComputerPlatform, "supported"> | undefined, scope: ServerScope) {
  return !!computer?.supported && scope === ServerScope.local
}

/**
 * Whether the renderer raises its own OS notification for an ask (INV-T6). When the desktop owns the Hands run, it
 * sends its own "needs you" notification for Hands' two permission asks and its handoff questions, so the renderer
 * skips those, and only those. Check-in questions, ordinary asks and every in-app toast and sound are unchanged.
 * Malformed metadata keeps notifying: the skip needs the exact documented shape.
 */
export function rendererNotifies(
  event: { type: string; properties: { permission?: string; metadata?: unknown } },
  owned: boolean,
) {
  if (!owned) return true
  // Exactly the two asks Hands raises: another tool's permission can share the `computer_` prefix (an MCP server
  // named "computer" asks `computer_<tool>`), and the desktop never notifies for it.
  if (event.type === "permission.asked") return !PermissionPolicy.handsAsk(event.properties.permission)
  if (event.type === "question.asked") return !handoff(event.properties.metadata)
  return true
}

function handoff(metadata: unknown) {
  if (!record(metadata)) return false
  const computer = metadata.computer
  return record(computer) && computer.kind === "handoff"
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
