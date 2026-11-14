import { expectSessionTitle } from "../../utils/waits"
import { benchmark, expect } from "../benchmark"
import { measureFirstNavigation } from "./first-navigation-probe"
import { fixture } from "./session-timeline-stress.fixture"
import {
  installStressTasks,
  installTimelineSettings,
  mockStressTimeline,
  navigateStressTask,
  stressDraftHref,
  stressSessionHref,
} from "./timeline-test-helpers"
import { waitForStableTimeline } from "./session-tab-switch-probe"

const contentSelector = '[data-message-id], [data-component="prompt-input"]'
const draftID = "draft_first_navigation"

benchmark.describe("performance: first navigation paint", () => {
  benchmark("opens an unvisited task without a blank frame", async ({ page, report }) => {
    await setup(page)
    const href = stressSessionHref(fixture.targetID)
    const result = await measureFirstNavigation(page, {
      href,
      trigger: "route",
      destinationPath: href,
      sourceSelector: messageSelector(fixture.expected.sourceMessageIDs.at(-1)!),
      destinationSelector: messageSelector(fixture.expected.targetMessageIDs.at(-1)!),
      contentSelector,
      navigate: async () => {
        await navigateStressTask(page, href)
        await expectSessionTitle(page, fixture.expected.targetTitle)
      },
    })
    report(result)
    expect(result.summary.blankSamples).toBe(0)
    expect(result.summary.unknownSamples).toBe(0)
  })

  benchmark("opens the new session page before its lazy module is used", async ({ page, report }) => {
    await setup(page, draftID)
    const href = stressDraftHref(draftID)
    const result = await measureFirstNavigation(page, {
      href,
      trigger: "route",
      destinationPath: href,
      sourceSelector: messageSelector(fixture.expected.sourceMessageIDs.at(-1)!),
      destinationSelector: '[data-component="session-new-composer"]',
      contentSelector,
      navigate: async () => {
        await navigateStressTask(page, href)
        await expect(
          page.locator('[data-component="session-new-composer"] [data-component="prompt-input"]'),
        ).toBeVisible()
      },
    })
    report(result)
    expect(result.summary.blankSamples).toBe(0)
    expect(result.summary.unknownSamples).toBe(0)
  })

  benchmark("opens a child session without a blank frame", async ({ page, report }) => {
    await setup(page)
    const href = stressSessionHref(fixture.childID)
    const clickSelector = `${messageSelector(fixture.expected.sourceMessageIDs.at(-1)!)} button[aria-controls="vector-bg-tasks"]`
    const result = await measureFirstNavigation(page, {
      href,
      trigger: "click",
      clickSelector,
      destinationPath: href,
      sourceSelector: messageSelector(fixture.expected.sourceMessageIDs.at(-1)!),
      destinationSelector: messageSelector(fixture.expected.childMessageIDs.at(-1)!),
      contentSelector,
      navigate: async () => {
        // The single-agent chip opens its child session with a modifier click.
        await page.locator(clickSelector).click({ modifiers: ["ControlOrMeta"] })
        await expectSessionTitle(page, fixture.expected.childTitle)
      },
    })
    report(result)
    expect(result.summary.blankSamples).toBe(0)
    expect(result.summary.unknownSamples).toBe(0)
  })
})

async function setup(page: Parameters<typeof mockStressTimeline>[0], draft?: string) {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressTasks(page, draft ? { draftID: draft } : undefined)
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await waitForStableTimeline(page, fixture.expected.sourceMessageIDs.at(-1)!)
}

function messageSelector(id: string) {
  return `[data-message-id="${id}"]`
}
