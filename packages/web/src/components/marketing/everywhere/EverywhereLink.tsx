/** @jsxImportSource react */
import { useEffect, useMemo, useSyncExternalStore } from "react"
import { vectorAccountClient } from "../../../lib/account-client"
import { EverywhereLinkView } from "./EverywhereView"
import { connectAccountSession, createEverywhereAccountModel } from "./everywhere-model"
import "../account/account.css"
import "./everywhere.css"

/*
 * The root vectordev.ai/everywhere/link mounts with `client:only="react"` (the draft in src/drafts/everywhere/link.astro):
 * the Linear sign-in that links the signed-in account (3.8). It starts the same sign-in as the /everywhere page's
 * "Link with Linear sign-in" (`startLink`), and Linear's return lands on /everywhere, which finishes it. It loads no
 * jobs or audit log.
 */
export function EverywhereLink() {
  const model = useMemo(
    () =>
      createEverywhereAccountModel({
        signOut: () => vectorAccountClient().then((client) => client.auth.signOut({ scope: "local" })),
      }),
    [],
  )
  const state = useSyncExternalStore(model.subscribe, model.state, model.state)

  useEffect(() => {
    const disconnect = connectAccountSession(
      model,
      vectorAccountClient().then((client) => client.auth),
    )
    return () => {
      disconnect()
      model.close()
    }
  }, [model])

  return (
    <EverywhereLinkView state={state} model={model} pathname={globalThis.location?.pathname ?? "/everywhere/link"} />
  )
}
