import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import assert from "node:assert/strict"

const origin = `http://127.0.0.1:${process.env.PORT}`
const records = []
const checks = []
let snapshot
function act(action) {
  const result = JSON.parse(execFileSync(process.env.NODE_EXE, [process.env.BROWSER_DRIVER_CLIENT, "--endpoint", process.env.BROWSER_DRIVER_ENDPOINT, JSON.stringify(action)], { encoding: "utf8", timeout: 30000, maxBuffer: 8_000_000 }))
  records.push(result)
  assert.equal(result.ok, true, JSON.stringify(result))
  if (result.snapshot) snapshot = result.snapshot
  return result
}
async function waitFor(ready, description) {
  const deadline = Date.now() + 12000
  while (true) {
    act({ action: "observe" })
    if (ready(snapshot)) return snapshot
    if (Date.now() > deadline) throw new Error(description + ": " + snapshot.text)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}
function control(name) {
  const found = snapshot.controls.find((item) => item.name === name)
  assert.ok(found, "Missing control " + name)
  return found
}
function click(name) { act({ action: "click", ref: control(name).ref }) }
function type(text) { act({ action: "type", ref: control("Reply").ref, text }) }
async function api(path, body, base = origin) {
  const response = await fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  return { response, data: await response.json() }
}
async function message(id) { return (await api("/api/messages/" + id)).data.message }
const health = (await api("/api/health")).data
const provider = (path, body) => api(path, body, health.providerOrigin)
async function draft(body) {
  type(body)
  click("Save draft")
  await waitFor((s) => s.controls.some((item) => item.name.startsWith("Queue ")) && control("Reply").value === "", "draft save")
  const messages = (await api("/api/tickets/t-101")).data.messages
  const saved = messages.findLast((item) => item.body === body && item.status === "draft")
  assert.ok(saved)
  return saved
}
try {
  act({ action: "open", url: origin })
  await waitFor((s) => s.headings.includes("Replacement cable"), "initial ticket")
  type("   ")
  click("Save draft")
  const invalid = await api("/api/tickets/t-101/messages", { body: "   " })
  assert.equal(invalid.response.status, 400)
  await waitFor((s) => s.text.includes(invalid.data.error), "invalid-save error")
  assert.equal(control("Reply").value, "   ")
  checks.push("Invalid save shows the exact API error and preserves composer text")

  const saved = await draft("  Browser synthetic draft\nreply  ")
  click("Edit " + saved.id)
  assert.equal(control("Reply").value, saved.body)
  const editedBody = "  Edited browser synthetic reply\nverbatim  "
  type(editedBody)
  click("Save draft")
  await waitFor((s) => s.text.includes(editedBody) && control("Reply").value === "", "draft editing")
  assert.equal((await message(saved.id)).body, editedBody)
  click("Queue " + saved.id)
  await waitFor((s) => s.text.includes("Status: queued"), "queue admission")
  const queued = await message(saved.id)
  assert.equal(queued.delivery.attempts, 0)
  assert.equal((await provider("/control/state")).data.attempts.filter((item) => item.messageId === saved.id).length, 0)
  await provider("/control/plan", { messageId: saved.id, mode: "fail_once" })
  click("Process queue")
  await waitFor((s) => s.controls.some((item) => item.name === "Retry " + saved.id), "retryable delivery")
  const failed = await message(saved.id)
  click("Details " + saved.id)
  assert.ok(snapshot.text.includes(failed.delivery.lastError))
  assert.ok(snapshot.text.includes("Attempts: 1"))
  click("Retry " + saved.id)
  await waitFor((s) => s.text.includes("Status: queued"), "retry queue")
  click("Process queue")
  await waitFor((s) => s.text.includes("Status: delivered") && !control("Process queue").disabled, "delivered reply")
  const delivered = await message(saved.id)
  assert.equal(delivered.delivery.attempts, 2)
  assert.equal(delivered.delivery.idempotencyKey, queued.delivery.idempotencyKey)
  assert.ok(snapshot.text.includes(delivered.delivery.receiptId))
  click("Refresh")
  await waitFor((s) => s.text.includes(delivered.delivery.receiptId), "refresh receipt")
  assert.deepEqual(await message(saved.id), delivered)
  click("Invoice copy")
  await waitFor((s) => s.headings.includes("Invoice copy"), "ticket navigation")
  click("Replacement cable")
  await waitFor((s) => s.text.includes("Status: delivered"), "return to ticket")
  checks.push("Draft editing, verbatim storage, ticket navigation, queue-only admission, retry, receipt details, and refresh")
  act({ action: "viewport", width: 1280, height: 900 })
  act({ action: "screenshot", path: join(process.env.DATA_DIR, "browser-desktop.png") })

  act({ action: "viewport", width: 390, height: 844 })
  const cancelled = await draft("Mobile synthetic reply to cancel")
  click("Queue " + cancelled.id)
  await waitFor((s) => s.controls.some((item) => item.name === "Cancel " + cancelled.id) && !s.controls.some((item) => item.name === "Queue " + cancelled.id), "mobile queue")
  click("Cancel " + cancelled.id)
  await waitFor((s) => s.text.includes("Status: cancelled"), "mobile cancellation")
  click("Details " + cancelled.id)
  assert.ok(snapshot.text.includes("Attempts: 0"))
  assert.equal((await message(cancelled.id)).status, "cancelled")
  assert.equal((await provider("/control/state")).data.attempts.filter((item) => item.messageId === cancelled.id).length, 0)
  checks.push("390px queue/cancel/details controls are reachable; untransmitted cancellation has zero attempts")

  const late = await draft("Mobile synthetic cancellation after acceptance")
  click("Queue " + late.id)
  await waitFor((s) => !s.controls.some((item) => item.name === "Queue " + late.id), "late-cancel admission")
  await provider("/control/plan", { messageId: late.id, mode: "after_accept" })
  click("Process queue")
  const deadline = Date.now() + 10000
  while (!(await provider("/control/state")).data.held.some((item) => item.messageId === late.id)) {
    if (Date.now() > deadline) throw new Error("Provider never held accepted request")
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  click("Refresh")
  await waitFor((s) => s.text.includes("Status: sending"), "sending status")
  click("Cancel " + late.id)
  await waitFor((s) => s.text.includes("Cancellation was too late"), "too-late cancellation")
  const accepted = await message(late.id)
  assert.equal(accepted.status, "delivered")
  assert.ok(accepted.delivery.receiptId)
  click("Details " + late.id)
  assert.ok(snapshot.text.includes(accepted.delivery.receiptId))
  assert.ok(snapshot.text.includes(accepted.delivery.lastError))
  await provider("/control/release", { messageId: late.id, response: "lost" })
  await waitFor(() => !control("Process queue").disabled, "late response settled")
  assert.deepEqual(await message(late.id), accepted)
  act({ action: "screenshot", path: join(process.env.DATA_DIR, "browser-mobile.png") })
  checks.push("390px sending/cancellation race displays receipt and exact too-late explanation, retained after late 503")
  act({ action: "open", url: origin })
  await waitFor((s) => s.text.includes("Cancellation was too late"), "page reload persistence")
  assert.deepEqual(await message(late.id), accepted)
  checks.push("Full page reload retains committed delivery state")
  const consoleResult = act({ action: "console" })
  console.log(JSON.stringify({ checks, console: consoleResult.result }, null, 2))
} finally {
  writeFileSync(join(process.env.DATA_DIR, "browser-verification.json"), JSON.stringify({ checks, records }, null, 2))
}
