import { ApiError } from "../http.js"
import { authorizedCommands, type AuthorityContext } from "./authority.js"
import { installationAuthority, readInstallState, type InstallRecord } from "./identity.js"
import { everywhereKeys } from "./keys.js"
import { sha256Hex } from "./signature.js"
import { getValue } from "./store.js"

type Snapshot = { readonly record: InstallRecord; readonly raw: string }
type Control = { readonly snapshot: Snapshot; readonly receipt: string; readonly raw: string; readonly hold: string }
const RETENTION = 90 * 86_400_000

/** A signed semantic event pins one generation. A retry can never capture a later reconnect as its new target. */
export async function captureControl(ctx: AuthorityContext, installation: string, event: string): Promise<Control | undefined> {
  const snapshot = await readInstallState(ctx.store, installation)
  if (!snapshot || snapshot.record.closing) return undefined
  const platform = installation.slice(0, installation.indexOf(":"))
  const receipt = everywhereKeys.controlReceipt(platform, installation, event)
  const hold = everywhereKeys.installHold(installation, installationAuthority(snapshot))
  const value = JSON.stringify({ authority: installationAuthority(snapshot), snapshot: sha256Hex(snapshot.raw), outcome: "pending" })
  const known = await getValue(ctx.store, receipt)
  if (known !== undefined) {
    if (known !== value || await getValue(ctx.store, hold) !== receipt) return undefined
    return { snapshot, receipt, raw: known, hold }
  }
  try {
    await authorizedCommands(ctx.store, [{ key: everywhereKeys.install(installation), value: snapshot.raw }, { key: receipt }, { key: hold }], [
      ["SET", receipt, value, "PX", RETENTION], ["SET", hold, receipt],
    ])
    return { snapshot, receipt, raw: value, hold }
  } catch (error) {
    if (error instanceof ApiError && error.code === "EVERYWHERE_AUTHORITY_CHANGED") return undefined
    throw error
  }
}

/** A valid exact current authorization clears only this event's hold; another event's hold is never removed. */
export async function preserveControl(ctx: AuthorityContext, installation: string, control: Control) {
  await authorizedCommands(ctx.store, [{ key: everywhereKeys.install(installation), value: control.snapshot.raw },
    { key: control.receipt, value: control.raw }, { key: control.hold, value: control.receipt }], [
    ["SET", control.receipt, JSON.stringify({ authority: installationAuthority(control.snapshot), snapshot: sha256Hex(control.snapshot.raw), outcome: "preserved" }), "PX", RETENTION],
    ["DEL", control.hold],
  ])
}
