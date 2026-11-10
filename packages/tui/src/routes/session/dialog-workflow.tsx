import { createResource, createSignal } from "solid-js"
import type { WorkflowSaved } from "@vectordevai/sdk/v2"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { DialogSelect } from "../../ui/dialog-select"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { sanitizeTerminalText } from "../../util/presentation"
import { readWorkflowPlan, workflowPlanLines } from "../../util/permission"

/*
 * `/workflow` (5.I.5): pick a saved workflow, fill its inputs, see its plan and every ceiling, then start it. Starting
 * goes through the owner routes 7, 8 and 9. While the session works, the composer gets a message asking the agent to
 * run it instead, which shows the workflow's own approval when the agent reads it.
 */

const safe = sanitizeTerminalText
const INPUT_BYTES = 8 * 1024

type Input = WorkflowSaved["inputs"][number]

function ownerOnly(error: unknown) {
  const cause = error instanceof Error ? (error.cause as { status?: unknown; body?: unknown } | undefined) : undefined
  const body = cause?.body && typeof cause.body === "object" ? (cause.body as Record<string, unknown>) : undefined
  return cause?.status === 403 || body?.code === "forbidden"
}

function failureCode(error: unknown) {
  const cause = error instanceof Error ? (error.cause as { body?: unknown } | undefined) : undefined
  const body = cause?.body && typeof cause.body === "object" ? (cause.body as Record<string, unknown>) : undefined
  return typeof body?.code === "string" ? body.code : undefined
}

function issuesOf(error: unknown) {
  const cause = error instanceof Error ? (error.cause as { body?: unknown } | undefined) : undefined
  const body = cause?.body && typeof cause.body === "object" ? (cause.body as Record<string, unknown>) : undefined
  return Array.isArray(body?.issues)
    ? body.issues.flatMap((issue: unknown) =>
        issue && typeof issue === "object" && typeof (issue as { message?: unknown }).message === "string"
          ? [safe((issue as { message: string }).message)]
          : [],
      )
    : []
}

/**
 * One input's text as its value: blank uses the declared default (left out), text stays text unless the default is
 * not text or the text is a JSON object or list.
 */
function parseInput(field: Input, raw: string): { ok: true; value?: unknown } | { ok: false; message: string } {
  if (!raw.trim()) {
    if (field.required && field.default === undefined) return { ok: false, message: `${field.name} is required.` }
    return { ok: true }
  }
  const json = field.default !== undefined && typeof field.default !== "string"
  let value: unknown = raw
  if (json || /^\s*[[{]/.test(raw)) {
    try {
      value = JSON.parse(raw)
    } catch {
      if (json) return { ok: false, message: `${field.name} must be JSON, like its default.` }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > INPUT_BYTES)
    return { ok: false, message: `${field.name} must be at most 8 KiB.` }
  return { ok: true, value }
}

/** The composer message that asks a busy session's agent to run the saved workflow. */
export function workflowBusyMessage(name: string, inputs: Readonly<Record<string, unknown>>) {
  const quoted = JSON.stringify(name)
  if (Object.keys(inputs).length === 0) return `Run the saved workflow ${quoted} with its default inputs.`
  return `Run the saved workflow ${quoted} with ${JSON.stringify(inputs)}.`
}

export function DialogWorkflow(props: { sessionID: string; busy: () => boolean; onBusy: (message: string) => void }) {
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const dialog = useDialog()
  const [error, setError] = createSignal<string>()
  const [saved] = createResource(async () =>
    sdk.client.experimental.workflow
      .saved({ workspace: project.workspace.current() }, { throwOnError: true })
      .then((result) => result.data?.workflows ?? [])
      .catch((cause: unknown) => {
        setError(ownerOnly(cause) ? "Only the server owner can start a saved workflow." : errorMessage(cause))
        return []
      }),
  )

  function collect(workflow: WorkflowSaved, index: number, inputs: Record<string, unknown>) {
    const field = workflow.inputs[index]
    if (!field) return review(workflow, inputs)
    dialog.replace(() => (
      <DialogPrompt
        title={`${safe(workflow.title)}: ${safe(field.name)}${field.required && field.default === undefined ? "" : " (optional)"}`}
        description={field.description ? () => <text>{safe(field.description!)}</text> : undefined}
        placeholder={
          field.default === undefined
            ? undefined
            : safe(typeof field.default === "string" ? field.default : JSON.stringify(field.default))
        }
        onConfirm={(raw) => {
          const parsed = parseInput(field, raw)
          if (!parsed.ok) return toast.show({ message: parsed.message, variant: "error" })
          collect(workflow, index + 1, parsed.value === undefined ? inputs : { ...inputs, [field.name]: parsed.value })
        }}
      />
    ))
  }

  function review(workflow: WorkflowSaved, inputs: Record<string, unknown>) {
    void sdk.client.experimental.workflow
      .validate(
        { workflowValidateInput: { name: workflow.name, inputs }, workspace: project.workspace.current() },
        { throwOnError: true },
      )
      .then((result) => {
        const validation = result.data
        const plan = readWorkflowPlan(validation?.plan)
        if (!validation?.ok || !plan) {
          const issues = validation?.issues.map((issue) => `${safe(issue.path)}: ${safe(issue.message)}`) ?? []
          toast.show({
            message: issues.join("\n") || "This workflow is not valid.",
            variant: "error",
            duration: 10_000,
          })
          return
        }
        const warnings = validation.warnings.map((issue) => `Warning: ${safe(issue.message)}`)
        const busy = props.busy()
        dialog.replace(() => (
          <DialogConfirm
            title={busy ? `Ask Vector to run ${safe(plan.title)}?` : `Run ${safe(plan.title)}?`}
            message={[
              ...workflowPlanLines(plan),
              ...warnings,
              ...(busy ? ["Vector is working, so this adds a message asking it to run the workflow."] : []),
            ].join("\n")}
            onConfirm={() =>
              busy ? props.onBusy(workflowBusyMessage(workflow.name, inputs)) : start(workflow, inputs)
            }
          />
        ))
      })
      .catch((cause: unknown) =>
        toast.show({
          message: ownerOnly(cause)
            ? "Only the server owner can start a saved workflow."
            : [errorMessage(cause), ...issuesOf(cause)].join("\n"),
          variant: "error",
        }),
      )
  }

  function start(workflow: WorkflowSaved, inputs: Record<string, unknown>) {
    void sdk.client.experimental.workflow
      .start(
        {
          sessionID: props.sessionID,
          workflowStartInput: { name: workflow.name, inputs },
          workspace: project.workspace.current(),
        },
        { throwOnError: true },
      )
      .then((result) =>
        toast.show({ message: `Started ${safe(result.data?.title ?? workflow.title)}.`, variant: "success" }),
      )
      .catch((cause: unknown) => {
        if (failureCode(cause) === "busy") return props.onBusy(workflowBusyMessage(workflow.name, inputs))
        toast.show({
          message: ownerOnly(cause)
            ? "Only the server owner can start a saved workflow."
            : [errorMessage(cause), ...issuesOf(cause)].join("\n"),
          variant: "error",
        })
      })
  }

  const entries = () =>
    [...(saved() ?? [])].sort((a, b) => {
      const invalid = Number(!!a.issues?.length) - Number(!!b.issues?.length)
      return invalid || a.title.localeCompare(b.title) || a.name.localeCompare(b.name)
    })

  return (
    <DialogSelect
      title="Saved workflows"
      emptyView={<text>{error() ?? (saved.loading ? "Loading workflows…" : "No saved workflows.")}</text>}
      options={entries().map((workflow) => ({
        value: workflow.name,
        title: safe(workflow.title),
        description: workflow.issues?.length
          ? `Not valid: ${safe(workflow.issues[0]!.message)}`
          : [safe(workflow.name), workflow.source, ...(workflow.description ? [safe(workflow.description)] : [])].join(
              " · ",
            ),
        category: workflow.source === "repository" ? "This repository" : "Yours",
        onSelect: () => {
          if (workflow.issues?.length) {
            toast.show({
              message: workflow.issues.map((issue) => `${safe(issue.path)}: ${safe(issue.message)}`).join("\n"),
              variant: "error",
              duration: 10_000,
            })
            return
          }
          collect(workflow, 0, {})
        },
      }))}
    />
  )
}
