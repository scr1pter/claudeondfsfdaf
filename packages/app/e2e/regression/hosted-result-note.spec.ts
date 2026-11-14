import { expect, test } from "@playwright/test"
import { model, rootID, setup, userMessage } from "../utils/multiagent"

test("a returned hosted report is visible as a quiet cloud note in its original conversation", async ({ page }) => {
  const text = "Hosted job (jb_aaaaaaaaaaaaaaaaaaaaaaaaaa): reported.\n\nPrepared a pull request for your review."
  const app = await setup(page, { messages: { [rootID]: [
    userMessage(rootID, "msg_001_owner", "Prepare the parser fix while I am away."),
    { info: { id: "msg_002_hosted", sessionID: rootID, role: "user", agent: "build", model,
      time: { created: 1700000002000 } },
      parts: [{ id: "prt_hosted_result", messageID: "msg_002_hosted", sessionID: rootID,
        type: "text", synthetic: true, text,
        metadata: { hostedJobNotification: { jobID: "jb_aaaaaaaaaaaaaaaaaaaaaaaaaa", state: "reported" }, taskQuiet: true } }],
    },
  ] } })
  await app.open()
  const note = page.locator('[data-component="user-message"][data-kind="hosted"]')
  await expect(note).toBeVisible()
  await expect(note).toContainText("Cloud computer report")
  await expect(note).toContainText("Prepared a pull request for your review.")
  await expect(note.getByRole("button", { name: /revert/i })).toHaveCount(0)
  await expect(page.getByText("Prepare the parser fix while I am away.", { exact: true })).toBeVisible()
  expect(app.capture.session.filter((request) => request.method === "POST" &&
    /\/session\/[^/]+\/(?:message|prompt_async)(?:\?|$)/.test(request.path))).toEqual([])
})
