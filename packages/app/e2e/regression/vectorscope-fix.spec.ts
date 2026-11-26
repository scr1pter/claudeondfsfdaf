import { expect, test, type Page } from "@playwright/test"
import { createHash } from "node:crypto"
import type { ReviewFixControl } from "@vectordevai/schema/review-fix"

// VS-12d (SF-10b): the desktop's fix actions in a real browser, against a page.route engine. Each step is previewed
// and approved on its own with a real click; nothing is sent before Prepare, and a script's click approves nothing.
const parentID = "ses_local_fix_parent"
const fixID = "fix_0123abcd-ef45"
const head = "a".repeat(40)
const base = "b".repeat(40)
const commit = "c".repeat(40)
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const FILE = "export function a(value: number) {\n  return value\n}\n"
const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " export function a(value: number) {",
  "-  return value",
  "+  return Math.abs(value)",
  " }",
  "",
].join("\n")
const digest = `sha256:${"1".repeat(64)}`
const patchDigest = `sha256:${sha(PATCH)}`
const summary = (state: ReviewFixControl.State, extra: Partial<ReviewFixControl.Summary> = {}) => ({
  fixID,
  state,
  head,
  sourceBranch: "feature",
  destinationBranch: "vector/fix-0123abcd",
  digest,
  patchDigest,
  ...extra,
})

async function engine(
  page: Page,
  options: { guest?: boolean; staleExecute?: boolean; listed?: boolean; leftovers?: boolean } = {},
) {
  const state = {
    open: options.listed ? [summary("applied")] : ([] as ReturnType<typeof summary>[]),
    prepares: [] as unknown[],
    previews: [] as ReviewFixControl.Request[],
    executes: [] as unknown[],
    cancels: [] as string[],
    posts: 0,
    offer: 0,
    last: undefined as ReviewFixControl.Request | undefined,
  }
  await page.route("**/fixture/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/fixture/, "")
    if (request.method() === "POST") state.posts++
    if (path === `/session/${parentID}`)
      return route.fulfill({ json: { id: parentID, projectID: "project", directory: "/repo" } })
    if (path === "/file/content") return route.fulfill({ json: { type: "text", content: FILE } })
    const root = `/experimental/session/${parentID}/review/fix`
    if (options.guest && path.startsWith(root)) return route.fulfill({ status: 403, json: { message: "Owner only" } })
    if (path === root && request.method() === "GET") return route.fulfill({ json: { fixes: state.open } })
    if (path === root && request.method() === "POST") {
      const body: ReviewFixControl.Prepare = request.postDataJSON()
      state.prepares.push(body)
      state.open = [summary("preview")]
      return route.fulfill({
        json: {
          fixID,
          repository: "/repo",
          worktree: "/home/owner/.local/share/vector/fix/fix_0123",
          head: body.head,
          base: body.base,
          sourceBranch: "feature",
          baseBranch: body.baseBranch,
          destinationBranch: "vector/fix-0123abcd",
          source: { kind: "client" },
          findingsVerified: false,
          findings: body.findings,
          digest,
          patchDigest: `sha256:${sha(body.patch)}`,
          patch: body.patch,
          files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1 }],
          notes: [
            "The engine did not verify the findings this fix names: the patch and its finding references come from your client.",
            "Nothing is applied, committed or pushed until you approve each step, and no command has run.",
          ],
        },
      })
    }
    if (path === `${root}/${fixID}/preview`) {
      const body: ReviewFixControl.Request = request.postDataJSON()
      state.previews.push(body)
      state.last = body
      state.offer++
      const operation =
        body.kind === "checks"
          ? { kind: "checks", commands: body.commands, network: "off", timeoutMs: 120_000, outputBytes: 81_920 }
          : body.kind === "commit"
            ? { kind: "commit", message: `Apply a Vector fix for 1 review finding\n\nReviewed commit: ${head}\n` }
            : body.kind === "push"
              ? { kind: "push", remote: body.remote, mode: body.mode, commit }
              : { kind: "apply" }
      return route.fulfill({
        json: {
          offerID: `00000000-0000-4000-8000-${String(state.offer).padStart(12, "0")}`,
          fixID,
          operation,
          operationDigest: `sha256:${"e".repeat(60)}${String(state.offer).padStart(4, "0")}`,
          head,
          digest,
          patchDigest,
          expiresAt: Date.now() + 300_000,
          ...(body.kind === "commit" ? { identity: { name: "Owner", email: "owner@example.test" } } : {}),
          notes: body.kind === "push" ? ["Its hooks do not run, but its own Git configuration is read."] : [],
        },
      })
    }
    if (path === `${root}/${fixID}/execute`) {
      state.executes.push(request.postDataJSON())
      if (options.staleExecute)
        return route.fulfill({
          status: 400,
          json: { code: "stale", message: "The reviewed branch moved since the review. Nothing was changed." },
        })
      const kind = state.last!.kind
      if (kind === "apply") {
        state.open = [summary("applied")]
        return route.fulfill({
          json: { kind, fixID, worktree: "/w", head, digest, patchDigest, consumedAt: 1, files: [] },
        })
      }
      if (kind === "checks")
        return route.fulfill({
          json: {
            kind,
            fixID,
            head,
            digest,
            operation: `sha256:${"2".repeat(64)}`,
            consumedAt: 1,
            results: [
              {
                argv: ["bun", "test"],
                cwd: ".",
                exitCode: 1,
                timedOut: false,
                output: "ok\u001b[2J ‮ done",
                truncated: false,
                durationMs: 5,
              },
            ],
            ...(options.leftovers ? { leftovers: ["coverage/lcov.info"] } : {}),
            passed: false,
          },
        })
      if (kind === "commit") {
        state.open = [summary("committed", { commit })]
        return route.fulfill({
          json: {
            kind,
            fixID,
            head,
            digest,
            commit,
            tree: "d".repeat(40),
            branch: "vector/fix-0123abcd",
            author: { name: "Owner", email: "owner@example.test" },
            consumedAt: 1,
          },
        })
      }
      state.open = [summary("pushed", { commit })]
      return route.fulfill({
        json: {
          kind,
          fixID,
          commit,
          remote: "file:///srv/remote.git",
          ref: "refs/heads/vector/fix-0123abcd",
          mode: "branch",
          consumedAt: 1,
        },
      })
    }
    if (path === `${root}/${fixID}/cancel`) {
      state.cancels.push(fixID)
      state.open = []
      return route.fulfill({ json: { fixID, removed: true } })
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } })
  })
  return state
}

const panel = (page: Page) => page.getByRole("region", { name: "Local VectorScope fixes" })
const button = (page: Page, name: string) => panel(page).getByRole("button", { name, exact: true })
const open = (page: Page, suffix = "") => page.goto(`/e2e/fixtures/vectorscope-fix.html${suffix}`)
const prepare = async (page: Page) => {
  await button(page, "Prepare a fix checkout").click()
  await expect(button(page, "Preview apply")).toBeEnabled()
}

test("nothing is posted before Prepare, and the preview shows the full patch, paths, destination and commands", async ({
  page,
}) => {
  const state = await engine(page)
  await open(page)
  await expect(button(page, "Prepare a fix checkout")).toBeEnabled()
  expect(state.posts).toBe(0)
  await prepare(page)
  expect(state.prepares).toEqual([
    {
      source: { kind: "client" },
      head,
      base,
      baseBranch: "main",
      findings: ["f-verified"],
      files: [
        {
          path: "src/a.ts",
          preimage: `sha256:${sha(FILE)}`,
          postimage: `sha256:${sha(FILE.replace("return value", "return Math.abs(value)"))}`,
        },
      ],
      patch: PATCH,
    },
  ])
  const preview = panel(page).getByLabel("Fix preview")
  await expect(panel(page).getByLabel("Fix patch")).toHaveText(PATCH)
  await expect(preview).toContainText("Fix checkout: /home/owner/.local/share/vector/fix/fix_0123")
  await expect(preview).toContainText("Repository: /repo")
  await expect(preview).toContainText("Destination: a new branch vector/fix-0123abcd in this repository")
  await expect(preview).toContainText("Commands: none")
  await expect(preview).toContainText("M src/a.ts (+1 -1)")
  await expect(preview).toContainText("The engine did not verify the findings this fix names")
  await expect(preview).toContainText("Nothing is applied, committed or pushed until you approve each step")
  expect(state.previews).toEqual([])
  expect(state.executes).toEqual([])
})

test("apply, commit and push are separate buttons, each previewed and approved once, in order", async ({ page }) => {
  const state = await engine(page)
  await open(page)
  await prepare(page)
  for (const name of ["Preview checks", "Preview commit", "Preview push"])
    await expect(button(page, name)).toBeDisabled()
  await button(page, "Preview apply").click()
  await button(page, "Approve and apply").click()
  await expect(button(page, "Preview commit")).toBeEnabled()
  expect(state.executes).toHaveLength(1)
  expect(state.executes[0]).toEqual({
    offerID: "00000000-0000-4000-8000-000000000001",
    head,
    patchDigest,
    operationDigest: `sha256:${"e".repeat(60)}0001`,
  })
  await expect(button(page, "Preview apply")).toBeDisabled()
  await button(page, "Preview commit").click()
  const offer = panel(page).getByLabel("Fix step offer")
  await expect(offer).toContainText("Apply a Vector fix for 1 review finding")
  await expect(offer).toContainText("Author and committer: Owner <owner@example.test>")
  await button(page, "Approve and commit").click()
  await expect(button(page, "Preview push")).toBeDisabled()
  await panel(page).getByLabel("Fix push remote").fill("file:///srv/remote.git")
  await expect(button(page, "Preview push")).toBeEnabled()
  await button(page, "Preview push").click()
  await expect(offer).toContainText(`Push commit ${commit} to file:///srv/remote.git`)
  await expect(offer).toContainText("Its hooks do not run")
  await button(page, "Approve and push").click()
  await expect(panel(page).getByLabel("Fix results")).toContainText("Pushed ccccccc to file:///srv/remote.git")
  expect(state.previews.map((item) => item.kind)).toEqual(["apply", "commit", "push"])
  expect(state.executes).toHaveLength(3)
  expect(state.previews[2]).toEqual({ kind: "push", remote: "file:///srv/remote.git", mode: "branch" })
})

test("a double-click on a step previews once and approves nothing; a script's click approves nothing", async ({
  page,
}) => {
  const state = await engine(page)
  await open(page)
  await prepare(page)
  await button(page, "Preview apply").dblclick()
  await expect(button(page, "Approve and apply")).toBeVisible()
  await page.waitForTimeout(1_000)
  expect(state.previews).toHaveLength(1)
  expect(state.executes).toEqual([])
  await button(page, "Approve and apply").dispatchEvent("click")
  await page.waitForTimeout(200)
  expect(state.executes).toEqual([])
  await button(page, "Approve and apply").click()
  await expect(button(page, "Approve and apply")).toHaveCount(0)
  // The offer leaves the page before its session check and execute are sent, so wait for the applied step.
  await expect(button(page, "Preview commit")).toBeEnabled()
  expect(state.executes).toHaveLength(1)
})

test("with the setting off nothing can be prepared or run, and a listed fix can still be cancelled", async ({
  page,
}) => {
  const state = await engine(page, { listed: true })
  await open(page, "?enabled=0")
  await expect(panel(page)).toContainText("Fixes are off in the owner’s global VectorScope settings.")
  await expect(button(page, "Prepare a fix checkout")).toBeDisabled()
  await expect(panel(page)).toContainText("prepared elsewhere: it can only be cancelled here")
  await button(page, "Cancel this fix").click()
  await expect(panel(page)).toContainText("No fix is open for this conversation.")
  expect(state.cancels).toEqual([fixID])
  expect(state.prepares).toEqual([])
  expect(state.executes).toEqual([])
})

test("a stale execute shows the engine's message, spends the offer and lets the step be previewed again", async ({
  page,
}) => {
  const state = await engine(page, { staleExecute: true })
  await open(page)
  await prepare(page)
  await button(page, "Preview apply").click()
  await button(page, "Approve and apply").click()
  await expect(panel(page).getByRole("alert")).toContainText("The reviewed branch moved since the review.")
  await expect(button(page, "Approve and apply")).toHaveCount(0)
  await expect(button(page, "Preview apply")).toBeEnabled()
  expect(state.executes).toHaveLength(1)
})

test("check output is escaped, leftovers are named, and a result approves nothing", async ({ page }) => {
  const state = await engine(page, { leftovers: true })
  await open(page)
  await prepare(page)
  await button(page, "Preview apply").click()
  await button(page, "Approve and apply").click()
  await expect(button(page, "Preview checks")).toBeDisabled()
  await panel(page).getByLabel("bun test", { exact: true }).check()
  await button(page, "Preview checks").click()
  await expect(panel(page).getByLabel("Fix step offer")).toContainText("bun test in .")
  await expect(panel(page).getByLabel("Fix step offer")).toContainText("Network: off")
  await button(page, "Approve and run checks").click()
  const results = panel(page).getByLabel("Fix results")
  await expect(results).toContainText("ok\\u{1b}[2J \\u{202e} done")
  await expect(results).toContainText("A check left files in the fix checkout: coverage/lcov.info.")
  await expect(results).toContainText("This is information only: it approves no change, commit or push.")
  await expect(button(page, "Preview commit")).toBeDisabled()
  expect(state.previews[1]).toEqual({ kind: "checks", commands: [{ argv: ["bun", "test"], cwd: "." }] })
})

test("a guest answer shows the owner alert and places nothing", async ({ page }) => {
  const state = await engine(page, { guest: true })
  await open(page)
  await expect(panel(page).getByRole("alert")).toContainText("Owner access")
  await button(page, "Prepare a fix checkout").click()
  await expect(panel(page).getByRole("alert")).toContainText("Owner access")
  await expect(button(page, "Preview apply")).toHaveCount(0)
  expect(state.prepares).toEqual([])
})

for (const variant of ["untrusted", "uncommitted"] as const)
  test(`a ${variant} review shows why it offers no fix`, async ({ page }) => {
    const state = await engine(page)
    await open(page, `?variant=${variant}`)
    await expect(panel(page)).toContainText(
      variant === "untrusted"
        ? "Fixes come only from a review of your own pull request"
        : "Fixes come only from a review of a pull request",
    )
    await expect(button(page, "Prepare a fix checkout")).toHaveCount(0)
    expect(state.posts).toBe(0)
  })

test("closing the panel cancels the fix it prepared", async ({ page }) => {
  const state = await engine(page)
  await open(page)
  await prepare(page)
  await page.getByRole("button", { name: "Close fixture panel", exact: true }).click()
  await expect(panel(page)).toHaveCount(0)
  await expect.poll(() => state.cancels).toEqual([fixID])
  await page.getByRole("button", { name: "Reopen fixture panel", exact: true }).click()
  await expect(panel(page)).toContainText("No fix is open for this conversation.")
})
