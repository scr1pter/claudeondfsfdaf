/** @jsxImportSource react */
import React from "react"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import type { CodiumOffer, CodiumPricingView } from "../../../lib/codium-pricing"
import { modelPlanRedirect } from "../../../lib/model-plans"
import "./codium-pricing.css"

export type CodiumMode = "monthly" | "topup"

const INTENT_KEY = "vector-codium-intent"
const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
const range = (tasks: readonly [number, number]) => `${count.format(tasks[0])}–${count.format(tasks[1])}`
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const MODES = [
  { mode: "monthly", label: "Individual" },
  { mode: "topup", label: "Top-ups" },
] as const
// The plan marked "Most popular", by position: the second of the four.
const POPULAR = 1
// The four plans, cheapest first, as the plan question describes them.
const [STARTER, REGULAR, DAILY, HEAVY] = CodiumPlan.PLANS
// Plans differ only in usage. What they share is listed once, on the cards with room for it, under labels that say
// it applies to every plan; the list lengths follow the reference layout's cards.
const EVERY_PLAN = [
  "Zero-data-retention endpoints",
  "No provider keys needed",
  "Works in the desktop app and CLI",
  "No overage charges",
]
const WORKSPACE = [
  "Parallel agents",
  "Subagents",
  "Vectorscope code reviews",
  "Multiplayer sessions",
  "Browser agent",
  "Automations",
  "Run Guard",
]
// The renewal terms sit in every plan card. The shorter one keeps to one line on the narrowest cards.
const RENEWS = "*Renews monthly until you cancel."
const RENEWS_RESET = "*Renews monthly until you cancel. Credits reset each billing period."

/**
 * Codium's plan toggle, cards, the note under them and the plan comparison on /codium. Purchases go through the
 * account's checkout.
 */
export function CodiumPricing(props: { pricing: CodiumPricingView; mode?: CodiumMode }) {
  const [mode, setMode] = React.useState<CodiumMode>(
    props.pricing.topups.length ? (props.mode ?? "monthly") : "monthly",
  )
  const [pending, setPending] = React.useState<{ id: string; signIn?: boolean }>()
  const [failure, setFailure] = React.useState<{ id: string; message: string }>()
  const [pack, setPack] = React.useState(0)
  const models = props.pricing.models
  const plans = props.pricing.monthly
  const topups = props.pricing.topups

  const choose = (next: CodiumMode) => {
    if (next === mode) return
    setMode(next)
    document.documentElement.dataset.codiumMode = next
    history.pushState(history.state, "", codiumModeUrl(location.href, next))
  }

  const buy = (offer: CodiumOffer, kind: CodiumMode, resumed = false) => {
    if (!offer.available || pending) return
    setPending({ id: offer.id })
    setFailure(undefined)
    void checkoutDestination(offer.id, kind, resumed)
      .then((destination) => {
        if (!destination) return setPending(undefined)
        setPending({ id: offer.id, signIn: destination.startsWith("/login") })
        location.assign(destination)
      })
      .catch((cause) => {
        setPending(undefined)
        setFailure({
          id: offer.id,
          message: cause instanceof Error ? cause.message : "Vector could not open checkout. Try again.",
        })
      })
  }

  // The tab lives in the address (?type=topups), so a shared link, a reload and the back button all restore it.
  React.useEffect(() => {
    const restore = () => {
      const next = topups.length ? codiumMode(location.search) : "monthly"
      setMode(next)
      document.documentElement.dataset.codiumMode = next
    }
    restore()
    addEventListener("popstate", restore)
    return () => removeEventListener("popstate", restore)
  }, [])

  // A purchase started before sign-in continues once the buyer is back from signing in.
  React.useEffect(() => {
    const intent = takeIntent()
    const offer = intent && (intent.mode === "monthly" ? plans : topups).find((item) => item.id === intent.id)
    if (!intent || !offer) return
    if (intent.mode === "topup") setPack(topups.indexOf(offer))
    setMode(intent.mode)
    document.documentElement.dataset.codiumMode = intent.mode
    buy(offer, intent.mode, true)
  }, [])

  // Returning with the back button restores this page from the cache, still marked as opening. The mount effect above
  // doesn't run again, so a purchase saved before an abandoned sign-in is dropped here; otherwise a later visit to
  // this page would open its checkout without a new click.
  React.useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      setPending(undefined)
      takeIntent()
    }
    addEventListener("pageshow", restore)
    return () => removeEventListener("pageshow", restore)
  }, [])

  const button = (offer: CodiumOffer, kind: CodiumMode, primary: boolean, small = false) => (
    <button
      className={`cx-btn${primary ? "" : " cx-btn--secondary"}${small ? " cx-btn--sm" : ""}`}
      type="button"
      disabled={!offer.available || pending !== undefined}
      onClick={() => buy(offer, kind)}
    >
      {!offer.available
        ? "Coming soon"
        : pending?.id === offer.id
          ? pending.signIn
            ? "Signing in…"
            : "Opening checkout…"
          : `${kind === "monthly" ? "Get" : "Buy"} ${offer.name}`}
    </button>
  )

  const rows = [
    {
      group: "Models",
      icon: ModelsIcon,
      // The catalog lists the default model first.
      rows: models.map((model, index) => ({
        label: index === 0 ? `${model.name} (default)` : model.name,
        values: plans.map(() => true as const),
      })),
    },
    ...(plans.some((offer) => offer.tasks.some(Boolean))
      ? [
          {
            group: "Typical tasks a month",
            icon: TasksIcon,
            rows: models.map((model, row) => ({
              label: model.name,
              values: plans.map((offer) => {
                const tasks = offer.tasks[row]
                return tasks ? range(tasks) : (false as const)
              }),
            })),
          },
        ]
      : []),
    {
      group: "Credits",
      icon: CreditsIcon,
      rows: [
        "No provider keys needed",
        "No overage charges",
        "Monthly plans only",
        "Balance in Settings and your account",
        "Cancel any time",
      ].map((label) => ({ label, values: plans.map(() => true as const) })),
    },
    {
      group: "Included in the free Vector workspace",
      icon: WorkspaceIcon,
      rows: [
        "Desktop app and CLI",
        "Parallel agents",
        "Subagents",
        "Vectorscope code reviews",
        "Multiplayer sessions",
        "Vector Cloud",
        "Browser agent",
        "Skills and commands",
        "MCP servers and plugins",
        "Automations",
        "Checkpoints",
        "Run Guard",
        "Free models inside of Vector",
        "Any provider with your own key",
      ].map((label) => ({ label, values: plans.map(() => true as const) })),
    },
  ]

  // One card in the reference's anatomy: name, price, button, lead line, usage, feature lists and a footnote.
  const card = (content: {
    key: string
    name: string
    picker?: React.ReactNode
    badge?: boolean
    price: string
    per?: string
    action: React.ReactNode
    offer?: string
    lead: string
    big: string
    small: string
    groups: { label?: string; icon?: () => React.ReactNode; items: string[] }[]
    footnote: string
  }) => (
    <article className="cx-card" key={content.key}>
      <div className="cx-card-inner">
        <div className="cx-card-head">
          <h3 className="cx-type-md">{content.name}</h3>
          {content.badge && <span className="cx-badge cx-type-xs">Most popular</span>}
          {content.picker}
        </div>
        <p className="cx-price">
          <span className="cx-amount cx-type-lg">{content.price}</span>
          {content.per && <span className="cx-per">{content.per}</span>}
        </p>
        <div className="cx-card-buy">
          {content.action}
          {failure && failure.id === content.offer && (
            <p className="cx-error cx-type-xs" role="alert">
              {failure.message} <a href="/account">Open your account</a>
            </p>
          )}
        </div>
        <p className="cx-lead cx-type-sm">{content.lead}</p>
        <div className="cx-usage">
          <p className="cx-type-md">{content.big}</p>
          <p className="cx-type-sm">{content.small}</p>
        </div>
        {content.groups.map((group, index) => (
          <div className="cx-group" key={group.label ?? index}>
            {group.label ? (
              <p className="cx-group-label cx-type-sm">
                {group.icon && <group.icon />}
                {group.label}
              </p>
            ) : (
              <hr className="cx-divider" />
            )}
            <ul className="cx-list cx-type-sm">
              {group.items.map((feature) => (
                <li key={feature}>
                  <Tick />
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="cx-footnote cx-type-xs">{content.footnote}</p>
      </div>
    </article>
  )

  const topup = topups[pack] ?? topups[0]
  const multiples = plans.flatMap((plan) => (plan.multiple ? [plan.multiple] : []))

  return (
    <React.Fragment>
      {topups.length > 0 && (
        <div className="cx-toggle-wrap">
          <Segmented
            className="cx-toggle"
            label="Plan type"
            name="cx-plan-type"
            options={MODES.map((item) => ({ value: item.mode, label: item.label }))}
            value={mode}
            onChange={choose}
          />
        </div>
      )}

      <div className="cx-plans">
        <div className="cx-panel" data-mode="monthly">
          <h2 className="cx-visually-hidden">Codium plans</h2>
          <div className="cx-cards">
            {plans.map((offer, index) =>
              card({
                key: offer.id,
                name: offer.name,
                badge: index === POPULAR,
                price: usd.format(offer.price),
                per: "/month",
                action: button(offer, "monthly", index === POPULAR),
                offer: offer.id,
                lead: index === 0 ? "Get started with:" : `Everything in ${plans[index - 1]!.name}, and:`,
                big: index === 0 || !offer.multiple ? "Codium credits" : `${count.format(offer.multiple)}x`,
                small: index === 0 ? "for every Codium model, every month" : `more usage than ${plans[0]!.name}`,
                // Later plans differ only in credits, stated as a multiple of the first so they never read as adding up,
                // and in the usage those credits buy on each model. Credit amounts never appear.
                groups: planGroups(index, taskLines(offer, models)),
                footnote: index < 2 ? RENEWS : RENEWS_RESET,
              }),
            )}
          </div>
        </div>

        {topup && (
          <div className="cx-panel" data-mode="topup">
            <h2 className="cx-visually-hidden">Codium top-ups</h2>
            <div className="cx-cards cx-cards--pair">
              {card({
                key: "topup",
                name: "Top-up",
                picker: (
                  <Segmented
                    className="cx-picker"
                    label="Top-up amount"
                    name="cx-topup"
                    options={topups.map((item, index) => ({
                      value: String(index),
                      label: usd.format(item.price),
                      // The top-up's name, as checkout gives it, starts with the visible amount.
                      title: item.name,
                    }))}
                    value={String(pack)}
                    onChange={(value) => setPack(Number(value))}
                  />
                ),
                price: usd.format(topup.price),
                per: "one-time",
                action: button(topup, "topup", true),
                offer: topup.id,
                lead: "For when credits run low:",
                big: topup === topups[0] || !topup.multiple ? "Codium credits" : `${count.format(topup.multiple)}x`,
                small:
                  topup === topups[0]
                    ? "that carry forward, with no subscription"
                    : `more usage than the ${topups[0]!.name}`,
                groups: [
                  {
                    items: [
                      ...taskLines(topup, models).map((line) => `${line} tasks`),
                      "Zero-data-retention endpoints",
                      "No subscription needed",
                      "Unused credits carry forward",
                      "Spent after a plan's monthly credits",
                      "Balance in Vector's Settings and your account page",
                      "Works in the desktop app and CLI",
                      "No provider keys needed",
                      "No overage charges or automatic top-ups",
                    ],
                  },
                ],
                // Names the chosen top-up as checkout and the account page do, such as "$10 credit top-up".
                footnote: `*${topup.name}: one-time purchase. Typical tasks estimated.`,
              })}
              {plans.length > 0 &&
                card({
                  key: "plans",
                  name: "Monthly plans",
                  price:
                    plans.length > 1
                      ? `${usd.format(plans[0]!.price)}–${usd.format(plans.at(-1)!.price)}`
                      : usd.format(plans[0]!.price),
                  per: "/month",
                  action: (
                    <button
                      className="cx-btn cx-btn--secondary"
                      type="button"
                      onClick={() => {
                        choose("monthly")
                        // This button disappears with its tab, so focus moves to the plan type it switched to.
                        document.querySelector<HTMLInputElement>('input[name="cx-plan-type"][value="monthly"]')?.focus()
                      }}
                    >
                      Compare plans
                    </button>
                  ),
                  lead: "Everything in a top-up, and:",
                  big: "Monthly",
                  small: "credits that renew each billing period",
                  groups: [
                    {
                      items: [
                        `Plans from ${plans[0]!.name} to ${plans.at(-1)!.name}`,
                        ...(multiples.length > 0
                          ? [`Up to ${count.format(Math.max(...multiples))}x the usage of ${plans[0]!.name}`]
                          : []),
                        "Credits reset each billing period",
                        "Spent before top-up credits",
                        "Renews monthly until you cancel",
                        "Access lasts the paid period after cancelling",
                        "Top up whenever credits run low",
                        "No overage charges or automatic top-ups",
                      ],
                    },
                  ],
                  footnote: "*Plans renew monthly at the listed price until you cancel.",
                })}
            </div>
          </div>
        )}
        <p className="cx-note cx-type-xs">
          Any applicable taxes are shown before payment. Plans renew monthly at the listed price until you cancel, and
          monthly credits reset each billing period. Typical tasks are estimates, not commitments. See the{" "}
          <a href="/legal/terms#codium">Codium terms</a>.
        </p>
      </div>

      {plans.length > 0 && (
        <section className="cx-compare" aria-labelledby="cx-compare-heading">
          <h2 className="cx-type-lg" id="cx-compare-heading">
            Compare features across plans
          </h2>
          {/* Below 1140px the table scrolls sideways, so keyboard users can focus and scroll it. */}
          <div className="cx-compare-scroll" role="region" aria-labelledby="cx-compare-heading" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="cx-visually-hidden">Feature</span>
                  </th>
                  {plans.map((offer, index) => (
                    <th scope="col" key={offer.id}>
                      <div className="cx-compare-plan">
                        <div>
                          <p className="cx-type-sm">{offer.name}</p>
                          <p className="cx-compare-price cx-type-xs">
                            {usd.format(offer.price)}
                            <span>/month</span>
                          </p>
                        </div>
                        {button(offer, "monthly", index === POPULAR, true)}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="cx-type-sm">
                <tr>
                  <th scope="row">Usage</th>
                  {plans.map((offer, index) => (
                    <td key={offer.id}>
                      <span className="cx-compare-text">
                        {index === 0 || !offer.multiple ? "Base" : `${count.format(offer.multiple)}x ${plans[0]!.name}`}
                      </span>
                    </td>
                  ))}
                </tr>
              </tbody>
              {rows.map((group) => (
                <tbody className="cx-type-sm" key={group.group}>
                  <tr>
                    <th className="cx-compare-group" colSpan={plans.length + 1} scope="rowgroup">
                      <div>
                        <group.icon />
                        {group.group}
                      </div>
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
      )}
    </React.Fragment>
  )
}

/** "Questions & Answers": independent toggles that open and close at once, all closed at first. */
export function CodiumQuestions(props: { models: CodiumPricingView["models"] }) {
  const [open, setOpen] = React.useState<string[]>([])
  const [ready, setReady] = React.useState(false)
  const regions = React.useRef(new Map<string, HTMLDivElement>())
  const names = (category: "everyday" | "advanced") =>
    new Intl.ListFormat("en-US", { type: "disjunction" }).format(
      props.models.filter((model) => model.category === category).map((model) => model.name),
    )

  // Closed answers are hidden "until found", so find in page still reaches them and opens their question. React
  // can't render that value, so the attribute is kept here.
  React.useEffect(() => {
    regions.current.forEach((region, id) => {
      if (open.includes(id)) region.removeAttribute("hidden")
      if (!open.includes(id)) region.setAttribute("hidden", "until-found")
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
          Start with {STARTER.name} to try Codium on everyday coding. {REGULAR.name} suits coding with agents most days,{" "}
          {DAILY.name} daily agent work across repositories, and {HEAVY.name} long sessions with parallel agents.
        </p>
      ),
    },
    {
      id: "need",
      question: "Do I need Codium to use Vector?",
      answer: (
        <p>
          No. Vector is free to download and use with your own provider keys or the free models inside Vector. Codium is
          optional: it adds low-cost coding models you pay for with credits, without setting up a provider account.
        </p>
      ),
    },
    {
      id: "credits",
      question: "How do Codium credits work?",
      answer: (
        <p>
          Each monthly plan includes Codium credits. Each request spends credits for the tokens it actually uses with
          the model you picked: input, output and reasoning all count, and cached input costs less. Monthly credits
          reset when each billing period ends. Credits from a refunded or disputed payment are removed.
        </p>
      ),
    },
    {
      id: "run-out",
      question: "What happens when my credits run out?",
      answer: (
        <p>
          Before each Codium request, Vector checks that your credits can cover it. When they can't, Codium requests
          pause: there are no overage charges and no top-ups. Wait for your plan to renew, or keep working with your own
          provider keys or free models. The Vector workspace keeps working either way.
        </p>
      ),
    },
    {
      id: "models",
      question: "Which models are included, and where do my requests go?",
      answer: (
        <React.Fragment>
          <p>
            Every plan includes the same {props.models.length} coding models.
            {props.models[0] && ` ${props.models[0].name} is the recommended default; you choose which model to use.`}
            {names("advanced") && " The advanced models use credits faster."}
          </p>
          <ul>
            {props.models.map((model) => (
              <li key={model.id}>
                <strong>{model.name}</strong>
                {model.description && ` · ${model.description}`}
              </li>
            ))}
          </ul>
          <p>
            Codium requests, including the code and tool output a task sends, go through Vector and OpenRouter to a
            provider serving the model you picked. Vector routes them only to zero-data-retention endpoints that
            OpenRouter lists as not storing or collecting request data. OpenRouter still screens requests for child
            sexual abuse material and keeps request metadata, and some providers hold a short-lived prompt cache. Review
            the <a href="/legal/privacy#codium">privacy policy</a> before sending code.
          </p>
        </React.Fragment>
      ),
    },
    {
      id: "taxes",
      question: "Are prices inclusive of taxes?",
      answer: <p>Prices are in US dollars. Any applicable taxes and the total you pay are shown before payment.</p>,
    },
    {
      id: "balance",
      question: "Where can I see my balance?",
      answer: (
        <p>
          In Vector's Settings, and on your <a href="/account">account page</a> while you're signed in. Your monthly
          balance can lag behind requests that are still finishing.
        </p>
      ),
    },
    {
      id: "last-longer",
      question: "How can I make my credits last longer?",
      answer: (
        <p>
          {names("everyday") && names("advanced")
            ? `Use ${names("everyday")} for routine work and save ${names("advanced")} for hard problems. `
            : ""}
          Start a new session for each new task so the model doesn't keep re-reading old context, point agents at the
          files that matter, and run fewer agents in parallel. Requests through your own provider keys or free models
          don't use credits at all.
        </p>
      ),
    },
    {
      id: "cancel",
      question: "Can I cancel any time?",
      answer: (
        <p>
          Yes. Cancel through your account's billing before renewal. Cancelling stops future renewals and keeps your
          access for the rest of the paid period. Monthly credits end with that period.
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
                    onClick={() => setOpen(expanded ? open.filter((id) => id !== item.id) : [...open, item.id])}
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

/**
 * A pill-shaped radio group whose fill slides to the chosen option. The fill is measured from the chosen label, again
 * whenever the labels resize: when the font loads, or the root size changes at 900px.
 */
function Segmented<T extends string>(props: {
  className: string
  label: string
  name: string
  options: readonly { value: T; label: string; title?: string }[]
  value: T
  onChange: (value: T) => void
}) {
  const track = React.useRef<HTMLFieldSetElement>(null)
  const [indicator, setIndicator] = React.useState<{ left: number; width: number }>()

  React.useLayoutEffect(() => {
    const element = track.current
    if (!element) return
    const measure = () => {
      const label = element.querySelector<HTMLElement>(`label[data-value="${props.value}"]`)
      if (label) setIndicator({ left: label.offsetLeft, width: label.offsetWidth })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [props.value])

  return (
    <fieldset
      className={`cx-seg ${props.className}`}
      aria-label={props.label}
      ref={track}
      data-ready={indicator ? "" : undefined}
    >
      {indicator && (
        <div className="cx-seg-indicator" aria-hidden="true" style={{ left: indicator.left, width: indicator.width }} />
      )}
      {props.options.map((option) => (
        <label key={option.value} data-value={option.value}>
          <input
            type="radio"
            name={props.name}
            value={option.value}
            checked={props.value === option.value}
            aria-label={option.title}
            onChange={() => props.onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

/** Each model's reviewed range of typical tasks, in catalog order. */
function taskLines(offer: CodiumOffer, models: CodiumPricingView["models"]) {
  return models.flatMap((model, row) => {
    const tasks = offer.tasks[row]
    return tasks ? [`${model.name}: ${range(tasks)}`] : []
  })
}

/**
 * A monthly plan card's lists. The first card shows only its usage; the second and third also carry what every plan
 * shares, so the cards keep the reference layout's list lengths: the first is shortest and the third tallest.
 */
function planGroups(index: number, tasks: string[]) {
  const usage = { label: "Typical tasks a month", items: tasks }
  const groups =
    index === 1
      ? [usage, { label: "Every plan includes", icon: WorkspaceIcon, items: EVERY_PLAN }]
      : index === 2
        ? [
            { label: "In the free Vector workspace", items: WORKSPACE },
            { ...usage, icon: TasksIcon },
          ]
        : [usage]
  return groups.filter((group) => group.items.length > 0)
}

/** A card list tick: a thin check centred in a 16px box. */
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

/** The comparison table's check, drawn in the advance box of a 22px text glyph. */
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

/** The comparison table's and the cards' group marks: flat, filled 16px shapes in the text colour. */
function ModelsIcon() {
  return (
    <svg className="cx-group-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M5.3 3h5.4A2.3 2.3 0 0 1 13 5.3v5.4a2.3 2.3 0 0 1-2.3 2.3H5.3A2.3 2.3 0 0 1 3 10.7V5.3A2.3 2.3 0 0 1 5.3 3zm1.2 3.4a.1.1 0 0 0-.1.1v3a.1.1 0 0 0 .1.1h3a.1.1 0 0 0 .1-.1v-3a.1.1 0 0 0-.1-.1zM5.2 0h1.1v2.2H5.2zm2.25 0h1.1v2.2h-1.1zM9.7 0h1.1v2.2H9.7zM5.2 13.8h1.1V16H5.2zm2.25 0h1.1V16h-1.1zm2.25 0h1.1V16H9.7zM0 5.2h2.2v1.1H0zm0 2.25h2.2v1.1H0zM0 9.7h2.2v1.1H0zm13.8-4.5H16v1.1h-2.2zm0 2.25H16v1.1h-2.2zm0 2.25H16v1.1h-2.2z"
      />
    </svg>
  )
}

function TasksIcon() {
  return (
    <svg className="cx-group-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="1.5" y="8.5" width="3.5" height="6" rx="1" />
      <rect x="6.25" y="4.75" width="3.5" height="9.75" rx="1" />
      <rect x="11" y="1.5" width="3.5" height="13" rx="1" />
    </svg>
  )
}

function CreditsIcon() {
  return (
    <svg className="cx-group-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 2.1a4.9 4.9 0 1 0 0 9.8 4.9 4.9 0 0 0 0-9.8zM8 4.6a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8z"
      />
    </svg>
  )
}

function WorkspaceIcon() {
  return (
    <svg className="cx-group-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="1.5" y="1.5" width="5.75" height="5.75" rx="1.25" />
      <rect x="8.75" y="1.5" width="5.75" height="5.75" rx="1.25" />
      <rect x="1.5" y="8.75" width="5.75" height="5.75" rx="1.25" />
      <rect x="8.75" y="8.75" width="5.75" height="5.75" rx="1.25" />
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

/** The tab a /codium address selects: `?type=topups` shows the one-time packs, anything else the monthly plans. */
export function codiumMode(search: string): CodiumMode {
  return new URLSearchParams(search).get("type") === "topups" ? "topup" : "monthly"
}

/** The same address with a tab selected, keeping the rest of its query and its hash. */
export function codiumModeUrl(href: string, mode: CodiumMode) {
  const url = new URL(href)
  if (mode === "topup") url.searchParams.set("type", "topups")
  if (mode === "monthly") url.searchParams.delete("type")
  return url
}

/** Where a purchase continues: the sign-in page for a signed-out visitor, or the plan's checkout session. */
async function checkoutDestination(id: string, mode: CodiumMode, resumed: boolean) {
  const { readAccountApiResponse, vectorAccountClient } = await import("../../../lib/account-client")
  const client = await vectorAccountClient()
  const session = await client.auth.getSession()
  if (session.error) throw session.error
  if (!session.data.session) {
    // Coming back from an abandoned sign-in must not send the buyer straight back to it.
    if (resumed) return
    try {
      sessionStorage.setItem(INTENT_KEY, `${mode} ${id} ${Date.now()}`)
    } catch {
      // Without storage, the buyer chooses the plan again after signing in.
    }
    const back = codiumModeUrl(location.href, mode)
    return `/login?returnTo=${encodeURIComponent(`${back.pathname}${back.search}`)}`
  }
  const kind = mode === "monthly" ? "checkout" : "topup"
  const response = await fetch(`/api/model-plans/${kind}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${session.data.session.access_token}`,
    },
    body: JSON.stringify(kind === "checkout" ? { plan: id } : { pack: id }),
  })
  return modelPlanRedirect(await readAccountApiResponse(response, "Vector could not open checkout. Try again."), kind)
}

/** Read once. Only a click in this tab can leave an intent, so a link can never start a checkout. */
function takeIntent() {
  try {
    const parts = (sessionStorage.getItem(INTENT_KEY) ?? "").split(" ")
    sessionStorage.removeItem(INTENT_KEY)
    const mode = (["monthly", "topup"] as const).find((value) => value === parts[0])
    const age = Date.now() - Number(parts[2])
    if (!mode || !parts[1] || !(age >= 0 && age < 30 * 60_000)) return
    return { mode, id: parts[1] }
  } catch {
    return undefined
  }
}
