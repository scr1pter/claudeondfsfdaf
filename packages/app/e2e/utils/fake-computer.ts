import type { Page } from "@playwright/test"
import type { Computer } from "@vectordevai/schema/computer"
import type {
  createFakeComputer,
  FakeComputerCall,
  FakeComputerScript,
} from "../../src/features/computer/fake-platform"
import { mockVectorServer, type MockServerConfig } from "./mock-server"

export type ComputerTestWindow = Window & {
  __vectorE2E?: {
    computer?: FakeComputerScript
    computerControl?: ReturnType<typeof createFakeComputer>
  }
}

/** Install before navigation. Permission/question events and tool parts use the ordinary server fixture. */
export async function installFakeComputer(page: Page, script: FakeComputerScript, server?: MockServerConfig) {
  if (server) await mockVectorServer(page, server)
  await page.addInitScript((computer) => {
    const target = window as ComputerTestWindow
    target.__vectorE2E = { ...target.__vectorE2E, computer }
  }, script)
}

export async function pushState(page: Page, state: Computer.ComputerState) {
  await page.waitForFunction(() => !!(window as ComputerTestWindow).__vectorE2E?.computerControl)
  await page.evaluate((next) => {
    const control = (window as ComputerTestWindow).__vectorE2E?.computerControl
    if (!control) throw new Error("The computer fixture was not installed before navigation")
    control.emit(next)
  }, state)
}

/** Synthetic native readiness; Playwright input must never count as real Windows calibration. */
export async function pushInputSetup(page: Page, status: Computer.InputSetupStatus) {
  await page.waitForFunction(() => !!(window as ComputerTestWindow).__vectorE2E?.computerControl)
  await page.evaluate((next) => {
    const control = (window as ComputerTestWindow).__vectorE2E?.computerControl
    if (!control) throw new Error("The computer fixture was not installed before navigation")
    control.emitInputSetup(next)
  }, status)
}

/** Stands in for desktop main storing an Always reply it observed (D15, D16); the renderer never writes this list. */
export async function grantAlways(page: Page, app: Computer.AlwaysAllowed) {
  await page.waitForFunction(() => !!(window as ComputerTestWindow).__vectorE2E?.computerControl)
  await page.evaluate((next) => {
    const control = (window as ComputerTestWindow).__vectorE2E?.computerControl
    if (!control) throw new Error("The computer fixture was not installed before navigation")
    control.grantAlways(next)
  }, app)
}

export async function calls(page: Page): Promise<readonly FakeComputerCall[]> {
  await page.waitForFunction(() => !!(window as ComputerTestWindow).__vectorE2E?.computerControl)
  return page.evaluate(() => {
    const control = (window as ComputerTestWindow).__vectorE2E?.computerControl
    if (!control) throw new Error("The computer fixture was not installed before navigation")
    return [...control.calls]
  })
}
