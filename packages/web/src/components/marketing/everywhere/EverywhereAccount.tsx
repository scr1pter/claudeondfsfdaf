/** @jsxImportSource react */
import { useEffect, useMemo, useSyncExternalStore } from "react"
import { vectorAccountClient } from "../../../lib/account-client"
import { EverywhereAccountView } from "./EverywhereView"
import { connectAccountSession, createEverywhereAccountModel } from "./everywhere-model"
import "../account/account.css"
import "./everywhere.css"

/*
 * The root a vectordev.ai/everywhere page mounts with `client:only="react"` (EV-23). It follows the browser's Vector
 * sign-in and never reads the URL: the account client has `detectSessionInUrl: false`, so an OAuth landing's fragment
 * is never taken for a sign-in. A link code is forgotten when the page is hidden for good.
 */
export function EverywhereAccount() {
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
    const forget = () => model.forgetCode()
    globalThis.addEventListener("pagehide", forget)
    return () => {
      disconnect()
      globalThis.removeEventListener("pagehide", forget)
      model.close()
    }
  }, [model])

  return <EverywhereAccountView state={state} model={model} pathname={globalThis.location?.pathname ?? "/everywhere"} />
}
