const state = { ticket: null, editing: null }
const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node }
const error = (text) => { document.querySelector("#error").textContent = text; document.querySelector("#error").hidden = !text }
async function api(path, method = "GET", body) {
  const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || "Request failed")
  return result
}
async function safely(operation) { error(""); try { await operation() } catch (failure) { error(failure.message || "Request failed") } }
async function loadTicket(id) {
  state.ticket = id
  const result = await api("/api/tickets/" + id)
  document.querySelector("#subject").textContent = result.ticket.subject
  document.querySelector("#summary").textContent = result.ticket.summary
  const list = document.querySelector("#messages")
  list.replaceChildren()
  for (const message of result.messages) {
    const card = element("article")
    card.append(element("p", message.body), element("p", "Status: " + message.status))
    if (message.status === "draft") {
      const edit = element("button", "Edit " + message.id)
      edit.onclick = () => { state.editing = message.id; document.querySelector("#reply").value = message.body; document.querySelector("#editing").textContent = "Editing " + message.id }
      card.append(edit)
    }
    if (["draft", "failed"].includes(message.status)) {
      const send = element("button", "Send " + message.id)
      send.onclick = () => safely(async () => { await api("/api/messages/" + message.id + "/send", "POST", {}); await loadTicket(id) })
      card.append(send)
    }
    if (message.status === "draft") {
      const cancel = element("button", "Cancel " + message.id)
      cancel.onclick = () => safely(async () => { await api("/api/messages/" + message.id + "/cancel", "POST", {}); await loadTicket(id) })
      card.append(cancel)
    }
    const details = element("details")
    details.append(element("summary", "Details " + message.id), element("pre", JSON.stringify(message, null, 2)))
    card.append(details)
    list.append(card)
  }
}
async function load() {
  const result = await api("/api/tickets")
  const nav = document.querySelector("#tickets")
  nav.replaceChildren()
  for (const ticket of result.tickets) {
    const button = element("button", ticket.subject)
    button.onclick = () => safely(() => loadTicket(ticket.id))
    nav.append(button)
  }
  await loadTicket(state.ticket || result.tickets[0].id)
}
document.querySelector("#compose").onsubmit = (event) => {
  event.preventDefault()
  safely(async () => {
    if (!state.ticket) throw new Error("Select a ticket first")
    const body = document.querySelector("#reply").value
    await api(state.editing ? "/api/messages/" + state.editing : "/api/tickets/" + state.ticket + "/messages", state.editing ? "PATCH" : "POST", { body })
    state.editing = null
    document.querySelector("#reply").value = ""
    document.querySelector("#editing").textContent = ""
    await loadTicket(state.ticket)
  })
}
document.querySelector("#refresh").onclick = () => safely(load)
safely(load)
