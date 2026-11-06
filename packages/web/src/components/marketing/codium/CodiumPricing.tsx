/** @jsxImportSource react */
import React from "react"
import { CodiumCopy } from "@vectordevai/schema/codium-copy"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import {
  refreshCodiumPricing,
  unavailablePricing,
  type CodiumOffer,
  type CodiumPricingView,
} from "../../../lib/codium-pricing"
import { modelPlanRedirect, type ModelPlanStatus } from "../../../lib/model-plans"
import "./codium-pricing.css"

const INTENT_KEY = "vector-codium-intent"
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
const range = (tasks: readonly [number, number]) => `${count.format(tasks[0])}–${count.format(tasks[1])}`
const FOOTNOTE = "Renews monthly until you cancel. Coming items are not part of today's purchase and have no date."

/** The runtime listing replaces the prerendered view before a saved purchase can resume. */
export function CodiumPricing(props: { pricing: CodiumPricingView; accountPreview?: ModelPlanStatus | null }) {
  const [pricing, setPricing] = React.useState(props.pricing)
  const [account, setAccount] = React.useState<ModelPlanStatus | null | undefined>(props.accountPreview)
  const [accessToken, setAccessToken] = React.useState("")
  const [accountFailed, setAccountFailed] = React.useState(false)
  const [refreshIndex, setRefreshIndex] = React.useState(0)
  const [pending, setPending] = React.useState<{ id: string; signIn?: boolean }>()
  const pendingAction = React.useRef(false)
  const [failure, setFailure] = React.useState<{ id: string; message: string }>()
  const plans = pricing.monthly

  const buy = (offer: CodiumOffer, resumed = false, known = account) => {
    if (
      props.accountPreview !== undefined ||
      !offer.available ||
      pendingAction.current ||
      known === undefined ||
      known?.active ||
      known?.enabled === false ||
      known?.plan?.state === "paused"
    )
      return
    pendingAction.current = true
    setPending({ id: offer.id })
    setFailure(undefined)
    void checkoutDestination(offer.id, resumed)
      .then((destination) => {
        if (!destination) {
          pendingAction.current = false
          return setPending(undefined)
        }
        setPending({ id: offer.id, signIn: destination.startsWith("/login") })
        location.assign(destination)
      })
      .catch((cause) => {
        pendingAction.current = false
        setPending(undefined)
        setFailure({
          id: offer.id,
          message: cause instanceof Error ? cause.message : "Vector could not open checkout. Try again.",
        })
      })
  }

  React.useEffect(() => {
    if (props.accountPreview !== undefined) return
    let active = true
    let generation = 0
    const intent = takeIntent()
    const refresh = (resume = false) => {
      const current = ++generation
      setPricing(unavailablePricing(props.pricing))
      setAccount(undefined)
      setAccessToken("")
      setAccountFailed(false)
      void Promise.all([refreshCodiumPricing(props.pricing), currentAccount().catch(() => undefined)]).then(
        ([next, identity]) => {
          if (!active || current !== generation) return
          setPricing(next)
          if (!identity) {
            setAccountFailed(true)
            return
          }
          setAccount(identity.status)
          setAccessToken(identity.accessToken ?? "")
          const offer = intent && next.monthly.find((item) => item.id === intent.id)
          if (resume && offer?.available && identity.status && !identity.status.active)
            buy(offer, true, identity.status)
        },
      )
    }
    refresh(true)
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      pendingAction.current = false
      setPending(undefined)
      takeIntent()
      // Back-forward cache can outlive the server's listing and sales switches.
      refresh()
    }
    addEventListener("pageshow", restore)
    return () => {
      active = false
      removeEventListener("pageshow", restore)
    }
  }, [refreshIndex])

  const paused = account?.plan?.state === "paused"
  const confirm = account?.plan?.action === "confirm-payment" || account?.plan?.reason === "action_required"
  const recover = () => {
    if (props.accountPreview !== undefined || pendingAction.current || !accessToken || !paused) return
    pendingAction.current = true
    setPending({ id: "payment" })
    setFailure(undefined)
    void import("../../../lib/model-plan-actions")
      .then(({ executeModelPlanAction, modelPlanRecovery }) => {
        const request = modelPlanRecovery(account)?.request
        return request ? executeModelPlanAction(request, accessToken) : undefined
      })
      .then((result) => {
        if (result && "url" in result) location.assign(result.url)
      })
      .catch((cause) =>
        setFailure({
          id: "payment",
          message: cause instanceof Error ? cause.message : "Vector could not open billing. Try again.",
        }),
      )
      .finally(() => {
        pendingAction.current = false
        setPending(undefined)
      })
  }

  const button = (offer: CodiumOffer, small = false) =>
    paused ? null : (
      <button
        className={`cx-btn${offer.id === "vector-50" ? "" : " cx-btn--secondary"}${small ? " cx-btn--sm" : ""}`}
        type="button"
        disabled={
          props.accountPreview !== undefined ||
          pending !== undefined ||
          (account?.active
            ? account.plan?.id === offer.id
            : !offer.available || account === undefined || account?.enabled === false)
        }
        onClick={() => (account?.active ? location.assign("/account") : buy(offer))}
      >
        {account?.active
          ? account.plan?.id === offer.id
            ? "Current plan"
            : "Change plan"
          : !offer.available || account?.enabled === false
            ? "Coming soon"
            : account === undefined
              ? "Reading your plan…"
              : pending?.id === offer.id
                ? pending.signIn
                  ? "Signing in…"
                  : "Opening checkout…"
                : `Get ${offer.name}`}
      </button>
    )
  const groups: { label: string; rows: { label: string; values: (string | boolean)[] }[] }[] = [
    { label: "Usage", rows: [{ label: "Monthly usage", values: plans.map((plan) => plan.usage) }] },
    {
      label: "Headline perks",
      rows: Object.entries(CodiumCopy.PERK_COPY).flatMap(([id, copy]) => {
        const values = plans.map((plan) => plan.perks.find((perk) => perk.id === id)?.text ?? false)
        return values.some(Boolean) ? [{ label: copy.label, values }] : []
      }),
    },
    {
      label: "Models",
      rows: pricing.models.map((model) => ({
        label: model.name,
        values: plans.map((plan) => plan.models.some((item) => item.id === model.id)),
      })),
    },
    {
      label: "Typical tasks a month",
      rows: pricing.models.flatMap((model, index) =>
        plans.some((plan) => plan.tasks[index])
          ? [
              {
                label: model.name,
                values: plans.map((plan) => (plan.tasks[index] ? range(plan.tasks[index]!) : false)),
              },
            ]
          : [],
      ),
    },
    {
      label: "Limits",
      rows: [
        { label: "Codium requests at once", values: plans.map((plan) => String(plan.caps.inFlight)) },
        { label: "Requests a minute", values: plans.map((plan) => String(plan.caps.perMinute)) },
        { label: "Daily limit", values: plans.map((plan) => plan.limits[2]!) },
        { label: "Longest available context", values: plans.map((plan) => plan.limits[3] ?? "Not yet listed") },
      ],
    },
    {
      label: "Coming",
      rows: [
        {
          label: CodiumCopy.COMING.velocity.name,
          values: plans.map((plan) => (plan.coming.length ? "Coming" : false)),
        },
      ],
    },
    {
      label: "Every plan includes",
      rows: CodiumCopy.EVERY_PLAN.map((label) => ({ label, values: plans.map(() => true) })),
    },
    {
      label: "Included in the free Vector workspace",
      rows: CodiumCopy.FREE_WORKSPACE.map((label) => ({ label, values: plans.map(() => true) })),
    },
  ]

  return (
    <React.Fragment>
      <section className="cx-section cx-pricing">
        <div className="cx-container">
          <h1 className="cx-type-xl">Pricing</h1>
          {accountFailed && (
            <p className="cx-error cx-type-sm" role="alert">
              Vector could not read your plan.{" "}
              <button type="button" className="cx-btn cx-btn--sm" onClick={() => setRefreshIndex((value) => value + 1)}>
                Try again
              </button>{" "}
              <a href="/account">Open your account</a>.
            </p>
          )}
          {paused && (
            <div className="cx-note cx-type-sm" role="status">
              <p>
                {confirm
                  ? "Confirm your payment to resume Codium."
                  : "Your Codium plan is paused until payment is resolved."}
              </p>
              <button
                type="button"
                className="cx-btn"
                disabled={pending !== undefined || props.accountPreview !== undefined}
                onClick={() => void recover()}
              >
                {pending?.id === "payment" ? "Opening billing…" : confirm ? "Confirm payment" : "Update card"}
              </button>
              {failure?.id === "payment" && <p role="alert">{failure.message}</p>}
            </div>
          )}
          <div className="cx-plans">
            <h2 className="cx-visually-hidden">Codium monthly plans</h2>
            <div className="cx-cards">
              {plans.map((offer) => (
                <article
                  className={`cx-card${offer.id === "vector-10" ? "" : " cx-card--premium"}`}
                  key={offer.id}
                  data-plan={offer.id}
                >
                  <div className="cx-card-inner">
                    <div className="cx-card-head">
                      <h3 className="cx-type-md">{offer.name}</h3>
                      {offer.id === "vector-50" && <span className="cx-badge cx-type-xs">Recommended</span>}
                    </div>
                    <p className="cx-price">
                      <span className="cx-amount cx-type-lg">{usd.format(offer.price)}</span>
                      <span className="cx-per">/month</span>
                    </p>
                    <div className="cx-card-buy">
                      {button(offer)}
                      {failure?.id === offer.id && (
                        <p className="cx-error cx-type-xs" role="alert">
                          {failure.message} <a href="/account">Open your account</a>
                        </p>
                      )}
                    </div>
                    <p className="cx-lead cx-type-sm">{offer.tagline}</p>
                    <div className="cx-usage">
                      <p className="cx-type-md">{offer.usage}</p>
                    </div>
                    {offer.headlines.length > 0 && (
                      <FeatureGroup label="Headlines" items={offer.headlines.map((perk) => perk.text)} />
                    )}
                    <div className="cx-group">
                      <p className="cx-group-label cx-type-sm">Models</p>
                      {offer.modelLead && <p className="cx-type-sm">{offer.modelLead}</p>}
                      {offer.models.length ? (
                        <ul className="cx-list cx-type-sm">
                          {offer.additions.map((model) => (
                            <li key={model.id}>
                              <Tick />
                              {model.name}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="cx-type-sm cx-muted">Model access is not available yet.</p>
                      )}
                    </div>
                    {offer.coming.length > 0 && (
                      <div className="cx-group">
                        <p className="cx-group-label cx-type-sm">Coming</p>
                        {offer.coming.map((item) => (
                          <div className="cx-coming" key={item.name}>
                            <p className="cx-type-sm">
                              {item.name} <span className="cx-coming-pill">{item.label}</span>
                            </p>
                            <p className="cx-type-xs">{item.text}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    <FeatureGroup label="Limits" items={offer.limits} />
                    {offer.perks.some((perk) => perk.id === "github-agents") && (
                      <p className="cx-type-xs cx-muted">
                        Codium agents run in your own repo, on your own Actions minutes. GitHub bills Actions minutes on
                        private repos beyond your GitHub plan's included minutes.
                      </p>
                    )}
                    {offer.caps.rank! >= 3 && (
                      <p className="cx-type-xs cx-muted">
                        New Max and Ultra accounts start with lower limits while trust builds.
                      </p>
                    )}
                    <p className="cx-footnote cx-type-xs">{FOOTNOTE}</p>
                  </div>
                </article>
              ))}
            </div>
            <p className="cx-note cx-type-xs">
              Any applicable taxes are shown before payment. Monthly plans only, no top-ups or overage charges. When the
              month is used up, Codium pauses until renewal; your own keys and free models keep working. Upgrade and
              keep what's left of this month. Typical tasks are estimates. See the{" "}
              <a href="/legal/terms#codium">Codium terms</a>.
            </p>
          </div>
          <section className="cx-compare" aria-labelledby="cx-compare-heading">
            <h2 className="cx-type-lg" id="cx-compare-heading">
              Compare features across plans
            </h2>
            <div className="cx-compare-scroll" role="region" aria-labelledby="cx-compare-heading" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="cx-visually-hidden">Feature</span>
                    </th>
                    {plans.map((offer) => (
                      <th scope="col" key={offer.id}>
                        <div className="cx-compare-plan">
                          <div>
                            <p className="cx-type-sm">{offer.name}</p>
                            <p className="cx-compare-price cx-type-xs">
                              {usd.format(offer.price)}
                              <span>/month</span>
                            </p>
                          </div>
                          {button(offer, true)}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                {groups
                  .filter((group) => group.rows.length)
                  .map((group) => (
                    <tbody className="cx-type-sm" key={group.label}>
                      <tr>
                        <th className="cx-compare-group" colSpan={plans.length + 1} scope="rowgroup">
                          <div>{group.label}</div>
                        </th>
                      </tr>
                      {group.rows.map((row) => (
                        <tr key={row.label}>
                          <th scope="row">{row.label}</th>
                          {row.values.map((value, index) => (
                            <td key={plans[index]!.id}>
                              {value === true ? (
                                <span className="cx-mark cx-type-md">
                                  <Check />
                                  <span className="cx-visually-hidden">Included</span>
                                </span>
                              ) : value === false ? (
                                <span className="cx-mark cx-mark--no cx-type-md">
                                  —<span className="cx-visually-hidden">Not included</span>
                                </span>
                              ) : (
                                <span className="cx-compare-text">{value}</span>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  ))}
              </table>
            </div>
          </section>
        </div>
      </section>
      <CodiumQuestions models={pricing.models} />
    </React.Fragment>
  )
}

function FeatureGroup(props: { label: string; items: readonly string[] }) {
  return (
    <div className="cx-group">
      <p className="cx-group-label cx-type-sm">{props.label}</p>
      <ul className="cx-list cx-type-sm">
        {props.items.map((item) => (
          <li key={item}>
            <Tick />
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Independent FAQ toggles; find-in-page can reveal a collapsed answer. */
export function CodiumQuestions(props: { models: CodiumPricingView["models"] }) {
  const [open, setOpen] = React.useState<string[]>([])
  const [ready, setReady] = React.useState(false)
  const regions = React.useRef(new Map<string, HTMLDivElement>())
  React.useEffect(() => {
    regions.current.forEach((region, id) => {
      if (open.includes(id)) region.removeAttribute("hidden")
      else region.setAttribute("hidden", "until-found")
    })
    setReady(true)
  }, [open])
  React.useEffect(() => {
    const listeners = [...regions.current].map(([id, region]) => {
      const reveal = () => setOpen((current) => (current.includes(id) ? current : [...current, id]))
      region.addEventListener("beforematch", reveal)
      return () => region.removeEventListener("beforematch", reveal)
    })
    return () => listeners.forEach((remove) => remove())
  }, [])
  const faq = [
    {
      id: "plan",
      question: "What is the right plan for me?",
      answer: (
        <p>
          Start with Plus for occasional coding, Pro for regular work, Max for demanding tasks, or Ultra for the most
          monthly usage and no daily limit. Compare the models and currently listed features above.
        </p>
      ),
    },
    {
      id: "need",
      question: "Do I need Codium to use Vector?",
      answer: (
        <p>
          No. Vector's desktop app and CLI are free with your own provider keys or free models. Codium is an optional
          monthly plan for model access without setting up provider accounts.
        </p>
      ),
    },
    {
      id: "usage",
      question: "How is Codium usage measured?",
      answer: (
        <p>
          Each request uses part of your monthly allowance. Larger models, longer conversations and more parallel work
          use more. Vector shows usage as a percentage. All work on Codium counts toward your month.
        </p>
      ),
    },
    {
      id: "run-out",
      question: "What happens when my month runs out?",
      answer: (
        <p>
          Codium pauses until renewal. There are no top-ups or overage charges. You can upgrade and keep what's left, or
          continue using your own provider keys, Vector Local and free models.
        </p>
      ),
    },
    {
      id: "models",
      question: "Which models are offered, and where do requests go?",
      answer: (
        <React.Fragment>
          <p>
            {props.models.length
              ? "The currently offered models are listed below. Availability differs by plan; the comparison table shows which you can use."
              : "Model access is not available yet. The current model list will appear here when access is ready."}
          </p>
          {props.models.length > 0 && (
            <ul>
              {props.models.map((model) => (
                <li key={model.id}>
                  <strong>{model.name}</strong>
                </li>
              ))}
            </ul>
          )}
          <p>
            Codium requests, including the code and tool output a task sends, go through Vector and OpenRouter to the
            provider serving your chosen model. Vector routes them only to zero-data-retention endpoints. OpenRouter
            still screens requests for child sexual abuse material and keeps request metadata, and some providers hold a
            short-lived prompt cache. Read the <a href="/legal/privacy#codium">privacy policy</a> before sending code.
          </p>
        </React.Fragment>
      ),
    },
    {
      id: "github",
      question: "Does GitHub agent work cost extra?",
      answer: (
        <p>
          When listed, Codium model use comes from your month. Runs happen in your own repo, on your own Actions
          minutes. GitHub bills Actions minutes on private repos beyond your GitHub plan's included minutes. GitHub
          agents with your own key as a repo secret stay part of the free workspace.
        </p>
      ),
    },
    {
      id: "coming",
      question: "What does Coming mean?",
      answer: (
        <p>
          These items are in development, have no date and are not part of what a subscription buys today.{" "}
          {CodiumCopy.COMING.velocity.name} is a planned 550B+ parameter coding model, intended for Max and Ultra if it
          launches.
        </p>
      ),
    },
    {
      id: "taxes",
      question: "Are prices inclusive of taxes?",
      answer: <p>Prices are in US dollars. Any applicable taxes and the total you pay are shown before payment.</p>,
    },
    {
      id: "balance",
      question: "Where can I see my usage?",
      answer: (
        <p>
          As a percentage in Settings → Usage, Settings → Account, <code>vector codium</code>, and your{" "}
          <a href="/account">account page</a>. The figure can lag behind requests that are still finishing.
        </p>
      ),
    },
    {
      id: "last-longer",
      question: "How can I make my month last longer?",
      answer: (
        <p>
          Use a smaller available model for routine work. Start a new session for each task, point agents at the files
          that matter and run fewer agents in parallel. Your own keys and free models do not use your Codium month.
        </p>
      ),
    },
    {
      id: "change",
      question: "How do I change or cancel my plan?",
      answer: (
        <p>
          Upgrade immediately: the new monthly price is charged in full and what's left of this month carries over. A
          downgrade starts at renewal. A failed payment pauses Codium until you update your payment method. Cancel
          through your account to stop future renewals; access continues until the paid period ends.
        </p>
      ),
    },
  ]
  return (
    <section className="cx-section cx-faq" aria-labelledby="cx-faq-heading" data-ready={ready ? "" : undefined}>
      <div className="cx-container cx-faq-grid">
        <div className="cx-faq-title">
          <div>
            <h2 className="cx-type-lg" id="cx-faq-heading">
              Questions &amp; Answers
            </h2>
          </div>
        </div>
        <div className="cx-faq-list">
          {faq.map((item) => {
            const expanded = open.includes(item.id)
            return (
              <div className="cx-faq-item" data-state={expanded ? "open" : "closed"} key={item.id}>
                <h3>
                  <button
                    type="button"
                    id={`cx-faq-q-${item.id}`}
                    aria-expanded={expanded}
                    aria-controls={`cx-faq-${item.id}`}
                    onClick={() =>
                      setOpen((current) => (expanded ? current.filter((id) => id !== item.id) : [...current, item.id]))
                    }
                  >
                    {item.question}
                    <Chevron open={expanded} />
                  </button>
                </h3>
                <div
                  className="cx-faq-region"
                  id={`cx-faq-${item.id}`}
                  ref={(element) => {
                    if (element) regions.current.set(item.id, element)
                  }}
                >
                  <div className="cx-faq-answer cx-prose">{item.answer}</div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function Tick() {
  return (
    <svg className="cx-tick" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.5 8.4 6.9 10.9 11.6 5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
function Check() {
  return (
    <svg viewBox="0 0 15.34 26" fill="none" aria-hidden="true">
      <path
        d="M2.3 14.5 6.4 19.2 13.6 9"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
function Chevron(props: { open: boolean }) {
  return (
    <svg className="cx-faq-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d={props.open ? "M1.4 14.4 8 7.8 14.6 14.4" : "M1.4 7.8 8 14.4 14.6 7.8"}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Legacy top-up links and intents never select a product or trigger checkout. */
export function codiumPlansUrl(href: string) {
  const url = new URL(href)
  url.searchParams.delete("type")
  return url
}

/** Authentication is read only after mounting; no account token is part of prerendered pricing props. */
async function currentAccount(): Promise<{ status: ModelPlanStatus | null; accessToken?: string }> {
  const { vectorAccountClient } = await import("../../../lib/account-client")
  const client = await vectorAccountClient()
  const result = await client.auth.getSession()
  if (result.error) throw result.error
  if (!result.data.session) return { status: null }
  const { fetchModelPlanAccount } = await import("../../../lib/model-plan-actions")
  return {
    status: await fetchModelPlanAccount(result.data.session.access_token),
    accessToken: result.data.session.access_token,
  }
}

async function checkoutDestination(id: string, resumed: boolean) {
  const { readAccountApiResponse, vectorAccountClient } = await import("../../../lib/account-client")
  const client = await vectorAccountClient()
  const session = await client.auth.getSession()
  if (session.error) throw session.error
  if (!session.data.session) {
    if (resumed) return
    try {
      sessionStorage.setItem(INTENT_KEY, `monthly ${id} ${Date.now()}`)
    } catch {
      /* Choose again if this tab cannot store an intent. */
    }
    const back = codiumPlansUrl(location.href)
    return `/login?returnTo=${encodeURIComponent(`${back.pathname}${back.search}`)}`
  }
  const response = await fetch("/api/model-plans/checkout", {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${session.data.session.access_token}`,
    },
    body: JSON.stringify({ plan: id }),
  })
  return modelPlanRedirect(
    await readAccountApiResponse(response, "Vector could not open checkout. Try again."),
    "checkout",
  )
}

function takeIntent() {
  try {
    const parts = (sessionStorage.getItem(INTENT_KEY) ?? "").split(" ")
    sessionStorage.removeItem(INTENT_KEY)
    const age = Date.now() - Number(parts[2])
    if (parts[0] !== "monthly" || !CodiumPlan.isPlanId(parts[1]) || !(age >= 0 && age < 30 * 60_000)) return
    return { id: parts[1] }
  } catch {
    return undefined
  }
}
