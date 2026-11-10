import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { FOOTER_MENU_ROWS, createFooterMenuState } from "@/cli/cmd/run/footer.menu"
import { runCommandEntries, runCommandPick, type CommandEntry } from "@/cli/cmd/run/footer.command"
import type { FooterSubagentTab } from "@/cli/cmd/run/types"

function mount(count: number, limit = FOOTER_MENU_ROWS) {
  let dispose!: () => void
  let menu!: ReturnType<typeof createFooterMenuState>

  createRoot((nextDispose) => {
    dispose = nextDispose
    menu = createFooterMenuState({ count: () => count, limit })
    return null
  })

  return { menu, dispose }
}

test("footer menu scrolls before the selected row hits the bottom edge", () => {
  const state = mount(20)

  try {
    Array.from({ length: 6 }).forEach(() => state.menu.move(1))

    expect(state.menu.selected()).toBe(6)
    expect(state.menu.offset()).toBe(1)
  } finally {
    state.dispose()
  }
})

test("footer menu scrolls before the selected row hits the top edge", () => {
  const state = mount(20)

  try {
    Array.from({ length: 13 }).forEach(() => state.menu.move(1))
    Array.from({ length: 4 }).forEach(() => state.menu.move(-1))

    expect(state.menu.selected()).toBe(9)
    expect(state.menu.offset()).toBe(7)
  } finally {
    state.dispose()
  }
})

// The split footer's helper commands (5.I.6).
function tab(sessionID: string, status: FooterSubagentTab["status"]): FooterSubagentTab {
  return {
    sessionID,
    partID: `part-${sessionID}`,
    callID: `call-${sessionID}`,
    label: "General",
    description: sessionID,
    status,
    lastUpdatedAt: 1,
  }
}

function entries(input: Partial<Parameters<typeof runCommandEntries>[0]> = {}) {
  return runCommandEntries({ commands: [], subagents: [], queued: [], variants: [], variantCycle: "ctrl+t", ...input })
}

test("footer palette offers Stop including helpers and Resume interrupted helpers only when the runtime does", () => {
  const without = entries({ subagents: [tab("ses_a", "running")] })
  expect(without.map((item) => item.display)).not.toContain("Stop including helpers")
  expect(without.map((item) => item.display)).not.toContain("Resume interrupted helpers")

  const offered = entries({
    subagents: [tab("ses_a", "running"), tab("ses_b", "running"), tab("ses_c", "completed")],
    interruptAll: {},
    resumeInterrupted: true,
  })
  const session = offered
    .filter((item) => item.category === "Session")
    .map((item) => [item.action, item.display, item.footer])
  expect(session).toEqual([
    ["editor", "Open editor", "/editor"],
    ["subagent", "View subagents", "2 active"],
    ["interrupt.all", "Stop including helpers", "2 active"],
    ["resume.interrupted", "Resume interrupted helpers", undefined],
    ["slash", "New session", "/new"],
  ])
  // Its key shows once the keymap binds session.interrupt.all; it is offered while nothing runs, too.
  const idle = entries({ interruptAll: { shortcut: "<leader>k" } })
  expect(idle.find((item) => item.action === "interrupt.all")?.footer).toBe("<leader>k")
  // The rest of the palette is unchanged.
  expect(idle.map((item) => item.display)).toEqual([
    "Open editor",
    "Stop including helpers",
    "New session",
    "Switch model",
    "Variant cycle",
    "Exit",
  ])
})

test("picking a helper command runs its handler and nothing else", () => {
  const calls: string[] = []
  const handlers = {
    onModel: () => calls.push("model"),
    onEditor: () => calls.push("editor"),
    onSkill: () => calls.push("skill"),
    onSubagent: () => calls.push("subagent"),
    onQueued: () => calls.push("queued"),
    onVariant: () => calls.push("variant"),
    onVariantCycle: () => calls.push("cycle"),
    onCommand: (name: string) => calls.push(`/${name}`),
    onNew: () => calls.push("new"),
    onExit: () => calls.push("exit"),
    onInterruptAll: () => calls.push("interrupt.all"),
    onResumeInterrupted: () => calls.push("resume.interrupted"),
  }
  const pick = (action: string) =>
    runCommandPick(
      entries({ interruptAll: {}, resumeInterrupted: true }).find((item) => item.action === action) as CommandEntry,
      handlers,
    )
  pick("interrupt.all")
  pick("resume.interrupted")
  pick("editor")
  pick("exit")
  runCommandPick({ action: "slash", name: "review", category: "Repository Commands", display: "review" }, handlers)
  expect(calls).toEqual(["interrupt.all", "resume.interrupted", "editor", "exit", "/review"])
})
