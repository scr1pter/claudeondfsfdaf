import { Option, Schema } from "effect"
import { EverywherePreferenceWire } from "@vectordevai/core/everywhere/preferences"
import type { ConfigEverywhereV1 } from "@vectordevai/core/v1/config/everywhere"

export const READ_EVERYWHERE_PREFERENCES = { version: 1, kind: "read" } as const

type Transport = (request: EverywherePreferenceWire.Request) => Promise<EverywherePreferenceWire.Result>

type Access = {
  transport: () => Transport | undefined
  authorityRevision: () => number
  offered: () => Promise<boolean>
  confirm: (withRemote: boolean) => Promise<boolean>
  remote: () => { enabled: boolean; enable: () => Promise<boolean> } | undefined
  refresh: () => Promise<void>
}

function windsDown(before: ConfigEverywhereV1.Info, after: ConfigEverywhereV1.Info) {
  const { enabled: wasEnabled, projects: oldProjects, ...previous } = before
  const { enabled, projects, ...updated } = after
  return (
    (enabled !== true || wasEnabled === true) &&
    JSON.stringify(previous) === JSON.stringify(updated) &&
    (projects ?? []).every((project) =>
      oldProjects?.some((item) => item.directory === project.directory && item.repository === project.repository),
    )
  )
}

export async function updateEverywherePreferences(
  input: unknown,
  access: Access,
): Promise<EverywherePreferenceWire.ChangeResult> {
  const request = Schema.decodeUnknownOption(EverywherePreferenceWire.Update)(input)
  if (Option.isNone(request)) return { version: 1, kind: "invalid" }
  const transport = access.transport()
  if (!transport) return { version: 1, kind: "unsupported" }
  const authority = access.authorityRevision()
  let turnedOnRemote = false
  try {
    const current = await transport(READ_EVERYWHERE_PREFERENCES)
    if (current.kind !== "ready") return current
    if (current.snapshot.locked.includes("everywhere")) return { version: 1, kind: "locked" }
    if (current.snapshot.revision !== request.value.revision) return { version: 1, kind: "stale" }
    const previous = current.snapshot.everywhere
    const needsPlan = !windsDown(previous, request.value.settings)
    if (needsPlan && !(await access.offered())) return { version: 1, kind: "not-offered" }
    if (request.value.settings.enabled === true && previous.enabled !== true) {
      const remote = access.remote()
      if (!remote) return { version: 1, kind: "remote-unavailable" }
      if (!(await access.confirm(!remote.enabled))) return { version: 1, kind: "cancelled" }
      if (access.authorityRevision() !== authority || access.transport() !== transport)
        return { version: 1, kind: "stale" }
      if (!(await access.offered())) return { version: 1, kind: "not-offered" }
      const verified = await transport(READ_EVERYWHERE_PREFERENCES)
      if (verified.kind !== "ready") return verified
      if (verified.snapshot.locked.includes("everywhere")) return { version: 1, kind: "locked" }
      if (
        verified.snapshot.revision !== current.snapshot.revision ||
        JSON.stringify(verified.snapshot.everywhere) !== JSON.stringify(previous)
      )
        return { version: 1, kind: "stale" }
      if (access.authorityRevision() !== authority || access.transport() !== transport)
        return { version: 1, kind: "stale" }
      const fresh = access.remote()
      if (!fresh || (remote.enabled && !fresh.enabled)) return { version: 1, kind: "remote-unavailable" }
      if (!fresh.enabled) {
        turnedOnRemote = await fresh.enable()
        if (!turnedOnRemote) return { version: 1, kind: "remote-unavailable" }
        if (!(await access.offered())) return { version: 1, kind: "remote-stayed-on" }
      }
    }
    if (access.authorityRevision() !== authority || access.transport() !== transport)
      return { version: 1, kind: turnedOnRemote ? "remote-stayed-on" : "stale" }
    const result = await transport(request.value)
    if (result.kind !== "ready" && turnedOnRemote) return { version: 1, kind: "remote-stayed-on" }
    if (result.kind === "ready") await access.refresh().catch(() => undefined)
    return result
  } catch {
    return { version: 1, kind: turnedOnRemote ? "remote-stayed-on" : "unavailable" }
  }
}
