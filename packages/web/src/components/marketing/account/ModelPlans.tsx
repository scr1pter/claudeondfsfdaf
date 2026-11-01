/** @jsxImportSource react */
import React from "react"
import { readAccountApiResponse } from "../../../lib/account-client"
import {
  modelPlanPurchasable,
  modelPlanRedirect,
  modelTopupPurchasable,
  readModelPlanConfig,
  readModelPlanStatus,
  type ModelPlanConfig,
  type ModelPlanStatus,
} from "../../../lib/model-plans"
import "./model-plans.css"

export type ModelPlansPreview = { config: ModelPlanConfig; status: ModelPlanStatus }

const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
const price = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
// The monthly balance is the share of the month's credits left and purchased credits are a state, never amounts,
// which with the purchase price would reveal the dollars of model credit in them.
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 })
// Purchased credits pool every top-up ever bought, so they show a state rather than a share of that pool.
const PURCHASED = {
  available: "Purchased Codium credits available",
  low: "Your purchased Codium credits are running low",
  used: "Your purchased Codium credits are used up",
} as const

export function ModelPlans(props: { accessToken: string; preview?: ModelPlansPreview | true }) {
  const preview: ModelPlansPreview | undefined =
    props.preview === true
      ? {
          config: { enabled: false, currency: "usd", interval: "month", plans: [] },
          status: { active: false },
        }
      : props.preview
  const [data, setData] = React.useState<ModelPlansPreview | undefined>(preview)
  const [loading, setLoading] = React.useState(!preview && Boolean(props.accessToken))
  const [error, setError] = React.useState("")
  const [action, setAction] = React.useState("")
  const [refresh, setRefresh] = React.useState(0)

  React.useEffect(() => {
    if (preview || !props.accessToken) return
    const controller = new AbortController()
    setLoading(true)
    setError("")
    setData(undefined)
    void Promise.all([
      fetch("/api/model-plans/config", { headers: { accept: "application/json" }, signal: controller.signal })
        .then((response) => readAccountApiResponse(response, "Vector could not load model plans. Try again."))
        .then(readModelPlanConfig),
      fetch("/api/model-plans/status", {
        headers: { accept: "application/json", authorization: `Bearer ${props.accessToken}` },
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

  const openBilling = (kind: "checkout" | "portal" | "topup", plan?: string) => {
    if (props.preview || !props.accessToken || action || !data) return
    if (
      kind === "checkout" &&
      !data.config.plans.some((item) => item.id === plan && modelPlanPurchasable(data.config, item, data.status))
    )
      return
    if (
      kind === "topup" &&
      !data.config.topups?.some((item) => item.id === plan && modelTopupPurchasable(data.config, item, data.status))
    )
      return
    if (kind === "portal" && !data.status.active && !data.status.customer) return
    setAction(plan ?? "portal")
    setError("")
    void fetch(`/api/model-plans/${kind}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${props.accessToken}`,
      },
      body: JSON.stringify(kind === "checkout" ? { plan } : kind === "topup" ? { pack: plan } : {}),
    })
      .then((response) => readAccountApiResponse(response, "Vector could not open billing. Try again."))
      .then((payload) => location.assign(modelPlanRedirect(payload, kind)))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Vector could not open billing. Try again."))
      .finally(() => setAction(""))
  }

  const status = data?.status
  const monthly = status?.plan
  const purchased = status?.purchased?.bought ? status.purchased : undefined
  const customer = status?.active || status?.customer
  const defaultModel = data?.config.models?.[0]
  return (
    <section className="acct-section model-plans" aria-labelledby="model-plans-heading" aria-busy={loading}>
      <div className="model-plans-heading">
        <h2 id="model-plans-heading">{data?.config.product ?? "Vector Codium"}</h2>
        {monthly && (
          <span className="model-plans-badge">{monthly.cancelAtPeriodEnd ? "Ending this period" : "Active"}</span>
        )}
      </div>
      <p>The same coding model catalog for every budget. Subscribe monthly for Codium access.</p>
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
      {monthly && (
        <div className="model-plans-usage">
          <h3>Monthly allowance · {data?.config.plans.find((item) => item.id === monthly.id)?.name ?? monthly.name}</h3>
          <p className="model-plans-balance">
            {monthly.left === undefined ? (
              "Usage temporarily unavailable"
            ) : (
              <span>
                <strong>{percent.format(monthly.left)}</strong> of this month&apos;s Codium credits remaining
              </span>
            )}
          </p>
          {monthly.left !== undefined && (
            <progress value={Math.round(monthly.left * 100)} max={100} aria-label="Monthly Codium credits remaining" />
          )}
          <p>
            {monthly.cancelAtPeriodEnd ? "Access ends" : "Renews"}{" "}
            {new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(monthly.renewsAt)}
          </p>
        </div>
      )}
      {purchased && (
        <div className="model-plans-usage">
          <h3>Purchased credits</h3>
          <p className="model-plans-balance">
            {purchased.state === undefined ? "Usage temporarily unavailable" : PURCHASED[purchased.state]}
          </p>
          <p>
            Purchased credits carry forward and work without a subscription. Your monthly allowance is used first when
            it can cover the request.
          </p>
        </div>
      )}
      {customer && (
        <div className="model-plans-manage">
          <button
            className="acct-button acct-button-secondary"
            type="button"
            disabled={Boolean(action) || Boolean(props.preview)}
            onClick={() => openBilling("portal")}
          >
            {action === "portal" ? "Opening billing…" : "Manage subscription"}
          </button>
          <p>Update payment details, view invoices, or cancel in billing.</p>
        </div>
      )}
      {data && !data.config.enabled && (
        <p className="model-plans-notice">Vector Codium is coming soon. Purchasing is not available yet.</p>
      )}
      {data &&
        [
          {
            kind: "checkout" as const,
            title: "Monthly subscriptions",
            description:
              "Billed monthly. Cancel any time; access continues through your billing period. Monthly credits do not roll over.",
            plans: data.config.plans,
          },
          {
            kind: "topup" as const,
            title: "One-time credit packs",
            description:
              "A single purchase. Credits carry forward, with no subscription required and no automatic top-ups.",
            plans: data.config.topups ?? [],
          },
        ]
          .filter((group) => group.plans.length > 0)
          .map((group) => (
            <div className="model-plans-offer" key={group.kind}>
              <h3>{group.title}</h3>
              <p>{group.description}</p>
              <div className="model-plans-grid">
                {group.plans.map((plan) => {
                  const current = group.kind === "checkout" && status?.plan?.id === plan.id
                  const available =
                    group.kind === "checkout"
                      ? modelPlanPurchasable(data.config, plan, status)
                      : modelTopupPurchasable(data.config, plan, status)
                  const tasks = plan.tasks?.[0]
                  return (
                    <article className="model-plan" key={plan.id} data-current={current || undefined}>
                      <h4>{plan.name}</h4>
                      <p className="model-plan-price">
                        <strong>{price.format(plan.price)}</strong>
                        <span>{group.kind === "checkout" ? "/month" : "once"}</span>
                      </p>
                      {tasks && defaultModel && (
                        <p className="model-plan-estimate">
                          About {count.format(tasks[0])}–{count.format(tasks[1])} typical tasks
                          {group.kind === "checkout" ? " a month" : ""} with {defaultModel.name}
                        </p>
                      )}
                      <p className="model-plan-access">All Codium models included</p>
                      <button
                        className="acct-button"
                        type="button"
                        disabled={!available || Boolean(action) || Boolean(props.preview)}
                        onClick={() => openBilling(group.kind, plan.id)}
                      >
                        {current
                          ? "Current plan"
                          : group.kind === "checkout" && status?.active
                            ? "Manage in billing"
                            : action === plan.id
                              ? "Opening checkout…"
                              : available
                                ? `Choose ${plan.name}`
                                : "Coming soon"}
                      </button>
                    </article>
                  )
                })}
              </div>
            </div>
          ))}
      {data && (
        <div className="model-plans-terms">
          <p>
            Usage estimates are a guide, not a guarantee. Model choice, context length, and reasoning affect usage;
            repeated context also counts toward usage.
          </p>
          <p>
            Monthly credits reset each billing period. No automatic overage charges or top-ups: usage stops when your
            available credits cannot cover a request. Your own provider keys remain available separately.{" "}
            <a href="/legal/terms#codium">Codium terms</a> explain billing and credit usage.
          </p>
        </div>
      )}
      {data?.config.models && data.config.models.length > 0 && (
        <div className="model-plans-catalog">
          <h3>{data.config.enabled ? "The Codium model catalog" : "Planned model catalog"}</h3>
          <ul className="model-plans-model-list">
            {data.config.models.map((model) => (
              <li key={model.id}>
                <span className="model-plans-model-name">{model.name}</span>
                {model.category && (
                  <span className="model-plans-model-category">
                    {model.category === "advanced" ? "Advanced" : "Everyday"}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="model-plans-catalog-note">
            Every budget includes the same catalog. Model availability can change.
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
