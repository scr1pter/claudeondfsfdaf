import { For, Show, createMemo, createSignal } from "solid-js"
import { CodiumUsage } from "@vectordevai/core/codium-usage"
import { TooltipV2 } from "@vectordevai/ui/v2/tooltip-v2"
import { useBackgroundTasks } from "@/features/background-tasks/use-background-tasks"
import { desktopSpendAgents, taskCost } from "@/features/background-tasks/task-board-model"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useProviders } from "@/hooks/use-providers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createDelegatedSpend } from "@/components/session-delegated-spend"
import { compactTokens, formatSessionCost, sessionSpend, sessionTokens } from "@/utils/session-cost"
import {
  SPEND_TOOLTIP,
  capTooltip,
  lastAssistantModel,
  sessionReading,
  spendKind,
  spendPill,
} from "@/features/economics/format-spend"

/**
 * Live cost readout for the active session. It reads the aggregated `cost` and
 * `tokens` the backend records on every assistant message and, while a capped
 * run is going, the run guard's per-run figure from `session.spend`, surfaced
 * always-visible instead of hidden in a hover tooltip. Work Vector ran for the
 * session under the hood (a Vectorscope review, autocomplete) and its subagents
 * are part of the total, each named below it.
 */
export function SessionCostReadout() {
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const providers = useProviders(() => sdk().directory)
  const { params } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))
  const messages = createMemo(() => (params.id ? (sync().data.message[params.id] ?? []) : []))
  const [hovered, setHovered] = createSignal(false)
  const delegated = createDelegatedSpend(info, hovered, messages)
  const children = () => [
    ...delegated().sessions,
    ...sync().data.session.filter((child) => child.parentID !== undefined && child.parentID === info()?.id),
  ]
  // The task's spend, so a session that delegated most of its work does not read as cheap.
  const spend = createMemo(() => sessionSpend(info(), messages(), children()))
  const cost = () => spend().cost
  const unpriced = () => CodiumUsage.ownUnpricedSteps(spend().unpricedSteps, spend().codiumSteps)
  const codium = () => spend().codiumSteps
  const tokens = createMemo(() => sessionTokens(info(), messages(), children()))
  const tasks = useBackgroundTasks()
  const desktop = createMemo(() =>
    tasks?.rootID() === info()?.id ? desktopSpendAgents(tasks?.cards().flatMap((card) => card.agents) ?? []) : [],
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: cost() > 0 && cost() < 0.01 ? 4 : 2,
        maximumFractionDigits: 4,
      }),
  )

  // The guard keys a run by its root session, so a subagent's pill reads its root's run.
  const runID = createMemo(() => {
    const session = info()
    if (!session) return undefined
    if (sync().data.session_spend[session.id]) return session.id
    if (session.parentID && sync().data.session_spend[session.parentID]) return session.parentID
    return undefined
  })
  const pill = createMemo(() => {
    const model = lastAssistantModel(messages())
    const id = runID()
    return spendPill({
      session: sessionReading({
        ...spend(),
        tokens: tokens(),
        kind: spendKind(providers.all(), model?.providerID, model?.modelID),
        format: (value) => usd().format(value),
        t: language.t,
      }),
      run: id ? sync().data.session_spend[id] : undefined,
      running: id ? sync().data.session_working(id) : false,
    })
  })

  // Each helper by name, then whatever the subagents spent.
  const parts = createMemo(() => [
    ...delegated().helpers,
    ...(delegated().subagents
      ? [{ label: delegated().split ? "Subagents" : "Subagents and helpers", ...delegated().subagents! }]
      : []),
  ])
  const partText = (part: { cost: number; unpricedSteps: number; codiumSteps: number; tokens: number }) =>
    `${formatSessionCost({
      cost: part.cost,
      unpricedSteps: part.unpricedSteps,
      codiumSteps: part.codiumSteps,
      format: (value) => usd().format(value),
      t: language.t,
    })}${part.tokens ? ` · ${CodiumUsage.withCodium(compactTokens(part.tokens), part.codiumSteps)}` : ""}`

  // Only appears once the session has actually spent something.
  return (
    <Show when={params.id && (cost() > 0 || (tokens() ?? 0) > 0 || codium() > 0 || desktop().length > 0)}>
      <TooltipV2
        placement="bottom"
        value={
          <div class="flex w-[230px] flex-col gap-1.5">
            <div class="flex items-center justify-between gap-4">
              <span class="text-v2-text-text-muted">Session cost</span>
              <span class="text-v2-text-text-base">{pill().session}</span>
            </div>
            <Show when={pill().run}>
              {(run) => (
                <div data-slot="session-cost-run" class="flex items-center justify-between gap-4">
                  <span class="text-v2-text-text-muted">This run</span>
                  <span class="text-v2-text-text-base">{run()}</span>
                </div>
              )}
            </Show>
            <div class="flex items-center justify-between gap-4">
              <span class="text-v2-text-text-muted">Tokens</span>
              <span class="text-v2-text-text-base">
                {CodiumUsage.withCodium(
                  tokens() === undefined
                    ? codium()
                      ? undefined
                      : "Unavailable"
                    : tokens() || !codium()
                      ? tokens()?.toLocaleString(language.intl())
                      : undefined,
                  codium(),
                )}
              </span>
            </div>
            <Show when={parts().length > 0}>
              <div class="pt-1 text-[11px] leading-4 text-v2-text-text-faint">Of which</div>
              <For each={parts()}>
                {(part) => (
                  <div data-slot="session-cost-part" class="flex items-center justify-between gap-4">
                    <span class="truncate text-v2-text-text-muted">{part.label}</span>
                    <span class="shrink-0 text-v2-text-text-base">{partText(part)}</span>
                  </div>
                )}
              </For>
              <For each={delegated().children.slice(0, 8)}>
                {(child) => (
                  <div data-slot="session-cost-child" class="flex items-center justify-between gap-4 pl-2">
                    <span class="truncate text-v2-text-text-muted" title={child.label}>
                      {child.label}
                    </span>
                    <span class="shrink-0 text-v2-text-text-base">{partText(child)}</span>
                  </div>
                )}
              </For>
              <Show when={delegated().children.length > 8}>
                <div class="text-[11px] leading-4 text-v2-text-text-faint">
                  {delegated().children.length - 8} more in Background tasks
                </div>
              </Show>
            </Show>
            <Show when={desktop().length > 0}>
              <div
                data-slot="session-cost-desktop"
                class="flex items-center justify-between gap-4 border-t border-v2-border-base pt-2"
              >
                <span class="text-v2-text-text-muted">Desktop task spend</span>
                <span class="shrink-0 text-v2-text-text-base">{taskCost(desktop())}</span>
              </div>
              <div class="text-[11px] leading-4 text-v2-text-text-faint">
                Latest recorded workspace runs, shown separately from Session cost. Tasks without usage remain unpriced.
              </div>
            </Show>
            <Show when={unpriced() > 0}>
              <div class="pt-1 text-[11px] leading-4 text-v2-text-text-faint">
                {language.t("session.cost.unpricedNote")}
              </div>
            </Show>
            <Show when={codium() > 0}>
              <div class="pt-1 text-[11px] leading-4 text-v2-text-text-faint">
                {language.t("session.cost.codiumNote")}
              </div>
            </Show>
            <div class="pt-1 text-[11px] leading-4 text-v2-text-text-faint">{SPEND_TOOLTIP[pill().kind]}</div>
            <Show when={pill().capUsd} keyed>
              {(capUsd) => <div class="text-[11px] leading-4 text-v2-text-text-faint">{capTooltip(capUsd)}</div>}
            </Show>
          </div>
        }
      >
        {/* --vx tokens, not white/* utilities: the theme resets --color-*, so those classes rendered nothing. */}
        <div
          data-component="session-cost-readout"
          data-state={pill().warn ? "warn" : undefined}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocusIn={() => setHovered(true)}
          onFocusOut={() => setHovered(false)}
          class="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--vx-line)] bg-[color:color-mix(in_srgb,var(--vx-text)_3%,transparent)] px-2.5 text-[11px] font-medium tabular-nums text-[color:color-mix(in_srgb,var(--vx-text)_62%,transparent)] transition-colors duration-150 hover:border-[color:var(--vx-line)] hover:text-[color:color-mix(in_srgb,var(--vx-text)_80%,transparent)]"
        >
          <span classList={{ "text-[#a78bfa]": !pill().warn, "text-[color:var(--vx-amber)]": pill().warn }}>
            {cost() > 0 || (tokens() ?? 0) > 0 || codium() > 0 ? pill().label : `Desktop ${taskCost(desktop())}`}
          </span>
          <Show when={(tokens() ?? 0) > 0}>
            <span class="text-[color:color-mix(in_srgb,var(--vx-text)_25%,transparent)]">·</span>
            <span>{CodiumUsage.withCodium(compactTokens(tokens() ?? 0), codium())}</span>
          </Show>
        </div>
      </TooltipV2>
    </Show>
  )
}
