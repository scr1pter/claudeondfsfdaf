import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { usePlatform } from "@/context/platform"
import { Page } from "@/components/settings-v2/parts/page"
import { onCodiumChange } from "@/vector-account"
import { PHONE_ORIGIN, phonePath } from "@/phone/config"
import { BeforeAfter } from "./before-after"
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
  opsParts,
  opsSections,
  PART_LINES,
  releaseLine,
  rollbackLabel,
  SNOOZE_HOURS,
  verdictLine,
  type OpsCard,
  type OpsIncident,
  type OpsPerk,
} from "./ops-model"
import type { OpsMergeRequest, OpsRequest } from "./ops-requests"
import "./ops.css"

// Settings → Production (WP A50): the desktop's production-check screens. Incidents with snooze, "Fix it" and Undo;
// the releases Release Guard watched; Ship Desk's cards with their checks, the judge's verdict and a before and after
// slider; the domains and URLs On Call checks. The main process holds the account token and asks vectordev.ai, which
// decides each action from the plan (S1). Undo and Approve open the pull request in GitHub or merge it here with the
// person's own GitHub sign-in: Vector's server never merges (S9). Each part shows only when listed (H1).

type Section = "incidents" | "releases" | "cards" | "checks"
const LABELS: Record<Section, string> = {
  incidents: "Incidents",
  releases: "Releases",
  cards: "Ship Desk",
  checks: "Domains and URLs",
}
const PHONE_ALERTS_URL = `${PHONE_ORIGIN}${phonePath("notifications")}`

type Answer =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status?: number; code?: string; message: string }

export function SettingsProduction() {
  const platform = usePlatform()
  const [plan, { refetch: refetchPlan }] = createResource(
    () => Boolean(platform.vectorAccount?.codium),
    () => platform.vectorAccount?.codium?.().catch(() => undefined),
  )
  onCleanup(onCodiumChange(() => void refetchPlan()))
  const parts = createMemo<OpsPerk[]>(() => opsParts(plan.latest))
  const shown = createMemo(() => opsSections(parts()))
  const sections = () =>
    (["incidents", "releases", "cards", "checks"] as const).filter((section) =>
      section === "checks" ? shown().domains || shown().monitors : shown()[section],
    )
  const [section, setSection] = createSignal<Section>()
  const current = () => section() ?? sections()[0]
  const [problem, setProblem] = createSignal<string>()
  const [notice, setNotice] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const call = async (request: OpsRequest): Promise<Record<string, unknown>> => {
    const ops = platform.ops
    if (!ops) throw { message: "Production checks open in the Vector desktop app." }
    const answer: Answer = await ops.request(request).catch(() => ({ ok: false as const, message: "" }))
    if (!answer.ok) throw answer
    return answer.body
  }
  const act = async (request: OpsRequest, message: string, after: () => unknown) => {
    if (busy()) return
    setBusy(true)
    setProblem(undefined)
    setNotice(undefined)
    try {
      await call(request)
      setNotice(message)
      after()
    } catch (cause) {
      setProblem(opsErrorText(cause as { status?: number; code?: string; message?: string }))
    } finally {
      setBusy(false)
    }
  }
  const merge = async (target: OpsMergeRequest, after: () => unknown) => {
    const ops = platform.ops
    if (!ops || busy()) return
    setBusy(true)
    setProblem(undefined)
    setNotice(undefined)
    const answer = await ops.merge(target).catch(() => ({ ok: false as const, message: "GitHub did not merge it." }))
    setBusy(false)
    if (answer.ok) {
      setNotice(answer.message)
      after()
    } else setProblem(answer.message)
  }

  return (
    <div class="settings-v2-content-root">
      <Page
        eyebrow="Vector Codium"
        title="Production"
        description="Checks on your production sites and releases, run by Vector. Vector's agent is on call, not a person."
      >
        <div class="settings-ops" data-component="settings-production">
          <Show
            when={platform.ops}
            fallback={<p class="settings-ops-muted">Production checks open in the Vector desktop app.</p>}
          >
            <ul class="settings-ops-parts">
              <For each={parts()}>{(part) => <li>{PART_LINES[part]}</li>}</For>
            </ul>
            <Show when={plan.latest?.listed?.includes("alerts")}>
              <div class="settings-ops-note" role="note">
                <span>On Call and Ship Desk alert your phone. Turn alerts on in the phone app.</span>
                <ButtonV2 variant="outline" onClick={() => platform.openLink(PHONE_ALERTS_URL)}>
                  Open the phone app
                </ButtonV2>
              </div>
            </Show>
            <Show when={sections().length > 1}>
              <div class="settings-ops-tabs" role="tablist" aria-label="Production">
                <For each={sections()}>
                  {(item) => (
                    <button
                      type="button"
                      role="tab"
                      class="settings-ops-tab"
                      aria-selected={current() === item}
                      onClick={() => {
                        setSection(item)
                        setProblem(undefined)
                        setNotice(undefined)
                      }}
                    >
                      {LABELS[item]}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={problem()}>
              {(message) => (
                <p role="alert" class="settings-ops-error">
                  {message()}
                </p>
              )}
            </Show>
            <Show when={notice()}>
              {(message) => (
                <p role="status" class="settings-ops-muted">
                  {message()}
                </p>
              )}
            </Show>
            <Show when={current() === "incidents"}>
              <Incidents call={call} act={act} merge={merge} busy={busy()} parts={parts()} />
            </Show>
            <Show when={current() === "releases"}>
              <Releases call={call} />
            </Show>
            <Show when={current() === "cards"}>
              <Cards call={call} merge={merge} busy={busy()} />
            </Show>
            <Show when={current() === "checks"}>
              <Checks call={call} act={act} busy={busy()} showMonitors={shown().monitors} />
            </Show>
          </Show>
        </div>
      </Page>
    </div>
  )
}

type Call = (request: OpsRequest) => Promise<Record<string, unknown>>
type Act = (request: OpsRequest, message: string, after: () => unknown) => Promise<void>
type Merge = (target: OpsMergeRequest, after: () => unknown) => Promise<void>

const failure = (error: unknown) => opsErrorText(error as { status?: number; code?: string; message?: string })

function Loading(props: { when: unknown; error: unknown; label: string; children: JSX.Element }) {
  return (
    <Show when={!props.error} fallback={<p class="settings-ops-error">{failure(props.error)}</p>}>
      <Show when={props.when} fallback={<p class="settings-ops-muted">Loading {props.label}…</p>}>
        {props.children}
      </Show>
    </Show>
  )
}

/** A merge with the person's own GitHub sign-in, asked twice so it never happens on one stray click. */
function MergeButton(props: { label: string; busy: boolean; onMerge: () => void }) {
  const [sure, setSure] = createSignal(false)
  return (
    <Show
      when={sure()}
      fallback={
        <ButtonV2 variant="outline" disabled={props.busy} onClick={() => setSure(true)}>
          {props.label}
        </ButtonV2>
      }
    >
      <ButtonV2
        variant="contrast"
        disabled={props.busy}
        onClick={() => {
          setSure(false)
          props.onMerge()
        }}
      >
        Merge with my GitHub sign-in
      </ButtonV2>
      <ButtonV2 variant="outline" disabled={props.busy} onClick={() => setSure(false)}>
        Cancel
      </ButtonV2>
    </Show>
  )
}

function Incidents(props: { call: Call; act: Act; merge: Merge; busy: boolean; parts: OpsPerk[] }) {
  const [incidents, { refetch }] = createResource(async () => decodeIncidents(await props.call({ kind: "incidents" })))
  const sorted = () =>
    [...(incidents.latest ?? [])].sort((left, right) =>
      left.state === right.state ? right.openedAt - left.openedAt : left.state === "open" ? -1 : 1,
    )
  return (
    <div class="settings-ops-section">
      <Loading when={incidents.latest} error={incidents.error} label="incidents">
        <Show when={sorted().length} fallback={<p class="settings-ops-muted">Nothing needs you right now.</p>}>
          <For each={sorted()}>
            {(incident) => (
              <IncidentCard
                incident={incident}
                busy={props.busy}
                fixable={canFix(incident, props.parts)}
                act={(request, message) => void props.act(request, message, () => void refetch())}
                merge={(target) => void props.merge(target, () => void refetch())}
              />
            )}
          </For>
        </Show>
      </Loading>
    </div>
  )
}

function IncidentCard(props: {
  incident: OpsIncident
  busy: boolean
  fixable: boolean
  act: (request: OpsRequest, message: string) => void
  merge: (target: OpsMergeRequest) => void
}) {
  const platform = usePlatform()
  const now = Date.now()
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
    <article class="settings-ops-card" data-state={props.incident.state}>
      <div class="settings-ops-card-head">
        <h3>{incidentTitle(props.incident)}</h3>
        <span class="settings-ops-badge" data-open={props.incident.state === "open" ? "" : undefined}>
          {props.incident.state === "open" ? "Open" : "Resolved"}
        </span>
      </div>
      <p class="settings-ops-muted">
        {incidentDetail(props.incident)} · {ago(props.incident.openedAt, now)}
      </p>
      <Show when={release()}>
        {(details) => (
          <>
            <Show when={details().commits.length}>
              <p class="settings-ops-muted">
                Undoes {details().totalCommits ?? details().commits.length}{" "}
                {(details().totalCommits ?? details().commits.length) === 1 ? "commit" : "commits"}:
              </p>
              <ul class="settings-ops-commits">
                <For each={details().commits.slice(0, 8)}>
                  {(commit) => (
                    <li>
                      <code>{commit.sha.slice(0, 7)}</code> {commit.title}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={details().migrations.length}>
              <p class="settings-ops-warning">
                It touches database migrations ({details().migrations.slice(0, 3).join(", ")}). Check what undoing them
                does to your data before you merge.
              </p>
            </Show>
            <Show when={manual()}>{(undo) => <p class="settings-ops-muted">{manualReason(undo().reason)}</p>}</Show>
          </>
        )}
      </Show>
      <Show when={props.incident.fix}>
        {(fix) => (
          <p class="settings-ops-muted">
            A fix run started {ago(fix().at, now)}. It opens a pull request for you to merge.
          </p>
        )}
      </Show>
      <div class="settings-ops-actions">
        <Show when={pullRequest()}>
          {(undo) => (
            <>
              <ButtonV2 variant="outline" onClick={() => platform.openLink(undo().url)}>
                Open revert pull request #{undo().number}
              </ButtonV2>
              <Show when={release()?.repository && props.incident.state === "open"}>
                <MergeButton
                  label="Undo here"
                  busy={props.busy}
                  onMerge={() =>
                    props.merge({
                      repository: release()!.repository!,
                      number: undo().number,
                      // At the commit Vector opened: GitHub refuses the merge if someone pushed to the branch since.
                      ...(undo().headSha ? { headSha: undo().headSha } : {}),
                    })
                  }
                />
              </Show>
            </>
          )}
        </Show>
        <Show when={manual()}>
          {(undo) => (
            <>
              <Show when={undo().openUrl}>
                {(url) => (
                  <ButtonV2 variant="outline" onClick={() => platform.openLink(url())}>
                    Open in GitHub
                  </ButtonV2>
                )}
              </Show>
              <Show when={undo().rollback}>
                {(rollback) => (
                  <ButtonV2 variant="outline" onClick={() => platform.openLink(rollback().url)}>
                    {rollbackLabel(rollback().host)}
                  </ButtonV2>
                )}
              </Show>
            </>
          )}
        </Show>
        <Show when={props.incident.fix?.url}>
          {(url) => (
            <ButtonV2 variant="outline" onClick={() => platform.openLink(url())}>
              Follow the fix run
            </ButtonV2>
          )}
        </Show>
        <Show when={props.fixable}>
          <ButtonV2
            variant="contrast"
            disabled={props.busy}
            onClick={() =>
              props.act(
                { kind: "fix", id: props.incident.id },
                "A fix run started in your repository. It opens a pull request for you to merge.",
              )
            }
          >
            Fix it
          </ButtonV2>
        </Show>
        <Show
          when={props.incident.snoozedUntil}
          fallback={
            <Show when={props.incident.state === "open"}>
              <For each={SNOOZE_HOURS}>
                {(hours) => (
                  <ButtonV2
                    variant="outline"
                    disabled={props.busy}
                    onClick={() =>
                      props.act(
                        { kind: "snooze", id: props.incident.id, hours },
                        `Snoozed for ${hours} h: no alerts until then.`,
                      )
                    }
                  >
                    Snooze {hours} h
                  </ButtonV2>
                )}
              </For>
            </Show>
          }
        >
          {(until) => (
            <>
              <span class="settings-ops-muted">Snoozed until {ModelPlanStatus.formatDate(until())}</span>
              <ButtonV2
                variant="outline"
                disabled={props.busy}
                onClick={() => props.act({ kind: "unsnooze", id: props.incident.id }, "Alerts are back on.")}
              >
                End snooze
              </ButtonV2>
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
    <div class="settings-ops-section">
      <Loading when={releases.latest} error={releases.error} label="releases">
        <Show
          when={releases.latest!.length}
          fallback={<p class="settings-ops-muted">No production release watched yet.</p>}
        >
          <ul class="settings-ops-list">
            <For each={releases.latest}>
              {(release) => (
                <li>
                  {releaseLine(release)} <span class="settings-ops-muted">· {ago(release.at, Date.now())}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Loading>
    </div>
  )
}

function Cards(props: { call: Call; merge: Merge; busy: boolean }) {
  const [cards, { refetch }] = createResource(async () => decodeCards(await props.call({ kind: "cards" })))
  const [open, setOpen] = createSignal<string>()
  return (
    <div class="settings-ops-section">
      <Loading when={cards.latest} error={cards.error} label="cards">
        <Show
          when={!cards.latest!.hidden}
          fallback={
            <p class="settings-ops-warning">Ship Desk is on hold for this account while a payment is reviewed.</p>
          }
        >
          <Show
            when={open()}
            fallback={
              <Show
                when={cards.latest!.cards.length}
                fallback={<p class="settings-ops-muted">No cards yet. Pull requests from Codium runs show up here.</p>}
              >
                <For each={cards.latest!.cards}>
                  {(card) => (
                    <button
                      type="button"
                      class="settings-ops-card settings-ops-card--button"
                      onClick={() => setOpen(card.id)}
                    >
                      <span class="settings-ops-card-head">
                        <strong>
                          {card.repository} #{card.number}
                        </strong>
                        <span class="settings-ops-badge">{cardState(card)}</span>
                      </span>
                      <span class="settings-ops-muted">
                        {card.title ?? "Pull request"} · {checksLine(card)}
                      </span>
                    </button>
                  )}
                </For>
              </Show>
            }
          >
            {(id) => (
              <CardView
                call={props.call}
                id={id()}
                busy={props.busy}
                onBack={() => setOpen(undefined)}
                merge={(target) =>
                  void props.merge(target, () => {
                    setOpen(undefined)
                    void refetch()
                  })
                }
              />
            )}
          </Show>
        </Show>
      </Loading>
    </div>
  )
}

function CardView(props: {
  call: Call
  id: string
  busy: boolean
  onBack: () => void
  merge: (target: OpsMergeRequest) => void
}) {
  const platform = usePlatform()
  const [card] = createResource(async () => decodeCardAnswer(await props.call({ kind: "card", id: props.id })))
  const [shots] = createResource(card, async (current: OpsCard | undefined) => {
    const ops = platform.ops
    if (!current || !ops) return new Map<number, string>()
    const entries = await Promise.all(
      current.images.map(async (image) => {
        const answer = await ops.image({ card: current.id, n: image.n }).catch(() => undefined)
        return [image.n, answer?.ok ? answer.src : undefined] as const
      }),
    )
    return new Map(entries.filter((entry): entry is readonly [number, string] => entry[1] !== undefined))
  })
  return (
    <div class="settings-ops-detail">
      <ButtonV2 variant="outline" onClick={props.onBack}>
        All cards
      </ButtonV2>
      <Loading when={card.latest} error={card.error} label="the card">
        <Show when={card.latest}>
          {(current) => (
            <article class="settings-ops-card">
              <div class="settings-ops-card-head">
                <h3>
                  {current().repository} #{current().number}
                </h3>
                <span class="settings-ops-badge">{cardState(current())}</span>
              </div>
              <Show when={current().title}>{(title) => <p>{title()}</p>}</Show>
              <p class="settings-ops-muted">
                {checksLine(current())} {verdictLine(current())} Kept until{" "}
                {ModelPlanStatus.formatDate(current().expiresAt)}.
              </p>
              <Show when={current().checks?.items.length}>
                <ul class="settings-ops-list">
                  <For each={current().checks!.items}>
                    {(check) => (
                      <li>
                        {check.name}: <span class="settings-ops-muted">{check.conclusion ?? check.status}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={current().imagesOutdated}>
                <p class="settings-ops-muted">These screenshots are of an earlier commit of this pull request.</p>
              </Show>
              <div class="settings-ops-shots">
                <For each={imagePairs(current())}>
                  {(pair) => (
                    <BeforeAfter
                      base="settings-ops-compare"
                      route={pair.route}
                      before={pair.before ? shots.latest?.get(pair.before.n) : undefined}
                      after={pair.after ? shots.latest?.get(pair.after.n) : undefined}
                    />
                  )}
                </For>
              </div>
              <div class="settings-ops-actions">
                <ButtonV2 variant="outline" onClick={() => platform.openLink(current().approve.url)}>
                  Open in GitHub
                </ButtonV2>
                <Show when={current().run}>
                  {(url) => (
                    <ButtonV2 variant="outline" onClick={() => platform.openLink(url())}>
                      The run in GitHub
                    </ButtonV2>
                  )}
                </Show>
                <Show when={current().state === "open" && !current().draft}>
                  <MergeButton
                    label="Approve and merge"
                    busy={props.busy}
                    onMerge={() =>
                      props.merge({
                        repository: current().approve.repository,
                        number: current().approve.number,
                        headSha: current().approve.headSha,
                      })
                    }
                  />
                </Show>
              </div>
              <p class="settings-ops-muted">
                Vector never merges for you. Merging here uses your own GitHub sign-in, at the commit this card shows.
              </p>
            </article>
          )}
        </Show>
      </Loading>
    </div>
  )
}

function Checks(props: { call: Call; act: Act; busy: boolean; showMonitors: boolean }) {
  const [domains, { refetch: refetchDomains }] = createResource(async () =>
    decodeDomains(await props.call({ kind: "domains" })),
  )
  const [monitors, { refetch: refetchMonitors }] = createResource(
    () => props.showMonitors,
    async () => decodeMonitors(await props.call({ kind: "monitors" })),
  )
  const [domain, setDomain] = createSignal("")
  const [url, setUrl] = createSignal("")
  const refresh = () => {
    void refetchDomains()
    if (props.showMonitors) void refetchMonitors()
  }
  return (
    <div class="settings-ops-section">
      <h3 class="settings-ops-heading">Domains</h3>
      <p class="settings-ops-muted">
        Vector checks only domains you verified. Verification is checked again every week, and each domain's
        certificate, registration and DNS are read daily.
      </p>
      <div class="settings-ops-form">
        <input
          class="settings-ops-input"
          type="text"
          placeholder="example.com"
          aria-label="Domain to verify"
          spellcheck={false}
          value={domain()}
          onInput={(event) => setDomain(event.currentTarget.value)}
        />
        <ButtonV2
          variant="outline"
          disabled={props.busy || !domain().trim()}
          onClick={() =>
            void props.act(
              { kind: "add-domain", domain: domain() },
              "Domain added. Publish its record, then check it.",
              () => {
                setDomain("")
                refresh()
              },
            )
          }
        >
          Add domain
        </ButtonV2>
      </div>
      <Loading when={domains.latest} error={domains.error} label="domains">
        <Show when={domains.latest!.limit !== undefined}>
          <p class="settings-ops-muted">Your plan checks up to {domains.latest!.limit} domains.</p>
        </Show>
        <For each={domains.latest!.domains}>
          {(entry) => (
            <div class="settings-ops-card">
              <div class="settings-ops-card-head">
                <strong>{entry.domain}</strong>
                <span class="settings-ops-badge" data-open={entry.status === "verified" ? undefined : ""}>
                  {domainStatusLine(entry)}
                </span>
              </div>
              <For each={healthLines(entry.health, Date.now(), ModelPlanStatus.formatDate)}>
                {(line) => <p class={line.warn ? "settings-ops-warning" : "settings-ops-muted"}>{line.text}</p>}
              </For>
              <Show when={entry.status !== "verified" && entry.record}>
                {(record) => (
                  <p class="settings-ops-muted">
                    Publish a TXT record at <code>{record().txt.name}</code> with the value{" "}
                    <code>{record().txt.value}</code>, or serve that value at <code>{record().file.url}</code>.
                  </p>
                )}
              </Show>
              <div class="settings-ops-actions">
                <Show when={entry.status !== "verified"}>
                  <ButtonV2
                    variant="outline"
                    disabled={props.busy}
                    onClick={() =>
                      void props.act(
                        { kind: "verify-domain", domain: entry.domain },
                        `Checked ${entry.domain}.`,
                        refresh,
                      )
                    }
                  >
                    Check now
                  </ButtonV2>
                </Show>
                <ButtonV2
                  variant="outline"
                  disabled={props.busy}
                  onClick={() =>
                    void props.act(
                      { kind: "remove-domain", domain: entry.domain },
                      `Removed ${entry.domain} and the URLs on it.`,
                      refresh,
                    )
                  }
                >
                  Remove
                </ButtonV2>
              </div>
            </div>
          )}
        </For>
      </Loading>
      <Show when={props.showMonitors}>
        <h3 class="settings-ops-heading">URLs On Call checks</h3>
        <div class="settings-ops-form">
          <input
            class="settings-ops-input"
            type="text"
            placeholder="https://example.com/health"
            aria-label="URL for On Call to check"
            spellcheck={false}
            value={url()}
            onInput={(event) => setUrl(event.currentTarget.value)}
          />
          <ButtonV2
            variant="outline"
            disabled={props.busy || !url().trim()}
            onClick={() =>
              void props.act({ kind: "add-monitor", url: url() }, "URL added.", () => {
                setUrl("")
                refresh()
              })
            }
          >
            Add URL
          </ButtonV2>
        </div>
        <Loading when={monitors.latest} error={monitors.error} label="URLs">
          <Show when={monitors.latest!.limits}>
            {(limits) => (
              <p class="settings-ops-muted">
                Up to {limits().urls} URLs, each checked {intervalLine(limits().intervalSec)}. Two failures in a row
                alert your phone.
              </p>
            )}
          </Show>
          <For each={monitors.latest!.monitors}>
            {(monitor) => (
              <div class="settings-ops-row">
                <span>{monitor.url}</span>
                <span class="settings-ops-muted">
                  {monitor.checked
                    ? "Checked"
                    : monitor.domainVerified
                      ? "Past your plan's URLs"
                      : "Domain not verified"}
                </span>
                <ButtonV2
                  variant="outline"
                  disabled={props.busy}
                  onClick={() => void props.act({ kind: "remove-monitor", id: monitor.id }, "URL removed.", refresh)}
                >
                  Remove
                </ButtonV2>
              </div>
            )}
          </For>
        </Loading>
      </Show>
    </div>
  )
}
