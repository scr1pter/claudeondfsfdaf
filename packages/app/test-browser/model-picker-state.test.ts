import { expect, test } from "bun:test"
import { createMemo, createRenderEffect, createRoot, createSignal, mapArray, onCleanup } from "solid-js"
import { createPickerCurrent } from "@/components/model-picker-state"
import { buildModelSections, pickerSectionViews, type PickerModel } from "@/utils/provider-brand"

const model = (name = "Maker", providerID = "anthropic", id = "maker/text"): PickerModel => ({
  id,
  name,
  provider: { id: providerID, name: "Anthropic" },
  capabilities: { toolcall: true },
  limit: { context: 100_000 },
})

test("the actual picker key ignores same-key object replacement and propagates actual selection changes", () => {
  const state = createRoot((dispose) => {
    const [selected, setSelected] = createSignal<PickerModel | undefined>(model())
    const current = createPickerCurrent(selected)
    const observed: (string | undefined)[] = []
    createRenderEffect(() => observed.push(current()))
    return { dispose, setSelected, current, observed }
  })
  try {
    expect(state.observed).toEqual(["anthropic:maker/text"])
    state.setSelected(model("Replaced host metadata"))
    expect(state.observed).toEqual(["anthropic:maker/text"])
    state.setSelected(model("Another model", "openai", "maker/other"))
    expect(state.observed).toEqual(["anthropic:maker/text", "openai:maker/other"])
    state.setSelected(undefined)
    expect(state.current()).toBeUndefined()
    expect(state.observed).toEqual(["anthropic:maker/text", "openai:maker/other", undefined])
  } finally {
    state.dispose()
  }
})

test("same-key host updates from a mapped section do not rebuild the section or form a reactive feedback loop", () => {
  const state = createRoot((dispose) => {
    const [host, setHost] = createSignal({ selected: undefined as PickerModel | undefined, epoch: 0 })
    const current = createPickerCurrent(() => host().selected)
    let sectionsRead = 0
    let mounts = 0
    let cleanups = 0
    let effects = 0
    const sections = createMemo(() => {
      if (++sectionsRead > 8) throw new Error("Same-key host updates rebuilt picker sections recursively")
      return buildModelSections({ models: [model()], currentKey: current(), term: "", now: 0 })
    })
    const views = createMemo(() => pickerSectionViews(sections(), new Set(), ""))
    const rows = createMemo(
      mapArray(views, (view) => {
        mounts++
        onCleanup(() => cleanups++)
        return view.section.id
      }),
    )
    createRenderEffect(() => {
      rows()
      effects++
      setHost((previous) => ({ selected: previous.selected, epoch: previous.epoch + 1 }))
    })
    return { dispose, setHost, rows, counts: () => ({ sectionsRead, mounts, cleanups, effects }) }
  })
  try {
    expect(state.rows()).toEqual(["provider:anthropic"])
    expect(state.counts()).toEqual({ sectionsRead: 1, mounts: 1, cleanups: 0, effects: 1 })
    state.setHost({ selected: undefined, epoch: 100 })
    expect(state.counts()).toEqual({ sectionsRead: 1, mounts: 1, cleanups: 0, effects: 1 })
    state.setHost({ selected: model(), epoch: 101 })
    expect(state.rows()).toEqual(["recent", "provider:anthropic"])
    expect(state.counts().sectionsRead).toBe(2)
    expect(state.counts().effects).toBe(2)
    state.setHost({ selected: model("Same key, new object"), epoch: 102 })
    expect(state.counts().sectionsRead).toBe(2)
    expect(state.counts().effects).toBe(2)
  } finally {
    state.dispose()
  }
})
