import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { OffInLocal } from "@/features/local/off-in-local"
import "./onboarding.css"

// The ambient sky both onboarding surfaces share: purple hues drifting on a
// slow loop across the whole screen, plus a pointer glow — the patch of sky
// under the cursor brightens slightly and follows it. Same recipe as the
// landing page's .aurora/.pointer-glow, tuned quieter for in-app use.
export function AmbientSky() {
  let root!: HTMLDivElement
  onMount(() => {
    // No rAF throttle: two custom-property writes per move are cheap, and a
    // lost frame callback would freeze the glow behind a stuck guard flag.
    const move = (event: MouseEvent) => {
      root.style.setProperty("--mx", `${event.clientX}px`)
      root.style.setProperty("--my", `${event.clientY}px`)
    }
    globalThis.window?.addEventListener("mousemove", move, { passive: true })
    onCleanup(() => globalThis.window?.removeEventListener("mousemove", move))
  })
  return (
    <div class="vx-sky" ref={root} aria-hidden="true">
      <div class="vx-sky-aurora" />
      <div class="vx-sky-stars" />
      <div class="vx-sky-pointer" />
    </div>
  )
}

// First-run activation stays intentionally short. The exhaustive spotlight
// tour and feature reference remain opt-in from this surface.

export type ProgressStep = {
  id: string
  title: string
  detail: string
  done: boolean
  cta: string
  onGo: () => void
  /** A quieter alternative to the primary action, such as using an existing key. */
  secondary?: { label: string; onGo: () => void }
}

// ---- Feature guide ---------------------------------------------------------
// The whole product, surface by surface, below the progress timeline. Data
// only — no navigation callbacks — so the guide stays a quiet reference the
// user scrolls at their own pace. Every claim here matches what the feature
// actually does; when a surface changes, its entry changes with it.

export type GuideEntry = {
  title: string
  /** Where the feature lives / how to open it — the locator line under the title. */
  where: string
  body: string
  tip: string
}

export type GuideSection = {
  kicker: string
  intro?: string
  entries: GuideEntry[]
}

export const GUIDE_SECTIONS: GuideSection[] = [
  {
    kicker: "Start here",
    entries: [
      {
        title: "New session",
        where: "The gradient button at the top of the sidebar — or ⌘N (Ctrl+N on Windows/Linux).",
        body: "This is the front door: a fresh session with the Vector agent. Describe one result in plain language and press Enter. The agent plans the work, edits files, runs commands, and narrates each step so you can follow along or interrupt. The model chip in the composer shows which model is answering.",
        tip: "Brief it like an engineer: name the outcome (“a pricing page with three tiers”), not the implementation — and when something breaks, paste the exact error text.",
      },
      {
        title: "Overview",
        where: "The house icon at the top of the sidebar — Vector's home.",
        body: "Overview is where every repository starts and returns. Open a repository, start one focused session, or pick up yesterday's work from the searchable session list. The activity strip shows your real local streak, token use, completed chats, and favorite model at a glance.",
        tip: "The search box filters your recent sessions — faster than scrolling once the list grows.",
      },
      {
        title: "Code it yourself",
        where: "Repository tools → Code editor.",
        body: "Open the repository in Vector's editor, search for a file, and make the change directly. Your manual edits and the agent's edits share the same active repository, so you can take over for a precise change and hand larger work back to the agent.",
        tip: "Use direct editing for exact, local changes; use an agent when the job spans files or needs commands and verification.",
      },
      {
        title: "Work with one agent",
        where: "Start a session and describe the outcome in the message box.",
        body: "The main agent can inspect the repository, plan, edit, run Terminal commands, operate the visible Browser, and repair failures. You can steer it while it works, change the model or effort, and inspect the result before keeping it.",
        tip: "Ask for a working outcome and a verification step, not just generated code.",
      },
      {
        title: "Work with multiple agents",
        where: "Use New workspace under the active repository in the sidebar.",
        body: "Launch isolated agents for separate parts of the same repository. Each one receives its own worktree, conversation, files, and command history. When an agent finishes, review its diff and checks, then merge only the work you trust.",
        tip: "Split work by ownership — for example frontend, backend, auth, and tests — so agents can move in parallel without editing one another's files.",
      },
    ],
  },
  {
    kicker: "Vector Cloud",
    intro:
      "One repository-scoped console for releases, health, domains, environment, data, and build configuration, on your own Vercel and Supabase accounts. Open it from Vector Home and pick a repository. The agent can do the same work from chat and asks before anything changes.",
    entries: [
      {
        title: "Connections",
        where: "Vector Cloud → Connections.",
        body: "Connect your Vercel and Supabase accounts: sign in with each provider, or paste an access token you create on its token page. Vector checks the connection and keeps the credential encrypted on this device. Then link the Vercel project this repository publishes to.",
        tip: "Vector never shows a saved token again. To replace one, disconnect the account and connect it with the new token.",
      },
      {
        title: "Deployments",
        where: "Vector Cloud → Deployments.",
        body: "Publish a preview first: Vector installs, builds, scans for exposed secrets, deploys to the Vercel project you connected and linked once in Vector Cloud → Connections, and checks that the preview responds and renders. Production changes only when you ask for it: Vector builds production, checks it, and promotes it only if the checks pass. Every deployment Vercel has for the linked Vercel project is listed, git pushes included, with logs, promote and roll back. Your code is never proxied through Vector: the build runs on your account. When a release fails, Fix this deploy starts the agent on it with the failing check's evidence.",
        tip: "Deploy a preview early, even half-finished: a live URL makes every change after it feel real.",
      },
      {
        title: "Observability",
        where: "Vector Cloud → Observability.",
        body: "Check every deployed URL from Vector and see real HTTP status, response time, last-check time, and the exact network failure when a release cannot be reached. Results stay attached to the repository, so a different app never inherits the wrong health history.",
        tip: "Run Check all immediately after a production release, then inspect any degraded endpoint before sharing the link.",
      },
      {
        title: "Domains",
        where: "Vector Cloud → Domains.",
        body: "Point a domain you own at the linked Vercel project. Add the domain and Vector shows the exact records Vercel asks for: an A record for an apex domain, a CNAME for a subdomain, and a TXT record when ownership needs verifying. Click Verify and Vector checks them and reports the certificate.",
        tip: "DNS changes can take a few minutes to propagate. If verification doesn't pass immediately, wait a little and verify again.",
      },
      {
        title: "Environment variables",
        where: "Vector Cloud → Environment variables.",
        body: "Manage the repository's configuration as key–value pairs. Add or remove variables in the panel, then apply them and Vector writes them into the repository's .env file, where your app and the code the agent writes can read them. Below them, manage the linked Vercel project's variables per environment: compare with yours, review a sync plan before anything is written, or pull development values.",
        tip: "Keep secrets out of chat messages: put them here and just tell the agent the variable name.",
      },
      {
        title: "Database",
        where: "Vector Cloud → Database.",
        body: "Link a Supabase project from your connected Supabase account: Vector writes its public URL and key to your .env and adds a ready-configured client, so the agent codes against a real database and auth setup instead of mocks. When a task involves accounts, logins, or stored data, a banner offers to ask Vector to set the database up; the agent can link one you already have or create a new one on your account, and asks you first either way.",
        tip: "Set up the database before asking for signup or login features, so the agent builds against the real client on the first pass.",
      },
      {
        title: "Hosting settings",
        where: "Vector Cloud → Hosting settings.",
        body: "Detect the framework, package manager, install command, build command, output directory, and Node requirement from the actual repository. You can correct any value and save it for that repository; Vector Cloud then uses the configured build and output directory when it publishes.",
        tip: "Detect once after opening a repository, then verify the output directory before the first publish.",
      },
    ],
  },
  {
    kicker: "Agents",
    entries: [
      {
        title: "Scheduled runs",
        where: "Agents group in the sidebar.",
        body: "Write a prompt now, pick a date and time, and let it run later. On desktop, Vector launches the agent for you at the scheduled time — even while you work on something else; where a real scheduler isn't available, Vector saves the prompt, reminds you, and you choose when to load and run it. The badge on the sidebar item shows how many runs are waiting. Open a repository first — the scheduled agent runs inside it.",
        tip: "Queue the unglamorous chores — dependency bumps, lint sweeps — for a time you're away, and review the result when you're back.",
      },
      {
        title: "Agent tabs",
        where: "Inside every active repository.",
        body: "Launch an agent into its own isolated git worktree or a managed copy of the repository. Every agent is a complete Vector session with its own model, conversation, tools, terminal activity, and file changes. Coordination can split one objective into dependent workstreams and assign an agent to each automatically. Results pass guardrail checks and remain isolated until you review the diff and merge all or only approved hunks.",
        tip: "Give auth, frontend, backend, and testing to separate agents, then merge only the verified results.",
      },
      {
        title: "MCP",
        where: "Agents group in the sidebar.",
        body: "Connect Model Context Protocol servers — the open standard for giving agents tools. Add a server and its capabilities become available to the agent in your repositories: databases, APIs, internal services, whatever the server exposes. The dialog manages all of your connections in one place.",
        tip: "Start with one server you actually need — every connected tool adds to what the agent weighs on each step.",
      },
    ],
  },
  {
    kicker: "Repository tools",
    entries: [
      {
        title: "Code editor",
        where: "Switch from Agent to Editor at the top of the sidebar inside an active repository.",
        body: "A focused editor over your repository's files, for when you'd rather change something by hand. Search for a file, open it in a tab, edit it in place, and ask the agent to work on that same file without losing the session's context.",
        tip: "For a one-line tweak, editing here is faster than prompting — save the agent for changes worth delegating.",
      },
      {
        title: "Browser",
        where: "Repository tools in the sidebar, inside an active task.",
        body: "A real controlled browser beside the chat. You can use it directly, and Vector can inspect and operate that exact same visible page while reading DOM state, console output, runtime failures, and network errors. The diagnostics sidebar can be hidden when you want the full browser width.",
        tip: "Ask Vector to test the visible flow after an edit; it can inspect, repair, and retest without switching to a separate browser screen.",
      },
      {
        title: "Review changes",
        where: "Repository tools in the sidebar, inside an active task.",
        body: "Everything the task changed, as diffs — read it like a pull request before you accept it. Each file shows its additions and deletions with a Low / Medium / High risk read based on the size and nature of the change, so you know where to slow down. Vector's own guidance applies here too: review carefully and run the app before accepting broad edits, and if a request went the wrong way, Rewind code + chat undoes it.",
        tip: "Make Review the last step of every task — two minutes of reading beats an hour of debugging a change you never saw.",
      },
      {
        title: "Rewind code + chat",
        where:
          "Command palette (⌘⇧P, or Ctrl+Shift+P on Windows/Linux) inside a session, or type /undo or /redo in the message box.",
        body: "Undo an agent's work one request at a time. Rewind code + chat restores the files and the conversation to before your last request. If the agent is still working, Vector stops it first, and that request's text goes back into the message box so you can edit it and send it again. Run it again to go back further. Move rewind forward (or /redo) restores the next request; at the latest one, everything is back.",
        tip: "When a request took the repository the wrong way, rewind and re-prompt instead of asking the agent to repair its own change.",
      },
      {
        title: "Terminal",
        where: "Repository tools in the sidebar, inside an active task.",
        body: "A real shell in your repository's folder, opened as a panel inside the task. Run the dev server, git commands, package installs — anything you'd type into any terminal — without leaving Vector. It needs an active task; the sidebar item toggles it open and closed.",
        tip: "One-off commands are often faster typed here yourself than asked of the agent.",
      },
    ],
  },
  {
    kicker: "Everyday flow",
    entries: [
      {
        title: "Dictation",
        where: "The mic button in the message composer.",
        body: "Talk instead of typing. Tap the mic, speak your prompt, and the transcript lands in the composer ready to edit or send. On the desktop app, transcription runs entirely on your machine with a local Whisper model — audio never leaves your computer; in the browser, Vector uses the browser's built-in speech recognition, streaming interim text as you speak.",
        tip: "Dictate the messy first version, tidy the words that matter, then hit Enter.",
      },
      {
        title: "Push to GitHub or GitLab",
        where: "Vector Cloud → Connections, after choosing a repository.",
        body: "Commit and push a selected repository from its Vector Cloud workspace. Vector can use an existing origin or create a new GitHub or GitLab repository through your connected account, while keeping source-control publishing attached to the repository it belongs to.",
        tip: "Run Review changes first, then push — a commit should never contain a diff you haven't read.",
      },
      {
        title: "Vector Local",
        where: "Settings → Vector Local, or Models you host in Getting started.",
        body: "Run Vector's AI features on model servers you or your company host. With Vector Local on, the agent, subagents, the judge, Vectorscope, Deep research and Vector's helpers use only the model servers on your list, Vector blocks its own requests to vectordev.ai and to AI services that are not on your list unless you allow one, and the network log, What Vector sent, shows the requests it made or blocked. Programs the agent runs make their own connections.",
        tip: "Run a check in Settings → Vector Local after setting it up: it reads every layer and says which one needs attention.",
      },
      {
        title: "Settings",
        where: "The gear or your name at the bottom of the sidebar, Settings in its Help menu, or Cmd+, (Ctrl+, on Windows and Linux).",
        body: "Everything about how Vector runs. Providers is where you connect your own keys for OpenAI, Anthropic, Google, and more, and Models manages which models appear in your pickers. In the desktop app, Account is where you sign in and see your Vector Codium plan and how much of this month is left, and Spend limits caps what Vector may spend.",
        tip: "Connect a provider with your API key, then switch models per task from the composer's model chip.",
      },
    ],
  },
]

export function OnboardingProgress(props: {
  open: boolean
  steps: ProgressStep[]
  onReplayTour: () => void
  onClose: () => void
}) {
  const dialog = useDialog()
  // The third way to connect a model, beside free models and an API key: model servers the person or their company
  // hosts, set up with the Vector Local wizard. The wizard loads only when it is opened.
  const hostModels = async () => {
    props.onClose()
    const { DialogLocalSetup } = await import("@/features/local/setup-wizard")
    void dialog.show(() => <DialogLocalSetup />)
  }
  const doneCount = createMemo(() => props.steps.filter((step) => step.done).length)
  const allDone = createMemo(() => doneCount() === props.steps.length)

  return (
    <Show when={props.open}>
      <div
        class="vprogress"
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onClose()
        }}
      >
        <AmbientSky />
        <div class="vprogress-card">
          <button type="button" class="vprogress-close" aria-label="Close getting started" onClick={props.onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="m4.5 4.5 7 7M11.5 4.5l-7 7"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
            </svg>
          </button>
          <div class="vtour-eyebrow">
            <span class="vtour-eyebrow-dot" />
            Getting started
          </div>
          <h1 class="vprogress-title">
            <Show
              when={!allDone()}
              fallback={
                <>
                  Vector is <em>yours.</em>
                </>
              }
            >
              <em>
                {doneCount()} of {props.steps.length}
              </em>{" "}
              first steps
            </Show>
          </h1>
          <p class="vprogress-sub">
            {allDone()
              ? "You've run the whole loop. Everything in Vector is yours now."
              : "No rush — Vector checks these off as you actually do them."}
          </p>

          <div class="vprogress-timeline">
            <div class="vprogress-rail">
              <div
                class="vprogress-rail-fill"
                style={{ height: `${(doneCount() / Math.max(1, props.steps.length)) * 100}%` }}
              />
            </div>
            <div class="vprogress-steps">
              <For each={props.steps}>
                {(step) => (
                  <>
                    <div class="vprogress-step" data-done={step.done}>
                      <span class="vprogress-node" data-done={step.done}>
                        <Show when={step.done}>
                          <svg viewBox="0 0 16 16" aria-hidden="true">
                            <path
                              d="m3.5 8.5 3 3 6-7"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            />
                          </svg>
                        </Show>
                      </span>
                      <div class="vprogress-copy">
                        <div class="vprogress-step-title">{step.title}</div>
                        <div class="vprogress-step-detail">{step.detail}</div>
                      </div>
                      <Show when={!step.done}>
                        <div class="vprogress-actions">
                          <button type="button" class="vprogress-go" onClick={step.onGo}>
                            {step.cta} →
                          </button>
                          <Show when={step.secondary}>
                            {(secondary) => (
                              <button type="button" class="vprogress-alt" onClick={secondary().onGo}>
                                {secondary().label}
                              </button>
                            )}
                          </Show>
                        </div>
                      </Show>
                    </div>
                    <Show when={step.id === "provider" && !step.done}>
                      <div class="vprogress-host" data-component="onboarding-models-you-host">
                        <div class="vprogress-copy">
                          <div class="vprogress-step-title">Models you host (Vector Local)</div>
                          <div class="vprogress-step-detail">
                            Run Vector's AI features on model servers you or your company host, such as Ollama or vLLM.
                            Vector finds the servers on this computer and checks each model with its tools.
                          </div>
                          {/* With Vector Local on, free models are off; the step above still offers them, so say so. */}
                          <OffInLocal source="vector-free-models" named />
                        </div>
                        <button
                          type="button"
                          class="vprogress-alt"
                          data-action="onboarding-models-you-host"
                          onClick={() => void hostModels()}
                        >
                          Set up
                        </button>
                      </div>
                    </Show>
                  </>
                )}
              </For>
            </div>
          </div>

          <details class="vguide">
            <summary class="vguide-toggle">
              <span>
                <span class="vguide-kicker">Optional reference</span>
                <strong>Explore the full feature guide</strong>
              </span>
              <span class="vguide-toggle-icon" aria-hidden="true">
                ↓
              </span>
            </summary>
            <div class="vguide-content">
              <div class="vguide-head">
                <div class="vguide-kicker">Feature guide</div>
                <h2 class="vguide-title">Everything Vector can do</h2>
                <p class="vguide-lede">
                  The whole workspace, surface by surface — what each one is for, where it lives, and how to get the
                  most out of it. Scroll at your own pace; it'll be here whenever you need it.
                </p>
              </div>
              <For each={GUIDE_SECTIONS}>
                {(section) => (
                  <section class="vguide-section">
                    <div class="vguide-kicker">{section.kicker}</div>
                    <Show when={section.intro}>
                      <p class="vguide-intro">{section.intro}</p>
                    </Show>
                    <div class="vguide-entries">
                      <For each={section.entries}>
                        {(entry) => (
                          <article class="vguide-entry">
                            <h3 class="vguide-entry-title">{entry.title}</h3>
                            <div class="vguide-entry-where">{entry.where}</div>
                            <p class="vguide-entry-body">{entry.body}</p>
                            <p class="vguide-entry-tip">
                              <span class="vguide-tip-label">Pro tip</span>
                              {entry.tip}
                            </p>
                          </article>
                        )}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            </div>
          </details>

          <div class="vprogress-footer">
            <button type="button" class="vtour-back" onClick={props.onReplayTour}>
              Take the full tour
            </button>
            <button type="button" class="vtour-next" onClick={props.onClose}>
              {allDone() ? "Done" : "Keep building"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
