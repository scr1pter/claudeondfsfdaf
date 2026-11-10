const state = { ticket: null, editing: null, expanded: new Set(), processing: false, loadVersion: 0 }
const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node }
const error = (text) => { document.querySelector("#error").textContent = text; document.querySelector("#error").hidden = !text }

async function api(path, method = "GET", body) {
  const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || "Request failed.")
  return result
}

async function safely(operation) {
  error("")
  try { await operation() } catch (failure) { error(failure.message || "Request failed.") }
}

function control(name, identifier, operation) {
  const button = element("button", name)
  button.type = "button"
  button.setAttribute("aria-label", name + " " + identifier)
  button.onclick = () => safely(operation)
  return button
}

function renderDetails(message) {
  const region = element("div")
  region.id = "details-" + message.id
  region.hidden = !state.expanded.has(message.id)
  const values = [
    ["Message ID", message.id], ["Ticket", message.ticketId], ["Status", message.status],
    ["Attempt count", String(message.delivery?.attempts ?? 0)],
    ["Provider key", message.delivery?.idempotencyKey ?? "Not admitted"],
    ["Provider receipt", message.delivery?.receiptId ?? "Not confirmed"],
    ["Cancellation requested", message.delivery?.cancelRequested ? "Yes" : "No"],
  ]
  const details = element("dl")
  for (const [label, value] of values) details.append(element("dt", label), element("dd", value))
  if (message.delivery?.lastError) details.append(element("dt", "Delivery or cancellation note"), element("dd", message.delivery.lastError))
  region.append(details)
  return region
}

async function loadTicket(id) {
  state.ticket = id
  const version = ++state.loadVersion
  const result = await api("/api/tickets/" + id)
  if (version !== state.loadVersion || state.ticket !== id) return
  document.querySelector("#subject").textContent = result.ticket.subject
  document.querySelector("#summary").textContent = result.ticket.summary
  for (const button of document.querySelectorAll("#tickets button")) button.setAttribute("aria-current", button.dataset.ticket === id ? "true" : "false")
  const list = document.querySelector("#messages")
  list.replaceChildren()
  if (!result.messages.length) list.append(element("p", "No saved replies yet."))
  for (const message of result.messages) {
    const card = element("article")
    card.append(element("h3", "Reply " + message.id), element("p", message.body), element("p", "Status: " + message.status))
    if (message.delivery?.lastError) card.append(element("p", message.delivery.lastError))
    const actions = element("div")
    actions.className = "actions"
    if (message.status === "draft") {
      actions.append(control("Edit", message.id, async () => {
        state.editing = message.id
        document.querySelector("#reply").value = message.body
        document.querySelector("#editing").textContent = "Editing " + message.id
        document.querySelector("#reply").focus()
      }))
      actions.append(control("Queue", message.id, async () => {
        await api("/api/messages/" + message.id + "/send", "POST", { requestId: "admit-" + message.id })
        await loadTicket(id)
      }))
    }
    if (message.status === "retryable") actions.append(control("Retry", message.id, async () => {
      await api("/api/messages/" + message.id + "/retry", "POST", {})
      await loadTicket(id)
    }))
    if (["draft", "queued", "sending", "retryable"].includes(message.status)) actions.append(control("Cancel", message.id, async () => {
      await api("/api/messages/" + message.id + "/cancel", "POST", {})
      await loadTicket(id)
    }))
    const details = renderDetails(message)
    const toggle = control("Details", message.id, async () => {
      state.expanded.has(message.id) ? state.expanded.delete(message.id) : state.expanded.add(message.id)
      details.hidden = !state.expanded.has(message.id)
      toggle.setAttribute("aria-expanded", String(!details.hidden))
    })
    toggle.setAttribute("aria-controls", details.id)
    toggle.setAttribute("aria-expanded", String(!details.hidden))
    actions.append(toggle)
    card.append(actions, details)
    list.append(card)
  }
}

async function load() {
  const result = await api("/api/tickets")
  const nav = document.querySelector("#tickets")
  nav.replaceChildren()
  for (const ticket of result.tickets) {
    const button = element("button", ticket.subject)
    button.type = "button"
    button.dataset.ticket = ticket.id
    button.onclick = () => safely(async () => {
      if (state.ticket !== ticket.id) {
        state.editing = null
        document.querySelector("#editing").textContent = ""
        document.querySelector("#reply").value = ""
      }
      await loadTicket(ticket.id)
    })
    nav.append(button)
  }
  await loadTicket(state.ticket || result.tickets[0].id)
}

document.querySelector("#compose").onsubmit = (event) => {
  event.preventDefault()
  safely(async () => {
    if (!state.ticket) throw new Error("Select a ticket first.")
    const body = document.querySelector("#reply").value
    await api(state.editing ? "/api/messages/" + state.editing : "/api/tickets/" + state.ticket + "/messages", state.editing ? "PATCH" : "POST", { body })
    state.editing = null
    document.querySelector("#reply").value = ""
    document.querySelector("#editing").textContent = ""
    await loadTicket(state.ticket)
  })
}
document.querySelector("#refresh").onclick = () => safely(load)
document.querySelector("#process").onclick = () => {
  if (state.processing) return
  state.processing = true
  document.querySelector("#process").disabled = true
  document.querySelector("#activity").textContent = "Processing queue. You can refresh or cancel while waiting."
  error("")
  void api("/api/outbox/drain", "POST", {}).then(() => loadTicket(state.ticket)).catch((failure) => error(failure.message || "Queue processing failed.")).finally(() => {
    state.processing = false
    document.querySelector("#process").disabled = false
    document.querySelector("#activity").textContent = "Queue processing finished."
  })
  void loadTicket(state.ticket).catch((failure) => error(failure.message || "Refresh failed."))
}
safely(load)
