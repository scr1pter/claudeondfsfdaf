import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { usePlatform } from "@/context/platform"
import type { VectorRoadmapRequest } from "@/vector-account"
import {
  ballotLine,
  choiceTitle,
  decodeRoadmap,
  nominationReady,
  refusalText,
  resultsLine,
  ROADMAP_DETAIL_MAX,
  ROADMAP_TITLE_MAX,
  totalShare,
  type Roadmap,
} from "./roadmap-model"
import "./settings-v2.css"
import "./settings-roadmap.css"

/**
 * Settings > Roadmap vote (WP A34): this quarter's ballot, the latest results and, on Ultra, the quarter's nomination.
 * The desktop main process holds the account token and asks vectordev.ai, which decides who may vote from the plan;
 * this page shows its answer and never decides anything itself.
 */
export function SettingsRoadmapV2() {
  const platform = usePlatform()
  const [roadmap, setRoadmap] = createSignal<Roadmap>()
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [picked, setPicked] = createSignal<string>()
  const [title, setTitle] = createSignal("")
  const [detail, setDetail] = createSignal("")
  const choice = createMemo(() => picked() ?? roadmap()?.ballot?.choice)
  const canVote = createMemo(() => {
    const current = roadmap()
    return Boolean(current?.vote.allowed && current.ballot?.open && choice() && choice() !== current.ballot.choice)
  })

  const send = async (request: VectorRoadmapRequest) => {
    const ask = platform.vectorAccount?.roadmap
    if (!ask) return
    setBusy(true)
    setError(undefined)
    const answer = await ask(request).catch(() => ({
      ok: false as const,
      message: "Vector could not load the roadmap vote. Try again shortly.",
    }))
    setBusy(false)
    setLoading(false)
    if (!answer.ok) {
      setError(answer.message)
      return false
    }
    const next = decodeRoadmap(answer.roadmap)
    if (!next) {
      setError("Vector could not read the roadmap vote. Try again shortly.")
      return false
    }
    setRoadmap(next)
    setPicked(undefined)
    return true
  }

  const vote = () => {
    const current = roadmap()
    const selected = choice()
    if (!current?.ballot || !selected) return
    void send({ kind: "vote", quarter: current.ballot.quarter, choice: selected })
  }

  const nominate = async () => {
    const current = roadmap()
    if (!current || !nominationReady(title(), detail())) return
    const sent = await send({
      kind: "nominate",
      quarter: current.quarter,
      title: title(),
      ...(detail().trim() ? { detail: detail() } : {}),
    })
    if (sent) {
      setTitle("")
      setDetail("")
    }
  }

  onMount(() => void send({ kind: "read" }))

  return (
    <section class="settings-v2-page settings-roadmap-page" data-component="settings-roadmap">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Vector Codium</p>
          <h2 class="settings-v2-page-title">Roadmap vote</h2>
          <p class="settings-v2-page-subtitle">
            Max and Ultra choose what Vector builds next. You get one ballot a quarter and can change it until the vote
            closes.
          </p>
        </div>
      </div>

      <Show when={loading()}>
        <p role="status" class="settings-roadmap-muted">
          Loading the roadmap vote…
        </p>
      </Show>

      <Show when={error()}>
        {(message) => (
          <p role="alert" class="settings-roadmap-error">
            {message()}
          </p>
        )}
      </Show>

      <Show when={roadmap()}>
        {(current) => (
          <>
            <div class="settings-roadmap-section" data-component="settings-roadmap-ballot">
              <div class="settings-roadmap-head">
                <h3>This quarter's ballot</h3>
                <Show when={current().ballot}>{(open) => <p>{ballotLine(open(), ModelPlanStatus.formatDate)}</p>}</Show>
              </div>
              <Show
                when={current().ballot}
                fallback={<p class="settings-roadmap-muted">No ballot is open right now.</p>}
              >
                {(open) => (
                  <>
                    <div class="settings-roadmap-options" role="radiogroup" aria-label="Features on this ballot">
                      <For each={open().candidates}>
                        {(candidate) => (
                          <button
                            type="button"
                            role="radio"
                            class="settings-roadmap-option"
                            aria-checked={choice() === candidate.id}
                            data-voted={open().choice === candidate.id ? "" : undefined}
                            disabled={!current().vote.allowed || !open().open || busy()}
                            onClick={() => setPicked(candidate.id)}
                          >
                            <span class="settings-roadmap-option-title">{candidate.title}</span>
                            <Show when={candidate.detail}>
                              {(about) => <span class="settings-roadmap-muted">{about()}</span>}
                            </Show>
                            <Show when={open().choice === candidate.id}>
                              <span class="settings-roadmap-badge">Your vote</span>
                            </Show>
                          </button>
                        )}
                      </For>
                    </div>
                    <Show
                      when={current().vote.allowed}
                      fallback={<p class="settings-roadmap-muted">{refusalText(current().vote.reason)}</p>}
                    >
                      <Show when={open().open}>
                        <div class="settings-roadmap-actions">
                          <ButtonV2 variant="contrast" disabled={!canVote() || busy()} onClick={vote}>
                            {open().choice ? "Change vote" : "Vote"}
                          </ButtonV2>
                        </div>
                      </Show>
                    </Show>
                  </>
                )}
              </Show>
            </div>

            <Show when={current().results}>
              {(closed) => (
                <div class="settings-roadmap-section" data-component="settings-roadmap-results">
                  <div class="settings-roadmap-head">
                    <h3>Latest results</h3>
                    <p>The vote closed {ModelPlanStatus.formatDate(closed().closedAt)}.</p>
                  </div>
                  <Show when={closed().published && closed().totals}>
                    {(totals) => (
                      <ol class="settings-roadmap-totals">
                        <For each={totals()}>
                          {(total) => (
                            <li data-winner={closed().winner?.id === total.id ? "" : undefined}>
                              <span class="settings-roadmap-total-title">{total.title}</span>
                              <span class="settings-roadmap-muted">
                                {total.votes} {total.votes === 1 ? "vote" : "votes"}
                              </span>
                              <span class="settings-roadmap-bar" aria-hidden="true">
                                <span style={{ width: `${totalShare(total, closed().counted)}%` }} />
                              </span>
                            </li>
                          )}
                        </For>
                      </ol>
                    )}
                  </Show>
                  <Show when={resultsLine(closed())}>{(line) => <p class="settings-roadmap-result">{line()}</p>}</Show>
                  <Show when={choiceTitle(closed())}>
                    {(voted) => <p class="settings-roadmap-muted">You voted for {voted()}.</p>}
                  </Show>
                  <p class="settings-roadmap-muted">
                    If the winning feature adds to the free workspace, that part ships free for everyone.
                  </p>
                </div>
              )}
            </Show>

            <Show when={current().nominate.allowed || current().nominate.nomination}>
              <div class="settings-roadmap-section" data-component="settings-roadmap-nominate">
                <div class="settings-roadmap-head">
                  <h3>Nominate a feature</h3>
                  <p>Ultra can nominate one feature a quarter for the next ballot.</p>
                </div>
                <Show
                  when={current().nominate.nomination}
                  fallback={
                    <div class="settings-roadmap-form">
                      <label class="settings-roadmap-field">
                        <span>Feature</span>
                        <input
                          type="text"
                          maxLength={ROADMAP_TITLE_MAX}
                          value={title()}
                          onInput={(event) => setTitle(event.currentTarget.value)}
                        />
                      </label>
                      <label class="settings-roadmap-field">
                        <span>What it would do (optional)</span>
                        <textarea
                          rows={3}
                          maxLength={ROADMAP_DETAIL_MAX}
                          value={detail()}
                          onInput={(event) => setDetail(event.currentTarget.value)}
                        />
                      </label>
                      <div class="settings-roadmap-actions">
                        <ButtonV2
                          variant="outline"
                          disabled={busy() || !nominationReady(title(), detail())}
                          onClick={() => void nominate()}
                        >
                          Nominate
                        </ButtonV2>
                      </div>
                    </div>
                  }
                >
                  {(nomination) => (
                    <p class="settings-roadmap-muted">
                      You nominated “{nomination().title}” this quarter. It goes to the team for the next ballot.
                    </p>
                  )}
                </Show>
              </div>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}
