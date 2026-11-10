import { beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createRoot, createSignal } from "solid-js"
import type { DirectorySDK } from "@/context/sdk"
import type { TerminalReveal } from "@/context/terminal"
import { createTerminalReveal } from "@/pages/session/helpers"
import { ServerScope } from "@/utils/server-scope"

let createWorkspaceTerminalSession: typeof import("@/context/terminal").createWorkspaceTerminalSession

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    useLocation: () => ({}),
    useSearchParams: () => [{}, () => undefined],
  }))
  mock.module("@vectordevai/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "web" }),
  }))
  createWorkspaceTerminalSession = (await import("@/context/terminal")).createWorkspaceTerminalSession
})

const agent = { kind: "agent", sessionID: "ses_agent" } as const

function info(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: "dev server", command: "/bin/zsh", args: [], cwd: "/repo", status: "running", pid: 1, ...extra }
}

// A workspace's tabs over the PTY routes and events the server gives it: a real event emitter, and routes answered
// in memory. `list` is what the location holds when the stored tabs finish loading.
function workspace(dir: string, list: () => Promise<unknown> = async () => []) {
  const event = createGlobalEmitter<Record<string, { type: string; properties: unknown }>>()
  const created: string[] = []
  const client = {
    pty: {
      list: async () => ({ data: await list() }),
      create: async (body: { title?: string }) => {
        created.push(`pty_user${created.length + 1}`)
        return { data: { id: created[created.length - 1], title: body.title ?? "" } }
      },
    },
  }
  return createRoot((dispose) => ({
    // Only the routes and events the tab store uses exist here; the rest of the SDK is never reached.
    session: createWorkspaceTerminalSession({ client, event } as unknown as DirectorySDK, dir, ServerScope.local),
    emit: (type: string, properties: unknown) => event.emit(type, { type, properties }),
    dispose,
  }))
}

describe("workspace terminal events", () => {
  test("an agent's new terminal joins the tabs without taking the active one", async () => {
    const tabs = workspace("/repo/agent-created")
    tabs.session.new()
    await Bun.sleep(0)

    tabs.emit("pty.created", { info: info("pty_agent", { owner: agent }) })
    tabs.emit("pty.created", { info: info("pty_agent", { owner: agent }) })
    // A terminal the user opened in another window is not the agent's: that window shows it.
    tabs.emit("pty.created", { info: info("pty_elsewhere") })

    expect(tabs.session.all()).toEqual([
      { id: "pty_user1", title: "Terminal 1", titleNumber: 1 },
      { id: "pty_agent", title: "dev server", titleNumber: 2, agent: "ses_agent" },
    ])
    expect(tabs.session.active()).toBe("pty_user1")
    tabs.dispose()
  })

  test("an agent's terminal becomes the active tab when there is none", () => {
    const tabs = workspace("/repo/agent-first")
    tabs.emit("pty.created", { info: info("pty_agent", { owner: agent }) })
    expect(tabs.session.active()).toBe("pty_agent")
    tabs.dispose()
  })

  test("a user's terminal leaves when its process exits, while an agent's stays with its exit code", async () => {
    const tabs = workspace("/repo/exits")
    tabs.session.new()
    await Bun.sleep(0)
    tabs.emit("pty.created", { info: info("pty_agent", { owner: agent }) })

    tabs.emit("pty.exited", { id: "pty_user1", exitCode: 0 })
    tabs.emit("pty.exited", { id: "pty_agent", exitCode: 3 })

    expect(tabs.session.all()).toEqual([
      { id: "pty_agent", title: "dev server", titleNumber: 2, agent: "ses_agent", exitCode: 3 },
    ])
    expect(tabs.session.active()).toBe("pty_agent")
    tabs.dispose()
  })

  test("a deleted PTY's tab goes, whoever opened it", async () => {
    const tabs = workspace("/repo/deleted")
    tabs.session.new()
    await Bun.sleep(0)
    tabs.emit("pty.created", { info: info("pty_agent", { owner: agent }) })
    tabs.emit("pty.exited", { id: "pty_agent", exitCode: 0 })

    tabs.emit("pty.deleted", { id: "pty_agent" })
    tabs.emit("pty.deleted", { id: "pty_user1" })

    expect(tabs.session.all()).toEqual([])
    expect(tabs.session.active()).toBeUndefined()
    tabs.dispose()
  })

  test("a rename reaches a known tab", () => {
    const tabs = workspace("/repo/renamed")
    tabs.emit("pty.created", { info: info("pty_agent", { owner: agent }) })
    tabs.emit("pty.updated", { info: info("pty_agent", { owner: agent, title: "vite" }) })
    tabs.emit("pty.updated", { info: info("pty_unknown", { title: "other" }) })
    expect(tabs.session.all()).toEqual([{ id: "pty_agent", title: "vite", titleNumber: 1, agent: "ses_agent" }])
    tabs.dispose()
  })

  test("a reveal makes its tab active and records whether to move the focus", async () => {
    const tabs = workspace("/repo/revealed")
    tabs.session.new()
    await Bun.sleep(0)
    tabs.emit("pty.created", { info: info("pty_agent", { owner: agent }) })

    tabs.emit("pty.revealed", { id: "pty_agent", focus: false })
    expect(tabs.session.active()).toBe("pty_agent")
    expect(tabs.session.revealed()).toEqual({ id: "pty_agent", focus: false, at: expect.any(Number) })

    // A terminal this workspace has no tab for shows nothing.
    tabs.emit("pty.revealed", { id: "pty_unknown", focus: true })
    expect(tabs.session.active()).toBe("pty_agent")
    expect(tabs.session.revealed()?.id).toBe("pty_agent")

    tabs.emit("pty.revealed", { id: "pty_user1", focus: true })
    expect(tabs.session.active()).toBe("pty_user1")
    expect(tabs.session.revealed()).toEqual({ id: "pty_user1", focus: true, at: expect.any(Number) })
    tabs.dispose()
  })

  test("agent terminals opened while the app was closed join once the stored tabs load", async () => {
    const tabs = workspace("/repo/listed", async () => [
      info("pty_running", { owner: agent }),
      info("pty_finished", { owner: agent, title: "tests", status: "exited", exitCode: 2 }),
      info("pty_user"),
    ])
    await Bun.sleep(0)
    expect(tabs.session.all()).toEqual([
      { id: "pty_running", title: "dev server", titleNumber: 1, agent: "ses_agent" },
      { id: "pty_finished", title: "tests", titleNumber: 2, agent: "ses_agent", exitCode: 2 },
    ])
    expect(tabs.session.active()).toBe("pty_running")
    tabs.dispose()
  })

  test("an agent tab learns from the list that its process ended unseen", async () => {
    const listed = Promise.withResolvers<unknown[]>()
    const tabs = workspace("/repo/ended-unseen", () => listed.promise)
    tabs.emit("pty.created", { info: info("pty_agent", { owner: agent }) })
    listed.resolve([info("pty_agent", { owner: agent, status: "exited", exitCode: 1 })])
    await Bun.sleep(0)
    expect(tabs.session.all()).toEqual([
      { id: "pty_agent", title: "dev server", titleNumber: 1, agent: "ses_agent", exitCode: 1 },
    ])
    tabs.dispose()
  })

  test("a stored agent tab the server no longer has is marked gone, and an ended one keeps its exit code", async () => {
    const listed = Promise.withResolvers<unknown[]>()
    const state = { list: () => listed.promise }
    const tabs = workspace("/repo/gone", () => state.list())
    tabs.emit("pty.created", { info: info("pty_gone", { owner: agent }) })
    tabs.emit("pty.created", { info: info("pty_live", { owner: agent, title: "watch" }) })
    tabs.emit("pty.created", { info: info("pty_done", { owner: agent, title: "tests" }) })
    tabs.emit("pty.exited", { id: "pty_done", exitCode: 0 })
    await Bun.sleep(0)
    // Opened after the list was asked for: the list is older than this tab, so it says nothing about it.
    tabs.emit("pty.created", { info: info("pty_new", { owner: agent, title: "new" }) })
    listed.resolve([info("pty_live", { owner: agent, title: "watch" })])
    await Bun.sleep(0)
    expect(tabs.session.all()).toEqual([
      { id: "pty_gone", title: "dev server", titleNumber: 1, agent: "ses_agent", gone: true },
      { id: "pty_live", title: "watch", titleNumber: 2, agent: "ses_agent" },
      { id: "pty_done", title: "tests", titleNumber: 3, agent: "ses_agent", exitCode: 0 },
      { id: "pty_new", title: "new", titleNumber: 4, agent: "ses_agent" },
    ])
    // After a reload ended the rest, checking again (a reconnect, a failed connect) marks them too.
    state.list = async () => []
    await tabs.session.reconcile()
    expect(tabs.session.all().map((pty) => [pty.id, pty.gone ?? false])).toEqual([
      ["pty_gone", true],
      ["pty_live", true],
      ["pty_done", false],
      ["pty_new", true],
    ])
    tabs.dispose()
  })

  test("an answer to the list that is not a list judges no tab and logs no error", async () => {
    const errors = spyOn(console, "error")
    // An object, as a server or a fake that does not know the route may answer, then other answers that are no list.
    const state = { list: async (): Promise<unknown> => ({}) }
    const tabs = workspace("/repo/not-a-list", () => state.list())
    tabs.emit("pty.created", { info: info("pty_agent", { owner: agent }) })
    await Bun.sleep(0)
    for (const answer of [null, "pty_agent", { data: [info("pty_other", { owner: agent })] }]) {
      state.list = async () => answer
      await tabs.session.reconcile()
    }
    expect(tabs.session.all()).toEqual([{ id: "pty_agent", title: "dev server", titleNumber: 1, agent: "ses_agent" }])
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    // A real list still judges it: the server no longer has this terminal.
    state.list = async () => []
    await tabs.session.reconcile()
    expect(tabs.session.all()).toEqual([
      { id: "pty_agent", title: "dev server", titleNumber: 1, agent: "ses_agent", gone: true },
    ])
    tabs.dispose()
  })

  test("a command run in a tab ends when its process exits or its tab is closed, once", async () => {
    const tabs = workspace("/repo/run")
    const command = { title: "install", command: "/bin/sh", args: ["-c", "true"] }
    const exits: number[] = []

    const exited = await tabs.session.run(command, (exitCode) => exits.push(exitCode))
    tabs.emit("pty.exited", { id: exited, exitCode: 0 })
    tabs.emit("pty.deleted", { id: exited })

    // Closing the tab deletes the PTY without an exit: the command never finished.
    const closed = await tabs.session.run(command, (exitCode) => exits.push(exitCode))
    tabs.emit("pty.deleted", { id: closed })
    tabs.emit("pty.exited", { id: closed, exitCode: 0 })

    expect(exits).toEqual([0, 1])
    tabs.dispose()
  })
})

describe("revealing a terminal in the panel", () => {
  // The panel's side of a reveal over its real inputs: the tab store's reveal and active tab, and the panel's state.
  function panel(input: { active?: string; opened?: boolean } = {}) {
    const [revealed, setRevealed] = createSignal<TerminalReveal>()
    const [active, setActive] = createSignal(input.active)
    const [opened, setOpened] = createSignal(input.opened ?? false)
    const shown: TerminalReveal[] = []
    return createRoot((dispose) => ({
      quiet: createTerminalReveal({
        revealed,
        active,
        opened,
        open: (value) => {
          shown.push(value)
          setOpened(true)
        },
      }),
      // As the tab store does it: the revealed tab becomes active in the same update.
      reveal: (id: string, focus: boolean) =>
        batch(() => {
          setActive(id)
          setRevealed({ id, focus, at: shown.length + 1 })
        }),
      shown,
      opened,
      setActive,
      setOpened,
      dispose,
    }))
  }

  test("a reveal without focus opens the panel but leaves the user's focus where it is", () => {
    const view = panel({ active: "pty_user" })
    view.reveal("pty_agent", false)
    expect(view.shown).toEqual([{ id: "pty_agent", focus: false, at: 1 }])
    expect(view.opened()).toBe(true)
    expect(view.quiet()).toBe("pty_agent")
    view.dispose()
  })

  test("the revealed tab takes the focus again once the user picks a tab", () => {
    const view = panel({ active: "pty_user", opened: true })
    view.reveal("pty_agent", false)
    view.setActive("pty_user")
    expect(view.quiet()).toBeUndefined()
    view.setActive("pty_agent")
    expect(view.quiet()).toBeUndefined()
    view.dispose()
  })

  test("closing the panel ends a quiet reveal", () => {
    const view = panel({ active: "pty_agent", opened: true })
    view.reveal("pty_agent", false)
    expect(view.quiet()).toBe("pty_agent")
    view.setOpened(false)
    view.setOpened(true)
    expect(view.quiet()).toBeUndefined()
    view.dispose()
  })

  test("a reveal with focus opens the panel and moves the focus", () => {
    const view = panel({ active: "pty_user" })
    view.reveal("pty_agent", true)
    expect(view.shown).toEqual([{ id: "pty_agent", focus: true, at: 1 }])
    expect(view.opened()).toBe(true)
    expect(view.quiet()).toBeUndefined()
    view.dispose()
  })
})
