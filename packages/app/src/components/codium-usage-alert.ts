import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import type { PhoneAlert } from "@/context/phone-alerts"
import type { Platform } from "@/context/platform"
import { usageShare } from "./settings-v2/codium-usage-model"

/**
 * Codium's 80% usage alert, checked at each plan status read while Settings → Usage is open: this computer's
 * notification (WP A24, `codium.alert80`) and the paired phones' alert (WP A41, the "usage" event), both off until the
 * person turns them on. The threshold is the whole-percentage share the Usage card shows (H5), and neither title names
 * an amount (P1).
 *
 * `sent.periods` is A24's dedupe for this app's lifetime: one alert per account, plan and renewal, and a desktop
 * notification that fails removes its key so the next read tries again. `sent.phone` holds the periods whose phone
 * alert went or is on its way, so that retry never repeats the phone alert (F28). Its key is added before the send, so
 * overlapping reads cannot send twice, and removed only when `sendPhoneAlert` held the alert back or the send failed,
 * so a later retry (while the desktop notification keeps failing) tries the phone again, as before.
 */
export function sendUsageAlert(input: {
  status: ModelPlanStatus.Status | undefined
  identity: string | undefined
  desktop: boolean
  phone: boolean
  sent: { periods: Set<string>; phone: Set<string> }
  platform: Pick<Platform, "notify">
  sendPhone: (alert: PhoneAlert) => Promise<boolean>
}) {
  const status = input.status
  const share = usageShare(status?.plan?.left)
  if (
    (!input.desktop && !input.phone) ||
    !input.identity ||
    !status?.signedIn ||
    status.error ||
    !status.plan ||
    !share ||
    share.used < 80
  )
    return
  const key = `${input.identity}:${status.plan.id}:${status.plan.renewsAt}`
  if (input.sent.periods.has(key)) return
  input.sent.periods.add(key)
  if (input.phone && !input.sent.phone.has(key)) {
    input.sent.phone.add(key)
    void input.sendPhone({ event: "usage", title: "You've used 80% of this month's Codium usage" }).then((went) => {
      if (!went) input.sent.phone.delete(key)
    })
  }
  if (!input.desktop) return
  return input.platform
    .notify(
      "Vector Codium usage",
      "You've used at least 80% of this month's Codium usage. Check your plan in Settings → Usage.",
      undefined,
      { force: true },
    )
    .catch(() => void input.sent.periods.delete(key))
}
