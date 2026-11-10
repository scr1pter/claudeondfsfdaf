const state = { ticket: null, editing: null, expanded: new Set(), composers: new Map(), view: 0 }
const $ = (selector) => document.querySelector(selector)
const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node }
const error = (text) => { $("#error").textContent = text; $("#error").hidden = !text }
async function api(path, method = "GET", body) {
  const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || "Request failed")
  return result
}
async function safely(operation) { error(""); try { await operation() } catch (failure) { error(failure.message || "Request failed") } }
function action(card, label, operation) {
  const button = element("button", label)
  button.onclick = () => safely(async () => {
    button.disabled = true
    try { await operation(); await refresh() } finally { button.disabled = false }
  })
  card.append(button)
}
function showMessage(message) {
  const card = element("article")
  card.dataset.status = message.status
  const body = element("p", message.body)
  body.className = "message-body"
  const status = element("p", "Status: " + message.status)
  status.className = "status"
  card.append(body, status)
  if (message.delivery?.cancelRequested) {
    card.append(element("p", message.status === "cancelled" ? "Cancellation confirmed. No delivery will occur." : message.status === "delivered" ? "Cancellation was too late. Delivery is confirmed." : "Cancellation requested. Provider outcome is unresolved."))
  }
  if (message.delivery?.lastError) {
    const note = element("p", message.delivery.lastError)
    note.className = "delivery-error"
    card.append(note)
  }
  const controls = element("div")
  controls.className = "message-actions"
  if (message.status === "draft") {
    action(controls, "Edit " + message.id, async () => {
      state.editing = message.id
      $("#reply").value = message.body
      $("#editing").textContent = "Editing " + message.id
      $("#reply").focus()
    })
    // A stable admission ID also makes a repeat after a lost HTTP response safe.
    action(controls, "Queue " + message.id, () => api("/api/messages/" + message.id + "/send", "POST", { requestId: "queue_" + message.id }))
  }
  if (message.status === "retryable") action(controls, "Retry " + message.id, () => api("/api/messages/" + message.id + "/retry", "POST", {}))
  if (!["delivered", "cancelled"].includes(message.status)) action(controls, "Cancel " + message.id, () => api("/api/messages/" + message.id + "/cancel", "POST", {}))
  card.append(controls)
  const details = element("div")
  const toggle = element("button", "Details " + message.id)
  toggle.setAttribute("aria-expanded", String(state.expanded.has(message.id)))
  toggle.setAttribute("aria-controls", "details-" + message.id)
  details.append(toggle)
  const fields = element("dl")
  fields.id = "details-" + message.id
  fields.hidden = !state.expanded.has(message.id)
  toggle.onclick = () => {
    fields.hidden = !fields.hidden
    toggle.setAttribute("aria-expanded", String(!fields.hidden))
    if (fields.hidden) state.expanded.delete(message.id)
    else state.expanded.add(message.id)
  }
  for (const [name, value] of [
    ["Message ID", message.id], ["Status", message.status],
    ["Attempt count", message.delivery?.attempts ?? 0],
    ["Provider key", message.delivery?.idempotencyKey ?? "Not admitted"],
    ["Provider receipt", message.delivery?.receiptId ?? "None confirmed"],
    ["Cancellation requested", message.delivery?.cancelRequested ? "Yes" : "No"],
    ["Last error", message.delivery?.lastError ?? "None"],
  ]) fields.append(element("dt", name), element("dd", String(value)))
  details.append(fields)
  card.append(details)
  return card
}
async function loadTicket(id) {
  if (state.ticket !== id) {
    if (state.ticket) state.composers.set(state.ticket, { body: $("#reply").value, editing: state.editing })
    const composer = state.composers.get(id)
    state.editing = composer?.editing ?? null
    $("#reply").value = composer?.body ?? ""
    $("#editing").textContent = state.editing ? "Editing " + state.editing : ""
  }
  state.ticket = id
  const view = ++state.view
  const result = await api("/api/tickets/" + id)
  if (view !== state.view) return
  $("#subject").textContent = result.ticket.subject
  $("#summary").textContent = result.ticket.summary
  $("#customer").textContent = result.ticket.customer
  for (const button of $("#tickets").children) button.setAttribute("aria-pressed", String(button.dataset.id === id))
  $("#messages").replaceChildren(...result.messages.map(showMessage))
  $("#empty").hidden = result.messages.length > 0
}
async function refresh() {
  await loadTicket(state.ticket)
  const { items } = await api("/api/outbox")
  const pending = items.filter(item => !["delivered", "cancelled"].includes(item.status)).length
  $("#queue-status").textContent = `${pending} pending · ${items.filter(item => item.status === "delivered").length} delivered · ${items.filter(item => item.status === "cancelled").length} cancelled`
}
async function load() {
  const { tickets } = await api("/api/tickets")
  $("#tickets").replaceChildren()
  for (const ticket of tickets) {
    const button = element("button", ticket.subject)
    button.dataset.id = ticket.id
    button.onclick = () => safely(async () => { await loadTicket(ticket.id); await refresh() })
    $("#tickets").append(button)
  }
  await loadTicket(state.ticket || tickets[0].id)
  await refresh()
}
$("#compose").onsubmit = (event) => {
  event.preventDefault()
  safely(async () => {
    if (!state.ticket) throw new Error("Select a ticket first")
    const ticket = state.ticket
    const body = $("#reply").value
    const editing = state.editing
    $("#save").disabled = true
    try {
      await api(editing ? "/api/messages/" + editing : "/api/tickets/" + ticket + "/messages", editing ? "PATCH" : "POST", { body })
      state.composers.delete(ticket)
      if (state.ticket === ticket && $("#reply").value === body && state.editing === editing) {
        state.editing = null
        $("#reply").value = ""
        $("#editing").textContent = ""
      }
      await refresh()
    } finally { $("#save").disabled = false }
  })
}
$("#refresh").onclick = () => safely(refresh)
$("#process").onclick = () => safely(async () => {
  $("#process").disabled = true
  $("#processing").textContent = "Processing queue… You can refresh or request cancellation while an attempt is pending."
  try {
    const result = await api("/api/outbox/drain", "POST", {})
    $("#processing").textContent = `Queue pass complete: ${result.processed.length} message(s) processed.`
    await refresh()
  } finally { $("#process").disabled = false }
})
safely(load)
