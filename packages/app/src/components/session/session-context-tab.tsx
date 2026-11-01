import { createEffect, createMemo, on, onCleanup, For, Show } from "solid-js"
import { Billing } from "@vectordevai/schema/billing"
import { CodiumUsage } from "@vectordevai/core/codium-usage"
import type { Message } from "@vectordevai/sdk/v2/client"
import { ScrollView } from "@vectordevai/ui/scroll-view"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useSync } from "@/context/sync"
import { same } from "@/utils/same"
import { createOutcomes } from "@/features/economics/economics-repository"
import { lastAssistantModel, sessionReading, spendKind } from "@/features/economics/format-spend"
import { categorizeTask } from "@/features/economics/task-categorizer"
import { getSessionContext } from "./session-context-metrics"
import { rankModelsForCategory } from "./session-model-economics"
import { createSessionContextFormatter } from "./session-context-format"
import { formatSessionCost, legacyCodium, sessionSpend, sessionTokens } from "@/utils/session-cost"
import { createDelegatedSpend } from "@/components/session-delegated-spend"

const emptyMessages: Message[] = []

export function SessionContextTab() {
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const providers = useProviders(() => sdk().directory)
  const { params, view } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const messages = createMemo(
    () => {
      const id = params.id
      if (!id) return emptyMessages
      return (sync().data.message[id] ?? []) as Message[]
    },
    emptyMessages,
    { equals: same },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )
  // Per-run prices of cheap models are often below a cent, where two decimals would read as free.
  const price = (value: number) =>
    new Intl.NumberFormat(language.intl(), {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
      maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    }).format(value)
  const ctx = createMemo(() => getSessionContext(messages(), [...providers.all().values()]))
  const delegated = createDelegatedSpend(info, undefined, messages)
  const children = () => [
    ...delegated().sessions,
    ...sync().data.session.filter((child) => child.parentID !== undefined && child.parentID === info()?.id),
  ]
  const legacy = createMemo(() => legacyCodium(info(), messages(), children()))
  const tokens = createMemo(() => (info()?.tokensOwnOnly === true ? info()?.tokens : undefined))
  const spend = createMemo(() => sessionSpend(info(), messages(), children()))
  const codium = () => spend().codiumSteps
  const lastModel = createMemo(() => lastAssistantModel(messages()))
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const usage = createMemo(() => Math.max(0, Math.min(100, ctx()?.usage ?? 0)))
  const totalTokens = createMemo(() => sessionTokens(info(), messages(), children()))

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return { all: all.length, user, assistant }
  })

  // Model economics: rank the models Vector has verified for this task's
  // category, learned from real parallel-workspace outcomes.
  const economicsOutcomes = createOutcomes(() => sdk().directory)
  const taskCategory = createMemo(() => categorizeTask(info()?.title ?? ""))
  const modelEconomics = createMemo(() =>
    rankModelsForCategory(economicsOutcomes() ?? [], taskCategory(), ctx()?.tokens ?? 0, providers.all()),
  )
  const formatPercent = (value: number | undefined) => (value === undefined ? "-" : `${Math.round(value * 100)}%`)
  const formatLatency = (ms: number | undefined) =>
    ms === undefined ? "unknown" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`

  const ledger = createMemo(() => [
    {
      label: "Session",
      value: info()?.title || "Untitled session",
    },
    {
      label: "Messages",
      value: formatter().number(counts().all),
    },
    {
      label: "Provider",
      value: ctx()?.providerLabel ?? "No provider selected",
    },
    {
      label: "Model",
      value: ctx()?.modelLabel ?? "No model selected",
    },
    ...(ctx()?.codium ? [] : [{ label: "Context limit", value: formatter().number(ctx()?.limit) }]),
    {
      label: codium() && !totalTokens() ? "Tokens" : "Total tokens",
      value: CodiumUsage.withCodium(
        totalTokens() === undefined
          ? codium()
            ? undefined
            : "Unavailable"
          : totalTokens() || !codium()
            ? formatter().number(totalTokens())
            : undefined,
        codium(),
      ),
    },
    { label: "Usage", value: formatter().percent(ctx()?.usage) },
    ...(!tokens() || (codium() && !totalTokens())
      ? []
      : [
          { label: "Input tokens", value: CodiumUsage.withCodium(formatter().number(tokens()?.input), codium()) },
          { label: "Output tokens", value: CodiumUsage.withCodium(formatter().number(tokens()?.output), codium()) },
          {
            label: "Reasoning tokens",
            value: CodiumUsage.withCodium(formatter().number(tokens()?.reasoning), codium()),
          },
          {
            label: "Cache tokens (read/write)",
            value: CodiumUsage.withCodium(
              `${formatter().number(tokens()?.cache.read)} / ${formatter().number(tokens()?.cache.write)}`,
              codium(),
            ),
          },
        ]),
    {
      label: "User messages",
      value: formatter().number(counts().user),
    },
    {
      label: "Assistant messages",
      value: formatter().number(counts().assistant),
    },
    {
      label: "Total cost",
      value: sessionReading({
        ...spend(),
        tokens: totalTokens(),
        kind: spendKind(providers.all(), lastModel()?.providerID, lastModel()?.modelID),
        format: (value) => usd().format(value),
        t: language.t,
      }).label,
    },
    // Work Vector ran for this session under the hood, by helper, then its subagents; both are in the total above.
    ...[
      ...delegated().helpers,
      ...(delegated().subagents
        ? [{ label: delegated().split ? "subagents" : "subagents and helpers", ...delegated().subagents! }]
        : []),
    ].map((part) => ({
      label: `Of which ${part.label}`,
      value: `${formatSessionCost({
        cost: part.cost,
        unpricedSteps: part.unpricedSteps,
        codiumSteps: part.codiumSteps,
        format: (value) => usd().format(value),
        t: language.t,
      })}${part.tokens ? ` · ${CodiumUsage.withCodium(`${formatter().number(part.tokens)} tokens`, part.codiumSteps)}` : ""}`,
    })),
    {
      label: "Session created",
      value: formatter().time(info()?.time.created),
    },
    {
      label: "Last activity",
      value: formatter().time(info()?.time.updated ?? info()?.time.created),
    },
  ])

  const breakdown = createMemo(() => {
    // Raw Codium context stays local to percentage calculation; its token quantities never enter titles.
    const contextTokens = tokens() ?? ctx()?.message.tokens
    const values = [
      { label: "Input", value: contextTokens?.input ?? 0, color: "#72e2a5" },
      { label: "Output", value: contextTokens?.output ?? 0, color: "#ffb49d" },
      { label: "Reasoning", value: contextTokens?.reasoning ?? 0, color: "#ffd27d" },
      {
        label: "Cache",
        value: (contextTokens?.cache.read ?? 0) + (contextTokens?.cache.write ?? 0),
        color: "#bfa9ff",
      },
    ]
    const total = values.reduce((sum, item) => sum + item.value, 0)
    return values.map((item) => ({
      ...item,
      percentage: total ? (item.value / total) * 100 : 0,
    }))
  })

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined

  const restoreScroll = () => {
    const el = scroll
    if (!el) return
    const saved = view().scroll("context")
    if (!saved) return
    if (el.scrollTop !== saved.y) el.scrollTop = saved.y
    if (el.scrollLeft !== saved.x) el.scrollLeft = saved.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined
      const next = pending
      pending = undefined
      if (!next) return
      view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => messages().length,
      () => requestAnimationFrame(restoreScroll),
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <ScrollView
      class="@container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="flex flex-col gap-4 p-4 @[34rem]:p-5">
        <section class="overflow-hidden rounded-lg border border-[color:var(--vx-line)] bg-[#151517] shadow-[0_16px_44px_rgba(0,0,0,0.2)]">
          <div class="flex items-start justify-between gap-4 border-b border-[color:var(--vx-line)] px-5 py-4">
            <div>
              <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#b99aff]">Context window</div>
              <h3 class="mt-1.5 text-base font-semibold" style={{ color: "#fff" }}>
                Live task ledger
              </h3>
              <p class="mt-1 max-w-[430px] text-xs leading-5 text-white/45">
                Model, message, token, and cost totals for this task only.
              </p>
            </div>
            <div class="flex min-w-[72px] flex-col items-end">
              <strong class="text-sm font-semibold text-[#d6c5ff]">{formatter().percent(ctx()?.usage)}</strong>
              <span class="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-white/32">in context</span>
            </div>
          </div>
          <div class="h-1 bg-white/[0.06]">
            <div class="h-full bg-[#9b78ff] transition-[width] duration-200" style={{ width: `${usage()}%` }} />
          </div>

          <div class="grid grid-cols-1 @[28rem]:grid-cols-2">
            <For each={ledger()}>
              {(item) => (
                <div class="min-w-0 border-b border-[color:var(--vx-line)] px-5 py-3.5 last:border-b-0 @[28rem]:odd:border-r">
                  <div class="text-xs text-white/35">{item.label}</div>
                  <div
                    class="mt-1.5 min-w-0 break-words text-sm font-medium leading-5 text-white/88"
                    title={item.value}
                  >
                    {item.value}
                  </div>
                </div>
              )}
            </For>
          </div>

          <div class="px-5 py-4">
            <div class="text-xs text-white/35">Context breakdown</div>
            <div class="mt-3 flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
              <For each={breakdown()}>
                {(segment) => (
                  <span
                    class="h-full transition-[width] duration-200"
                    style={{ width: `${segment.percentage}%`, "background-color": segment.color }}
                    title={
                      ctx()?.codium || info()?.tokensOwnOnly !== true
                        ? `${segment.label}: ${segment.percentage.toFixed(1)}%`
                        : `${segment.label}: ${formatter().number(segment.value)} tokens`
                    }
                  />
                )}
              </For>
            </div>
            <div class="mt-3 flex flex-wrap gap-x-4 gap-y-2">
              <For each={breakdown()}>
                {(segment) => (
                  <span class="flex items-center gap-1.5 text-xs text-white/38">
                    <i class="size-2 rounded-full" style={{ "background-color": segment.color }} />
                    {segment.label} {segment.percentage.toFixed(1)}%
                  </span>
                )}
              </For>
            </div>
          </div>
        </section>

        <section class="rounded-lg border border-[color:var(--vx-line)] bg-white/[0.025] p-5">
          <div class="flex items-center justify-between gap-3">
            <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/38">Model economics</div>
            <div class="rounded-full border border-[#9b6cff]/30 bg-[#9b6cff]/12 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#d6c5ff]">
              {taskCategory()}
            </div>
          </div>
          <Show
            when={modelEconomics().length > 0}
            fallback={
              <div class="mt-3 text-xs leading-5 text-white/38">
                No recorded runs yet for this task type. Completion and validation checks provide separate evidence
                about how each model performs here.
              </div>
            }
          >
            <div class="mt-4 flex flex-col gap-2">
              <For each={modelEconomics()}>
                {(row) => (
                  <div class="rounded-md border border-[color:var(--vx-line)] bg-white/[0.025] px-4 py-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="min-w-0 truncate text-sm font-semibold text-white">
                        {row.mixedModels ? "Mixed models" : (row.model ?? "Model unknown")} ·{" "}
                        {row.variant?.kind === "named"
                          ? `${row.variant.name} effort`
                          : row.variant?.kind === "mixed"
                            ? "mixed effort"
                            : "effort unknown"}
                      </div>
                      <div class="shrink-0 text-xs text-white/42">
                        {Billing.isCodium(row.provider) ? "Vector Codium" : row.provider}
                      </div>
                    </div>
                    <Show
                      when={!Billing.isCodium(row.provider)}
                      fallback={<div class="mt-2 text-xs text-white/55">Codium</div>}
                    >
                      <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/55">
                        <span>
                          {row.sampleSize} run{row.sampleSize === 1 ? "" : "s"}
                        </span>
                        <span>{row.completedSamples} completed or positively validated</span>
                        <span>{row.unsuccessfulSamples} failed, aborted or incomplete</span>
                        <span>checks {formatPercent(row.checkPassRate)}</span>
                        <span title="Sum of recorded assistant wall-clock intervals, including tools and waits within them; excludes gaps and startup. Not total task wall time or provider-only latency.">
                          median summed reply time {formatLatency(row.medianLatencyMs)} · {row.timedSamples}/
                          {row.sampleSize} timed
                        </span>
                        <Show when={row.medianCostUsd !== undefined}>
                          <span>median {price(row.medianCostUsd ?? 0)}/priced run</span>
                        </Show>
                        <span>
                          {row.pricedSamples}/{row.sampleSize} priced
                        </span>
                        <span>
                          {row.projectedCostUsd !== undefined
                            ? `~${price(row.projectedCostUsd)} next turn`
                            : "rate unknown"}
                        </span>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>
      </div>
    </ScrollView>
  )
}
