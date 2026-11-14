import { Component, For, Show, createResource, onCleanup } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { onCodiumChange } from "@/vector-account"
import { Card, Page, SelectRow, ToggleRow } from "./parts/page"
import {
  DEFAULT_QUIET_HOURS,
  PHONE_ALERT_CONTENT,
  PHONE_ALERT_EVENTS,
  PHONE_APP_ADDRESS,
  QUIET_TIMES,
  phoneAlertsOffered,
  timeLabel,
} from "./notifications-model"
import "./settings-v2.css"

// Settings → Notifications (WP A38). Desktop notifications and sounds for everyone; phone alerts for an account
// whose Codium plan includes them while vectordev.ai lists them. The phone turns its alerts on in the phone app; which
// events this computer sends, and when it stays quiet, are chosen here once this computer can send them (A41).
export const SettingsNotificationsV2: Component = () => {
  const settings = useSettings()
  const platform = usePlatform()
  const [codiumPlan, { refetch }] = createResource(
    () => (platform.vectorAccount?.codium ? true : false),
    () => platform.vectorAccount?.codium?.().catch(() => undefined),
  )
  onCleanup(onCodiumChange(() => void refetch()))
  const times = QUIET_TIMES.map((time) => ({ value: time, label: timeLabel(time) }))
  const quiet = () => settings.notifications.quietHours()

  return (
    <div class="settings-v2-content-root">
      <Page
        eyebrow="Notifications"
        title="Alerts"
        description="Desktop notifications and sounds, and alerts on your phone when your plan includes them."
      >
        <div class="settings-v2-section-grid">
          <Card icon="status" title="On this computer" description="Notifications and sounds stay on this computer.">
            <ToggleRow
              title="Enable notifications"
              description="Desktop notification when the agent finishes or needs input."
              checked={settings.notifications.agent()}
              onChange={settings.notifications.setAgent}
            />
            <ToggleRow
              title="Error notifications"
              checked={settings.notifications.errors()}
              onChange={settings.notifications.setErrors}
            />
            <ToggleRow
              title="Sound effects"
              description="Master switch for agent, permission, and error sounds."
              checked={settings.notifications.soundEffects()}
              onChange={settings.notifications.setSoundEffects}
            />
          </Card>
          <Show when={phoneAlertsOffered(codiumPlan())}>
            <Card
              icon="share"
              title="Phone alerts"
              description={`On your phone, open ${PHONE_APP_ADDRESS}, add it to your Home Screen (needed on iPhone), sign in with this account and turn on alerts. ${PHONE_ALERT_CONTENT}`}
            >
              <Show when={platform.phoneAlerts}>
                <For each={PHONE_ALERT_EVENTS}>
                  {(item) => (
                    <ToggleRow
                      title={item.title}
                      description={item.description}
                      checked={settings.notifications.event(item.event)}
                      onChange={(value) => settings.notifications.setEvent(item.event, value)}
                    />
                  )}
                </For>
                <ToggleRow
                  title="Quiet hours"
                  description="No phone alerts from this computer between these times."
                  checked={quiet() !== null}
                  onChange={(value) => settings.notifications.setQuietHours(value ? DEFAULT_QUIET_HOURS : null)}
                />
                <Show when={quiet()}>
                  {(hours) => (
                    <>
                      <SelectRow
                        title="From"
                        options={times}
                        value={hours().start}
                        onChange={(start) => settings.notifications.setQuietHours({ ...hours(), start })}
                      />
                      <SelectRow
                        title="Until"
                        options={times}
                        value={hours().end}
                        onChange={(end) => settings.notifications.setQuietHours({ ...hours(), end })}
                      />
                    </>
                  )}
                </Show>
              </Show>
            </Card>
          </Show>
        </div>
      </Page>
    </div>
  )
}
