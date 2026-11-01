import { Billing } from "@vectordevai/schema/billing"
import { CodiumUsage } from "@vectordevai/core/codium-usage"
import type { AssistantMessage } from "@vectordevai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@vectordevai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createResource, For, Show } from "solid-js"
import { Locale } from "../../util/locale"
import { delegatedSpendLines } from "../../util/session"
import { useSync } from "../../context/sync"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

/** "$0.84 of $2.00" for a run under a spend cap, or undefined when the run has no dollar cap. */
export function spendCapLabel(spend: { spentUsd: number; capUsd?: number } | undefined) {
  if (spend?.capUsd === undefined || !(spend.spentUsd > 0)) return undefined
  return `${money.format(spend.spentUsd)} of ${money.format(spend.capUsd)}`
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const sync = useSync()
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  // The delegated total includes what Vector's hidden helpers (a Vectorscope review, autocomplete) spent for the
  // session. Helpers are in no list, so the session's children are read to split it, again whenever the total as shown
  // changes; a subagent's every step moves the exact figures.
  const revision = createMemo(() => {
    const value = session()
    const total = delegatedSpendLines(value, undefined)[0]
    if (!value || !total) return
    return `${value.id} ${total}`
  })
  const [children] = createResource(revision, (key) => {
    const sessionID = key.split(" ")[0] ?? ""
    return props.api.client.session.children({ sessionID }).then(
      (result) => ({ sessionID, sessions: result.data ?? [] }),
      () => undefined,
    )
  })
  const total = createMemo(() =>
    Locale.sessionSpend(
      session(),
      msg(),
      children.latest?.sessionID === props.session_id ? children.latest.sessions : [],
    ),
  )
  const spent = createMemo(() => {
    const value = total()
    const label = Locale.spend(value.cost, value.unpriced, value.codium)
    return (value.unpriced || value.codium) && !value.cost ? label : `${label} spent`
  })
  const delegated = createMemo(() =>
    delegatedSpendLines(
      session(),
      children.latest?.sessionID === props.session_id ? children.latest.sessions : undefined,
    ),
  )
  // The spend guard reports under the root session, so a subagent's own sidebar shows no run cap.
  const spend = createMemo(() => sync.data.session_spend[props.session_id])

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
        codium: false,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      codium: Boolean(Billing.of(last)),
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>
        {CodiumUsage.withCodium(
          state().codium ? undefined : `${state().tokens.toLocaleString()} tokens`,
          state().codium ? 1 : total().codium,
        )}
      </text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% of context used</text>
      <text fg={theme().textMuted}>{spent()}</text>
      <For each={delegated()}>{(line) => <text fg={theme().textMuted}>{line}</text>}</For>
      <Show when={spendCapLabel(spend())}>
        {(label) => <text fg={spend()?.warned ? theme().warning : theme().textMuted}>{label()} run cap</text>}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
