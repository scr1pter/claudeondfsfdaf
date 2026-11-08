import { createResource, createSignal, onCleanup } from "solid-js"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"
import { DialogSubagent } from "./dialog-subagent"
import { interruptedTaskIDs, limitsLine, orderedTasks, taskDescription, taskTitle } from "./task-presentation"
import { resumeTasks } from "./task-actions"
import { errorMessage } from "../../util/error"

/**
 * `/tasks` (5.I.5). In the main session it leads with "Resume all interrupted (N)" and "Stop including helpers", and
 * lists helpers a restart interrupted, then each workflow run with its agents, then the rest. `onStopAll` is given only
 * for the main session; a workflow run's agent list has no leading actions.
 */
export function DialogTasks(props: { sessionID: string; onStopAll?: () => void }) {
  const sdk = useSDK()
  const sync = useSync()
  const project = useProject()
  const toast = useToast()
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [tasks, { refetch }] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      setError(undefined)
      return sdk.client.experimental.task
        .list({ sessionID, descendants: "true", workspace: project.workspace.current() }, { throwOnError: true })
        .then((result) => result.data)
        .catch((cause: unknown) => {
          setError(errorMessage(cause))
          return undefined
        })
    },
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const dispose = sdk.event.on("event", (event) => {
    const payload = event.payload
    const relevant =
      payload.type === "session.created" || payload.type === "session.updated"
        ? payload.properties.info.parentID === props.sessionID ||
          tasks()?.tasks.some((task) => task.id === payload.properties.info.id)
        : payload.type === "message.part.updated"
          ? tasks()?.tasks.some((task) => task.sessionID === payload.properties.part.sessionID)
          : payload.type === "server.connected"
    if (!relevant || timer) return
    // Coalesce event bursts; this is an event refresh, never a polling loop.
    timer = setTimeout(() => {
      timer = undefined
      void refetch()
    }, 150)
  })
  onCleanup(() => {
    dispose()
    if (timer) clearTimeout(timer)
  })

  const interrupted = () =>
    props.onStopAll && sync.data.capabilities.taskResume ? interruptedTaskIDs(tasks()?.tasks ?? []) : []

  const actions = (): DialogSelectOption<string>[] => [
    ...(interrupted().length
      ? [
          {
            value: "tasks.resume_interrupted",
            title: `Resume all interrupted (${interrupted().length})`,
            description: "continue every helper a restart stopped, in the background",
            onSelect: () => {
              const taskIDs = interrupted()
              setBusy(true)
              void resumeTasks({
                client: sdk.client,
                sessionID: props.sessionID,
                taskIDs,
                workspace: project.workspace.current(),
              })
                .then((resumed) =>
                  toast.show({
                    message: `Resumed ${resumed.length} of ${taskIDs.length} interrupted helper${taskIDs.length === 1 ? "" : "s"}.`,
                    variant: resumed.length === taskIDs.length ? "success" : "warning",
                  }),
                )
                .catch((cause: unknown) => toast.show({ message: errorMessage(cause), variant: "error" }))
                .finally(() => {
                  setBusy(false)
                  void refetch()
                })
            },
          },
        ]
      : []),
    ...(props.onStopAll
      ? [
          {
            value: "tasks.stop_all",
            title: "Stop including helpers",
            description: "stop the main turn and every helper it started; partial work is kept",
            onSelect: () => props.onStopAll?.(),
          },
        ]
      : []),
  ]

  return (
    <DialogSelect
      title="Subagent tasks"
      preserveSelection
      locked={busy()}
      emptyView={<text>{error() ?? (tasks.loading ? "Loading tasks…" : "No subagent tasks.")}</text>}
      footer={
        <text>
          {[
            ...(tasks()?.limits ? [limitsLine(tasks()!.limits!)] : []),
            tasks()?.truncated
              ? "Showing the first 100 tasks."
              : "Select a task to inspect, message, stop, or open it.",
          ].join("\n")}
        </text>
      }
      options={[
        ...actions(),
        ...orderedTasks(tasks()?.tasks ?? []).map(
          ({ task, category }): DialogSelectOption<string> => ({
            value: task.id,
            title: taskTitle(task),
            description: taskDescription(task),
            category,
            onSelect: (dialog) =>
              dialog.replace(() => (
                <DialogSubagent sessionID={task.id} parentSessionID={props.sessionID} task={task} />
              )),
          }),
        ),
      ]}
    />
  )
}
