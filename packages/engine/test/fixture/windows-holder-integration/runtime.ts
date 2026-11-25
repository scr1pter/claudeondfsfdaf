import { integrationRunner } from "./scope"
import { stageWindowsHolder } from "./stage"

export { HolderStagingDeadline as IntegrationHolderDeadline } from "./stage"

let recorded = false

/** Verify staging with the same single deadline as the attempted native process startup. */
export async function prepareIntegrationHolder(deadline: number) {
  const context = integrationRunner()
  const { asset } = await import(new URL("./asset.generated.ts", import.meta.url).href)
  if (
    process.env.VECTOR_DIRECT_HOLDER_BACKEND !== "staged" ||
    asset.arch !== context.arch ||
    asset.run !== context.run ||
    asset.attempt !== context.attempt ||
    asset.revision !== context.revision
  )
    throw new Error("Invalid embedded holder identity")
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT
  if (root?.toLowerCase() !== "c:\\windows") throw new Error("The trusted Windows system directory is unavailable")
  const start = performance.now()
  const holder = await stageWindowsHolder({ ...asset, arch: context.arch }, deadline)
  if (!recorded) {
    recorded = true
    console.log("Verified private Windows holder staging elapsed ms: " + Math.round(performance.now() - start))
  }
  return holder
}
