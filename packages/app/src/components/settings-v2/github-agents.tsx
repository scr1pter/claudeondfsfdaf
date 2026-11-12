import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { GithubAgentsSetup } from "@/features/github-agents/setup-card"
import { GithubBindingsList } from "@/features/github-agents/bindings-list"
import type { AgentsStatus } from "@/features/github-agents/agents-model"

export function SettingsGithubAgentsV2(props: { repositoryPath?: string }) {
  const [state, setState] = createStore<{ status?: AgentsStatus }>({})
  return (
    <div class="github-agents p-6">
      <GithubAgentsSetup cwd={props.repositoryPath} onStatus={(status) => setState("status", status)} />
      <Show when={state.status}>{(status) => <GithubBindingsList cwd={props.repositoryPath} status={status()} />}</Show>
      <Show
        when={
          state.status?.options?.schedules?.length &&
          (state.status.options.mode === "own-key" || (state.status.listed.agents && state.status.listed.scheduled))
        }
      >
        <section>
          <h3>GitHub schedules</h3>
          <p>
            These schedules are stored in this repository's workflow on its default branch. Change them through
            Automations and merge the update pull request.
          </p>
          <ul>
            <For each={state.status?.options?.schedules}>
              {(schedule) => (
                <li>
                  <strong>{schedule.id}</strong> · <code>{schedule.cron}</code> (UTC)<p>{schedule.prompt}</p>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
    </div>
  )
}
