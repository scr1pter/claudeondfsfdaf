import { Component, JSX, Show, createResource, createSignal, onCleanup } from "solid-js"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { useShellPicker } from "./shell-picker"
import "./settings-v2.css"

import { usePlatform } from "@/context/platform"
import { observeTelemetryPreference, setTelemetryEnabled, telemetryEnabled } from "@/features/privacy/telemetry"
import { onCodiumChange } from "@/vector-account"
import { SECOND_OPINION_DESCRIPTION, SECOND_OPINION_TITLE, secondOpinionOffered } from "./second-opinion-model"
import { Card, Page, RangeRow, SelectRow, ToggleRow } from "./parts/page"

export type SettingsSection = "general" | "notifications" | "accessibility"

const localKeys = () => {
  if (typeof localStorage === "undefined") return []
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(Boolean) as string[]
}

const removeMatchingLocalKeys = (patterns: RegExp[]) => {
  if (typeof localStorage === "undefined") return 0
  const keys = localKeys().filter((key) => patterns.some((pattern) => pattern.test(key)))
  for (const key of keys) localStorage.removeItem(key)
  return keys.length
}

// Its own component so only the General page asks the server for its shells, not Accessibility.
const TerminalCard: Component = () => {
  const language = useLanguage()
  const shell = useShellPicker()
  return (
    <Card
      icon="terminal"
      title="Terminal"
      description="The terminal and the composer's shell mode both use this shell."
    >
      <SelectRow
        title={language.t("settings.general.row.shell.title")}
        description={language.t("settings.general.row.shell.description")}
        options={shell.options().map((option) => ({ value: option.id, label: option.label }))}
        value={shell.selected().id}
        onChange={(id) => shell.select(shell.options().find((option) => option.id === id))}
      />
    </Card>
  )
}

export const SettingsGeneralV2: Component<{
  sessionID?: string
  section?: SettingsSection
}> = (props) => {
  const settings = useSettings()
  const platform = usePlatform()
  const [status, setStatus] = createSignal("")
  const [crashDiagnostics, setCrashDiagnostics] = createSignal(telemetryEnabled())
  onCleanup(observeTelemetryPreference(setCrashDiagnostics))
  const [usageSharing, { mutate: setUsageSharing }] = createResource(
    () => (platform.getUsageSharing ? true : false),
    () => platform.getUsageSharing?.().catch(() => true) ?? true,
    { initialValue: true },
  )
  // Second opinion (WP A35) is offered only while vectordev.ai says the signed-in account's plan includes it and lists
  // it; Codium plan changes read it again.
  const [codiumPlan, { refetch: refetchCodiumPlan }] = createResource(
    () => (platform.vectorAccount?.codium ? true : false),
    () => platform.vectorAccount?.codium?.().catch(() => undefined),
  )
  onCleanup(onCodiumChange(() => void refetchCodiumPlan()))
  let statusTimeout: ReturnType<typeof setTimeout> | undefined

  const section = () => props.section ?? "general"
  const announce = (message: string) => {
    if (statusTimeout !== undefined) clearTimeout(statusTimeout)
    setStatus(message)
    statusTimeout = setTimeout(() => setStatus(""), 2400)
  }

  const clearApplicationCache = () => {
    const removed = removeMatchingLocalKeys([/cache/i, /\btemp\b/i, /temporary/i])
    if (typeof sessionStorage !== "undefined") sessionStorage.clear()
    announce(`Cleared ${removed} cached local entries.`)
  }

  const resetLocalPreferences = () => {
    settings.resetAll()
    announce("Vector preferences restored.")
  }

  const renderGeneral = () => (
    <Page
      eyebrow="General"
      title="General"
      description="Manage Vector's local behavior, diagnostics, verification defaults, and terminal shell. Memory has a page of its own."
    >
      <div class="settings-v2-section-grid">
        <Card
          icon="status"
          title="Crash diagnostics"
          description="Optional technical error reports. Disabled until you explicitly enable them."
        >
          <ToggleRow
            title="Share crash diagnostics"
            description="Send Vector's version, operating system, and stack traces to Sentry when the interface crashes. Request, user, breadcrumb, and extra fields are removed; repository files, prompts, terminal output, and provider credentials are not intentionally attached."
            checked={crashDiagnostics()}
            onChange={(enabled) => {
              if (!setTelemetryEnabled(enabled)) {
                announce("Could not save the diagnostics preference on this device.")
                return
              }
              setCrashDiagnostics(enabled)
              announce(enabled ? "Crash diagnostics enabled." : "Crash diagnostics disabled.")
            }}
          />
        </Card>
        <Show when={platform.getUsageSharing && platform.setUsageSharing}>
          <Card
            icon="share"
            title="Usage counts"
            description="Counted under a random install ID, and your Vector account when you are signed in. On by default."
          >
            <ToggleRow
              title="Share usage counts"
              description="Sends daily session counts and your token use by model, with your app version and OS. Never your prompts, code or files."
              checked={usageSharing.latest}
              onChange={(enabled) => {
                setUsageSharing(enabled)
                void Promise.resolve(platform.setUsageSharing?.(enabled))
                  .then(() => announce(enabled ? "Usage counts enabled." : "Usage counts disabled."))
                  .catch(() => {
                    setUsageSharing(!enabled)
                    announce("Could not save the usage counts preference.")
                  })
              }}
            />
          </Card>
        </Show>
        <Card
          icon="reset"
          title="Local data"
          description="Preferences and caches stored on this device. Repository files are never touched."
        >
          <div class="settings-v2-action-grid">
            <ButtonV2 variant="outline" icon="trash" onClick={clearApplicationCache}>
              Clear application cache
            </ButtonV2>
            <ButtonV2 variant="danger" icon="reset" onClick={resetLocalPreferences}>
              Restore default settings
            </ButtonV2>
          </div>
        </Card>
        <Card
          icon="circle-check"
          title="Verified completion"
          description="Have Vector prove its work matches what you asked before it reports done."
        >
          <ToggleRow
            title="Automatic model routing"
            description="Let Vector switch to a stronger model when it judges a task complex. This spends your own provider key at that model's rate, which can be many times higher than the one you picked. Off by default; the composer always shows the model actually in use."
            checked={settings.general.autoModelRouting()}
            onChange={settings.general.setAutoModelRouting}
          />
          <ToggleRow
            title="LLM-as-a-judge"
            description="When Vector finishes a task that changed files, a separate judge compares the result against your request. On a failed verdict Vector repairs it and the judge looks again, up to three rounds. Choose below which tasks it checks; greetings and questions are never judged. Costs extra model calls."
            checked={settings.general.llmJudge()}
            onChange={settings.general.setLlmJudge}
          />
          <Show when={settings.general.llmJudge()}>
            <SelectRow
              title="Tasks the judge checks"
              description="Large tasks are the ones Vector runs with subagents: when you ask it to be thorough, or when the agent finds the work is large. Every task that changes files also includes small fixes."
              options={[
                { value: "thorough", label: "Large tasks" },
                { value: "changes", label: "Every task that changes files" },
              ]}
              value={settings.general.judgeScope()}
              onChange={(value) => settings.general.setJudgeScope(value === "changes" ? "changes" : "thorough")}
            />
            <Show when={secondOpinionOffered(codiumPlan())}>
              <ToggleRow
                title={SECOND_OPINION_TITLE}
                description={SECOND_OPINION_DESCRIPTION}
                checked={settings.general.secondOpinion()}
                onChange={settings.general.setSecondOpinion}
              />
            </Show>
          </Show>
        </Card>
        <TerminalCard />
      </div>
    </Page>
  )

  const renderAccessibility = () => (
    <Page
      eyebrow="Accessibility"
      title="Readable by default"
      description="Make Vector easier to navigate, see, and click."
    >
      <div class="settings-v2-section-grid">
        <Card icon="settings-gear" title="Display and motion" description="Accessibility preferences apply instantly.">
          <RangeRow
            title="UI scaling"
            value={settings.accessibility.uiScale()}
            min={0.85}
            max={1.35}
            step={0.05}
            format={(value) => `${Math.round(value * 100)}%`}
            onInput={settings.accessibility.setUIScale}
          />
          <ToggleRow
            title="High contrast mode"
            checked={settings.accessibility.highContrast()}
            onChange={settings.accessibility.setHighContrast}
          />
          <ToggleRow
            title="Reduced motion"
            checked={settings.appearance.reduceAnimations()}
            onChange={settings.appearance.setReduceAnimations}
          />
          <ToggleRow
            title="Visible focus indicators"
            checked={settings.accessibility.focusIndicators()}
            onChange={settings.accessibility.setFocusIndicators}
          />
          <ToggleRow
            title="Larger click targets"
            checked={settings.accessibility.largerClickTargets()}
            onChange={settings.accessibility.setLargerClickTargets}
          />
        </Card>
      </div>
    </Page>
  )

  // Notifications has a component of its own (notifications.tsx, WP A38); Settings opens it directly.
  const pageFor = (value: SettingsSection) => (value === "notifications" ? "general" : value)
  const pages: Record<Exclude<SettingsSection, "notifications">, () => JSX.Element> = {
    general: renderGeneral,
    accessibility: renderAccessibility,
  }

  return (
    <div class="settings-v2-content-root">
      <Show when={status()}>
        <div class="settings-v2-toast" role="status" aria-live="polite">
          {status()}
        </div>
      </Show>
      {pages[pageFor(section())]()}
    </div>
  )
}
