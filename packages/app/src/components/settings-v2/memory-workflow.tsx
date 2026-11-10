import type { MemorySettings, VectorClient } from "@vectordevai/sdk/v2/client"
import { For, Show, createResource, createSignal } from "solid-js"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { Switch } from "@vectordevai/ui/v2/switch-v2"
import { clearOutcomes } from "@/features/economics/economics-repository"
import {
  MODES,
  WORKFLOW,
  armRow,
  card,
  controls,
  sized,
  tierLabel,
  type WorkflowTierInsights,
} from "./memory-workflow-model"

// Settings > Memory > Workflow insights (section 12): for each size, what the build agent's runs in this repository
// passed with and cost, and the cheaper default they support. The mode and exploring are the owner's settings; reset
// forgets a size's runs, and resetting every size also clears the app's model recommendations for the repository.
export function SettingsMemoryWorkflow(props: {
  client: () => VectorClient | undefined
  repository: boolean
  directory?: string
  /** The owner's saved settings, which hold for every repository: the mode and exploring show these, open or not. */
  settings?: MemorySettings
  onSettings: (settings: MemorySettings) => void
}) {
  const [version, setVersion] = createSignal(0)
  const [notice, setNotice] = createSignal("")
  const [confirming, setConfirming] = createSignal<"light" | "standard" | "thorough" | "all">()
  const [insights] = createResource(
    () => {
      const current = props.client()
      if (!current || !props.repository) return false
      return { client: current, version: version() }
    },
    (input) => input.client.memory.workflow.get().then((result) => result.data),
  )
  const act = async (run: (current: VectorClient) => Promise<{ error?: unknown }>, done: string) => {
    const current = props.client()
    if (!current) return
    const result = await run(current).catch((cause: unknown) => ({ error: cause }))
    setNotice(result.error ? "Vector could not change workflow insights. Try again in a moment." : done)
    if (!result.error) setVersion((value) => value + 1)
  }
  const configure = (change: { workflow?: MemorySettings["workflow"]; workflowExplore?: boolean }, done: string) =>
    act(
      (current) =>
        current.memory.settings.update(change).then((result) => {
          if (result.data) props.onSettings(result.data)
          return result
        }),
      done,
    )
  const reset = (tier: "light" | "standard" | "thorough" | "all") =>
    act(
      async (current) => {
        const result = await current.memory.workflow.reset(tier === "all" ? {} : { tier })
        // The recommender and learned defaults read separate data; resetting all of it clears both.
        if (tier === "all" && !result.error && props.directory) await clearOutcomes(props.directory)
        return result
      },
      tier === "all" ? "Workflow insights and model recommendations reset." : `${tierLabel(tier)} insights reset.`,
    )

  return (
    <>
      <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-workflow">
        <div class="settings-v2-card-head">
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">Workflow insights</h3>
            <p class="settings-v2-card-description">{WORKFLOW.intro}</p>
            <p class="settings-v2-card-description">
              {WORKFLOW.own} {WORKFLOW.privacy}
            </p>
          </div>
        </div>
        <div class="settings-v2-card-body">
          <div class="settings-v2-row-modern">
            <div class="settings-v2-row-copy">
              <div class="settings-v2-row-title">Learned defaults</div>
              <div class="settings-v2-row-description">
                Apply uses them when you leave effort on Default. Observe only records runs and shows what would apply.
                Off records nothing.
              </div>
            </div>
            <div class="settings-v2-row-control settings-v2-row-control--compact">
              <select
                class="settings-memory-kind"
                aria-label="Learned workflow defaults"
                value={controls(props.settings, insights.latest).mode}
                onChange={(event) => {
                  const workflow = event.currentTarget.value as MemorySettings["workflow"]
                  void configure(
                    { workflow },
                    workflow === "apply"
                      ? "Vector applies learned defaults."
                      : workflow === "observe"
                        ? "Vector records runs and applies nothing."
                        : "Vector records no workflow insights.",
                  )
                }}
              >
                <For each={MODES}>{(item) => <option value={item.value}>{item.label}</option>}</For>
              </select>
            </div>
          </div>
          <div class="settings-v2-row-modern">
            <div class="settings-v2-row-copy">
              <div class="settings-v2-row-title">Explore cheaper settings</div>
              <div class="settings-v2-row-description">{WORKFLOW.explore}</div>
            </div>
            <div class="settings-v2-row-control settings-v2-row-control--compact">
              <Switch
                checked={controls(props.settings, insights.latest).explore}
                hideLabel
                onChange={(workflowExplore) =>
                  void configure(
                    { workflowExplore },
                    workflowExplore ? "Vector will try cheaper settings now and then." : "Vector will not explore.",
                  )
                }
              >
                Explore cheaper settings
              </Switch>
            </div>
          </div>
          <Show when={notice()}>
            <p class="settings-memory-notice" role="status">
              {notice()}
            </p>
          </Show>
        </div>
      </div>

      <Show
        when={props.repository}
        fallback={
          <div class="settings-v2-card settings-v2-card--wide">
            <p class="settings-memory-empty">Open a repository to see its workflow insights.</p>
          </div>
        }
      >
        <For each={sized(insights.latest?.tiers ?? [])}>
          {(tier) => (
            <TierCard
              insights={tier}
              confirming={confirming() === tier.tier}
              onConfirm={(on) => setConfirming(on ? tier.tier : undefined)}
              onReset={async () => {
                await reset(tier.tier)
                setConfirming(undefined)
              }}
            />
          )}
        </For>
        <div class="settings-v2-card settings-v2-card--wide">
          <div class="settings-v2-card-head">
            <div class="settings-v2-card-copy">
              <h3 class="settings-v2-card-title">Reset</h3>
              <p class="settings-v2-card-description">{WORKFLOW.reset}</p>
            </div>
          </div>
          <div class="settings-v2-card-body">
            <Show
              when={confirming() === "all"}
              fallback={
                <div class="settings-v2-action-grid">
                  <ButtonV2 variant="outline" onClick={() => setConfirming("all")}>
                    Reset all workflow insights
                  </ButtonV2>
                </div>
              }
            >
              <div class="settings-memory-erase">
                <p>This forgets every run here and the app's model recommendations for this repository.</p>
                <div class="settings-v2-action-grid">
                  <ButtonV2
                    variant="danger"
                    onClick={async () => {
                      await reset("all")
                      setConfirming(undefined)
                    }}
                  >
                    Reset
                  </ButtonV2>
                  <ButtonV2 variant="ghost" onClick={() => setConfirming(undefined)}>
                    Cancel
                  </ButtonV2>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </>
  )
}

function TierCard(props: {
  insights: WorkflowTierInsights
  confirming: boolean
  onConfirm: (on: boolean) => void
  onReset: () => Promise<void>
}) {
  const head = () => card(props.insights)
  return (
    <div
      class="settings-v2-card settings-v2-card--wide"
      data-component="settings-memory-workflow-tier"
      data-tier={props.insights.tier}
    >
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">{head().title}</h3>
          <p class="settings-v2-card-description">
            Default: {head().current}. {head().learned}.
          </p>
          <Show when={head().reason}>{(reason) => <p class="settings-v2-card-description">{reason()}</p>}</Show>
        </div>
      </div>
      <div class="settings-v2-card-body">
        <Show when={props.insights.arms.length > 0} fallback={<p class="settings-memory-empty">{WORKFLOW.empty}</p>}>
          <table class="settings-memory-arms">
            <thead>
              <tr>
                <th scope="col">Setting</th>
                <th scope="col">Runs</th>
                <th scope="col">Passed</th>
                <th scope="col">Checked</th>
                <th scope="col">Average cost</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.insights.arms.map(armRow)}>
                {(row) => (
                  <tr>
                    <td>{row.setting}</td>
                    <td>{row.runs}</td>
                    <td>{row.passRate}</td>
                    <td>{row.checked}</td>
                    <td>{row.cost}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
        <Show when={head().excluded}>{(excluded) => <p class="settings-memory-meta">{excluded()}</p>}</Show>
        <div class="settings-memory-actions">
          <Show
            when={props.confirming}
            fallback={
              <ButtonV2 size="small" variant="ghost" onClick={() => props.onConfirm(true)}>
                Reset {head().title}
              </ButtonV2>
            }
          >
            <span class="settings-memory-confirm">Forget the {head().title} runs these insights learned from?</span>
            <ButtonV2 size="small" variant="danger" onClick={() => void props.onReset()}>
              Reset
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={() => props.onConfirm(false)}>
              Cancel
            </ButtonV2>
          </Show>
        </div>
      </div>
    </div>
  )
}
