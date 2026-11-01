import { createMemo, createResource, type Accessor } from "solid-js"
import type { Session, Message } from "@vectordevai/sdk/v2/client"
import { useSDK } from "@/context/sdk"
import { delegatedSpend, sessionSpend, sessionTokens } from "@/utils/session-cost"
import { isInternalSession } from "@/utils/internal-sessions"

// What a session delegated, named per Vector helper. Helper sessions are in no list, so they are read as the session's
// children, again whenever its rolled-up spend moves while the breakdown is shown. Autocomplete moves it on nearly
// every pause in typing, so a breakdown behind a hover only reads while hovered.
export function createDelegatedSpend(
  info: Accessor<Session | undefined>,
  shown: Accessor<boolean> = () => true,
  messages: Accessor<readonly Message[]> = () => [],
) {
  const sdk = useSDK()
  // A string, so an update that leaves the delegated spend unchanged does not read the children again.
  const revision = createMemo(() => {
    const session = info()
    if (!shown()) return
    if (
      !session ||
      !(session.subagentCost || session.subagentUnpricedSteps || session.subagentTokens || session.subagentCodiumSteps)
    )
      return
    return [
      session.id,
      session.subagentCost ?? 0,
      session.subagentUnpricedSteps ?? 0,
      session.subagentCodiumSteps ?? 0,
      sessionTokens({ tokens: session.subagentTokens }),
    ].join(" ")
  })
  const [children] = createResource(revision, (key) => {
    const sessionID = key.split(" ")[0] ?? ""
    return sdk()
      .client.session.children({ sessionID })
      .then(
        (result) => ({ sessionID, sessions: result.data ?? [] }),
        () => undefined,
      )
  })
  return createMemo(() => {
    const loaded = children.latest?.sessionID === info()?.id ? children.latest?.sessions : undefined
    // Until the children are read, what was delegated cannot be split between helpers and subagents.
    return {
      ...delegatedSpend(info(), loaded ?? [], messages()),
      split: loaded !== undefined,
      sessions: loaded ?? [],
      children: (loaded ?? [])
        .filter((session) => !isInternalSession(session))
        .map((session) => ({
          id: session.id,
          label: session.title.replace(/\s*\(@[^)]+ subagent\)\s*$/, ""),
          ...sessionSpend(session),
          tokens: sessionTokens(session),
        }))
        .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    }
  })
}
