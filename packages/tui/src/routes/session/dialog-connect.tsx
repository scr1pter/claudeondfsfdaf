import { createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { sanitizeTerminalText } from "../../util/presentation"
import { connectedMemberLine, connectedRunLine } from "./connect-presentation"

export function DialogConnect(props: { sessionID: string }) {
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const [state, setState] = createStore({ busy: false, error: "" })
  const selection = () => ({ sessionID: props.sessionID, workspace: project.workspace.current() })
  const sameSelection = (query: ReturnType<typeof selection>) =>
    query.sessionID === props.sessionID && query.workspace === project.workspace.current()
  const [data, { refetch }] = createResource(selection, async (query) => {
    setState("error", "")
    const values = await Promise.all([
      sdk.client.connect.list(query, { throwOnError: true }),
      sdk.client.connect.runs(query, { throwOnError: true }),
    ]).catch((cause: unknown) => {
      if (sameSelection(query)) setState("error", sanitizeTerminalText(errorMessage(cause)))
      return undefined
    })
    return values ? { query, members: values[0].data ?? [], runs: values[1].data ?? [] } : undefined
  })
  const current = () => {
    const value = data()
    return value && sameSelection(value.query) ? value : undefined
  }
  const dispose = sdk.event.on("event", (event) => {
    if (event.payload.type === "connect.run.updated" && event.payload.properties.sessionID === props.sessionID)
      void refetch()
  })
  onCleanup(dispose)
  const cancel = async (runID: string) => {
    if (state.busy || !current()?.runs.some((run) => run.id === runID && run.status !== "done")) return
    const query = selection()
    setState("busy", true)
    await sdk.client.connect
      .cancel({ runID, ...query }, { throwOnError: true })
      .then(() => {
        if (sameSelection(query)) return refetch()
      })
      .catch((cause: unknown) => {
        if (sameSelection(query)) toast.show({ message: sanitizeTerminalText(errorMessage(cause)), variant: "error" })
      })
      .finally(() => setState("busy", false))
  }
  const options = (): DialogSelectOption<string>[] => [
    ...(current()?.runs ?? []).map((run) => ({
      value: run.id,
      title: sanitizeTerminalText(`${run.request.to}: ${run.status}`),
      description: connectedRunLine(run),
      category: "Recent runs",
      onSelect: () => {
        if (run.status !== "done") void cancel(run.id)
      },
    })),
    ...(current()?.members ?? []).map((member) => ({
      value: member.id,
      title: sanitizeTerminalText(member.title),
      description: connectedMemberLine(member),
      category: "Connected tools",
      onSelect: () => {},
    })),
  ]
  return (
    <DialogSelect
      title="Connected tools"
      locked={state.busy}
      preserveSelection
      options={options()}
      emptyView={<text>{state.error || (data.loading ? "Loading connected tools…" : "No connected tools.")}</text>}
      footer={<text>Select a running review to cancel it. Use /vectorscope to review your changes.</text>}
    />
  )
}
