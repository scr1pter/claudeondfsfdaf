import { afterEach, beforeEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "../../app/scripts/test-dom"
import { initializeSupportReport } from "../src/components/support/report"

// The web form uses the same DOM test environment as its app-side draft handoff. Every request is injected here;
// nothing is sent to the support service or an email provider.
beforeEach(() => GlobalRegistrator.register())
afterEach(() => GlobalRegistrator.unregister())

async function submitted(body: unknown, code = 200) {
  const form = document.createElement("form")
  form.innerHTML = `
    <textarea name="message" required></textarea>
    <input name="email" type="email" />
    <p id="report-status" role="status"></p>
    <button type="submit">Send report</button>
  `
  document.body.append(form)
  const message = form.querySelector("textarea")!
  const email = form.querySelector("input")!
  const status = form.querySelector("p")!
  const submit = form.querySelector("button")!
  message.value = "The fixture's diff view froze."
  email.value = "reporter@example.invalid"
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = []
  const request: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return Response.json(body, { status: code })
    },
    { preconnect: () => {} },
  )
  const dispose = initializeSupportReport(form, request)
  const settled = new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      if (!status.textContent || status.textContent === "Sending…") return
      observer.disconnect()
      resolve()
    })
    observer.observe(status, { childList: true, subtree: true, characterData: true })
  })
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await settled
  dispose()
  return { message, email, status, submit, calls }
}

test("the website receipt shows the existing report reference after an anonymous submission", async () => {
  const id = `r_${"a".repeat(26)}`
  const sent = await submitted({ delivered: true, id: "email_provider_fixture", report: { id, status: "received" } })
  expect(sent.status.textContent).toContain(`Reference: ${id}`)
  expect(sent.status.textContent).not.toContain("email_provider_fixture")
  expect(sent.message.value).toBe("")
  expect(sent.email.value).toBe("")
  expect(sent.submit.textContent).toBe("Report sent")
  expect(sent.calls).toHaveLength(1)
  expect(sent.calls[0]!.input).toBe("/api/support/bug-report")
  expect(new Headers(sent.calls[0]!.init?.headers).has("authorization")).toBe(false)
})

test("untracked delivery and malformed metadata never display an email id or invent a reference", async () => {
  const id = `r_${"a".repeat(26)}`
  for (const report of [
    undefined,
    null,
    {},
    [],
    { id: "email_provider_fixture" },
    { id: id.toUpperCase() },
    { id: id.slice(0, -1) },
    { id: `${id}\n` },
    { id: `${id}<img src=x>` },
    { id: 123 },
  ]) {
    const sent = await submitted({ delivered: true, id, report })
    expect(sent.status.textContent).toBe("Report sent. If you left an email, the Vector team can reply there.")
    expect(sent.status.querySelector("img")).toBeNull()
    expect(sent.message.value).toBe("")
  }
})

test("an unconfirmed or failed delivery keeps the draft and never displays a report reference", async () => {
  for (const code of [200, 502]) {
    const sent = await submitted({ delivered: false, report: { id: `r_${"a".repeat(26)}` } }, code)
    expect(sent.status.textContent).not.toContain("Reference:")
    expect(sent.message.value).toBe("The fixture's diff view froze.")
    expect(sent.submit.disabled).toBe(false)
  }
})
