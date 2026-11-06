/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import type { TuiPluginApi } from "@vectordevai/plugin/tui"
import type { AssistantMessage, EventSessionSpend, GlobalEvent, Session } from "@vectordevai/sdk/v2"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import plugin, { spendCapLabel } from "../../src/feature-plugins/sidebar/context"
import { tmpdir } from "../fixture/fixture"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { directory, mount, wait } from "../cli/cmd/tui/sync-fixture"

const warning = RGBA.fromInts(250, 170, 20)
const muted = RGBA.fromInts(90, 90, 90)
const other = RGBA.fromInts(200, 200, 200)

test("spendCapLabel shows spend against the cap only when the run has a dollar cap", () => {
  expect(spendCapLabel({ spentUsd: 0.84, capUsd: 2 })).toBe("$0.84 of $2.00")
  expect(spendCapLabel({ spentUsd: 5.021, capUsd: 5 })).toBe("$5.02 of $5.00")
  expect(spendCapLabel({ spentUsd: 0.84 })).toBeUndefined()
  expect(spendCapLabel(undefined)).toBeUndefined()
})

test("the sidebar updates context for a cached zero-output turn without changing session spend", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const previous: AssistantMessage = {
    id: "msg_previous",
    sessionID: "ses_root",
    role: "assistant",
    parentID: "msg_user",
    providerID: "openai",
    modelID: "gpt-test",
    mode: "build",
    agent: "build",
    path: { cwd: "/repo", root: "/repo" },
    time: { created: 1, completed: 2 },
    cost: 0.1,
    tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const [state, setState] = createStore({ messages: [previous] })
  const slot: { render?: (ctx: unknown, props: { session_id: string }) => JSX.Element } = {}
  const base = createTuiPluginApi({
    state: {
      session: {
        messages: () => state.messages,
        get: () => ({ id: "ses_root", title: "Context test", cost: 1.25 }) as Session,
      },
    },
  })
  const api = {
    ...base,
    state: {
      ...base.state,
      provider: [{ id: "openai", models: { "gpt-test": { limit: { context: 2000 } } } }],
    },
    slots: {
      register(input: { slots: { sidebar_content: NonNullable<typeof slot.render> } }) {
        slot.render = input.slots.sidebar_content
      },
    },
  } as unknown as TuiPluginApi
  await plugin.tui(api, undefined, undefined as never)
  const { app } = await mount(undefined, tmp.path, undefined, undefined, () =>
    slot.render?.({}, { session_id: "ses_root" }),
  )
  const shows = (text: string) =>
    wait(() => {
      app.renderer.requestRender()
      return app.captureSpans().lines.some((line) => line.spans.some((span) => span.text.includes(text)))
    })
  try {
    await shows("110 tokens")
    await shows("$1.25 spent")
    const cached = {
      ...previous,
      id: "msg_cached",
      tokens: { input: 0, output: 0, reasoning: 500, cache: { read: 1000, write: 0 } },
    }
    setState("messages", [previous, cached])
    await shows("1,000 tokens")
    await shows("50% used")
    await shows("$1.25 spent")
    setState("messages", [
      previous,
      cached,
      { ...previous, id: "msg_pending", tokens: { ...previous.tokens, input: 0, output: 0 } },
    ])
    await shows("1,000 tokens")
  } finally {
    app.renderer.destroy()
  }
})

test("the sidebar shows the run cap from session.spend and keeps the warning colour for the rest of the run", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const slot: { render?: (ctx: unknown, props: { session_id: string }) => JSX.Element } = {}
  const api = {
    ...createTuiPluginApi({ state: { session: { messages: () => [], get: () => undefined } } }),
    slots: {
      register(input: { slots: { sidebar_content: NonNullable<typeof slot.render> } }) {
        slot.render = input.slots.sidebar_content
      },
    },
    theme: {
      current: new Proxy({}, { get: (_, key) => (key === "warning" ? warning : key === "textMuted" ? muted : other) }),
    },
  } as unknown as TuiPluginApi
  await plugin.tui(api, undefined, undefined as never)
  const { app, emit } = await mount(undefined, tmp.path, undefined, undefined, () =>
    slot.render?.({}, { session_id: "ses_root" }),
  )
  const span = (text: string) =>
    app
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((item) => item.text.includes(text))
  const shows = async (text: string) => {
    await wait(() => {
      app.renderer.requestRender()
      return span(text) !== undefined
    })
    return span(text)!.fg.toInts()
  }
  const report = (id: string, properties: Omit<EventSessionSpend["properties"], "sessionID">): GlobalEvent => ({
    directory,
    project: "proj_test",
    payload: { id, type: "session.spend", properties: { sessionID: "ses_root", ...properties } },
  })
  const priced = { unpricedSteps: 0, costKind: "priced" as const }
  try {
    // With no spend report the panel keeps the plain session cost.
    expect(await shows("$0.00 spent")).toEqual(muted.toInts())

    emit(report("evt_ok", { state: "ok", spentUsd: 0.84, capUsd: 2, steps: 3, ...priced }))
    expect(await shows("$0.84 of $2.00")).toEqual(muted.toInts())

    emit(report("evt_warn", { state: "warn", spentUsd: 1.64, capUsd: 2, steps: 7, ...priced }))
    expect(await shows("$1.64 of $2.00")).toEqual(warning.toInts())

    // The guard reports "warn" once; the next step of the same run reports "ok" and must stay amber.
    emit(report("evt_after_warn", { state: "ok", spentUsd: 1.8, capUsd: 2, steps: 8, ...priced }))
    expect(await shows("$1.80 of $2.00")).toEqual(warning.toInts())

    emit(report("evt_stop", { state: "stopped", reason: "cap", spentUsd: 2.05, capUsd: 2, steps: 9, ...priced }))
    expect(await shows("$2.05 of $2.00")).toEqual(warning.toInts())

    // A new run counts its steps from one again, so it starts without the warning.
    emit(report("evt_next_run", { state: "ok", spentUsd: 0.1, capUsd: 2, steps: 1, ...priced }))
    expect(await shows("$0.10 of $2.00")).toEqual(muted.toInts())

    // A run without a dollar cap falls back to the plain session cost.
    emit(report("evt_no_cap", { state: "ok", spentUsd: 0.2, steps: 2, ...priced }))
    expect(await shows("$0.00 spent")).toEqual(muted.toInts())
  } finally {
    app.renderer.destroy()
  }
})
