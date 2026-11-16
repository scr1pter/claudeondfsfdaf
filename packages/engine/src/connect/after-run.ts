export * as ConnectAfterRun from "./after-run"

import { ConfigConnectV1 } from "@vectordevai/core/v1/config/connect"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import type { Session } from "@/session/session"
import { SessionTaskSize } from "@/session/task-size"
import { Schema } from "effect"
import { Connect } from "@vectordevai/schema/connect"
import { MessageID } from "@/session/schema"

/** Engine-created provenance on the durable connect tool row, never on a synthetic user message. */
export const Marker = Schema.Struct({
  version: Schema.Literal(1),
  requestID: MessageID,
  reviewedThrough: MessageID,
  rounds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  mode: Schema.Literals(["report", "repair"]),
})
export type Marker = typeof Marker.Type

export interface History {
  requestID?: string
  reviewedThrough?: string
  rounds: number
  running: boolean
}

/** Restores the round fence from real assistant connect rows; live hub state wins over an older saved snapshot. */
export function history(messages: readonly SessionV1.WithParts[], runs: readonly Connect.Run[], requestID: string) {
  const records = messages.flatMap((message) =>
    message.info.role !== "assistant"
      ? []
      : message.parts.flatMap((part) => {
          if (part.type !== "tool" || part.tool !== "connect" || !("metadata" in part.state)) return []
          const marker = Schema.decodeUnknownOption(Marker)(part.state.metadata?.afterRun)
          const stored = Schema.decodeUnknownOption(Connect.Run)(part.state.metadata?.connect)
          if (marker._tag === "None" || stored._tag === "None" || marker.value.requestID !== requestID) return []
          const run = runs.find((run) => run.id === stored.value.id) ?? stored.value
          return [{ marker: marker.value, run }]
        }),
  )
  const latest = records.toSorted((left, right) => right.marker.rounds - left.marker.rounds)[0]
  return latest
    ? ({
        requestID,
        reviewedThrough: latest.marker.reviewedThrough,
        rounds: latest.marker.rounds,
        running: records.some(({ run }) => run.status !== "done"),
      } satisfies History)
    : undefined
}

/** No asynchronous work is admitted until a completed root build request actually changed files. */
export function eligible(input: {
  session: Pick<Session.Info, "parentID" | "internal" | "agent" | "revert">
  messages: readonly SessionV1.WithParts[]
  config?: ConfigConnectV1.Info
  previous?: History
  stopped: boolean
  guest: boolean
  requestID?: string
}) {
  const setting = ConfigConnectV1.review(input.config)
  if (
    setting.after_run === "off" ||
    input.stopped ||
    input.guest ||
    input.previous?.running ||
    input.session.parentID ||
    input.session.internal ||
    input.session.revert ||
    (input.session.agent ?? "build") !== "build"
  )
    return undefined
  const requests = SessionTaskSize.size({ messages: input.messages, caching: false, lifetime: 0 })
  const request = requests.at(-1)
  if (!request || SessionTaskSize.waiting(request)) return undefined
  const requestID = input.requestID ?? request.ledgerRequestID
  const last = request.messages.findLast((message) => message.info.role === "assistant")
  if (!last || last.info.role !== "assistant" || last.info.error || !last.info.time.completed) return undefined
  const judge = SessionTaskSize.judgeRuns(request).at(-1)?.part
  if (judge && judge.state.status !== "completed") return undefined
  if (
    judge &&
    typeof judge.metadata?.judge === "object" &&
    judge.metadata.judge !== null &&
    "verdict" in judge.metadata.judge &&
    judge.metadata.judge.verdict === "FAIL"
  )
    return undefined
  const same = input.previous?.requestID === requestID
  const rounds = same ? input.previous!.rounds : 0
  if (rounds >= setting.max_rounds) return undefined
  const files = SessionTaskSize.changedFiles(request, same ? input.previous?.reviewedThrough : undefined)
  // Read judgeable for its existing request grouping when enabled; its absence never overrides a person's separate review setting.
  const judged = SessionTaskSize.judgeable(requests, same ? (input.previous?.reviewedThrough ?? "") : "")
  if (!files.length && !judged?.files.length) return undefined
  return { requestID, reviewedThrough: last.info.id, rounds: rounds + 1, running: true, mode: setting.after_run }
}
