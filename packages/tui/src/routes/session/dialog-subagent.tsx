import { DialogSelect } from "../../ui/dialog-select"
import { useRoute } from "../../context/route"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useToast } from "../../ui/toast"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useDialog } from "../../ui/dialog"
import { createSignal } from "solid-js"
import type { Task } from "@vectordevai/schema/task"
import { stageLines, taskProgress, taskTitle } from "./task-presentation"
import { ownerOnlyMessage, resumeTasks } from "./task-actions"
import { errorMessage } from "../../util/error"
import { sanitizeTerminalText } from "../../util/presentation"

export function DialogSubagent(props: { sessionID: string; parentSessionID?: string; task?: Task.Info }) {
  const route = useRoute()
  const sdk = useSDK()
  const sync = useSync()
  const project = useProject()
  const toast = useToast()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  const fail = (error: unknown) => toast.show({ message: errorMessage(error), variant: "error" })
  const capabilities = () => sync.data.capabilities
  const task = () => props.task
  const parent = () => props.parentSessionID
  const run = () => task()?.workflow?.role === "run"
  const workspace = () => project.workspace.current()

  function request<T>(work: () => Promise<T>, done: (value: T) => void, failed: (error: unknown) => void = fail) {
    setBusy(true)
    void work()
      .then(done)
      .catch(failed)
      .finally(() => setBusy(false))
  }

  // Interrupted, stopped or failed engine subagents resume in the background (route 3); a finished one continues with
  // a message. A workflow run resumes through route 12, reusing its finished agents.
  const resumable = () =>
    !!parent() &&
    !run() &&
    capabilities().taskResume &&
    task()?.controls.resume === true &&
    task()?.source === "subagent"
  const continues = () => resumable() && task()?.status === "completed"
  const runResumable = () =>
    !!parent() &&
    run() &&
    capabilities().workflows &&
    (task()?.controls.resume === true || task()?.status === "stopped" || task()?.status === "failed")

  return (
    <DialogSelect
      title={task() ? taskTitle(task()!) : "Subagent actions"}
      locked={busy()}
      options={[
        ...(parent()
          ? [
              {
                title: "Inspect progress",
                value: "subagent.inspect",
                description: "recent steps, messages, partial output and any structured result",
                onSelect: () =>
                  request(
                    () =>
                      sdk.client.experimental.task.inspect(
                        { sessionID: parent()!, taskID: props.sessionID, workspace: workspace() },
                        { throwOnError: true },
                      ),
                    (result) => {
                      if (!result.data) return
                      dialog.replace(() => (
                        <box padding={2} gap={1}>
                          <text>{taskTitle(result.data!.task)}</text>
                          <scrollbox height={20}>
                            <text>{taskProgress(result.data!)}</text>
                          </scrollbox>
                          <text>esc to close</text>
                        </box>
                      ))
                    },
                  ),
              },
            ]
          : []),
        ...(resumable() && !continues()
          ? [
              {
                title: "Resume",
                value: "subagent.resume",
                description: "continue it in the background, with an optional message",
                onSelect: () =>
                  dialog.replace(() => (
                    <DialogTaskResume parentSessionID={parent()!} taskID={props.sessionID} optional />
                  )),
              },
            ]
          : []),
        ...(continues()
          ? [
              {
                title: "Continue with a message",
                value: "subagent.continue",
                description: "start it again in the background with your message",
                onSelect: () =>
                  dialog.replace(() => <DialogTaskResume parentSessionID={parent()!} taskID={props.sessionID} />),
              },
            ]
          : []),
        ...(runResumable()
          ? [
              {
                title: "Resume",
                value: "subagent.workflow.resume",
                description: "run what is left, reusing the agents that finished",
                onSelect: () =>
                  request(
                    () =>
                      sdk.client.experimental.workflow.resume(
                        {
                          sessionID: parent()!,
                          runID: props.sessionID,
                          workflowResumeInput: { retryFailed: true },
                          workspace: workspace(),
                        },
                        { throwOnError: true },
                      ),
                    () => {
                      toast.show({ message: "Workflow resumed.", variant: "success" })
                      dialog.clear()
                    },
                  ),
              },
            ]
          : []),
        ...(parent() && task()?.controls.message
          ? [
              {
                title: "Talk to this subagent",
                value: "subagent.message",
                description: "send a correction for its next safe step",
                onSelect: () =>
                  dialog.replace(() => <DialogTaskMessage parentSessionID={parent()!} taskID={props.sessionID} />),
              },
            ]
          : []),
        ...(parent() && capabilities().taskPromote && task()?.controls.background
          ? [
              {
                title: "Move to background",
                value: "subagent.background",
                description: "free the main turn; it reports on its own later",
                onSelect: () =>
                  request(
                    () =>
                      sdk.client.experimental.task.background(
                        { sessionID: parent()!, taskIDs: [props.sessionID], workspace: workspace() },
                        { throwOnError: true },
                      ),
                    (result) => {
                      const moved = result.data?.tasks.length ?? 0
                      toast.show({
                        message: moved
                          ? "Moved to the background."
                          : "This subagent can no longer move to the background.",
                        variant: moved ? "success" : "warning",
                      })
                      dialog.clear()
                    },
                  ),
              },
            ]
          : []),
        ...(parent() && run()
          ? [
              {
                title: "Show stages",
                value: "subagent.workflow.stages",
                description: "each stage's progress",
                onSelect: () =>
                  dialog.replace(() => (
                    <box padding={2} gap={1}>
                      <text>{taskTitle(task()!)}</text>
                      <scrollbox height={20}>
                        <text>{stageLines(task()!.workflow).join("\n") || "No stages have started yet."}</text>
                      </scrollbox>
                      <text>esc to close</text>
                    </box>
                  )),
              },
              {
                title: "Agents",
                value: "subagent.workflow.agents",
                description: "the run's agents",
                onSelect: () => {
                  void import("./dialog-tasks").then(({ DialogTasks }) =>
                    dialog.replace(() => <DialogTasks sessionID={props.sessionID} />),
                  )
                },
              },
            ]
          : []),
        ...(parent() && capabilities().taskIsolation && task()?.controls.merge
          ? [
              {
                title: "Merge",
                value: "subagent.merge",
                description: "bring its worktree's changes into this checkout",
                onSelect: () =>
                  dialog.replace(() => (
                    <DialogConfirm
                      title="Merge this subagent's changes?"
                      message={`Merge the changes of ${task() ? taskTitle(task()!) : sanitizeTerminalText(props.sessionID)} into this checkout.`}
                      onConfirm={() =>
                        void sdk.client.experimental.task
                          .merge(
                            { sessionID: parent()!, taskID: props.sessionID, workspace: workspace() },
                            { throwOnError: true },
                          )
                          .then((result) => {
                            const data = result.data
                            if (!data) return
                            toast.show({
                              message: data.conflicts.length
                                ? `Merged ${data.merged.length} files. Conflicts in: ${data.conflicts.map(sanitizeTerminalText).join(", ")}. Ask Vector to resolve them.`
                                : `Merged ${data.merged.length} file${data.merged.length === 1 ? "" : "s"}.`,
                              variant: data.conflicts.length ? "warning" : "success",
                              duration: data.conflicts.length ? 10_000 : undefined,
                            })
                          })
                          .catch((error: unknown) =>
                            toast.show({ message: ownerOnlyMessage(error) ?? errorMessage(error), variant: "error" }),
                          )
                      }
                    />
                  )),
              },
            ]
          : []),
        ...(parent() && capabilities().taskIsolation && task()?.controls.discard
          ? [
              {
                title: "Discard",
                value: "subagent.discard",
                description: "throw its worktree's changes away; a recovery copy is kept",
                onSelect: () =>
                  dialog.replace(() => (
                    <DialogConfirm
                      title="Discard this subagent's changes?"
                      message={`Discard the changes of ${task() ? taskTitle(task()!) : sanitizeTerminalText(props.sessionID)}. A recovery copy is kept.`}
                      onConfirm={() =>
                        void sdk.client.experimental.task
                          .discard(
                            { sessionID: parent()!, taskID: props.sessionID, workspace: workspace() },
                            { throwOnError: true },
                          )
                          .then((result) =>
                            toast.show({
                              message: result.data?.saved
                                ? `Discarded. A recovery copy is at ${sanitizeTerminalText(result.data.saved)}.`
                                : "Discarded.",
                              variant: "info",
                            }),
                          )
                          .catch((error: unknown) =>
                            toast.show({ message: ownerOnlyMessage(error) ?? errorMessage(error), variant: "error" }),
                          )
                      }
                    />
                  )),
              },
            ]
          : []),
        ...(parent() && task()?.controls.stop
          ? [
              {
                title: "Stop",
                value: "subagent.stop",
                description: run()
                  ? "stop this workflow run and keep what finished"
                  : "stop this task and retain partial work",
                onSelect: () =>
                  request(
                    () =>
                      sdk.client.experimental.task.stop(
                        {
                          sessionID: parent()!,
                          taskIDs: [props.sessionID],
                          reason: "Stopped from the terminal task panel",
                          workspace: workspace(),
                        },
                        { throwOnError: true },
                      ),
                    () => {
                      toast.show({ message: "Stop requested. Partial work is retained.", variant: "info" })
                      dialog.clear()
                    },
                  ),
              },
            ]
          : []),
        ...(!task() || (task()!.source === "subagent" && task()!.sessionID)
          ? [
              {
                title: "Open",
                value: "subagent.view",
                description: "the subagent's session",
                onSelect: () => {
                  route.navigate({
                    type: "session",
                    sessionID: task()?.sessionID ?? props.sessionID,
                  })
                  dialog.clear()
                },
              },
            ]
          : []),
      ]}
    />
  )
}

function DialogTaskResume(props: { parentSessionID: string; taskID: string; optional?: boolean }) {
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  return (
    <DialogPrompt
      title={props.optional ? "Resume this subagent" : "Continue with a message"}
      placeholder={props.optional ? "Optional: what it should know or do next" : "What it should do next"}
      busy={busy()}
      busyText="Resuming…"
      onConfirm={(value) => {
        const text = value.trim()
        if (!text && !props.optional) return
        setBusy(true)
        void resumeTasks({
          client: sdk.client,
          sessionID: props.parentSessionID,
          taskIDs: [props.taskID],
          ...(text ? { text } : {}),
          workspace: project.workspace.current(),
        })
          .then(() => {
            toast.show({ message: "Resumed in the background.", variant: "success" })
            dialog.clear()
          })
          .catch((error: unknown) => toast.show({ message: errorMessage(error), variant: "error" }))
          .finally(() => setBusy(false))
      }}
    />
  )
}

function DialogTaskMessage(props: { parentSessionID: string; taskID: string }) {
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  return (
    <DialogPrompt
      title="Talk to this subagent"
      placeholder="Describe the correction or additional context"
      busy={busy()}
      busyText="Sending…"
      onConfirm={(text) => {
        if (!text.trim()) return
        setBusy(true)
        void sdk.client.experimental.task
          .message(
            {
              sessionID: props.parentSessionID,
              taskID: props.taskID,
              text,
              delivery: "steer",
              workspace: project.workspace.current(),
            },
            { throwOnError: true },
          )
          .then(() => {
            toast.show({ message: "Message accepted for the subagent's next safe step.", variant: "success" })
            dialog.clear()
          })
          .catch((error: unknown) => toast.show({ message: errorMessage(error), variant: "error" }))
          .finally(() => setBusy(false))
      }}
    />
  )
}
