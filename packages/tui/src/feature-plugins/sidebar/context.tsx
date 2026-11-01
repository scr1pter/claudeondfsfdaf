import type { TuiPlugin, TuiPluginApi } from "@vectordevai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createResource, For, Show } from "solid-js"
import { Locale } from "../../util/locale"
import { delegatedSpendLines } from "../../util/session"
import { getSessionContext } from "../../util/session-context"
import { useSync } from "../../context/sync"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

/** "$0.84 of $2.00" for a run under a spend cap, or undefined when the run has no dollar cap. */
export function spendCapLabel(spend: { spentUsd: number; capUsd?: number } | undefined) {
  if (spend?.capUsd === undefined) return undefined
  return `${money.format(spend.spentUsd)} of ${money.format(spend.capUsd)}`
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const sync = useSync()
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const spent = createMemo(() => {
    const total = Locale.sessionSpend(session())
    const value = Locale.spend(total.cost, total.unpriced)
    return total.unpriced && !total.cost ? value : `${value} spent`
  })
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
  const delegated = createMemo(() =>
    delegatedSpendLines(
      session(),
      children.latest?.sessionID === props.session_id ? children.latest.sessions : undefined,
    ),
  )
  // The spend guard reports under the root session, so a subagent's own sidebar shows no run cap.
  const spend = createMemo(() => sync.data.session_spend[props.session_id])

  const state = createMemo(() => {
    const context = getSessionContext(msg())
    if (!context) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens = context.tokens
    const model = props.api.state.provider.find((item) => item.id === context.message.providerID)?.models[
      context.message.modelID
    ]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
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
