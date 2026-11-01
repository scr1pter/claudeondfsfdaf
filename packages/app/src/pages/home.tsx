import type { Session } from "@vectordevai/sdk/v2/client"
import type { SessionUsageSummary } from "@vectordevai/sdk/v2"
import {
  type ComponentProps,
  createEffect,
  createMemo,
  createResource,
  createRoot,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  startTransition,
  Switch,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useNavigate } from "@solidjs/router"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { Button } from "@vectordevai/ui/button"
import { Logo } from "@vectordevai/ui/logo"
import { Spinner } from "@vectordevai/ui/spinner"
import { ScrollView } from "@vectordevai/ui/scroll-view"
import { ProjectAvatar } from "@vectordevai/ui/v2/project-avatar-v2"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { Icon as IconV2 } from "@vectordevai/ui/v2/icon"
import { IconButtonV2 } from "@vectordevai/ui/v2/icon-button-v2"
import { MenuV2 } from "@vectordevai/ui/v2/menu-v2"
import { TooltipV2 } from "@vectordevai/ui/v2/tooltip-v2"
import { getProjectAvatarVariant, useLayout, type HomeProjectSelection, type LocalProject } from "@/context/layout"
import { base64Encode } from "@vectordevai/core/util/encode"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { Icon } from "@vectordevai/ui/icon"
import { DateTime } from "luxon"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useCloneFromGithub } from "@/components/dialog-clone-github"
import { ProjectTrustMenuItem } from "@/components/project-trust-prompt"
import { DialogSelectServer, useServerManagementController } from "@/components/dialog-select-server"
import { DialogServerV2 } from "@/components/settings-v2/dialog-server-v2"
import { ServerConnection, serverName, useServer } from "@/context/server"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { cloudHref } from "@/features/cloud/cloud-handoff"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import {
  closeHomeProject,
  displayName,
  getProjectAvatarSource,
  homeProjectDirectories,
  projectForSession,
  sortedRootSessions,
  toggleHomeProjectSelection,
} from "@/pages/layout/helpers"
import { SessionTabAvatar } from "@/pages/layout/session-tab-avatar"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"
import { useGlobal } from "@/context/global"
import { useCommand } from "@/context/command"
import { ServerRowMenu } from "@/components/server/server-row-menu"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { type ServerHealth } from "@/utils/server-health"
import { Persist, persisted } from "@/utils/persist"
import { useMarked } from "@vectordevai/ui/context/marked"
import { preloadMarkdown } from "@vectordevai/session-ui/markdown-cache"
import { normalizeUsageSummary, usageStreakCalendar } from "@/utils/usage-summary"
import { VectorAsciiField } from "@/components/vector-ascii-field"
import { HomeUpdate } from "@/components/home-update"
import { useUpdateAction } from "@/components/updater-action"
import {
  Automations,
  automationsApi,
  type AutomationRepository,
  type AutomationSession,
} from "@/features/scheduled/automations"
import { describeNextRun, type AutomationInput, type AutomationRecord } from "@/features/scheduled/schedule-model"
import { useModels } from "@/context/models"

const HOME_SESSION_LIMIT = 64
const HOME_SESSION_HEADER_STICKY_TOP = 12
const HOME_SESSION_HEADER_TEXT_HEIGHT = 16
const HOME_SESSION_HEADER_FADE_DISTANCE = 16
const HOME_ROW_LAYOUT =
  "flex min-w-0 w-full shrink-0 cursor-default items-center rounded-[10px] bg-transparent text-left transition-[background-color,color,box-shadow] duration-[200ms] ease-[cubic-bezier(0.22,0.7,0.28,1)] focus-visible:outline-none"
const HOME_ROW_BASE = `${HOME_ROW_LAYOUT} border-0`
const HOME_ROW = `${HOME_ROW_BASE} [font-weight:530] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover`
const HOME_PROJECT_NAV_LABEL = "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
const HOME_PROJECT_NAV_ROW = `${HOME_ROW_LAYOUT} h-7 gap-2 px-1.5 [font-weight:440] text-v2-text-text-muted hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base hover:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] data-[selected]:bg-v2-background-bg-layer-03 data-[selected]:text-v2-text-text-base data-[selected]:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] data-[selected]:hover:bg-v2-background-bg-layer-03 focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-base focus-visible:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]`
const HOME_SECTION_LABEL = "text-v2-text-text-muted [font-weight:440]"

type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

type HomeSessionGroup = {
  id: "today" | "yesterday" | "older"
  title: string
  sessions: HomeSessionRecord[]
}

const HOME_SESSION_SEARCH_RESULTS_ID = "home-session-search-results"
const HOME_SEARCH_RESULT_ROW =
  "flex h-10 w-full shrink-0 cursor-default items-center gap-2 rounded-[10px] border-0 py-3 pl-[18px] pr-6 text-left transition-[background-color] duration-[200ms] ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
const HOME_SEARCH_RESULT_TITLE =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-base [font-weight:530]"
const HOME_SEARCH_RESULT_META =
  "min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]"

function buildHomeSessionRecords(input: {
  sync: Pick<ServerSync, "child">
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  projectByID: () => Map<string, LocalProject>
}) {
  return [
    ...new Map(
      input
        .projectDirectories()
        .flatMap((directory) => sortedRootSessions(input.sync.child(directory, { bootstrap: false })[0], Date.now()))
        .map((session) => [`${pathKey(session.directory)}:${session.id}`, session] as const),
    ).values(),
  ]
    .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
    .flatMap((session) => {
      const project = projectForSession(session, input.projects(), input.projectByID())
      if (!project) return []
      return {
        session,
        project,
        projectName: displayName(project),
      }
    })
}

function matchesHomeSessionSearch(record: HomeSessionRecord, query: string) {
  return `${record.session.title} ${record.projectName}`.toLowerCase().includes(query)
}

function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${pathKey(record.session.directory)}:${record.session.id}`
}

function useHomeSessionHeaderOpacity(groups: () => HomeSessionGroup[]) {
  let viewport: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let positionFrame: number | undefined
  let resizeObserver: ResizeObserver | undefined
  const headerRefs = new Map<HomeSessionGroup["id"], HTMLDivElement>()
  const headerOffsets = new Map<HomeSessionGroup["id"], number>()
  const [state, setState] = createStore({
    titleOpacity: {} as Partial<Record<HomeSessionGroup["id"], number>>,
  })

  createEffect(() => {
    const items = groups()
    const ids = new Set(items.map((group) => group.id))
    headerRefs.forEach((_, id) => {
      if (!ids.has(id)) headerRefs.delete(id)
    })
    headerOffsets.forEach((_, id) => {
      if (!ids.has(id)) headerOffsets.delete(id)
    })
    if (items.length === 0) {
      content = undefined
      bindResizeObserver()
    }
    queuePositionUpdate()
  })

  onCleanup(() => {
    if (positionFrame !== undefined) cancelAnimationFrame(positionFrame)
    resizeObserver?.disconnect()
  })

  function setViewport(el: HTMLDivElement) {
    viewport = el
    bindResizeObserver()
    queuePositionUpdate()
  }

  function setContentRef(el: HTMLDivElement) {
    content = el
    bindResizeObserver()
    queuePositionUpdate()
  }

  function setHeaderRef(id: HomeSessionGroup["id"], el: HTMLDivElement) {
    headerRefs.set(id, el)
    queuePositionUpdate()
  }

  function queuePositionUpdate() {
    if (typeof requestAnimationFrame === "undefined") {
      updatePositionCache()
      return
    }
    if (positionFrame !== undefined) return
    positionFrame = requestAnimationFrame(() => {
      positionFrame = undefined
      updatePositionCache()
    })
  }

  function updatePositionCache() {
    if (!viewport) return
    groups().forEach((group) => {
      const el = headerRefs.get(group.id)
      if (!el) return
      headerOffsets.set(group.id, el.offsetTop)
    })
    update(viewport.scrollTop)
  }

  function update(scrollTop: number) {
    const items = groups()
    items.forEach((group, index) => {
      const nextOffset = items
        .slice(index + 1)
        .map((item) => headerOffsets.get(item.id))
        .find((offset) => offset !== undefined)
      const fadeEnd = HOME_SESSION_HEADER_STICKY_TOP + HOME_SESSION_HEADER_TEXT_HEIGHT
      const nextTop = nextOffset === undefined ? undefined : nextOffset - scrollTop
      const opacity =
        nextTop === undefined ? 1 : Math.max(0, Math.min(1, (nextTop - fadeEnd) / HOME_SESSION_HEADER_FADE_DISTANCE))
      setState("titleOpacity", group.id, Math.round(opacity * 1000) / 1000)
    })
  }

  function titleOpacity(id: HomeSessionGroup["id"]) {
    return state.titleOpacity[id] ?? 1
  }

  function bindResizeObserver() {
    resizeObserver?.disconnect()
    if (typeof ResizeObserver === "undefined") return
    resizeObserver = new ResizeObserver(() => queuePositionUpdate())
    if (viewport) resizeObserver.observe(viewport)
    if (content) resizeObserver.observe(content)
  }

  return { setViewport, setContentRef, setHeaderRef, update, titleOpacity }
}

export function NewHome() {
  const navigate = useNavigate()
  const sync = useServerSync()
  const layout = useLayout()
  const pickDirectory = useDirectoryPicker()
  const cloneFromGithub = useCloneFromGithub()
  const dialog = useDialog()
  const server = useServer()
  const language = useLanguage()
  const global = useGlobal()
  const tabs = useTabs()
  const command = useCommand()
  const notification = useNotification()
  const marked = useMarked()
  const models = useModels()
  let focusSessionSearch: (() => void) | undefined
  const [state, setState] = createStore({
    search: "",
    searchFocused: false,
  })
  const selection = layout.home.selection

  const focusedServer = createMemo(
    () => global.servers.list().find((conn) => ServerConnection.key(conn) === selection().server) ?? server.current,
  )
  const focusedServerCtx = createMemo(() => {
    const conn = focusedServer()
    if (!conn) return
    return global.ensureServerCtx(conn)
  })
  const focusedSync = () => focusedServerCtx()?.sync ?? sync()
  const projects = createMemo(() => focusedServerCtx()?.projects.list() ?? layout.projects.list())
  const selectedProject = createMemo(() => projects().find((project) => project.worktree === selection().directory))
  const newSessionProject = createMemo(
    () =>
      selectedProject() ??
      projects().find((project) => project.worktree === focusedServerCtx()?.projects.last()) ??
      projects()[0],
  )
  const directories = (project: LocalProject) => [project.worktree, ...(project.sandboxes ?? [])]
  const projectDirectories = createMemo(() => {
    const project = selectedProject()
    if (!project) return projects().flatMap(directories)
    return directories(project)
  })
  const search = createMemo(() => state.search.trim())
  const searchPlaceholder = createMemo(() => {
    const project = selectedProject()
    if (project) {
      return language.t("home.sessions.search.placeholder.scoped", { scope: displayName(project) })
    }
    if (global.servers.list().length > 1) {
      const conn = focusedServer()
      if (conn) {
        return language.t("home.sessions.search.placeholder.scoped", { scope: serverName(conn) })
      }
    }
    return language.t("home.sessions.search.placeholder")
  })
  const sessionLoad = useQuery(() => ({
    queryKey: ["home", "sessions", selection().server, ...projectDirectories()] as const,
    queryFn: async () => {
      await Promise.all(
        projectDirectories().map((directory) =>
          focusedSync().project.loadSessions(directory, { limit: HOME_SESSION_LIMIT }),
        ),
      )
      return null
    },
  }))

  const projectByID = createMemo(
    () => new Map(projects().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const allRecords = createMemo(() =>
    buildHomeSessionRecords({
      sync: focusedSync(),
      projectDirectories,
      projects,
      projectByID,
    }),
  )
  const records = createMemo(() => allRecords().slice(0, HOME_SESSION_LIMIT))
  const searchResults = createMemo(() => {
    const query = search().toLowerCase()
    if (!query) return []
    return allRecords().filter((record) => matchesHomeSessionSearch(record, query))
  })
  const searchOpen = createMemo(() => state.searchFocused && search().length > 0)
  const prefetched = new Set<string>()
  const usageLoad = useQuery(() => ({
    queryKey: ["home", "usage", selection().server] as const,
    queryFn: async () => {
      const ctx = focusedServerCtx()
      if (!ctx) return normalizeUsageSummary(undefined)
      const response = await ctx.sdk.client.experimental.session.usage()
      if (response.data) return normalizeUsageSummary(response.data)
      throw new Error(formatServerError(response.error, undefined, "Vector could not load local usage data."))
    },
    staleTime: 30_000,
  }))

  const [automationsOpen, setAutomationsOpen] = createSignal(false)
  const [automations, setAutomations] = createSignal<AutomationRecord[]>([])
  const [automationsError, setAutomationsError] = createSignal("")
  let automationRefresh = 0
  const automationDirectories = createMemo(() => projects().flatMap(directories))
  const automationRepositories = createMemo<AutomationRepository[]>(() =>
    projects().map((project) => ({ directory: project.worktree, name: displayName(project) })),
  )
  // Sessions come from the same sync store the recents list reads, but scoped to
  // every open repository instead of the focused one: an automation can target a
  // repository the home screen is not currently filtered to.
  const automationSessions = createMemo<AutomationSession[]>(() =>
    buildHomeSessionRecords({
      sync: focusedSync(),
      projectDirectories: automationDirectories,
      projects,
      projectByID,
    }).map((record) => ({
      id: record.session.id,
      title: sessionTitle(record.session.title) || record.session.id,
      // Where the session actually lives, which is the sandbox rather than the
      // worktree for a sandboxed session — that is the directory a run has to
      // resume in.
      directory: record.session.directory,
      repository: record.project.worktree,
    })),
  )
  // The recents list only loads sessions for the focused repository, so opening
  // the panel pulls in the rest before the picker claims a repository has none.
  useQuery(() => ({
    queryKey: ["home", "automations", "sessions", selection().server, ...automationDirectories()] as const,
    enabled: automationsOpen(),
    queryFn: async () => {
      await Promise.all(
        automationDirectories().map((directory) =>
          focusedSync().project.loadSessions(directory, { limit: HOME_SESSION_LIMIT }),
        ),
      )
      return null
    },
  }))

  async function refreshAutomations() {
    const api = automationsApi()
    if (!api) return
    const refresh = ++automationRefresh
    // Home is the global automation surface. Passing no scope is deliberate:
    // changing the selected repository must not hide schedules elsewhere.
    const next = await api.list(undefined).catch((error: unknown) => {
      if (refresh === automationRefresh) {
        setAutomationsError(
          `Vector could not refresh automations: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return undefined
    })
    if (!next || refresh !== automationRefresh) return
    setAutomations(next)
    setAutomationsError("")
  }

  createEffect(() => {
    if (!automationsApi()) return
    // Home can switch repositories without remounting. Re-read the same global
    // schedule after that transition and keep the last good result on failure.
    selection().server
    selection().directory
    void refreshAutomations()
    // The summary line reads "next run in 2 hours", so it has to keep being
    // recomputed or it silently freezes on a home screen left open all day.
    // Slow cadence when the panel is closed, since nothing else is watching.
    const timer = setInterval(() => void refreshAutomations(), automationsOpen() ? 10_000 : 60_000)
    const focus = () => void refreshAutomations()
    globalThis.window?.addEventListener("focus", focus)
    onCleanup(() => {
      clearInterval(timer)
      globalThis.window?.removeEventListener("focus", focus)
    })
  })

  async function createAutomation(input: AutomationInput) {
    const api = automationsApi()
    if (!api) return false
    await models.ready.promise
    // A Codium model the plan no longer includes stays in recents, but every unattended run on it would be refused.
    const recent = models.recent.list().find((item) => {
      const model = models.find(item)
      return model && !ModelPlanStatus.isLocked(model)
    })
    if (!recent) {
      showToast({
        variant: "error",
        title: "Choose a model first",
        description: "Start or open a session and choose the model Vector should use for unattended runs.",
      })
      return false
    }
    const variant = models.variant.get(recent)
    return api
      .create({
        ...input,
        model: { providerID: recent.providerID, id: recent.modelID, variant },
      })
      .then(async () => {
        await refreshAutomations()
        return true
      })
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: "Could not create that automation",
          description: error instanceof Error ? error.message : String(error),
        })
        return false
      })
  }

  function toggleAutomationPause(id: string, paused: boolean) {
    const api = automationsApi()
    if (!api) return
    // Older desktop builds expose only cancel, which can pause but cannot put a
    // cancelled automation back on its schedule. Saying so beats a Resume button
    // that quietly does nothing.
    if (!api.setPaused) {
      if (!paused) {
        showToast({
          variant: "error",
          title: "Resuming needs a newer Vector",
          description: "This build can pause an automation but cannot re-arm it. Update Vector to resume it.",
        })
        return
      }
      void Promise.resolve(api.cancel(id))
        .then(() => refreshAutomations())
        .catch((error: unknown) => {
          showToast({
            variant: "error",
            title: "Could not pause that automation",
            description: error instanceof Error ? error.message : String(error),
          })
        })
      return
    }
    void api
      .setPaused(id, paused)
      .then(() => refreshAutomations())
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: `Could not ${paused ? "pause" : "resume"} that automation`,
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  function deleteAutomation(id: string) {
    const api = automationsApi()
    if (!api) return
    void api
      .remove(id)
      .then(setAutomations)
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: "Could not delete that automation",
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  createEffect(() => {
    const ctx = focusedServerCtx()
    if (!ctx) return
    records()
      .slice(0, 2)
      .forEach((record) => {
        const key = `${ServerConnection.key(focusedServer()!)}\0${record.session.id}`
        if (prefetched.has(key)) return
        prefetched.add(key)
        createRoot((dispose) => {
          try {
            const directory = ctx.sync.ensureDirSyncContext(record.session.directory)
            void directory.session
              .sync(record.session.id)
              .then(() => {
                return Promise.all(
                  (ctx.sync.session.data.message[record.session.id] ?? []).flatMap((message) =>
                    (ctx.sync.session.data.part[message.id] ?? []).flatMap((part) => {
                      if (part.type !== "text" || !part.text) return []
                      return preloadMarkdown(part.text, part.id, marked)
                    }),
                  ),
                )
              })
              .catch(() => {})
              .finally(dispose)
          } catch {
            dispose()
          }
        })
      })
  })

  function setSelection(next: HomeProjectSelection) {
    layout.home.setSelection(next)
  }

  function closeSearch() {
    setState("search", "")
    setState("searchFocused", false)
  }

  function selectSearchSession(session: Session) {
    openSession(session)
    closeSearch()
  }

  command.register("home", () => [
    {
      id: "home.sessions.search.focus",
      title: searchPlaceholder(),
      keybind: "mod+f",
      hidden: true,
      onSelect: () => focusSessionSearch?.(),
    },
    // The legacy layout registers project.open only around /:dir routes, so Home needs its own for File > Open
    // Project... and the keybind.
    {
      id: "project.open",
      title: language.t("command.project.open"),
      category: language.t("command.category.project"),
      keybind: "mod+o",
      onSelect: () => {
        const conn = focusedServer() ?? global.servers.list()[0]
        if (conn) chooseProject(conn)
      },
    },
  ])

  const cloneAction = createMemo(() => {
    const conn = focusedServer() ?? global.servers.list()[0]
    if (!conn || !cloneFromGithub.available(conn)) return
    return () => cloneFromGithub.open(conn)
  })

  createEffect(() => {
    const list = global.servers.list()
    if (list.some((conn) => ServerConnection.key(conn) === selection().server)) return
    const conn = list.find((conn) => ServerConnection.key(conn) === server.key) ?? list[0]
    if (conn) setSelection({ server: ServerConnection.key(conn) })
  })

  function focusServer(conn: ServerConnection.Any) {
    setSelection({ server: ServerConnection.key(conn) })
  }

  function selectProject(conn: ServerConnection.Any, directory: string) {
    const key = ServerConnection.key(conn)
    if (global.servers.health[key]?.healthy === false) return
    if (
      !global
        .ensureServerCtx(conn)
        .projects.list()
        .some((project) => project.worktree === directory)
    )
      return
    setSelection(toggleHomeProjectSelection(selection(), key, directory))
  }

  function addProjects(conn: ServerConnection.Any, directories: string[]) {
    const directory = directories[0]
    if (!directory) return
    const ctx = global.ensureServerCtx(conn)
    directories.forEach(ctx.projects.open)
    ctx.projects.touch(directory)
    setSelection({ server: ServerConnection.key(conn), directory })
  }

  function openNewSession() {
    const conn = focusedServer()
    const project = newSessionProject()
    if (!conn || !project) return
    openProjectNewSession(conn, project.worktree)
  }

  function openProjectNewSession(conn: ServerConnection.Any, directory: string) {
    const ctx = global.ensureServerCtx(conn)
    ctx.projects.open(directory)
    ctx.projects.touch(directory)
    tabs.newDraft({ server: ServerConnection.key(conn), directory })
  }

  function editProject(conn: ServerConnection.Any, project: LocalProject) {
    void import("@/components/dialog-edit-project").then((x) => {
      dialog.show(() => <x.DialogEditProject server={conn} project={project} />)
    })
  }

  function unseenCount(conn: ServerConnection.Any, project: LocalProject) {
    const state = notification.ensureServerState(ServerConnection.key(conn))
    return directories(project).reduce((total, directory) => total + state.project.unseenCount(directory), 0)
  }

  function clearNotifications(conn: ServerConnection.Any, project: LocalProject) {
    const state = notification.ensureServerState(ServerConnection.key(conn))
    directories(project)
      .filter((directory) => state.project.unseenCount(directory) > 0)
      .forEach((directory) => state.project.markViewed(directory))
  }

  async function openSession(session: Session) {
    const project = projectForSession(session, projects(), projectByID())
    const conn = focusedServer()
    if (!conn) return
    const directory = project?.worktree ?? session.directory
    const ctx = global.ensureServerCtx(conn)

    try {
      await ctx.sdk.createClient({ directory, throwOnError: true }).file.list({ path: "." })
    } catch (error) {
      showToast({
        title: "Repository folder unavailable",
        description: formatServerError(
          error,
          undefined,
          `Vector cannot open ${directory}. Reopen the repository folder or start a new workspace from an existing repository.`,
        ),
        variant: "error",
        duration: 10000,
      })
      return
    }

    ctx.projects.open(directory)
    ctx.projects.touch(directory)
    startTransition(() => {
      const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
      tabs.select(tab)
    })
  }

  function chooseProject(conn: ServerConnection.Any) {
    if (global.servers.health[ServerConnection.key(conn)]?.healthy === false) return

    function resolve(result: string | string[] | null) {
      addProjects(conn, homeProjectDirectories(result))
    }

    pickDirectory({
      server: conn,
      title: "Open repository",
      multiple: true,
      onSelect: resolve,
    })
  }

  // The shell's Update action, so Home shows Update too: it has no sidebar.
  const updateAction = useUpdateAction()

  function openSettings() {
    void import("@/components/settings-v2/dialog-settings-v2").then((module) => {
      dialog.show(() => <module.DialogSettings repositoryPath={newSessionProject()?.worktree} />)
    })
  }

  return (
    <div
      data-vector-home
      class="rounded-[18px] shadow-[var(--v2-elevation-raised)] m-2 min-h-0 lg:overflow-hidden bg-[var(--vx-stage)] text-white self-stretch flex-1"
      style={{
        /* Alias the v2 token fork onto the real --vx-* shell ramp so sticky
           headers, fades, and layered surfaces never drift from the page
           background (see vector-premium.css [data-vector-home]). */
        "--v2-background-bg-base": "var(--vx-stage)",
        "--v2-background-bg-deep": "var(--vx-canvas)",
        "--v2-background-bg-layer-01": "var(--vx-sidebar)",
        "--v2-background-bg-layer-02": "var(--vx-surface)",
        "--v2-background-bg-layer-03": "var(--vx-surface-raised)",
        "--v2-background-bg-layer-04": "var(--vx-control-hover)",
        "--v2-text-text-base": "var(--vx-text)",
        "--v2-text-text-muted": "var(--vx-text-subtle)",
        "--v2-text-text-faint": "var(--vx-text-muted)",
        "--v2-icon-icon-muted": "var(--vx-text-subtle)",
        "--v2-border-border-base": "var(--vx-line-strong)",
        "--v2-border-border-muted": "var(--vx-line)",
        "--v2-overlay-simple-overlay-hover": "rgba(255,255,255,0.06)",
      }}
    >
      <VectorAsciiField />
      <div class="vector-home-dashboard">
        <header data-vector-home-overview class="vector-home-heading">
          <div class="vector-home-heading__topline">
            <div class="vector-home-heading__status" aria-label="Workspace status">
              <span classList={{ "is-offline": global.servers.health[selection().server]?.healthy === false }} />
              {global.servers.health[selection().server]?.healthy === false ? "Runtime offline" : "Runtime ready"}
            </div>
          </div>
          <div class="vector-home-heading__main">
            <div class="vector-home-heading__copy">
              <span>{selectedProject() ? displayName(selectedProject()!) : "The agentic workspace for builders"}</span>
              <h1>
                {selectedProject()
                  ? "Give Vector one concrete outcome."
                  : "Choose a repository. Direct an army of builders."}
              </h1>
              <p>
                {selectedProject()
                  ? "Vector can plan, research, edit, run, browse, verify, and ship from this repository. You stay in control of every change."
                  : "Bring your own models and tools. Work directly, direct one agent, or coordinate isolated builders from one local-first workspace."}
              </p>
            </div>
            <div class="vector-home-heading__actions">
              <Show when={newSessionProject()}>
                <button type="button" data-variant="primary" onClick={openNewSession}>
                  <IconV2 name="edit" />
                  Start building
                </button>
              </Show>
              <button
                type="button"
                data-variant="secondary"
                onClick={() => navigate(cloudHref(newSessionProject()?.worktree))}
              >
                <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                  <path
                    d="M4.35 12.2a2.9 2.9 0 0 1-.3-5.78 3.6 3.6 0 0 1 6.96-1.2 2.7 2.7 0 0 1 .54 5.34"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.15"
                    stroke-linecap="round"
                  />
                  <path
                    d="M8 8v4.3m0 0 1.6-1.6M8 12.3l-1.6-1.6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.15"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                Vector Cloud
              </button>
              <Show when={updateAction}>
                {(action) => (
                  <HomeUpdate
                    update={action().update()}
                    onUpdate={action().install}
                    runningAgents={action().runningAgents}
                  />
                )}
              </Show>
              <button type="button" data-variant="secondary" onClick={openSettings}>
                <IconV2 name="settings-gear" />
                Settings
              </button>
            </div>
          </div>
        </header>

        <HomeProjectDeck
          projects={projects()}
          selected={selectedProject()}
          server={focusedServer()}
          selectProject={selectProject}
          openNewSession={openProjectNewSession}
          editProject={editProject}
          closeProject={(conn, directory) => {
            const next = closeHomeProject(
              selection(),
              ServerConnection.key(conn),
              global.ensureServerCtx(conn).projects,
              directory,
            )
            if (next) setSelection(next)
          }}
          chooseProject={() => {
            const conn = focusedServer() ?? global.servers.list()[0]
            if (conn) chooseProject(conn)
          }}
          cloneFromGithub={cloneAction()}
        />

        <HomeUsagePulse
          summary={usageLoad.data}
          loading={usageLoad.isLoading}
          failed={usageLoad.isError}
          onOpenUsage={() => {
            void import("@/components/settings-v2/dialog-settings-v2").then((module) => {
              dialog.show(() => (
                <module.DialogSettings section="usage" repositoryPath={newSessionProject()?.worktree} />
              ))
            })
          }}
        />

        <HomeAutomations
          supported={Boolean(automationsApi())}
          records={automations()}
          error={automationsError()}
          onOpen={() => setAutomationsOpen(true)}
        />

        <section class="vector-home-recents" aria-label={language.t("sidebar.project.recentSessions")}>
          <div class="vector-home-recents__header">
            <div>
              <span>Recent work</span>
              <h2>{selectedProject() ? displayName(selectedProject()!) : "Across your repositories"}</h2>
            </div>
            <Show when={newSessionProject()}>
              <ButtonV2
                data-action="home-new-session"
                variant="ghost-muted"
                size="normal"
                icon="edit"
                class="h-8 px-3 [font-weight:530]"
                onClick={openNewSession}
              >
                New session
              </ButtonV2>
            </Show>
          </div>
          <HomeSessionSearch
            value={state.search}
            placeholder={searchPlaceholder()}
            open={searchOpen()}
            loading={sessionLoad.isLoading}
            results={searchResults()}
            showProjectName={!selectedProject()}
            server={selection().server}
            noResultsLabel={language.t("home.sessions.search.noResults", { query: search() })}
            bindFocus={(focus) => {
              focusSessionSearch = focus
            }}
            onInput={(value) => setState("search", value)}
            onFocus={() => setState("searchFocused", true)}
            onClose={closeSearch}
            onSelect={selectSearchSession}
          />
          <div class="vector-home-recents__scroll">
            <Show when={!sessionLoad.isLoading} fallback={<HomeSessionSkeleton label={language.t("common.loading")} />}>
              <Show
                when={records().length > 0}
                fallback={
                  <HomeSessionsEmpty
                    hasKnownProjects={projectDirectories().length > 0}
                    onNewSession={newSessionProject() ? openNewSession : undefined}
                    onOpenProject={
                      newSessionProject()
                        ? undefined
                        : () => {
                            const conn = focusedServer() ?? global.servers.list()[0]
                            if (conn) chooseProject(conn)
                          }
                    }
                    onCloneFromGithub={newSessionProject() ? undefined : cloneAction()}
                  />
                }
              >
                <div class="vector-home-recents__grid">
                  <For each={records()}>
                    {(record) => (
                      <HomeSessionRow
                        record={record}
                        showProjectName={!selectedProject()}
                        server={selection().server}
                        openSession={openSession}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </section>
      </div>

      <Automations
        open={automationsOpen()}
        supported={Boolean(automationsApi())}
        repositories={automationRepositories()}
        sessions={automationSessions()}
        records={automations()}
        loadError={automationsError()}
        focusedRepository={selectedProject()?.worktree}
        onClose={() => setAutomationsOpen(false)}
        onCreate={createAutomation}
        onTogglePause={toggleAutomationPause}
        onDelete={deleteAutomation}
      />
    </div>
  )
}

function HomeAutomations(props: {
  supported: boolean
  records: AutomationRecord[]
  error?: string
  onOpen: () => void
}) {
  // Still on the schedule. A settled one-shot keeps its runAt in the past, so
  // counting it would pin the summary to "Due now" forever.
  const pending = createMemo(() =>
    props.records.filter((record) => !record.paused && (record.status === "scheduled" || record.status === "running")),
  )
  const paused = createMemo(() => props.records.filter((record) => record.paused).length)
  const next = createMemo(() => {
    const times = pending()
      .map((record) => new Date(record.runAt).getTime())
      .filter((time) => Number.isFinite(time))
    if (times.length === 0) return undefined
    return new Date(Math.min(...times))
  })

  return (
    <section data-vector-home-automations class="shrink-0" aria-label="Automations">
      <div class="min-w-0 px-0.5 pb-2.5">
        <span class="block [font-family:var(--vx-mono)] text-[9.5px] uppercase [font-weight:650] text-v2-text-text-faint">
          Automations
        </span>
        <strong class="mt-1 block text-[15px] [font-weight:620] text-v2-text-text-base">
          Work Vector repeats without you
        </strong>
      </div>
      <Show
        when={props.supported}
        fallback={
          <p class="rounded-[8px] border border-v2-border-border-muted bg-[rgba(255,255,255,0.018)] px-3 py-2.5 text-[11.5px] leading-relaxed text-v2-text-text-muted">
            Automations run from the Vector desktop app, which keeps a scheduler alive in the tray. This surface
            activates once Vector connects to this workspace.
          </p>
        }
      >
        <button
          type="button"
          data-action="home-open-automations"
          class="flex w-full items-center gap-3 rounded-[8px] border border-v2-border-border-muted bg-[rgba(255,255,255,0.018)] px-3 py-2.5 text-left transition-[background-color,border-color] duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:border-[rgba(178,140,255,0.3)] hover:bg-[rgba(147,116,236,0.08)]"
          onClick={props.onOpen}
        >
          <span class="grid size-8 shrink-0 place-items-center rounded-[7px] border border-v2-border-border-muted bg-[rgba(255,255,255,0.025)] text-v2-icon-icon-muted">
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path
                d="M2.9 8a5.1 5.1 0 0 1 8.7-3.6l1.5 1.5m0 0V3.2m0 2.7h-2.7M13.1 8a5.1 5.1 0 0 1-8.7 3.6l-1.5-1.5m0 0v2.7m0-2.7h2.7"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-[12.5px] [font-weight:570] text-v2-text-text-base">
              {props.records.length === 0
                ? "Set up a recurring run"
                : `${pending().length === 1 ? "1 automation" : `${pending().length} automations`} on schedule${paused() ? ` · ${paused()} paused` : ""}`}
            </span>
            <span class="mt-0.5 block truncate text-[11.5px] text-v2-text-text-muted">
              {props.error
                ? props.error
                : props.records.length === 0
                  ? "One task, on a schedule, in the repositories and sessions you choose — while you are away."
                  : describeNextRun(next(), new Date())}
            </span>
          </span>
          <span class="shrink-0 text-[11.5px] text-v2-text-text-muted">Open</span>
          <IconV2 name="outline-chevron-down" class="-rotate-90" />
        </button>
      </Show>
    </section>
  )
}

const homeUsageNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })

function homeModelLabel(modelID: string) {
  return (
    modelID
      .split("/")
      .at(-1)
      ?.replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) ?? modelID
  )
}

function HomeUsagePulse(props: {
  summary?: SessionUsageSummary
  loading: boolean
  failed: boolean
  onOpenUsage: () => void
}) {
  const usage = createMemo(() => normalizeUsageSummary(props.summary))
  const week = createMemo(() => usageStreakCalendar(usage()))
  const favoriteModel = createMemo(() => usage().favoriteModels[0])

  return (
    <section class="vector-home-usage" aria-label="Your Vector activity">
      <button type="button" class="vector-home-usage__summary" onClick={props.onOpenUsage}>
        <span class="vector-home-usage__flame" aria-hidden="true">
          <svg viewBox="0 0 20 20">
            <path
              d="M11.7 2.4c.5 2.7-.8 3.7-2 5.1-.8.9-1.5 1.9-1.3 3.5-1.1-.7-1.7-1.9-1.6-3.3C4.9 9.2 4 11 4.2 13c.3 3 2.7 5 5.8 5s5.7-2.2 5.8-5.5c.1-3.4-2-6.8-4.1-10.1Z"
              fill="currentColor"
            />
          </svg>
        </span>
        <span>
          <strong>{usage().currentStreak}</strong>
          <small>day streak</small>
        </span>
        <IconV2 name="outline-chevron-down" class="-rotate-90" />
      </button>

      <div class="vector-home-usage__week" aria-label="Activity during the past seven days">
        <For each={week()}>
          {(day) => (
            <span
              classList={{ active: day.active, today: day.today }}
              title={`${day.date}: ${day.tokens.toLocaleString()} tokens`}
            >
              <i />
              <small>{day.label.slice(0, 1)}</small>
            </span>
          )}
        </For>
      </div>

      <div class="vector-home-usage__metric">
        <strong>{homeUsageNumber.format(usage().lifetimeTokens)}</strong>
        <span>tokens used</span>
      </div>
      <div class="vector-home-usage__metric">
        <strong>{homeUsageNumber.format(usage().completedChats)}</strong>
        <span>completed chats</span>
      </div>
      <div class="vector-home-usage__metric vector-home-usage__metric--model">
        <Show
          when={favoriteModel()}
          fallback={
            <>
              <strong>No model yet</strong>
              <span>favorite model</span>
            </>
          }
        >
          {(model) => (
            <>
              <strong>{homeModelLabel(model().modelID)}</strong>
              <span>{model().percentage.toFixed(0)}% of model use</span>
            </>
          )}
        </Show>
      </div>

      <Show when={props.loading || props.failed}>
        <span class="vector-home-usage__state">{props.loading ? "Updating activity…" : "Activity reconnecting"}</span>
      </Show>
    </section>
  )
}

function HomeProjectDeck(props: {
  projects: LocalProject[]
  selected?: LocalProject
  server?: ServerConnection.Any
  selectProject: (server: ServerConnection.Any, directory: string) => void
  openNewSession: (server: ServerConnection.Any, directory: string) => void
  editProject: (server: ServerConnection.Any, project: LocalProject) => void
  closeProject: (server: ServerConnection.Any, directory: string) => void
  chooseProject: () => void
  cloneFromGithub?: () => void
}) {
  return (
    <section class="vector-home-project-deck" aria-label="Agents">
      <div class="vector-home-project-deck__heading">
        <div>
          <span>Agents</span>
          <strong>Pick up where you left off</strong>
        </div>
        <div class="vector-home-project-deck__actions">
          <Show when={props.cloneFromGithub}>
            {(clone) => (
              <button type="button" data-action="home-deck-open-github" onClick={() => clone()()}>
                <Icon name="github" size="small" />
                From GitHub
              </button>
            )}
          </Show>
          <button type="button" onClick={props.chooseProject}>
            <IconV2 name="folder-add-left" />
            Add repository
          </button>
        </div>
      </div>
      <div class="vector-home-project-deck__rail">
        <For each={props.projects}>
          {(project) => (
            <HomeProjectCard
              project={project}
              selected={props.selected?.worktree === project.worktree}
              server={props.server}
              selectProject={props.selectProject}
              openNewSession={props.openNewSession}
              editProject={props.editProject}
              closeProject={props.closeProject}
            />
          )}
        </For>
        <button
          type="button"
          class="vector-home-project-card vector-home-project-card--add"
          onClick={props.chooseProject}
        >
          <span>
            <IconV2 name="folder-add-left" />
          </span>
          <strong>Open another repository</strong>
          <small>Choose a local folder</small>
        </button>
        <Show when={props.cloneFromGithub}>
          {(clone) => (
            <button
              type="button"
              class="vector-home-project-card vector-home-project-card--add"
              data-action="home-open-github"
              onClick={() => clone()()}
            >
              <span>
                <Icon name="github" size="small" />
              </span>
              <strong>Open from GitHub</strong>
              <small>Clone a repository</small>
            </button>
          )}
        </Show>
      </div>
    </section>
  )
}

function HomeProjectCard(props: {
  project: LocalProject
  selected: boolean
  server?: ServerConnection.Any
  selectProject: (server: ServerConnection.Any, directory: string) => void
  openNewSession: (server: ServerConnection.Any, directory: string) => void
  editProject: (server: ServerConnection.Any, project: LocalProject) => void
  closeProject: (server: ServerConnection.Any, directory: string) => void
}) {
  const [menuOpen, setMenuOpen] = createSignal(false)
  const path = () => props.project.worktree.replaceAll("\\", "/").split("/").filter(Boolean).slice(-2).join("/")
  return (
    <article class="vector-home-project-card" data-selected={props.selected ? "true" : undefined}>
      <button
        type="button"
        class="vector-home-project-card__main"
        disabled={!props.server}
        onClick={() => {
          if (props.server) props.selectProject(props.server, props.project.worktree)
        }}
        onDblClick={() => {
          if (props.server) props.openNewSession(props.server, props.project.worktree)
        }}
      >
        <HomeProjectAvatar project={props.project} />
        <span>
          <strong>{displayName(props.project)}</strong>
          <small>{path()}</small>
        </span>
      </button>
      <Show when={props.server}>
        {(server) => (
          <MenuV2 open={menuOpen()} onOpenChange={setMenuOpen} gutter={6} modal={false} placement="bottom-end">
            <MenuV2.Trigger
              as={IconButtonV2}
              variant="ghost-muted"
              size="small"
              icon={<IconV2 name="outline-dots" />}
              aria-label="Repository actions"
              class="vector-home-project-card__menu"
            />
            <MenuV2.Portal>
              <MenuV2.Content>
                <MenuV2.Item onSelect={() => props.openNewSession(server(), props.project.worktree)}>
                  Start new session
                </MenuV2.Item>
                <MenuV2.Item onSelect={() => props.editProject(server(), props.project)}>Edit repository</MenuV2.Item>
                <ProjectTrustMenuItem server={server()} directory={props.project.worktree} open={menuOpen()} />
                <MenuV2.Separator />
                <MenuV2.Item onSelect={() => props.closeProject(server(), props.project.worktree)}>
                  Close repository
                </MenuV2.Item>
              </MenuV2.Content>
            </MenuV2.Portal>
          </MenuV2>
        )}
      </Show>
      <span class="vector-home-project-card__state">{props.selected ? "Active" : "Ready"}</span>
    </article>
  )
}

function HomeProjectColumn(props: {
  projects: LocalProject[]
  selected: HomeProjectSelection
  focusServer: (server: ServerConnection.Any) => void
  selectProject: (server: ServerConnection.Any, directory: string) => void
  openNewSession: (server: ServerConnection.Any, directory: string) => void
  chooseProject: (server: ServerConnection.Any) => void
  editProject: (server: ServerConnection.Any, project: LocalProject) => void
  closeProject: (server: ServerConnection.Any, directory: string) => void
  clearNotifications: (server: ServerConnection.Any, project: LocalProject) => void
  unseenCount: (server: ServerConnection.Any, project: LocalProject) => number
  language: ReturnType<typeof useLanguage>
}) {
  const global = useGlobal()
  const dialog = useDialog()
  const controller = useServerManagementController({ navigateOnAdd: false })
  const [_state, setState, _, ready] = persisted(
    Persist.global("home.servers", ["home.servers.v1"]),
    createStore({ collapsed: {} as Record<string, boolean> }),
  )
  const [state] = createResource(
    () => ready.promise ?? Promise.resolve(),
    (p) => p.then(() => _state),
    { initialValue: _state },
  )

  return (
    <aside
      class="mt-6 flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden lg:mt-14 lg:pt-[52px]"
      aria-label="Agents"
    >
      <div class="flex h-7 min-w-0 shrink-0 items-center justify-between pl-1.5 pr-3">
        <div class={HOME_SECTION_LABEL}>Agents</div>
        <Show when={global.servers.list().length === 1}>
          <TooltipV2 placement="bottom" value="Open repository">
            <IconButtonV2
              data-action="home-add-project"
              variant="ghost-muted"
              size="large"
              class="titlebar-icon [&_[data-slot=icon-svg]]:text-v2-icon-icon-muted"
              icon={<IconV2 name="folder-add-left" />}
              disabled={global.servers.health[ServerConnection.key(global.servers.list()[0]!)]?.healthy === false}
              onClick={() => props.chooseProject(global.servers.list()[0]!)}
              aria-label="Open repository"
            />
          </TooltipV2>
        </Show>
      </div>
      <ScrollView data-slot="home-projects-scroll" class="min-h-0 min-w-0 shrink">
        <Show
          when={global.servers.list().length > 1}
          fallback={
            <div class="pr-3">
              <HomeProjectList {...props} server={global.servers.list()[0]!} />
            </div>
          }
        >
          <div class="flex min-w-0 flex-col gap-4 pr-3">
            <For each={global.servers.list()}>
              {(item) => {
                const key = ServerConnection.key(item)
                const healthy = () => !!global.servers.health[key]?.healthy
                const serverCtx = global.ensureServerCtx(item)
                const projects = () => serverCtx.projects.list()
                const hasProjects = () => projects().length > 0
                const collapsed = () => !!state().collapsed[key]
                return (
                  <div class="flex min-w-0 flex-col gap-1">
                    <HomeServerRow
                      server={item}
                      selected={props.selected.server === key && !props.selected.directory}
                      collapsed={collapsed()}
                      health={global.servers.health[key]}
                      controller={controller}
                      focusServer={props.focusServer}
                      chooseProject={props.chooseProject}
                      openEdit={(server) => dialog.show(() => <DialogServerV2 mode="edit" server={server} />)}
                      toggleCollapsed={() => setState("collapsed", key, !state().collapsed[key])}
                      language={props.language}
                    />
                    <Show when={healthy() && hasProjects() && !collapsed()}>
                      <div class="mx-3 h-px bg-v2-border-border-base" />
                      <HomeProjectList {...props} server={item} projects={projects()} />
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </ScrollView>
    </aside>
  )
}

function HomeServerRow(props: {
  server: ServerConnection.Any
  selected: boolean
  collapsed: boolean
  health: ServerHealth | undefined
  controller: ReturnType<typeof useServerManagementController>
  focusServer: (server: ServerConnection.Any) => void
  chooseProject: (server: ServerConnection.Any) => void
  openEdit: (server: ServerConnection.Http) => void
  toggleCollapsed: () => void
  language: ReturnType<typeof useLanguage>
}) {
  const global = useGlobal()
  const [state, setState] = createStore({ menuOpen: false })
  const healthy = () => !!props.health?.healthy
  const canToggle = () => healthy() && global.ensureServerCtx(props.server).projects.list().length > 0
  return (
    <div class="group/server relative flex h-7 min-w-0 items-center rounded-[10px]">
      <button
        type="button"
        data-action="home-server-collapse"
        class="absolute left-1 top-1/2 z-10 inline-flex size-5 shrink-0 -translate-y-1/2 items-center justify-center rounded-[4px] text-v2-icon-icon-muted transition-colors duration-150 ease-in-out focus-visible:outline-none"
        classList={{
          "hover:bg-v2-overlay-simple-overlay-hover": canToggle(),
          "cursor-default opacity-40": !canToggle(),
        }}
        aria-label={props.collapsed ? props.language.t("home.server.expand") : props.language.t("home.server.collapse")}
        aria-expanded={canToggle() ? !props.collapsed : undefined}
        disabled={!canToggle()}
        onClick={(event) => {
          event.stopPropagation()
          props.toggleCollapsed()
        }}
        onPointerDown={(event) => event.preventDefault()}
      >
        <IconV2
          name="chevron-down"
          size="small"
          class="transition-transform duration-150 ease-in-out"
          style={{ transform: `rotate(${props.collapsed ? -90 : 0}deg)` }}
        />
      </button>
      <button
        type="button"
        class={`${HOME_PROJECT_NAV_ROW} pl-7 pr-16 disabled:opacity-60`}
        data-selected={props.selected ? "" : undefined}
        disabled={!healthy()}
        onClick={() => props.focusServer(props.server)}
      >
        <div class="flex size-4 shrink-0 items-center justify-center -mr-0.5">
          <ServerHealthIndicator health={props.health} />
        </div>
        <span class="flex min-w-0 items-center gap-1">
          <span class={HOME_PROJECT_NAV_LABEL}>{props.server.displayName ?? new URL(props.server.http.url).host}</span>
          <Show when={props.server.label}>
            {(label) => (
              <span class="shrink-0 rounded-[3px] border border-v2-border-border-base px-1 py-0.5 text-[9px] leading-none text-v2-text-text-muted">
                {label()}
              </span>
            )}
          </Show>
        </span>
      </button>
      <div
        class="hover-reveal absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 group-hover/server:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100"
        data-menu={state.menuOpen}
      >
        <ServerRowMenu
          server={props.server}
          controller={props.controller}
          onEdit={props.openEdit}
          open={state.menuOpen}
          onOpenChange={(open) => setState("menuOpen", open)}
        />
        <TooltipV2 class="flex shrink-0 items-center" placement="bottom" value="Open repository">
          <IconButtonV2
            data-action="home-add-project"
            variant="ghost-muted"
            size="small"
            icon={<IconV2 name="folder-add-left" />}
            aria-label="Open repository"
            disabled={props.health?.healthy === false}
            onClick={() => props.chooseProject(props.server)}
          />
        </TooltipV2>
      </div>
    </div>
  )
}

function HomeProjectList(props: {
  server: ServerConnection.Any
  projects: LocalProject[]
  selected: HomeProjectSelection
  selectProject: (server: ServerConnection.Any, directory: string) => void
  openNewSession: (server: ServerConnection.Any, directory: string) => void
  editProject: (server: ServerConnection.Any, project: LocalProject) => void
  closeProject: (server: ServerConnection.Any, directory: string) => void
  clearNotifications: (server: ServerConnection.Any, project: LocalProject) => void
  unseenCount: (server: ServerConnection.Any, project: LocalProject) => number
  language: ReturnType<typeof useLanguage>
}) {
  return (
    <div class="flex min-w-0 flex-col gap-1">
      <For each={props.projects}>
        {(project) => (
          <HomeProjectRow
            project={project}
            server={props.server}
            selected={
              props.selected.server === ServerConnection.key(props.server) &&
              props.selected.directory === project.worktree
            }
            unseenCount={props.unseenCount(props.server, project)}
            selectProject={props.selectProject}
            openNewSession={props.openNewSession}
            editProject={props.editProject}
            closeProject={props.closeProject}
            clearNotifications={props.clearNotifications}
            language={props.language}
          />
        )}
      </For>
    </div>
  )
}

function HomeProjectRow(props: {
  project: LocalProject
  server: ServerConnection.Any
  selected: boolean
  unseenCount: number
  selectProject: (server: ServerConnection.Any, directory: string) => void
  openNewSession: (server: ServerConnection.Any, directory: string) => void
  editProject: (server: ServerConnection.Any, project: LocalProject) => void
  closeProject: (server: ServerConnection.Any, directory: string) => void
  clearNotifications: (server: ServerConnection.Any, project: LocalProject) => void
  language: ReturnType<typeof useLanguage>
}) {
  const global = useGlobal()
  const serverUnreachable = () => global.servers.health[ServerConnection.key(props.server)]?.healthy === false
  const [state, setState] = createStore({ menuOpen: false })
  return (
    <div class="group/project relative flex h-7 min-w-0 items-center rounded-[10px]">
      <button
        type="button"
        data-component="home-project-row"
        class={`${HOME_PROJECT_NAV_ROW} pr-16 disabled:opacity-60`}
        data-selected={props.selected ? "" : undefined}
        aria-current={props.selected ? "page" : undefined}
        disabled={serverUnreachable()}
        onClick={() => props.selectProject(props.server, props.project.worktree)}
      >
        <HomeProjectAvatar project={props.project} />
        <span class={HOME_PROJECT_NAV_LABEL}>{displayName(props.project)}</span>
      </button>
      <div
        class="hover-reveal absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 group-hover/project:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100"
        data-menu={state.menuOpen}
      >
        <MenuV2
          gutter={6}
          modal={false}
          placement="bottom-end"
          open={state.menuOpen}
          onOpenChange={(open) => setState("menuOpen", open)}
        >
          <MenuV2.Trigger
            as={IconButtonV2}
            data-action="home-project-menu"
            variant="ghost-muted"
            size="small"
            icon={<IconV2 name="outline-dots" />}
            aria-label={props.language.t("common.moreOptions")}
          />
          <MenuV2.Portal>
            <MenuV2.Content>
              <MenuV2.Item onSelect={() => props.openNewSession(props.server, props.project.worktree)}>
                {props.language.t("command.session.new")}
              </MenuV2.Item>
              <MenuV2.Item onSelect={() => props.editProject(props.server, props.project)}>Edit repository</MenuV2.Item>
              <MenuV2.Item
                disabled={props.unseenCount === 0}
                onSelect={() => props.clearNotifications(props.server, props.project)}
              >
                {props.language.t("sidebar.project.clearNotifications")}
              </MenuV2.Item>
              <MenuV2.Separator />
              <MenuV2.Item onSelect={() => props.closeProject(props.server, props.project.worktree)}>
                {props.language.t("common.close")}
              </MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
        <IconButtonV2
          data-action="home-project-new-session"
          variant="ghost-muted"
          size="small"
          icon={<IconV2 name="edit" />}
          aria-label={props.language.t("command.session.new")}
          onClick={() => props.openNewSession(props.server, props.project.worktree)}
        />
      </div>
    </div>
  )
}

function HomeProjectAvatar(props: { project: LocalProject }) {
  const name = createMemo(() => displayName(props.project))
  return (
    <ProjectAvatar
      fallback={name()}
      src={getProjectAvatarSource(props.project.id, props.project.icon)}
      variant={getProjectAvatarVariant(props.project.icon?.color)}
    />
  )
}

function HomeSessionLeading(props: {
  project: LocalProject
  session: Session
  server: ServerConnection.Key
  revealProjectOnHover: boolean
}) {
  const tabs = useTabs()
  const hasOpenTab = createMemo(() => sessionHasOpenTab(tabs.store, props.server, props.session))
  return (
    <div class="relative shrink-0">
      <Show when={hasOpenTab()}>
        <span
          aria-hidden="true"
          class="pointer-events-none absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-[2px] bg-v2-background-bg-layer-04"
          style={{ right: "calc(100% + 4px)" }}
        />
      </Show>
      <SessionTabAvatar
        project={props.project}
        directory={props.session.directory}
        sessionId={props.session.id}
        server={props.server}
        revealProjectOnHover={props.revealProjectOnHover}
      />
    </div>
  )
}

function HomeSessionSearch(props: {
  value: string
  placeholder: string
  open: boolean
  loading: boolean
  results: HomeSessionRecord[]
  showProjectName: boolean
  server: ServerConnection.Key
  noResultsLabel: string
  bindFocus: (focus: () => void) => void
  onInput: (value: string) => void
  onFocus: () => void
  onClose: () => void
  onSelect: (session: Session) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({ active: "" })
  let root: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  const focusInput = () => {
    input?.focus()
    props.onFocus()
  }

  onMount(() => {
    props.bindFocus(focusInput)
  })

  const syncActive = (results: HomeSessionRecord[]) => {
    if (results.length === 0) {
      setStore("active", "")
      return
    }
    if (!results.some((record) => homeSessionSearchKey(record) === store.active)) {
      setStore("active", homeSessionSearchKey(results[0]))
    }
  }

  createEffect(() => syncActive(props.results))

  createEffect(
    on(
      () => props.value,
      () => syncActive(props.results),
    ),
  )

  const scrollActiveIntoView = () => {
    const key = store.active
    if (!key || !listRef) return
    const element = listRef.querySelector<HTMLElement>(`[data-key="${key}"]`)
    element?.scrollIntoView({ block: "nearest" })
  }

  const moveActive = (delta: number) => {
    const results = props.results
    if (results.length === 0) return
    const index = results.findIndex((record) => homeSessionSearchKey(record) === store.active)
    const start = index === -1 ? 0 : index
    const next = (start + delta + results.length) % results.length
    setStore("active", homeSessionSearchKey(results[next]))
    scrollActiveIntoView()
  }

  const selectActive = () => {
    const record = props.results.find((item) => homeSessionSearchKey(item) === store.active)
    if (!record) return
    props.onSelect(record.session)
  }

  onCleanup(
    makeEventListener(document, "pointerdown", (event) => {
      if (!props.open) return
      const target = event.target
      if (!(target instanceof Node)) return
      if (root?.contains(target)) return
      props.onClose()
    }),
  )

  return (
    <div class="w-full">
      <div ref={root} data-component="home-session-search" class="relative z-30 w-full">
        <Show when={props.open}>
          <div
            data-component="home-session-search-panel"
            class="absolute flex flex-col overflow-hidden rounded-[12px] border border-[var(--vx-line)] bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]"
            style={{
              top: "-6px",
              left: "-6px",
              width: "calc(100% + 12px)",
            }}
          >
            <div class="flex flex-col pt-9">
              <div id={HOME_SESSION_SEARCH_RESULTS_ID} role="listbox" class="flex flex-col gap-4 pt-4">
                <Show
                  when={!props.loading}
                  fallback={
                    <div class="flex items-center justify-center px-4 py-3 text-v2-text-text-muted [font-weight:440]">
                      <Spinner class="size-4" />
                    </div>
                  }
                >
                  <Show
                    when={props.results.length > 0}
                    fallback={
                      <p class="my-1.5 px-4 pb-2 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
                        {props.noResultsLabel}
                      </p>
                    }
                  >
                    <div class="flex flex-col">
                      <p class="my-1.5 pl-[18px] pr-6 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
                        {language.t("home.sessions.search.sessions")}
                      </p>
                      <ScrollView class="max-h-80" viewportRef={(el) => (listRef = el)}>
                        <div class="flex flex-col gap-px pb-2">
                          <For each={props.results}>
                            {(record) => (
                              <HomeSessionSearchResultRow
                                record={record}
                                showProjectName={props.showProjectName}
                                server={props.server}
                                selected={store.active === homeSessionSearchKey(record)}
                                onHighlight={() => setStore("active", homeSessionSearchKey(record))}
                                onSelect={(session) => props.onSelect(session)}
                              />
                            )}
                          </For>
                        </div>
                      </ScrollView>
                    </div>
                  </Show>
                </Show>
              </div>
            </div>
          </div>
        </Show>
        <label class="relative z-20 flex h-9 w-full items-center gap-2 rounded-[11px] border border-[var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-surface)_82%,transparent)] py-1 pl-3 pr-2 text-v2-icon-icon-muted transition-[background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:border-[rgba(178,140,255,0.28)] hover:bg-[color-mix(in_srgb,var(--vx-surface)_94%,transparent)] focus-within:border-[rgba(147,116,236,0.55)] focus-within:shadow-[0_0_0_3px_rgba(147,116,236,0.14)]">
          <IconV2 name="magnifying-glass" />
          <input
            ref={input}
            class="relative z-20 min-w-0 flex-1 border-0 bg-transparent text-v2-text-text-base outline-0 [font-weight:440] placeholder:text-v2-text-text-faint"
            value={props.value}
            placeholder={props.placeholder}
            aria-label={props.placeholder}
            aria-expanded={props.open}
            aria-controls={HOME_SESSION_SEARCH_RESULTS_ID}
            aria-autocomplete="list"
            aria-activedescendant={
              store.active && props.open ? `home-session-search-option-${store.active}` : undefined
            }
            onFocus={() => props.onFocus()}
            onInput={(event) => props.onInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                props.onClose()
                input?.blur()
                return
              }
              if (!props.open || props.results.length === 0) return
              if (event.altKey || event.metaKey) return
              if (event.key === "ArrowDown") {
                event.preventDefault()
                moveActive(1)
                return
              }
              if (event.key === "ArrowUp") {
                event.preventDefault()
                moveActive(-1)
                return
              }
              if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault()
                selectActive()
              }
            }}
          />
          <Show when={props.value}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="relative z-20 shrink-0"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              aria-label={language.t("common.clear")}
              onClick={() => {
                props.onClose()
                input?.focus()
              }}
            />
          </Show>
        </label>
      </div>
    </div>
  )
}

function HomeSessionSearchResultRow(props: {
  record: HomeSessionRecord
  showProjectName: boolean
  server: ServerConnection.Key
  selected: boolean
  onHighlight: () => void
  onSelect: (session: Session) => void
}) {
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const showProjectName = () => props.showProjectName && props.record.projectName

  const key = () => homeSessionSearchKey(props.record)

  return (
    <button
      type="button"
      id={`home-session-search-option-${key()}`}
      data-key={key()}
      data-component="home-session-search-row"
      role="option"
      aria-selected={props.selected}
      classList={{
        [HOME_SEARCH_RESULT_ROW]: true,
        "bg-v2-overlay-simple-overlay-hover": props.selected,
        group: !!showProjectName(),
      }}
      onMouseEnter={() => props.onHighlight()}
      onClick={() => props.onSelect(props.record.session)}
    >
      <HomeSessionLeading
        project={props.record.project}
        session={props.record.session}
        server={props.server}
        revealProjectOnHover={!!showProjectName()}
      />
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          class={`${HOME_SEARCH_RESULT_TITLE} ${showProjectName() ? "max-w-[min(70%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
        >
          {title()}
        </span>
        <Show when={showProjectName()}>
          <span class={HOME_SEARCH_RESULT_META}>{props.record.projectName}</span>
        </Show>
      </div>
    </button>
  )
}

function HomeSessionGroupHeader(props: {
  title: string
  titleOpacity: number
  ref: ComponentProps<"div">["ref"]
  elevated?: boolean
}) {
  return (
    <div
      ref={props.ref}
      class={`pointer-events-none sticky top-3 flex h-7 min-w-0 items-center justify-between pl-3 bg-v2-background-bg-base ${props.elevated ? "home-session-group-header z-[5]" : "z-10"}`}
    >
      <div class={HOME_SECTION_LABEL} style={{ opacity: props.titleOpacity }}>
        {props.title}
      </div>
    </div>
  )
}

function HomeSessionRow(props: {
  record: HomeSessionRecord
  showProjectName: boolean
  server: ServerConnection.Key
  openSession: (session: Session) => void
}) {
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const showProjectName = () => props.showProjectName && props.record.projectName

  return (
    <div
      class="group/session relative flex h-10 min-w-0 items-center rounded-[10px]"
      classList={{ group: !!showProjectName() }}
    >
      <button
        type="button"
        data-component="home-session-row"
        class={`${HOME_ROW} h-10 min-w-0 flex-1 gap-2 py-3 pl-3 pr-10`}
        onClick={() => props.openSession(props.record.session)}
      >
        <HomeSessionLeading
          project={props.record.project}
          session={props.record.session}
          server={props.server}
          revealProjectOnHover={!!showProjectName()}
        />
        <span
          class={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530] ${showProjectName() ? "max-w-[min(70%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
        >
          {title()}
        </span>
        <Show when={showProjectName()}>
          <span class="min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-muted [font-weight:440]">
            {props.record.projectName}
          </span>
        </Show>
      </button>
    </div>
  )
}

function HomeSessionsEmpty(props: {
  onNewSession?: () => void
  onOpenProject?: () => void
  onCloneFromGithub?: () => void
  hasKnownProjects?: boolean
}) {
  const language = useLanguage()
  const hasKnownProjects = () => props.hasKnownProjects !== false
  return (
    <div class="flex min-h-[320px] flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div class="mb-1 grid size-10 place-items-center rounded-xl border border-[var(--vx-line)] bg-[rgba(255,255,255,0.035)] text-v2-icon-icon-muted">
        <IconV2 name="new-session" />
      </div>
      <div class="shrink-0 text-[13px] leading-[13px] tracking-[-0.04px] text-v2-text-text-base [font-weight:530]">
        {hasKnownProjects() ? language.t("home.sessions.empty") : "Open a repository to load its workspace"}
      </div>
      <p class="mb-1 max-w-[340px] text-center text-[13px] leading-5 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
        {hasKnownProjects()
          ? language.t("home.sessions.empty.description")
          : "Vector stores workspace history by repository path. Open a repository on this device to show saved sessions."}
      </p>
      <Show when={props.onNewSession}>
        {(onNewSession) => (
          <ButtonV2 data-action="home-new-session" variant="neutral" size="normal" icon="edit" onClick={onNewSession()}>
            Open workspace
          </ButtonV2>
        )}
      </Show>
      <Show when={props.onOpenProject}>
        {(onOpenProject) => (
          <ButtonV2
            data-action="home-open-project"
            variant="neutral"
            size="normal"
            icon="folder-add-left"
            onClick={onOpenProject()}
          >
            Open repository
          </ButtonV2>
        )}
      </Show>
      <Show when={props.onCloneFromGithub}>
        {(onCloneFromGithub) => (
          <ButtonV2
            data-action="home-open-github"
            variant="neutral"
            size="normal"
            icon="download"
            onClick={onCloneFromGithub()}
          >
            Open from GitHub
          </ButtonV2>
        )}
      </Show>
    </div>
  )
}

function HomeSessionSkeleton(props: { label: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <div class="flex h-7 min-w-0 items-center justify-between px-4">
        <div class={HOME_SECTION_LABEL}>{props.label}</div>
      </div>
      <div class="flex min-w-0 flex-col gap-px" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>{() => <div class="h-10 rounded-[10px] vector-home-skeleton-row" />}</For>
      </div>
    </div>
  )
}

function groupSessions(records: HomeSessionRecord[], language: ReturnType<typeof useLanguage>): HomeSessionGroup[] {
  const now = DateTime.local()
  const yesterday = now.minus({ days: 1 })
  const todaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(now, "day"),
  )
  const yesterdaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(yesterday, "day"),
  )
  const olderSessions = records.filter((record) => {
    const time = DateTime.fromMillis(record.session.time.updated ?? record.session.time.created)
    return !time.hasSame(now, "day") && !time.hasSame(yesterday, "day")
  })
  const olderTitle =
    todaySessions.length === 0 && yesterdaySessions.length === 0
      ? language.t("sidebar.project.recentSessions")
      : language.t("home.sessions.group.older")

  return [
    { id: "today" as const, title: language.t("home.sessions.group.today"), sessions: todaySessions },
    { id: "yesterday" as const, title: language.t("home.sessions.group.yesterday"), sessions: yesterdaySessions },
    { id: "older" as const, title: olderTitle, sessions: olderSessions },
  ].filter((group) => group.sessions.length > 0)
}
