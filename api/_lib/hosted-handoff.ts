import { persistentStore } from "./persistent-store.js"
import { hostedHandoffAlertKey, readBeat, type HostedHeartbeatHook } from "./hosted-sessions.js"
import { sendServerAlert } from "./web-push.js"

/*
 * "Vector needs you" (contract WP A56). When the cloud computer's credential guard meets a password, one-time-code or
 * card field, or a CAPTCHA, the computer hands itself to the person (WP A54) and its daemon reports why. The person's
 * surfaces show it from the session list (`handoff`); this heartbeat hook also sends one title-only phone alert (P7)
 * for each new hand-over, with the tag that opens the phone's cloud computer page, and at most one per session every
 * `HANDOFF_ALERT_GAP_MS` (P8 review: a field that flaps would otherwise alert on every beat). The alert says nothing
 * about the page or the field: a title and a tag, nothing else.
 */

export const HANDOFF_ALERT_TITLE = "Vector needs you on its cloud computer"
/** One hand-over alert per session at most this often. */
export const HANDOFF_ALERT_GAP_MS = 10 * 60_000

type Send = (account: string, alert: { title: string; tag?: string }) => Promise<unknown>

/**
 * The hook: after the heartbeat stored the computer's report, a hand-over whose `since` is this beat's time is new
 * (the beat keeps `since` while the reason stays the same), so it is alerted, unless the session had an alert in the
 * last `HANDOFF_ALERT_GAP_MS` (SET NX with that lifetime). Nothing is sent during a take-over (the person already has
 * the computer) or when the push service or the plan's alerts are not available.
 */
export function handoffAlertHook(send: Send = (account, alert) => sendServerAlert(account, alert)): HostedHeartbeatHook {
  return async ({ record, now, fetcher }) => {
    if (record.state !== "running") return
    const beat = await readBeat(record.id, fetcher)
    if (!beat?.handoff || beat.handoff.since !== now) return
    const first = await persistentStore(
      ["SET", hostedHandoffAlertKey(record.id), String(now), "NX", "PX", HANDOFF_ALERT_GAP_MS],
      fetcher,
    )
    if (first !== "OK") return
    await send(record.account, { title: HANDOFF_ALERT_TITLE, tag: "computer" })
  }
}
