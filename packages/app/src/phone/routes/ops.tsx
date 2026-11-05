import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { BeforeAfter } from "@/features/cloud/ops/before-after"
import {
  ago,
  canFix,
  cardState,
  checksLine,
  decodeCardAnswer,
  decodeCards,
  decodeDomains,
  decodeIncidents,
  decodeMonitors,
  decodeReleases,
  domainStatusLine,
  healthLines,
  imagePairs,
  incidentDetail,
  incidentTitle,
  intervalLine,
  manualReason,
  opsErrorText,
  opsSections,
  releaseLine,
  rollbackLabel,
  SNOOZE_HOURS,
  verdictLine,
  type OpsCard,
  type OpsIncident,
} from "@/features/cloud/ops/ops-model"
import { opsRoute, type OpsRequest } from "@/features/cloud/ops/ops-requests"
import { phoneApi, PhoneApiError } from "../api"
import { phonePath } from "../config"
import { alertsSupport } from "../environment"
import { alertsState } from "../push"
import { opsParts, planNotice } from "../status"
import { browserPush } from "./notifications"
import { Empty, Notice, Panel, type RouteProps } from "./parts"

// Production checks on the phone (WP A50; the A38 shell's route): incidents with snooze, "Fix it" and Undo, the releases
// Release Guard watched, Ship Desk's cards with their checks, verdict and a before and after slider, and the domains
// and URLs On Call checks. Each part shows only when listed (H1). Every action goes to vectordev.ai on this origin with
// the website session; the server decides each one from the plan (S1). Undo and Approve open GitHub: Vector's server
// never merges (S9), and the phone has no GitHub sign-in to merge with.
//
// On Call: Vector's agent is on call, not a person. Nothing here promises availability or a response time (H3).
const PARTS = {
  "on-call":
    "On Call: alerts after two failed checks in a row on your verified URLs and domains. Vector's agent is on call, not a person.",
  "release-guard": "Release Guard: releases Vector watches, and any revert pull request it opened for you to merge.",
  "ship-desk": "Ship Desk: cards for pull requests from Codium runs, with their checks, to approve.",
} as const

type Section = "incidents" | "releases" | "cards" | "checks"
const LABELS: Record<Section, string> = {
  incidents: "Incidents",
  releases: "Releases",
  cards: "Cards",
  checks: "Checks",
}

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
const day = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })

export function OpsRoute(props: RouteProps) {
  const parts = () => opsParts(props.status)
  const shown = createMemo(() => opsSections(parts()))
  const sections = () =>
    (["incidents", "releases", "cards", "checks"] as const).filter((section) =>
      section === "checks" ? shown().domains || shown().monitors : shown()[section],
    )
  const [section, setSection] = createSignal<Section>()
  const current = () => section() ?? sections()[0]
  const [problem, setProblem] = createSignal<string>()
  const [done, setDone] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const call = async (request: OpsRequest) => {
    const route = opsRoute(request)
    if (!route) throw new PhoneApiError(400, "OPS_INVALID", "Vector could not send that.")
    return phoneApi(route.path, props.session, { method: route.method, ...(route.body ? { body: route.body } : {}) })
  }
  const act = async (request: OpsRequest, message: string, after: () => unknown) => {
    if (busy()) return
    setBusy(true)
    setProblem(undefined)
    setDone(undefined)
    try {
      await call(request)
      setDone(message)
      after()
    } catch (cause) {
      setProblem(opsErrorText(cause instanceof PhoneApiError ? cause : undefined))
    } finally {
      setBusy(false)
    }
  }

  // Push opt-in: On Call and Ship Desk tell the phone, so a phone without alerts is offered them here.
  const support = alertsSupport(props.environment)
  const push = support === "ready" ? browserPush() : undefined
  const [alerts] = createResource(() => (push && props.status.listed.has("alerts") ? push : undefined), alertsState)

  return (
    <Panel title="Production">
      <Notice text={planNotice(props.status)} />
      <ul class="phone-list">
        <For each={parts()}>{(part) => <li>{PARTS[part]}</li>}</For>
      </ul>
      <Show when={alerts() === "off" || (props.status.listed.has("alerts") && support === "install-first")}>
        <div class="phone-row" role="note">
          <p>Get a short alert on this phone when a check fails or a card is ready.</p>
          <button
            type="button"
            class="phone-button phone-button--quiet"
            onClick={() => props.navigate(phonePath("notifications"))}
          >
            Set up alerts
          </button>
        </div>
      </Show>
      <Show when={sections().length > 1}>
        <div class="phone-tabs" role="tablist" aria-label="Production">
          <For each={sections()}>
            {(item) => (
              <button
                type="button"
                role="tab"
                class="phone-tab"
                aria-selected={current() === item}
                onClick={() => {
                  setSection(item)
                  setProblem(undefined)
                  setDone(undefined)
                }}
              >
                {LABELS[item]}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Notice text={problem()} />
      <Show when={done()}>
        <p class="phone-meta" role="status">
          {done()}
        </p>
      </Show>
      <Switch>
        <Match when={current() === "incidents"}>
          <Incidents call={call} act={act} busy={busy()} parts={parts()} />
        </Match>
        <Match when={current() === "releases"}>
          <Releases call={call} />
        </Match>
        <Match when={current() === "cards"}>
          <Cards call={call} />
        </Match>
        <Match when={current() === "checks"}>
          <Checks call={call} act={act} busy={busy()} showMonitors={shown().monitors} />
        </Match>
      </Switch>
    </Panel>
  )
}

type Call = (request: OpsRequest) => Promise<Record<string, unknown>>
type Act = (request: OpsRequest, message: string, after: () => unknown) => Promise<void>

function failure(error: unknown) {
  return opsErrorText(error instanceof PhoneApiError ? error : undefined)
}

function Incidents(props: { call: Call; act: Act; busy: boolean; parts: ReturnType<typeof opsParts> }) {
  const [incidents, { refetch }] = createResource(async () => decodeIncidents(await props.call({ kind: "incidents" })))
  const now = () => Date.now()
  const sorted = () =>
    [...(incidents.latest ?? [])].sort((left, right) =>
      left.state === right.state ? right.openedAt - left.openedAt : left.state === "open" ? -1 : 1,
    )
  return (
    <Show when={!incidents.error} fallback={<p class="phone-notice">{failure(incidents.error)}</p>}>
      <Show when={incidents.latest} fallback={<p class="phone-loading">Loading incidents…</p>}>
        <Show when={sorted().length} fallback={<Empty>Nothing needs you right now.</Empty>}>
          <div class="phone-stack">
            <For each={sorted()}>
              {(incident) => (
                <IncidentCard
                  incident={incident}
                  now={now()}
                  busy={props.busy}
                  fixable={canFix(incident, props.parts)}
                  act={(request, message) => props.act(request, message, () => void refetch())}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>
    </Show>
  )
}

function IncidentCard(props: {
  incident: OpsIncident
  now: number
  busy: boolean
  fixable: boolean
  act: (request: OpsRequest, message: string) => void
}) {
  const release = () => props.incident.release
  const pullRequest = () => {
    const undo = release()?.undo
    return undo?.kind === "pull-request" ? undo : undefined
  }
  const manual = () => {
    const undo = release()?.undo
    return undo?.kind === "manual" ? undo : undefined
  }
  return (
    <article class="phone-card" data-state={props.incident.state}>
      <h3>{incidentTitle(props.incident)}</h3>
      <p class="phone-meta">
        {props.incident.state === "open" ? "Open" : "Resolved"} · {ago(props.incident.openedAt, props.now)}
      </p>
      <p>{incidentDetail(props.incident)}</p>
      <Show when={release()}>
        {(details) => (
          <>
            <Show when={details().commits.length}>
              <p class="phone-meta">
                Undoes {details().totalCommits ?? details().commits.length}{" "}
                {(details().totalCommits ?? details().commits.length) === 1 ? "commit" : "commits"}:
              </p>
              <ul class="phone-list">
                <For each={details().commits.slice(0, 5)}>
                  {(commit) => (
                    <li>
                      {commit.sha.slice(0, 7)} {commit.title}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={details().migrations.length}>
              <p class="phone-notice">
                It touches database migrations ({details().migrations.slice(0, 3).join(", ")}). Check them before you
                undo.
              </p>
            </Show>
            <Show when={pullRequest()}>
              {(undo) => (
                <a class="phone-button" href={undo().url} target="_blank" rel="noreferrer">
                  Open the revert pull request #{undo().number}
                </a>
              )}
            </Show>
            <Show when={manual()}>
              {(undo) => (
                <>
                  <p class="phone-meta">{manualReason(undo().reason)}</p>
                  <Show when={undo().openUrl}>
                    {(url) => (
                      <a class="phone-link" href={url()} target="_blank" rel="noreferrer">
                        Open in GitHub
                      </a>
                    )}
                  </Show>
                  <Show when={undo().rollback}>
                    {(rollback) => (
                      <a class="phone-link" href={rollback().url} target="_blank" rel="noreferrer">
                        {rollbackLabel(rollback().host)}
                      </a>
                    )}
                  </Show>
                </>
              )}
            </Show>
            <Show when={details().undo.kind === "pending" && props.incident.state === "open"}>
              <p class="phone-meta">Vector is deciding how to undo this release.</p>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.incident.fix}>
        {(fix) => (
          <p class="phone-meta">
            A fix run started {ago(fix().at, props.now)}.{" "}
            <Show when={fix().url}>
              {(url) => (
                <a class="phone-link" href={url()} target="_blank" rel="noreferrer">
                  Follow it
                </a>
              )}
            </Show>
          </p>
        )}
      </Show>
      <div class="phone-actions">
        <Show when={props.fixable}>
          <button
            type="button"
            class="phone-button"
            disabled={props.busy}
            onClick={() =>
              props.act(
                { kind: "fix", id: props.incident.id },
                "A fix run started in your repository. It opens a pull request for you to merge.",
              )
            }
          >
            Fix it
          </button>
        </Show>
        <Show
          when={props.incident.snoozedUntil}
          fallback={
            <Show when={props.incident.state === "open"}>
              <For each={SNOOZE_HOURS}>
                {(hours) => (
                  <button
                    type="button"
                    class="phone-button phone-button--quiet"
                    disabled={props.busy}
                    onClick={() =>
                      props.act(
                        { kind: "snooze", id: props.incident.id, hours },
                        `Snoozed for ${hours} h: no alerts until then.`,
                      )
                    }
                  >
                    Snooze {hours} h
                  </button>
                )}
              </For>
            </Show>
          }
        >
          {(until) => (
            <>
              <span class="phone-meta">Snoozed until {when(until())}</span>
              <button
                type="button"
                class="phone-button phone-button--quiet"
                disabled={props.busy}
                onClick={() => props.act({ kind: "unsnooze", id: props.incident.id }, "Alerts are back on.")}
              >
                End snooze
              </button>
            </>
          )}
        </Show>
      </div>
    </article>
  )
}

function Releases(props: { call: Call }) {
  const [releases] = createResource(async () => decodeReleases(await props.call({ kind: "releases" })))
  return (
    <Show when={!releases.error} fallback={<p class="phone-notice">{failure(releases.error)}</p>}>
      <Show when={releases.latest} fallback={<p class="phone-loading">Loading releases…</p>}>
        <Show when={releases.latest!.length} fallback={<Empty>No production release watched yet.</Empty>}>
          <ul class="phone-list">
            <For each={releases.latest}>
              {(release) => (
                <li>
                  {releaseLine(release)} <span class="phone-meta">· {ago(release.at, Date.now())}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </Show>
  )
}

function Cards(props: { call: Call }) {
  const [cards] = createResource(async () => decodeCards(await props.call({ kind: "cards" })))
  const [open, setOpen] = createSignal<string>()
  return (
    <Show when={!cards.error} fallback={<p class="phone-notice">{failure(cards.error)}</p>}>
      <Show when={cards.latest} fallback={<p class="phone-loading">Loading cards…</p>}>
        <Show
          when={!cards.latest!.hidden}
          fallback={<p class="phone-notice">Ship Desk is on hold for this account while a payment is reviewed.</p>}
        >
          <Show when={open()} fallback={<CardList cards={cards.latest!.cards} onOpen={setOpen} />}>
            {(id) => <CardView call={props.call} id={id()} onBack={() => setOpen(undefined)} />}
          </Show>
        </Show>
      </Show>
    </Show>
  )
}

function CardList(props: { cards: OpsCard[]; onOpen: (id: string) => void }) {
  return (
    <Show
      when={props.cards.length}
      fallback={<Empty>No cards yet. Pull requests from Codium runs show up here.</Empty>}
    >
      <div class="phone-stack">
        <For each={props.cards}>
          {(card) => (
            <button type="button" class="phone-feature" onClick={() => props.onOpen(card.id)}>
              <strong>
                {card.repository} #{card.number}
              </strong>
              <span>
                {card.title ?? "Pull request"} · {cardState(card)} · {checksLine(card)}
              </span>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

function CardView(props: { call: Call; id: string; onBack: () => void }) {
  const [card] = createResource(async () => decodeCardAnswer(await props.call({ kind: "card", id: props.id })))
  // Each shot through a 60-second signed link from vectordev.ai, shown straight from storage.
  const [links] = createResource(card, async (current) => {
    if (!current) return new Map<number, string>()
    const entries = await Promise.all(
      current.images.map(async (image) => {
        const answer = await props.call({ kind: "image", card: current.id, n: image.n }).catch(() => undefined)
        return [image.n, typeof answer?.url === "string" ? answer.url : undefined] as const
      }),
    )
    return new Map(entries.filter((entry): entry is readonly [number, string] => entry[1] !== undefined))
  })
  return (
    <div class="phone-stack">
      <button type="button" class="phone-link" onClick={props.onBack}>
        All cards
      </button>
      <Show when={!card.error} fallback={<p class="phone-notice">{failure(card.error)}</p>}>
        <Show when={card.latest} fallback={<p class="phone-loading">Loading the card…</p>}>
          {(current) => (
            <article class="phone-card">
              <h3>
                {current().repository} #{current().number}
              </h3>
              <Show when={current().title}>{(title) => <p>{title()}</p>}</Show>
              <p class="phone-meta">
                {cardState(current())} · kept until {day(current().expiresAt)}
              </p>
              <p>{checksLine(current())}</p>
              <p>{verdictLine(current())}</p>
              <Show when={current().run}>
                {(url) => (
                  <a class="phone-link" href={url()} target="_blank" rel="noreferrer">
                    The run in GitHub
                  </a>
                )}
              </Show>
              <Show when={current().imagesOutdated}>
                <p class="phone-meta">These screenshots are of an earlier commit of this pull request.</p>
              </Show>
              <For each={imagePairs(current())}>
                {(pair) => (
                  <BeforeAfter
                    base="phone-compare"
                    route={pair.route}
                    before={pair.before ? links.latest?.get(pair.before.n) : undefined}
                    after={pair.after ? links.latest?.get(pair.after.n) : undefined}
                  />
                )}
              </For>
              <Show when={current().state === "open"}>
                <a class="phone-button" href={current().approve.url} target="_blank" rel="noreferrer">
                  Approve in GitHub
                </a>
                <p class="phone-meta">Vector never merges for you. You can also merge from Vector on your computer.</p>
              </Show>
            </article>
          )}
        </Show>
      </Show>
    </div>
  )
}

function Checks(props: { call: Call; act: Act; busy: boolean; showMonitors: boolean }) {
  const [domains, { refetch }] = createResource(async () => decodeDomains(await props.call({ kind: "domains" })))
  const [monitors] = createResource(
    () => props.showMonitors,
    async () => decodeMonitors(await props.call({ kind: "monitors" })),
  )
  return (
    <div class="phone-stack">
      <h3>Domains</h3>
      <Show when={!domains.error} fallback={<p class="phone-notice">{failure(domains.error)}</p>}>
        <Show when={domains.latest} fallback={<p class="phone-loading">Loading domains…</p>}>
          <Show
            when={domains.latest!.domains.length}
            fallback={<Empty>No domains yet. Add them in Vector on your computer: Settings → Production.</Empty>}
          >
            <For each={domains.latest!.domains}>
              {(domain) => (
                <div class="phone-row">
                  <strong>{domain.domain}</strong>
                  <span class="phone-meta">{domainStatusLine(domain)}</span>
                  <For each={healthLines(domain.health, Date.now(), day)}>
                    {(line) => <p class={line.warn ? "phone-notice" : "phone-meta"}>{line.text}</p>}
                  </For>
                  <Show when={domain.status !== "verified" && domain.record}>
                    {(record) => (
                      <>
                        <p class="phone-meta">
                          Publish a TXT record at {record().txt.name} with the value {record().txt.value}, or serve it
                          at {record().file.url}.
                        </p>
                        <button
                          type="button"
                          class="phone-button phone-button--quiet"
                          disabled={props.busy}
                          onClick={() =>
                            props.act(
                              { kind: "verify-domain", domain: domain.domain },
                              `Checked ${domain.domain}.`,
                              () => void refetch(),
                            )
                          }
                        >
                          Check now
                        </button>
                      </>
                    )}
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </Show>
      <Show when={props.showMonitors}>
        <h3>URLs On Call checks</h3>
        <Show when={!monitors.error} fallback={<p class="phone-notice">{failure(monitors.error)}</p>}>
          <Show when={monitors.latest} fallback={<p class="phone-loading">Loading URLs…</p>}>
            {(current) => (
              <>
                <Show when={current().limits}>
                  {(limits) => (
                    <p class="phone-meta">
                      Up to {limits().urls} URLs, each checked {intervalLine(limits().intervalSec)}.
                    </p>
                  )}
                </Show>
                <Show when={current().monitors.length} fallback={<Empty>No URLs yet.</Empty>}>
                  <ul class="phone-list">
                    <For each={current().monitors}>
                      {(monitor) => (
                        <li>
                          {monitor.url}{" "}
                          <span class="phone-meta">
                            ·{" "}
                            {monitor.checked
                              ? "checked"
                              : monitor.domainVerified
                                ? "past your plan's URLs"
                                : "domain not verified"}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </>
            )}
          </Show>
        </Show>
      </Show>
    </div>
  )
}
