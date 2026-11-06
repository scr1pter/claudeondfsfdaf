import { For, Show } from "solid-js"
import { Button } from "@vectordevai/ui/button"
import { DockTray } from "@vectordevai/ui/dock-surface"
import { Icon } from "@vectordevai/ui/icon"
import { IconButton } from "@vectordevai/ui/icon-button"
import { useLanguage } from "@/context/language"

export function SessionFollowupDock(props: {
  /** `failed`: the item's send failed; the queue waits at it until Retry or Delete. */
  items: { id: string; text: string; failed?: boolean }[]
  sending?: string
  /** Why the queue stopped sending (a spend stop, a Stop, an error), until Resume. */
  paused?: string
  onSend: (id: string) => void
  onDelete: (id: string) => void
  onResume?: () => void
}) {
  const language = useLanguage()

  return (
    <DockTray
      data-component="session-followup-dock"
      aria-label={language.t(
        props.items.length === 1 ? "session.followupDock.summary.one" : "session.followupDock.summary.other",
        { count: props.items.length },
      )}
    >
      <Show when={props.paused}>
        {(reason) => (
          <div data-component="session-followup-paused" class="flex min-w-0 items-center" role="status">
            <span class="min-w-0 flex-1 truncate text-12-regular text-text-weak">
              {language.t("session.followupDock.paused", { reason: reason() })}
            </span>
            <Show when={props.onResume}>
              {(resume) => (
                <Button size="small" variant="ghost" class="shrink-0" onClick={() => resume()()}>
                  {language.t("session.followupDock.resume")}
                </Button>
              )}
            </Show>
          </div>
        )}
      </Show>
      <div class="overflow-y-auto overscroll-contain no-scrollbar" style={{ "max-height": "min(48vh, 1080px)" }}>
        <For each={props.items}>
          {(item) => (
            <div
              data-component="session-followup-row"
              data-failed={item.failed ? "" : undefined}
              class="flex min-w-0 items-center"
            >
              <span data-component="session-followup-queue-icon" aria-hidden="true">
                <Icon name={item.failed ? "warning" : "enter"} size="normal" />
              </span>
              <span class="min-w-0 flex-1 truncate text-14-regular text-text-strong" title={item.text}>
                {item.text}
              </span>
              <Show when={item.failed}>
                <span data-component="session-followup-failed" class="shrink-0 px-2 text-12-regular text-text-weak">
                  {language.t("session.followupDock.failed")}
                </span>
              </Show>
              <div class="ml-auto flex shrink-0 items-center">
                <Button
                  icon={item.failed ? "reset" : "enter"}
                  size="small"
                  variant="ghost"
                  class="shrink-0"
                  disabled={!!props.sending}
                  onClick={() => props.onSend(item.id)}
                >
                  {item.failed
                    ? language.t("session.followupDock.retry")
                    : language.t("settings.general.row.followup.option.steer")}
                </Button>
                <IconButton
                  icon="trash"
                  size="normal"
                  variant="ghost"
                  disabled={props.sending === item.id}
                  aria-label={language.t("session.followupDock.delete")}
                  onClick={() => props.onDelete(item.id)}
                />
              </div>
            </div>
          )}
        </For>
      </div>
    </DockTray>
  )
}
