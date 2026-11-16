import "./background-tasks.css"
import { Show } from "solid-js"
import { Button } from "@vectordevai/ui/button"
import { Icon } from "@vectordevai/ui/icon"
import { TooltipKeybind } from "@vectordevai/ui/tooltip"
import { Hands } from "@vectordevai/schema/hands"
import { useCommand } from "@/context/command"
import { useComputerState } from "@/features/computer/use-computer-state"
import { BACKGROUND_TASKS_COMMAND, backgroundTasksPane } from "./background-tasks-state"
import { cardModel } from "./computer-card-model"
import { useBackgroundTasks } from "./use-background-tasks"

/** The session header's Tasks toggle, with the count of subagents still running. */
export function BackgroundTasksButton(props: { variant: "v2" | "legacy" }) {
  const tasks = useBackgroundTasks()
  const command = useCommand()
  const count = () => tasks?.runningCount() ?? 0
  const waiting = () => tasks?.waitingCount() ?? 0
  // The same family rule as the pinned card, so the dot always leads to a card, and the dot's words follow the card's
  // status: an active run can be waiting on the user or paused rather than working.
  const computer = useComputerState()
  const hands = () => {
    const card = cardModel(computer?.state(), tasks?.rootID())
    if (!card?.dot) return
    if (card.status === "computer.status.needsYou") return `${Hands.NAME} needs you`
    if (card.status === "computer.status.paused") return `${Hands.NAME} is paused`
    return `${Hands.NAME} is working`
  }
  const label = () => {
    const base =
      waiting() > 0
        ? `Background tasks, ${count()} active, ${waiting()} waiting on you`
        : count() > 0
          ? `Background tasks, ${count()} running`
          : "Background tasks"
    return hands() ? `${base}, ${hands()}` : base
  }
  const keybind = () => command.keybind(BACKGROUND_TASKS_COMMAND)

  return (
    <Show when={tasks?.rootID()}>
      <Show
        when={props.variant === "v2"}
        fallback={
          <TooltipKeybind title={label()} keybind={keybind()}>
            <Button
              variant="ghost"
              class="vector-bg-tasks-launch titlebar-icon h-6 px-1.5 gap-1 box-border shrink-0"
              data-vector-bg-tasks-launch
              data-waiting={waiting() > 0 ? "true" : undefined}
              data-computer={hands() ? "true" : undefined}
              onClick={() => backgroundTasksPane.toggle()}
              aria-label={label()}
              aria-expanded={backgroundTasksPane.opened()}
              aria-controls="vector-bg-tasks"
            >
              <Icon size="small" name="task" />
              <Show when={count() > 0}>
                <span class="vector-bg-tasks-launch-count">{count()}</span>
              </Show>
              <Show when={hands()}>
                <span class="vector-bg-tasks-computer-dot" data-computer-dot aria-hidden="true" />
              </Show>
            </Button>
          </TooltipKeybind>
        }
      >
        <TooltipKeybind title={label()} keybind={keybind()}>
          <button
            type="button"
            class="vector-bg-tasks-launch"
            data-vector-session-tool
            data-vector-bg-tasks-launch
            data-active={backgroundTasksPane.opened() ? "true" : "false"}
            data-running={count() > 0 ? "true" : undefined}
            data-waiting={waiting() > 0 ? "true" : undefined}
            data-computer={hands() ? "true" : undefined}
            onClick={() => backgroundTasksPane.toggle()}
            aria-label={label()}
            aria-expanded={backgroundTasksPane.opened()}
            aria-controls="vector-bg-tasks"
          >
            <Icon size="small" name="task" />
            <span>Tasks</span>
            <Show when={count() > 0}>
              <span data-vector-session-count data-running="true">
                {count()}
              </span>
            </Show>
            <Show when={hands()}>
              <span class="vector-bg-tasks-computer-dot" data-computer-dot aria-hidden="true" />
            </Show>
          </button>
        </TooltipKeybind>
      </Show>
    </Show>
  )
}
