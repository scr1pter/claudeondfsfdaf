import { createEffect, onCleanup, type Accessor } from "solid-js"
import { toaster } from "@vectordevai/ui/toast"
import { getFilename } from "@vectordevai/core/util/path"
import { useLanguage } from "../../context/language"
import { usePermission } from "../../context/permission"
import { usePlatform } from "../../context/platform"
import { useServerSDK } from "../../context/server-sdk"
import { useServerSync } from "../../context/server-sync"
import { useSettings } from "../../context/settings"
import { alertTitle, sendPhoneAlert } from "../../context/phone-alerts"
import { pathKey } from "../../utils/path-key"
import { playSoundById } from "../../utils/sound"
import { showToast } from "../../utils/toast"
import { desktopOwns } from "../layout-computer-notify"
import { createAskNotificationController } from "./ask-notification-controller"

/** A layout owns one selected-server subscription; changing servers disposes pending lookups and old alerts. */
export function useAskNotificationAlerts(input: {
  directory: Accessor<string | undefined>
  sessionID: Accessor<string | undefined>
  navigate(href: string): void
  enabled?: Accessor<boolean>
}) {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const settings = useSettings()
  const language = useLanguage()
  const platform = usePlatform()
  const permission = usePermission()
  createEffect(() => {
    if (input.enabled?.() === false) return
    const sdk = serverSDK()
    const sync = serverSync()
    const alerts = createAskNotificationController({
      resolve: (id) => sync.session.resolve(id),
      autoResponds: (request, directory) => permission.willAutoRespond(request, directory),
      desktopOwns: () => desktopOwns(platform.computer, sdk.scope),
      preferences: () => ({
        permissions: settings.notifications.permissions(),
        agent: settings.notifications.agent(),
        permissionSound: settings.sounds.permissionsEnabled(),
      }),
      copy(kind, session, directory) {
        const values = {
          sessionTitle: session.title ?? language.t("command.session.new"),
          projectName: getFilename(directory),
        }
        return {
          title: language.t(kind === "permission" ? "notification.permission.title" : "notification.question.title"),
          description: language.t(
            kind === "permission" ? "notification.permission.description" : "notification.question.description",
            values,
          ),
        }
      },
      notify: (title, description, href) => platform.notify(title, description, href),
      sound: () => playSoundById(settings.sounds.permissions()),
      // Its title names the session only (WP A41).
      phoneAlert: (session) =>
        sendPhoneAlert(platform, settings.notifications, {
          event: "needsYou",
          title: alertTitle("Needs you", session.title ?? language.t("command.session.new")),
          route: "approvals",
        }),
      viewed(session, directory) {
        const currentDirectory = input.directory()
        const currentSession = input.sessionID()
        return (
          !!currentDirectory &&
          !!currentSession &&
          pathKey(directory) === pathKey(currentDirectory) &&
          (session.id === currentSession || session.parentID === currentSession)
        )
      },
      toast: (kind, title, description, href) =>
        showToast({
          persistent: true,
          icon: kind === "permission" ? "checklist" : "bubble-5",
          title,
          description,
          actions: [
            { label: language.t("notification.action.goToSession"), onClick: () => input.navigate(href) },
            { label: language.t("common.dismiss"), onClick: "dismiss" },
          ],
        }),
      dismissToast: (id) => toaster.dismiss(id),
    })
    const stop = sdk.event.listen((event) => void alerts.observe(event))
    onCleanup(() => {
      stop()
      alerts.close()
    })
    createEffect(() => {
      const directory = input.directory()
      const sessionID = input.sessionID()
      if (!directory || !sessionID) return
      alerts.dismiss(directory, sessionID)
      const [store] = sync.child(directory, { bootstrap: false })
      for (const child of store.session) if (child.parentID === sessionID) alerts.dismiss(directory, child.id)
    })
  })
}
