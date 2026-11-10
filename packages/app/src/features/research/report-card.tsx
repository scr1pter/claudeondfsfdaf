import { Show, Suspense, createMemo, createResource, createSignal } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Markdown } from "@vectordevai/session-ui/markdown"
import { ToolRegistry, type ToolComponent, type ToolProps } from "@vectordevai/session-ui/message-part"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import { downloadResearch, type ReportFormat } from "./report-download"
import {
  CITE_PREFIX,
  GUEST,
  HELD,
  OPEN_SOURCES,
  PREVIEW,
  chipTitle,
  citedNote,
  confidenceOf,
  formatPreference,
  ownerOnly,
  reportMarkdown,
  reportPath,
  type OpenSources,
} from "./research-model"
import "./research.css"

/**
 * The app's research_report row is the report card (section 8.4): the report with source chips that show their quote on
 * hover and open the source at that passage, each section's confidence as Vector's estimate, and Keep in brain, Export,
 * Save to repository, Keep this format and Forget this research. The plain row session-ui draws stays for a guest,
 * for a report that was not saved, and for earlier versions of a report.
 */
export function registerResearchReportCard() {
  const plain = ToolRegistry.render("research_report")
  ToolRegistry.register({
    name: "research_report",
    // A pending report must not hide the chat: that can remove its virtual row and restart the same fetch.
    render: (props) => (
      <Suspense fallback={plain ? <Dynamic component={plain} {...props} /> : undefined}>
        <ResearchReportCard {...props} plain={plain} />
      </Suspense>
    ),
  })
}

export function openSources(detail: OpenSources) {
  window.dispatchEvent(new CustomEvent<OpenSources>(OPEN_SOURCES, { detail }))
}

function ResearchReportCard(props: ToolProps & { plain?: ToolComponent }) {
  const sdk = useSDK()
  const sync = useSync()
  const [version, setVersion] = createSignal(0)
  const [forgetting, setForgetting] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const runID = () => (typeof props.metadata.runID === "string" ? props.metadata.runID : undefined)
  // Only the newest version of a run's report draws the card; calling research_report again saved a new one.
  const latest = createMemo(() => {
    const id = runID()
    if (!id || !props.sessionID) return true
    const versions = (sync().data.message?.[props.sessionID] ?? []).flatMap((message) =>
      (sync().data.part?.[message.id] ?? []).flatMap((part) =>
        part.type === "tool" &&
        part.tool === "research_report" &&
        part.state.status === "completed" &&
        part.state.metadata?.runID === id &&
        typeof part.state.metadata?.version === "number"
          ? [part.state.metadata.version as number]
          : [],
      ),
    )
    return versions.length === 0 || (props.metadata.version ?? 0) >= Math.max(...versions)
  })
  const [detail] = createResource(
    () => {
      const id = runID()
      if (!id || props.status !== "completed" || props.metadata.refused || !latest()) return false
      return { runID: id, version: version(), client: sdk().client }
    },
    (input) => input.client.memory.research.get({ runID: input.runID }, { throwOnError: false }),
  )
  const data = () => detail.latest?.data
  const guest = () => ownerOnly(detail.latest?.response?.status)
  const notes = createMemo(() => new Map((data()?.notes ?? []).map((note) => [note.id, note])))
  const sources = createMemo(() => new Map((data()?.sources ?? []).map((source) => [source.id, source])))
  const markdown = createMemo(() => (data()?.report ? reportMarkdown(data()!.report!) : ""))

  // Chips and badges the Markdown cannot mark itself. Running it twice leaves the same DOM.
  const decorate = (root: HTMLDivElement) => {
    for (const link of root.querySelectorAll<HTMLAnchorElement>(`a[href^="${CITE_PREFIX}"]`)) {
      const id = citedNote(link.getAttribute("href"))
      if (!id) continue
      const note = notes().get(id)
      link.dataset.component = "research-citation"
      link.dataset.note = id
      link.removeAttribute("target")
      link.title = chipTitle(note, note ? sources().get(note.source) : undefined)
      link.setAttribute("aria-label", `Citation ${link.textContent ?? ""}: ${link.title}`)
    }
    for (const line of root.querySelectorAll<HTMLParagraphElement>("p")) {
      const badge = confidenceOf(line.textContent ?? "")
      if (!badge) continue
      line.dataset.component = "research-confidence"
      line.dataset.level = badge.level
      line.title = badge.title
    }
  }

  const open = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest(`a[href^="${CITE_PREFIX}"]`) : null
    if (!link) return
    event.preventDefault()
    const id = citedNote(link.getAttribute("href"))
    const note = id ? notes().get(id) : undefined
    const run = data()?.run
    if (!run) return
    openSources({ sessionID: run.session_id, runID: run.id, ...(note ? { source: note.source, note: note.id } : {}) })
  }

  const act = async (run: () => Promise<unknown>, done: string) => {
    if (busy()) return
    setBusy(true)
    const ok = await run().then(
      () => true,
      (error: unknown) => {
        showToast({
          title: "That did not work",
          description: error instanceof Error ? error.message : String(error),
          variant: "error",
        })
        return false
      },
    )
    setBusy(false)
    if (!ok) return
    showToast({ title: done })
    setVersion((value) => value + 1)
  }

  const exported = async (id: string, format: "markdown" | "json") => {
    const result = await sdk().client.memory.research.export({ runID: id, format })
    const body = result.data as unknown
    return typeof body === "string" ? body : JSON.stringify(body, null, 2)
  }

  const download = (id: string, format: ReportFormat) =>
    act(async () => {
      const run = data()?.run
      await downloadResearch(sdk().client, {
        runID: id,
        question: run?.question ?? "research",
        created: run?.created_at ?? Date.now(),
        format,
      })
    }, "Exported the research")

  return (
    <Show
      when={data()?.report && !guest()}
      fallback={
        <>
          <Show when={props.plain}>{(plain) => <Dynamic component={plain()} {...props} />}</Show>
          <Show when={guest()}>
            <div data-slot="research-muted">{GUEST}</div>
          </Show>
        </>
      }
    >
      <div data-component="research-report">
        <div data-component="research-card">
          <div data-slot="research-row">
            <span data-slot="research-label">Research report</span>
            <span data-component="research-preview-label">{PREVIEW}</span>
            <Show when={data()?.run.kept}>
              <span data-slot="research-tag">Kept in brain</span>
            </Show>
          </div>
          <div onClick={open}>
            <Markdown
              text={markdown()}
              cacheKey={`research:${runID()}:${props.metadata.version ?? 0}`}
              decorate={decorate}
            />
          </div>
          <Show when={!data()?.run.kept && !data()?.guest}>
            <div data-slot="research-notice">{HELD}</div>
          </Show>
          <Show when={data()?.guest}>
            <div data-slot="research-notice">
              An invited guest acted in this session, so this research is kept only until Vector quits and cannot be
              kept in the brain.
            </div>
          </Show>
          <div data-slot="research-actions">
            <Show when={!data()?.run.kept && !data()?.guest}>
              <button
                type="button"
                data-slot="research-button"
                data-variant="primary"
                disabled={busy()}
                onClick={() =>
                  act(() => sdk().client.memory.research.keep({ runID: runID()! }), "Kept the research in your brain")
                }
              >
                Keep in brain
              </button>
            </Show>
            <button
              type="button"
              data-slot="research-button"
              disabled={busy()}
              onClick={() => download(runID()!, "markdown")}
            >
              Export Markdown
            </button>
            <button
              type="button"
              data-slot="research-button"
              disabled={busy()}
              onClick={() => download(runID()!, "json")}
            >
              Export JSON
            </button>
            <button
              type="button"
              data-slot="research-button"
              disabled={busy()}
              onClick={() => download(runID()!, "docx")}
            >
              Export Word
            </button>
            <button
              type="button"
              data-slot="research-button"
              disabled={busy()}
              onClick={() => download(runID()!, "pdf")}
            >
              Export PDF
            </button>
            <button
              type="button"
              data-slot="research-button"
              disabled={busy()}
              onClick={() => {
                const run = data()?.run
                if (!run) return
                const path = reportPath(run.question, run.created_at)
                void act(async () => {
                  const content = await exported(run.id, "markdown")
                  await sdk().client.file.write({ directory: sdk().directory, path, content })
                }, `Saved to ${path}`)
              }}
            >
              Save to repository
            </button>
            <button
              type="button"
              data-slot="research-button"
              disabled={busy()}
              onClick={() =>
                act(
                  () =>
                    sdk().client.memory.create({
                      kind: "preference",
                      scope: "personal",
                      text: formatPreference(data()?.run.plan?.format),
                    }),
                  "Vector will keep this format for research",
                )
              }
            >
              Keep this format
            </button>
            <button
              type="button"
              data-slot="research-button"
              onClick={() => {
                const run = data()?.run
                if (run) openSources({ sessionID: run.session_id, runID: run.id })
              }}
            >
              Sources
            </button>
            <Show
              when={forgetting()}
              fallback={
                <button
                  type="button"
                  data-slot="research-button"
                  data-variant="danger"
                  disabled={busy()}
                  onClick={() => setForgetting(true)}
                >
                  Forget this research
                </button>
              }
            >
              <span data-slot="research-muted">Forget the report, its sources and notes?</span>
              <button
                type="button"
                data-slot="research-button"
                data-variant="danger"
                disabled={busy()}
                onClick={() => {
                  setForgetting(false)
                  void act(() => sdk().client.memory.research.forget({ runID: runID()! }), "Forgot this research")
                }}
              >
                Forget
              </button>
              <button type="button" data-slot="research-button" onClick={() => setForgetting(false)}>
                Keep it
              </button>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
