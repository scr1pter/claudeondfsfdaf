import { expect, test, type Page } from "@playwright/test"

// Track B B10 (contract: skills and insights sections "restored as drafts for review"; main-built readers refuse with
// "update Vector" via minReader). Settings → Memory → Backup, the app's real page, restores versions through a stand-in
// for the desktop's Brain Vault bridge (e2e/fixtures/vault-sections.jsx) whose answers are what the desktop's real
// controller answered in the native acceptance test (packages/desktop/src/main/vault-sections.test.ts). No GitHub and
// no Vector backend are reached.

type Fixture = {
  restores: () => { version?: string; code?: string }[]
  versions: { LEARNED: string; NEWER: string; LOCKED: string }
}

const fixture = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { vaultFixture: Fixture }).vaultFixture
    return { restores: state.restores(), versions: state.versions }
  })

async function open(page: Page, query = "") {
  await page.goto(`/e2e/fixtures/vault-sections.html${query}`)
  const card = page.locator('[data-component="settings-memory-backup-versions"]')
  await card.getByRole("button", { name: "Show versions" }).click()
  await expect(card.locator("[data-version]")).toHaveCount(3)
  return { card, versions: (await fixture(page)).versions }
}

test("a restore with learned skills and workflow insights says they wait for review, never as before", async ({
  page,
}) => {
  const { card, versions } = await open(page)
  await expect(card).toContainText("Learned skills and workflow insights come back as proposals for you to review.")
  await card.locator(`[data-version="${versions.LEARNED}"]`).getByRole("button", { name: "Restore" }).click()
  await expect(page.locator(".settings-memory-notice")).toHaveText(
    "Restored 4 entries from the backup of 2026-11-15 03:12 UTC. 1 in use, 0 waiting for your review as before, 2 learned skills to review, 1 workflow insight to review.",
  )
  await expect(page.getByRole("alert")).toHaveCount(0)
  expect((await fixture(page)).restores).toEqual([{ version: versions.LEARNED }])
})

test("on another computer the recovery code comes first, then the learned version restores for review", async ({
  page,
}) => {
  const { card, versions } = await open(page, "?mine=false")
  await expect(card).toContainText("This vault was made on another computer.")
  const restore = card.locator(`[data-version="${versions.LEARNED}"]`).getByRole("button", { name: "Restore" })
  await expect(restore).toBeDisabled()
  await card.getByLabel("Recovery code").fill("ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345")
  await restore.click()
  await expect(page.locator(".settings-memory-notice")).toContainText(
    "2 learned skills to review, 1 workflow insight to review.",
  )
  expect((await fixture(page)).restores).toEqual([
    { version: versions.LEARNED, code: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345" },
  ])
})

test("a backup with parts only a newer Vector reads says to update Vector to restore them too", async ({ page }) => {
  const { card, versions } = await open(page)
  await card.locator(`[data-version="${versions.NEWER}"]`).getByRole("button", { name: "Restore" }).click()
  const notice = page.locator(".settings-memory-notice")
  await expect(notice).toContainText("1 already in memory.")
  await expect(notice).toContainText("Parts of this backup need a newer Vector; update Vector to restore them too.")
})

test("a version only a newer Vector can read is refused with Update Vector", async ({ page }) => {
  const { card, versions } = await open(page)
  await card.locator(`[data-version="${versions.LOCKED}"]`).getByRole("button", { name: "Restore" }).click()
  await expect(page.getByRole("alert")).toHaveText(
    "This backup was made by a newer version of Vector. Update Vector to restore it.",
  )
  await expect(page.locator(".settings-memory-notice")).toHaveCount(0)
})
