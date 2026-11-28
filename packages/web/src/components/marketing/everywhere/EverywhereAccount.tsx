/** @jsxImportSource react */
import { useEffect, useMemo, useSyncExternalStore } from "react"
import { vectorAccountClient } from "../../../lib/account-client"
import { EverywhereAccountView } from "./EverywhereView"
import {
  connectAccountSession,
  createEverywhereAccountModel,
  focusJob,
  takeInstallIntent,
  takeOAuthReturn,
} from "./everywhere-model"
import "../account/account.css"
import "./everywhere.css"

/*
 * The root vectordev.ai/everywhere mounts with `client:only="react"` (the draft in src/drafts/everywhere.astro). It is
 * also the OAuth landing (PUB-8): the Slack and Linear callbacks redirect here with `#platform=…&code=…&state=…`, which
 * is taken out of the address bar before anything else and posted once to oauth-finish with the bearer token. It
 * follows the browser's Vector sign-in, which never reads the URL: the account client has `detectSessionInUrl: false`,
 * so the fragment is never taken for a sign-in. A link code is forgotten when the page is hidden for good. It is also
 * the documented directory install (spec 3.8): `?install=slack|linear` is taken out of the address bar and starts
 * Connect once the person is signed in and the lists are loaded; signed out, the sign-in link keeps it.
 */
export function EverywhereAccount() {
  const model = useMemo(
    () =>
      createEverywhereAccountModel({
        activity: true,
        signOut: () => vectorAccountClient().then((client) => client.auth.signOut({ scope: "local" })),
      }),
    [],
  )
  const state = useSyncExternalStore(model.subscribe, model.state, model.state)

  useEffect(() => {
    // Before the session is followed, so the return waits for it and is sent at most once.
    const place = { location: globalThis.location, history: globalThis.history }
    const back = takeOAuthReturn(place)
    if (back) void model.finishOAuth(back)
    // Taken either way, so it never starts on a reload; an OAuth return being finished wins over a new install.
    const install = takeInstallIntent(place)
    if (install && !back) void model.installOnReady(install)
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

  return (
    <EverywhereAccountView
      state={state}
      model={model}
      pathname={globalThis.location?.pathname ?? "/everywhere"}
      focus={focusJob(globalThis.location?.search)}
    />
  )
}
