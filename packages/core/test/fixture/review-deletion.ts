import { spawn } from "node:child_process"
import path from "node:path"
import { Schema } from "effect"
import type { ReviewRun } from "@vectordevai/schema/review-run"

const result = Schema.Struct({ lateAdmitted: Schema.Boolean })

/** Two barriers keep the real foreign process alive before and after settlement. */
export function foreignReview(input: { filename: string; parentID: string; request: ReviewRun.Start; runID: string }) {
  const child = spawn(
    process.execPath,
    [
      path.join(import.meta.dir, "review-deletion-probe.ts"),
      input.filename,
      input.parentID,
      JSON.stringify(input.request),
      input.runID,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  )
  let output = ""
  let errors = ""
  let readyResolve = () => {}
  let settledResolve = () => {}
  let readyReject: (error: Error) => void = () => {}
  let settledReject: (error: Error) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const settled = new Promise<void>((resolve, reject) => {
    settledResolve = resolve
    settledReject = reject
  })
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString()
    if (output.includes("READY\n")) readyResolve()
    if (output.includes("SETTLED\n")) settledResolve()
  })
  child.stderr.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-4000)
  })
  const done = new Promise<typeof result.Type>((resolve, reject) => {
    const fail = (error: Error) => {
      readyReject(error)
      settledReject(error)
      reject(error)
    }
    child.once("error", fail)
    child.once("close", (code) => {
      if (code !== 0) return fail(new Error(`Foreign review process exited ${code}: ${errors}`))
      try {
        const line = output.split("\n").find((line) => line.startsWith("RESULT "))
        if (!line) throw new Error("Foreign review process returned no result")
        resolve(Schema.decodeUnknownSync(result)(JSON.parse(line.slice(7))))
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
  void ready.catch(() => {})
  void settled.catch(() => {})
  void done.catch(() => {})
  return {
    ready,
    settled,
    done,
    settle: () => child.stdin.write("settle\n"),
    late: () => child.stdin.end("late\n"),
    stop: () => child.kill(),
  }
}
