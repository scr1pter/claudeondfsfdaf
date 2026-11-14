/** @jsxImportSource react */
import React from "react"
import { CodiumCopy } from "@vectordevai/schema/codium-copy"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { ENTITLEMENTS } from "@vectordevai/schema/codium-entitlements"
import { readAccountApiResponse } from "../../../lib/account-client"
import {
  executeModelPlanAction,
  modelPlanOffer,
  modelPlanRecovery,
  type ModelPlanAction,
} from "../../../lib/model-plan-actions"
import {
  readModelPlanConfig,
  readModelPlanStatus,
  type ModelPlanConfig,
  type ModelPlanStatus,
} from "../../../lib/model-plans"
import { FoundingMember } from "./FoundingMember"
import "./model-plans.css"

export type ModelPlansPreview = { config: ModelPlanConfig; status: ModelPlanStatus }

const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
const price = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const date = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" })
const time = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })

export function ModelPlans(props: { accessToken: string; preview?: ModelPlansPreview | true }) {
  const preview: ModelPlansPreview | undefined =
    props.preview === true
      ? {
          config: { enabled: false, currency: "usd", interval: "month", plans: [] },
          status: { active: false },
        }
      : props.preview
  const [loaded, setData] = React.useState<ModelPlansPreview | undefined>(preview)
  const data = preview ?? (props.accessToken ? loaded : undefined)
  const [loading, setLoading] = React.useState(!preview && Boolean(props.accessToken))
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [action, setAction] = React.useState("")
  const pending = React.useRef(false)
  const [refresh, setRefresh] = React.useState(0)

  React.useEffect(() => {
    if (preview || !props.accessToken) return
    const controller = new AbortController()
    setLoading(true)
    setError("")
    setData(undefined)
    void Promise.all([
      fetch("/api/model-plans/config", {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      })
        .then((response) => readAccountApiResponse(response, "Vector could not load model plans. Try again."))
        .then(readModelPlanConfig),
      fetch("/api/model-plans/status", {
        headers: { accept: "application/json", authorization: `Bearer ${props.accessToken}` },
        cache: "no-store",
        signal: controller.signal,
      })
        .then((response) => readAccountApiResponse(response, "Vector could not load your model plan. Try again."))
        .then(readModelPlanStatus),
    ])
      .then(([config, status]) => {
        if (!controller.signal.aborted) setData({ config, status })
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Vector could not load model plans. Try again.")
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [props.accessToken, props.preview, refresh])

  const status = data?.status
  const monthly = status?.plan
  const customer = status?.active || status?.customer
  const recovery = modelPlanRecovery(status)
  const paused = monthly?.state === "paused"
  const confirmPayment = monthly?.action === "confirm-payment" || monthly?.reason === "action_required"
  const keeps =
    !!monthly?.scheduled &&
    !monthly.changeBlocked &&
    !monthly.cancelAtPeriodEnd &&
    (monthly.state === undefined || monthly.state === "active")
  const caps = monthly && CodiumPlan.isPlanId(monthly.id) ? ENTITLEMENTS[monthly.id] : undefined
  const listed = new Set(status?.listed)
  const meters = status?.meters

  const openBilling = (request: ModelPlanAction) => {
    if (props.preview || !props.accessToken || pending.current || !data) return
    if (request.kind === "checkout" || request.kind === "change") {
      const offer = data.config.plans.find((item) => item.id === request.plan)
      const available = offer && modelPlanOffer(data.config, offer, data.status)?.request
      if (!available || available.kind !== request.kind || !("plan" in available) || available.plan !== request.plan)
        return
    }
    if (request.kind === "keep" && !keeps) return
    if (request.kind === "portal" && !customer) return
    pending.current = true
    setAction("plan" in request ? request.plan : request.kind)
    setError("")
    setNotice("")
    void executeModelPlanAction(request, props.accessToken)
      .then((result) => {
        if ("url" in result) return location.assign(result.url)
        setNotice(
          "scheduled" in result
            ? `${result.scheduled.name} will start on ${date.format(result.scheduled.at)}. Your current plan continues until then.`
            : "Your scheduled change was removed. You’re keeping your current plan.",
        )
        setRefresh((value) => value + 1)
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Vector could not update billing. Try again."),
      )
      .finally(() => {
        pending.current = false
        setAction("")
      })
  }

  const badge = !monthly
    ? undefined
    : paused
      ? confirmPayment
        ? "Confirm payment"
        : monthly.reason === "payment_pending"
          ? "Payment pending"
          : "Payment failed"
      : monthly.state === "frozen"
        ? "On hold"
        : monthly.state === "unknown"
          ? "Plan status unavailable"
          : monthly.state === "ended" || monthly.state === "none"
            ? "Ended"
            : monthly.cancelAtPeriodEnd
              ? "Ending this period"
              : "Active"

  return (
    <section className="acct-section model-plans" aria-labelledby="model-plans-heading" aria-busy={loading}>
      <div className="model-plans-heading">
        <h2 id="model-plans-heading">{data?.config.product ?? "Vector Codium"}</h2>
        {badge && (
          <span className="model-plans-badge" data-state={monthly?.state}>
            {badge}
          </span>
        )}
      </div>
      <p>Monthly coding plans without provider keys. Models and limits differ by plan.</p>
      {!props.accessToken && !preview && <p>Sign in to view your model plan.</p>}
      {loading && <p role="status">Loading model plans…</p>}
      {error && (
        <div className="model-plans-error" role="alert">
          <p>{error}</p>
          {!data && (
            <button
              className="acct-button acct-button-secondary"
              type="button"
              onClick={() => setRefresh((value) => value + 1)}
            >
              Try again
            </button>
          )}
        </div>
      )}
      {notice && (
        <p className="model-plans-notice" role="status">
          {notice}
        </p>
      )}
      {monthly && (
        <div className="model-plans-usage">
          <h3>Plan · {CodiumPlan.name(monthly.id) ?? monthly.name}</h3>
          <dl className="model-plans-rows">
            <UsageRow label="This month" left={monthly.left} />
            <div>
              <dt>{monthly.cancelAtPeriodEnd ? "Access ends" : "Renews"}</dt>
              <dd>{date.format(monthly.renewsAt)}</dd>
            </div>
            {monthly.today && caps?.dailyShare !== null && (
              <UsageRow
                label="Today"
                left={1 - monthly.today.used}
                detail={`${monthly.today.reached ? "Today's limit is reached. " : ""}Resets ${time.format(monthly.today.resetsAt)} UTC.`}
              />
            )}
            {listed.has("github-agents") && caps && (
              <UsageRow
                label="Codium agent time"
                left={meters?.cloudAgents && 1 - meters.cloudAgents.used}
                detail={`${meters?.cloudAgents?.exhausted ? "This month's agent time is used up. " : ""}Codium agents run in your own repo, on your own Actions minutes.`}
              />
            )}
            {listed.has("computer") && caps?.hosted && (
              <UsageRow
                label="Cloud computer hours"
                left={meters?.hosted && 1 - meters.hosted.used}
                detail={`Time on ${CodiumCopy.COMPUTER_LABEL} counts toward your month.`}
              />
            )}
            {listed.has("vault") && !!caps?.vault.gb && (
              <UsageRow
                label="Vault storage"
                left={
                  meters?.vault && meters.vault.quotaBytes > 0
                    ? Math.max(0, 1 - meters.vault.usedBytes / meters.vault.quotaBytes)
                    : undefined
                }
                detail={
                  meters?.vault
                    ? `${count.format(meters.vault.usedBytes / 1e9)} GB used of ${count.format(meters.vault.quotaBytes / 1e9)} GB.`
                    : undefined
                }
              />
            )}
            {listed.has("brain") && caps && (
              <UsageRow
                label="Brain helpers"
                left={
                  meters?.brain && meters.brain.cap > 0
                    ? Math.max(0, 1 - meters.brain.used / meters.brain.cap)
                    : undefined
                }
              />
            )}
            {listed.has("remote") && caps && (
              <div>
                <dt>Vector Remote</dt>
                <dd>
                  {meters?.remote
                    ? `${meters.remote.computers} of ${meters.remote.limit} computers paired`
                    : "Usage temporarily unavailable"}
                </dd>
              </div>
            )}
            {monthly.forecastDate && (
              <div>
                <dt>Forecast</dt>
                <dd>
                  At this pace, this month’s usage may run out around{" "}
                  {date.format(new Date(`${monthly.forecastDate}T12:00:00Z`))}.
                </dd>
              </div>
            )}
            {monthly.ramp && caps && caps.rank >= 3 && (
              <div>
                <dt>Starting limits</dt>
                <dd>
                  New Max and Ultra plans start with lower limits while trust builds, until{" "}
                  {date.format(monthly.ramp.until)}.
                </dd>
              </div>
            )}
          </dl>
          {status?.founding && !preview && (
            <FoundingMember accessToken={props.accessToken} number={status.founding.number} />
          )}
          {status?.velocity === "coming" && caps?.velocity && (
            <div className="model-plans-coming">
              <p>
                <strong>{CodiumCopy.COMING.velocity.name}</strong>{" "}
                <span className="model-plans-badge">{CodiumCopy.COMING.velocity.label}</span>
              </p>
              <p>{CodiumCopy.COMING.velocity.text}</p>
            </div>
          )}
          {keeps && monthly.scheduled && (
            <p className="model-plans-scheduled">
              {CodiumPlan.name(monthly.scheduled.id) ?? monthly.scheduled.name} starts{" "}
              {date.format(monthly.scheduled.at)}. Your current plan continues until then.
            </p>
          )}
          {keeps && (
            <button
              className="acct-button acct-button-secondary"
              type="button"
              disabled={Boolean(action) || Boolean(props.preview)}
              onClick={() => openBilling({ kind: "keep" })}
            >
              {action === "keep" ? "Saving…" : "Keep my plan"}
            </button>
          )}
        </div>
      )}
      {paused && (
        <p className="model-plans-notice">
          {confirmPayment
            ? "Your Codium plan and its perks are paused until you confirm payment."
            : "Your Codium plan and its perks are paused until payment goes through. Update your payment method to continue."}{" "}
          Your billing period has not been extended.
        </p>
      )}
      {monthly?.state === "frozen" && (
        <p className="model-plans-notice">Your Codium plan is on hold. Contact Vector support.</p>
      )}
      {monthly?.state === "unknown" && (
        <p className="model-plans-notice">
          Refresh to check your plan status, or open billing to manage your subscription.
        </p>
      )}
      {!paused && monthly?.state !== "frozen" && monthly?.state !== "unknown" && monthly && status?.empty && (
        <p className="model-plans-notice">
          This month’s Codium usage is used up. {monthly.cancelAtPeriodEnd ? "Access ends" : "It renews"} on{" "}
          {date.format(monthly.renewsAt)}. Your own keys and free models keep working.
          {data?.config.plans.some(
            (offer) =>
              CodiumPlan.rank(offer.id) > CodiumPlan.rank(monthly.id) &&
              modelPlanOffer(data.config, offer, status)?.request?.kind === "change",
          ) && " Upgrade and keep what’s left of this month."}
        </p>
      )}
      {!paused &&
        monthly?.state !== "frozen" &&
        monthly?.state !== "unknown" &&
        monthly &&
        !status?.empty &&
        status?.low && <p className="model-plans-notice">Less than 10% of this month’s Codium usage is left.</p>}
      {customer && (
        <div className="model-plans-manage">
          <button
            className="acct-button acct-button-secondary"
            type="button"
            disabled={Boolean(action) || Boolean(props.preview)}
            onClick={() => openBilling(recovery?.request ?? { kind: "portal" })}
          >
            {action === "portal" ? "Opening billing…" : (recovery?.label ?? "Manage subscription")}
          </button>
          {!paused && <p>Update payment details, view invoices, or cancel in billing.</p>}
        </div>
      )}
      {data && !data.config.enabled && (
        <p className="model-plans-notice">
          {customer
            ? "New Codium purchases are not available right now."
            : "Vector Codium is coming soon. Purchasing is not available yet."}
        </p>
      )}
      {status?.enabled === false && monthly && (
        <p className="model-plans-notice">
          Codium is temporarily unavailable. Your own keys and free models keep working.
        </p>
      )}
      {data && !paused && data.config.plans.length > 0 && (
        <div className="model-plans-offer">
          <h3>Monthly subscriptions</h3>
          <p>
            Billed monthly. Cancel any time; access continues through your paid billing period. Unused monthly usage
            does not roll over, except when you upgrade.
          </p>
          <div className="model-plans-grid">
            {data.config.plans
              .filter((plan) => CodiumPlan.isPlanId(plan.id))
              .map((plan) => {
                const offer = modelPlanOffer(data.config, plan, status)
                const canonical = CodiumPlan.PLANS.find((item) => item.id === plan.id)!
                const models = (data.config.models ?? []).filter(
                  (model) =>
                    (model.plans !== undefined || model.minPlan !== undefined) &&
                    CodiumCopy.modelAvailable(model, canonical.id),
                )
                const defaultModel = models[0]
                const index = defaultModel ? data.config.models!.findIndex((model) => model.id === defaultModel.id) : -1
                const tasks = index < 0 ? undefined : plan.tasks?.[index]
                return (
                  <article className="model-plan" key={plan.id} data-current={offer?.current || undefined}>
                    <h4>{canonical.name}</h4>
                    <p className="model-plan-price">
                      <strong>{price.format(canonical.price)}</strong>
                      <span>/month</span>
                    </p>
                    {tasks && defaultModel && (
                      <p className="model-plan-estimate">
                        About {count.format(tasks[0])}–{count.format(tasks[1])} typical tasks a month with{" "}
                        {defaultModel.name}
                      </p>
                    )}
                    {models.length > 0 ? (
                      <p className="model-plan-access">
                        Models on {canonical.name}: {models.map((model) => model.name).join(", ")}.
                      </p>
                    ) : (
                      <p className="model-plan-access">
                        See current model availability on <a href="/codium">Codium plans</a>.
                      </p>
                    )}
                    {offer?.detail && <p className="model-plan-detail">{offer.detail}</p>}
                    {offer && (
                      <button
                        className="acct-button"
                        type="button"
                        disabled={!offer.request || Boolean(action) || Boolean(props.preview)}
                        onClick={() => {
                          if (offer.request) openBilling(offer.request)
                        }}
                      >
                        {action === plan.id ? "Updating plan…" : offer.label}
                      </button>
                    )}
                  </article>
                )
              })}
          </div>
        </div>
      )}
      {data && (
        <div className="model-plans-terms">
          <p>
            Usage estimates are a guide, not a guarantee. Model choice, context length, and reasoning affect usage;
            repeated context also counts toward usage.
          </p>
          <p>
            When the month is used up, Codium pauses until renewal. Your own provider keys and free models keep working.
            No overage charges. <a href="/legal/terms#codium">Codium terms</a> explain billing and usage.
          </p>
          <p>
            <a href="/codium">Compare Codium plans, models, and limits</a>
          </p>
        </div>
      )}
      {data && !props.preview && (
        <button
          className="model-plans-refresh"
          type="button"
          disabled={Boolean(action) || loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh plan and usage
        </button>
      )}
    </section>
  )
}

function UsageRow(props: { label: string; left: number | undefined; detail?: string }) {
  // Round only once: the displayed used and left shares must add up to 100.
  const left =
    props.left === undefined || !Number.isFinite(props.left) || props.left < 0 || props.left > 1
      ? undefined
      : Math.round(props.left * 100)
  const text = left === undefined ? "Usage temporarily unavailable" : `${100 - left}% used · ${left}% left`
  return (
    <div className="model-plans-usage-row">
      <dt>{props.label}</dt>
      <dd>
        <span>{text}</span>
        {left !== undefined && (
          <meter
            min={0}
            max={100}
            value={left}
            aria-label={`${props.label} left`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={left}
            aria-valuetext={text}
          />
        )}
        {props.detail && <p>{props.detail}</p>}
      </dd>
    </div>
  )
}
