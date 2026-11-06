const state = { ticket: null, editing: null, drafts: new Map(), loading: 0 }
const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node }
const error = (text) => { document.querySelector("#error").textContent = text; document.querySelector("#error").hidden = !text }
async function api(path, method = "GET", body) {
  const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || "Request failed")
  return result
}
async function safely(operation) { error(""); try { await operation() } catch (failure) { error(failure.message || "Request failed") } }
function rememberComposer() {
  if (state.ticket) state.drafts.set(state.ticket, { body: document.querySelector("#reply").value, editing: state.editing })
}
function resetComposer() {
  state.editing = null
  document.querySelector("#reply").value = ""
  document.querySelector("#editing").textContent = ""
  rememberComposer()
}
function action(card, name, message, id, route, payload = {}) {
  const button = element("button", name + " " + message.id)
  button.onclick = () => safely(async () => {
    button.disabled = true
    try {
      const pending = api("/api/messages/" + message.id + "/" + route, "POST", payload)
      await Promise.all([pending, route === "cancel" ? loadTicket(id) : Promise.resolve()])
      if (state.editing === message.id) resetComposer()
      if (state.ticket === id) await loadTicket(id)
    } finally { button.disabled = false }
  })
  card.append(button)
}
async function loadTicket(id) {
  rememberComposer()
  if (id !== state.ticket) {
    const saved = state.drafts.get(id)
    state.editing = saved?.editing || null
    document.querySelector("#reply").value = saved?.body || ""
    document.querySelector("#editing").textContent = state.editing ? "Editing " + state.editing : ""
  }
  state.ticket = id
  for (const button of document.querySelectorAll("#tickets button")) button.setAttribute("aria-pressed", String(button.dataset.id === id))
  const loading = ++state.loading
  const result = await api("/api/tickets/" + id)
  if (loading !== state.loading) return
  document.querySelector("#subject").textContent = result.ticket.subject
  document.querySelector("#summary").textContent = result.ticket.summary
  const list = document.querySelector("#messages")
  const opened = new Set([...list.querySelectorAll("[data-detail-id][aria-expanded=true]")].map((button) => button.dataset.detailId))
  list.replaceChildren()
  for (const message of result.messages) {
    const card = element("article")
    card.dataset.status = message.status
    const body = element("p", message.body)
    body.className = "message-body"
    const status = element("p", "Status: " + message.status)
    status.className = "status"
    card.append(body, status)
    if (message.delivery?.lastError) { const explanation = element("p", message.delivery.lastError); explanation.className = "delivery-error"; card.append(explanation) }
    if (message.status === "draft") {
      const edit = element("button", "Edit " + message.id)
      edit.onclick = () => { state.editing = message.id; document.querySelector("#reply").value = message.body; document.querySelector("#editing").textContent = "Editing " + message.id; document.querySelector("#reply").focus(); rememberComposer() }
      card.append(edit)
      action(card, "Queue", message, id, "send", { requestId: "queue-" + message.id })
    }
    if (message.status === "retryable") action(card, "Retry", message, id, "retry")
    if (!["delivered", "cancelled"].includes(message.status)) action(card, "Cancel", message, id, "cancel")
    const details = element("div")
    details.id = "details-" + message.id
    details.hidden = !opened.has(message.id)
    const toggle = element("button", "Details " + message.id)
    toggle.dataset.detailId = message.id
    toggle.setAttribute("aria-controls", details.id)
    toggle.setAttribute("aria-expanded", String(!details.hidden))
    toggle.onclick = () => { details.hidden = !details.hidden; toggle.setAttribute("aria-expanded", String(!details.hidden)) }
    details.append(element("p", "Message ID: " + message.id), element("p", "Status: " + message.status), element("p", "Attempts: " + (message.delivery?.attempts ?? 0)))
    if (message.delivery) {
      details.append(element("p", "Idempotency key: " + message.delivery.idempotencyKey), element("p", "Provider receipt: " + (message.delivery.receiptId ?? "Not confirmed")), element("p", "Cancellation requested: " + (message.delivery.cancelRequested ? "yes" : "no")))
      if (message.delivery.lastError) details.append(element("p", message.delivery.lastError))
    }
    card.append(toggle, details)
    list.append(card)
  }
}
async function load() {
  const result = await api("/api/tickets")
  const nav = document.querySelector("#tickets")
  nav.replaceChildren()
  for (const ticket of result.tickets) {
    const button = element("button", ticket.subject)
    button.dataset.id = ticket.id
    button.onclick = () => safely(() => loadTicket(ticket.id))
    nav.append(button)
  }
  await loadTicket(state.ticket || result.tickets[0].id)
}
document.querySelector("#compose").onsubmit = (event) => {
  event.preventDefault()
  safely(async () => {
    if (!state.ticket) throw new Error("Select a ticket first")
    const ticket = state.ticket
    const editing = state.editing
    const body = document.querySelector("#reply").value
    const button = event.submitter
    button.disabled = true
    try {
      await api(editing ? "/api/messages/" + editing : "/api/tickets/" + ticket + "/messages", editing ? "PATCH" : "POST", { body })
      state.drafts.delete(ticket)
      if (state.ticket === ticket && state.editing === editing && document.querySelector("#reply").value === body) resetComposer()
      if (state.ticket === ticket) await loadTicket(ticket)
    } finally { button.disabled = false }
  })
}
document.querySelector("#process").onclick = () => safely(async () => {
  const button = document.querySelector("#process")
  button.disabled = true
  document.querySelector("#processing").textContent = "Processing queue..."
  try {
    const pending = api("/api/outbox/drain", "POST", {})
    const [result] = await Promise.all([pending, loadTicket(state.ticket)])
    await loadTicket(state.ticket)
    document.querySelector("#processing").textContent = "Queue settled: " + result.processed.length + " attempted."
  } finally { button.disabled = false; if (document.querySelector("#processing").textContent === "Processing queue...") document.querySelector("#processing").textContent = "Queue processing interrupted. Refresh to check durable state." }
})
document.querySelector("#refresh").onclick = () => safely(load)
safely(load)
