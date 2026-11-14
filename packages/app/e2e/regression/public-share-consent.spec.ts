import { expect, test } from "@playwright/test"
import { createHash } from "node:crypto"
import { Hands } from "@vectordevai/schema/hands"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import {
  installStressTasks,
  mockStressTimeline,
  stressSessionHref,
} from "../performance/timeline/timeline-test-helpers"
import { expectSessionTitle } from "../utils/waits"

for (const newLayoutDesigns of [false, true]) {
  test(`public sharing requires consent and retains retry controls on unshare failure (new layout: ${newLayoutDesigns})`, async ({
    page,
  }) => {
    await mockStressTimeline(page)
    await installStressTasks(page)
    await page.addInitScript((value) => {
      localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: value } }))
    }, newLayoutDesigns)
    const id = "a".repeat(32)
    const info = {
      id,
      url: `https://vectordev.ai/s/${id}`,
      expiresAt: Date.now() + 604_800_000,
      updatedAt: Date.now(),
      revision: 1,
      updates: false,
    }
    const archive = {
      version: 1,
      engine: "v2",
      title: "Full transcript",
      messages: [
        {
          id: "older-than-compaction",
          role: "user",
          createdAt: 1,
          parts: [{ type: "text", text: "Full history before compaction" }],
        },
        {
          id: "newest-message",
          role: "assistant",
          createdAt: 2,
          parts: [
            {
              type: "tool",
              name: "shell",
              callID: "call",
              status: "completed",
              input: "echo visible",
              output: "Visible result",
            },
            { type: "attachment", name: "image.png", mediaType: "image/png" },
            {
              type: "tool",
              name: "computer",
              callID: "computer-call",
              status: "completed",
              input: '{"action":"screenshot"}',
              output: "Captured the screen",
            },
          ],
        },
      ],
    }
    const previews: (string | null)[] = []
    const writes: { method: string; body: unknown }[] = []
    let failRemoval = true
    let activeInfo: typeof info | undefined
    await page.route(
      (url) => url.pathname === `/session/${fixture.sourceID}`,
      (route) => {
        if (route.request().method() !== "GET") return route.fallback()
        return route.fulfill({
          json: {
            ...fixture.sessions.find((session) => session.id === fixture.sourceID),
            share: activeInfo ?? { url: "https://example.invalid/historical-share" },
          },
        })
      },
    )
    await page.route(
      (url) => url.pathname === `/session/${fixture.sourceID}/share/preview`,
      (route) => {
        previews.push(new URL(route.request().url()).searchParams.get("includeScreenshots"))
        return route.fulfill({ json: archive })
      },
    )
    await page.route(
      (url) => url.pathname === `/session/${fixture.sourceID}/share`,
      async (route) => {
        const request = route.request()
        writes.push({ method: request.method(), body: request.postDataJSON() })
        if (request.method() === "POST") {
          activeInfo = info
          return route.fulfill({ json: info })
        }
        if (failRemoval)
          return route.fulfill({
            status: 503,
            json: {
              _tag: "PublicSessionError",
              code: "UNAVAILABLE",
              message: "The sharing service is temporarily unavailable.",
            },
          })
        activeInfo = undefined
        return route.fulfill({ json: {} })
      },
    )
    await page.goto(stressSessionHref(fixture.sourceID))
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    const open = async () => {
      await page.getByRole("button", { name: "More options", exact: true }).last().click()
      await page.getByRole("menuitem", { name: "Share publicly…", exact: true }).click()
    }
    await open()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByRole("button", { name: "Publish public copy", exact: true })).toBeDisabled()
    await dialog.getByText("Review included transcript (2 messages)", { exact: true }).click()
    await expect(dialog.getByRole("textbox", { name: "Included transcript" })).toHaveValue(
      /Full history before compaction[\s\S]*Visible result[\s\S]*Attachment: image.png/,
    )
    // A transcript with Hands steps offers the screenshot choice, unticked, with its help text.
    await expect(dialog.getByLabel("Include screenshots", { exact: true })).not.toBeChecked()
    await expect(
      dialog.getByText(`Screenshots from ${Hands.NAME} can show other things on your screen.`, { exact: true }),
    ).toBeVisible()
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    expect(writes).toEqual([])
    await open()
    const updates = "Include future updates to this conversation until expiry"
    const remember = "Also allow automatic public sharing of future sessions on this Vector account"
    await expect(dialog.getByLabel(remember, { exact: true })).toBeDisabled()
    await expect(dialog.getByLabel(remember, { exact: true })).not.toBeChecked()
    await dialog.getByText(updates, { exact: true }).click()
    await expect(dialog.getByLabel(remember, { exact: true })).toBeEnabled()
    await dialog.getByText(remember, { exact: true }).click()
    await expect(dialog.getByLabel(remember, { exact: true })).toBeChecked()
    await dialog.getByText(updates, { exact: true }).click()
    await expect(dialog.getByLabel(remember, { exact: true })).not.toBeChecked()
    await expect(dialog.getByLabel(remember, { exact: true })).toBeDisabled()
    await expect(dialog.getByText("Automatic sharing of future sessions requires future updates.")).toBeVisible()
    await dialog.getByText("I have reviewed the included content and want to make it public", { exact: true }).click()
    await dialog.getByLabel("Public copy expiry").selectOption("1")
    await expect(
      dialog.getByLabel("I have reviewed the included content and want to make it public", { exact: true }),
    ).toBeChecked()
    await page.screenshot({ path: test.info().outputPath("public-share-consent.png"), fullPage: true })
    const before = Date.now()
    await dialog.getByRole("button", { name: "Publish public copy", exact: true }).click()
    await expect(dialog.locator("[data-public-share-url]")).toHaveText(info.url)
    expect(writes).toHaveLength(1)
    expect(writes[0].method).toBe("POST")
    expect(writes[0].body).toMatchObject({
      consent: { version: 1, public: true, updates: false },
      remember: false,
      includeScreenshots: false,
      previewHash: createHash("sha256").update(JSON.stringify(archive)).digest("hex"),
    })
    expect(previews.length).toBeGreaterThan(0)
    expect(previews.every((value) => value === null)).toBe(true)
    const body = writes[0].body as { expiresAt: number }
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 86_400_000)
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 86_400_000)
    await dialog.getByRole("button", { name: "Done", exact: true }).click()
    await open()
    await expect(dialog.locator("[data-public-share-url]")).toHaveText(info.url)
    expect(writes).toHaveLength(1)
    await expect(dialog.getByRole("button", { name: "Unshare", exact: true })).toBeDisabled()
    await dialog.getByText("Remove this public copy", { exact: true }).click()
    await dialog.getByRole("button", { name: "Unshare", exact: true }).click()
    await expect(dialog.getByRole("alert")).toContainText("retained so you can retry")
    await expect(dialog.locator("[data-public-share-url]")).toHaveText(info.url)
    failRemoval = false
    await dialog.getByRole("button", { name: "Unshare", exact: true }).click()
    await expect(dialog.getByRole("status")).toHaveText("Public copy removed. The local session is unchanged.")
    await expect(dialog.locator("[data-public-share-url]")).toHaveCount(0)
    expect(writes.map((write) => write.method)).toEqual(["POST", "DELETE", "DELETE"])
  })
}

test("an explicit screenshot opt-in reloads the review and publishes exactly that review", async ({ page }) => {
  await mockStressTimeline(page)
  await installStressTasks(page)
  await page.addInitScript(() => {
    localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
  })
  const id = "b".repeat(32)
  const info = {
    id,
    url: `https://vectordev.ai/s/${id}`,
    expiresAt: Date.now() + 604_800_000,
    updatedAt: Date.now(),
    revision: 0,
    updates: true,
  }
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
  const archive = (screenshots: boolean) => ({
    version: 1,
    engine: "v2",
    title: "Hands transcript",
    messages: [
      { id: "question", role: "user", createdAt: 1, parts: [{ type: "text", text: "Summarize the meeting notes" }] },
      {
        id: "answer",
        role: "assistant",
        createdAt: 2,
        parts: [
          {
            type: "tool",
            name: "computer",
            callID: "computer-call",
            status: "completed",
            input: '{"action":"screenshot"}',
            output: "Captured the screen",
            ...(screenshots ? { screenshots: [{ name: "screen.png", mediaType: "image/png", url: png }] } : {}),
          },
        ],
      },
    ],
  })
  const previews: (string | null)[] = []
  const writes: unknown[] = []
  let activeInfo: typeof info | undefined
  await page.route(
    (url) => url.pathname === `/session/${fixture.sourceID}`,
    (route) => {
      if (route.request().method() !== "GET") return route.fallback()
      return route.fulfill({
        json: { ...fixture.sessions.find((session) => session.id === fixture.sourceID), share: activeInfo },
      })
    },
  )
  await page.route(
    (url) => url.pathname === `/session/${fixture.sourceID}/share/preview`,
    (route) => {
      const flag = new URL(route.request().url()).searchParams.get("includeScreenshots")
      previews.push(flag)
      return route.fulfill({ json: archive(flag === "true") })
    },
  )
  await page.route(
    (url) => url.pathname === `/session/${fixture.sourceID}/share`,
    (route) => {
      writes.push(route.request().postDataJSON())
      activeInfo = info
      return route.fulfill({ json: info })
    },
  )
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await page.getByRole("button", { name: "More options", exact: true }).last().click()
  await page.getByRole("menuitem", { name: "Share publicly…", exact: true }).click()
  const dialog = page.getByRole("dialog")
  const box = dialog.getByLabel("Include screenshots", { exact: true })
  const acknowledgement = "I have reviewed the included content and want to make it public"
  const publish = dialog.getByRole("button", { name: "Publish public copy", exact: true })
  await expect(box).not.toBeChecked()
  await dialog.getByText(acknowledgement, { exact: true }).click()
  await expect(dialog.getByLabel(acknowledgement, { exact: true })).toBeChecked()
  await dialog.getByText("Include screenshots", { exact: true }).click()
  await expect(box).toBeChecked()
  await expect(box).toBeEnabled()
  // The opted-in transcript is a new review: the earlier acknowledgement no longer counts.
  await expect(dialog.getByLabel(acknowledgement, { exact: true })).not.toBeChecked()
  await expect(publish).toBeDisabled()
  await expect(dialog.getByText("Only this manual share can include screenshots.", { exact: false })).toBeVisible()
  await dialog.getByText("Review included transcript (2 messages)", { exact: true }).click()
  await expect(dialog.getByRole("textbox", { name: "Included transcript" })).toHaveValue(
    /Captured the screen\nScreenshot: screen\.png \(image\/png\)/,
  )
  await dialog.getByText("Include future updates to this conversation until expiry", { exact: true }).click()
  await dialog
    .getByText("Also allow automatic public sharing of future sessions on this Vector account", { exact: true })
    .click()
  await expect(dialog.getByText("Auto-shares never include screenshots.", { exact: true })).toBeVisible()
  await dialog.getByText(acknowledgement, { exact: true }).click()
  await page.screenshot({ path: test.info().outputPath("public-share-screenshots.png"), fullPage: true })
  await publish.click()
  await expect(dialog.locator("[data-public-share-url]")).toHaveText(info.url)
  expect(previews).toEqual([null, "true"])
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({
    consent: { version: 1, public: true, updates: true },
    remember: true,
    includeScreenshots: true,
    previewHash: createHash("sha256")
      .update(JSON.stringify(archive(true)))
      .digest("hex"),
  })
})
