import { parentPort, workerData } from "node:worker_threads"
import { BrainOcr } from "@vectordevai/core/brain/document/ocr"
import { BrainLimits } from "@vectordevai/core/brain/document/limits"

// Bun delivers parent-port messages after module initialization, as the real reader's request handler does.
setImmediate(async () => {
  const session = await BrainOcr.open(workerData, BrainLimits.LIMITS.worker)
  const result = await session?.read(1)
  await session?.close()
  parentPort?.postMessage({ type: "ocr-proof", result: result ?? { type: "unread" } })
})
