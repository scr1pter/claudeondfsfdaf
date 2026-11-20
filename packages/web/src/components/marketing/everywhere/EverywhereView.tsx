/** @jsxImportSource react */
import { useState } from "react"
import {
  EVERYWHERE_COPY,
  PLATFORM_NAMES,
  formatDay,
  installationLabel,
  placeLabel,
  signInPath,
  type EverywhereAccountModel,
  type EverywhereInstall,
  type EverywhereMapping,
  type EverywhereReady,
  type EverywhereState,
} from "./everywhere-model"

/*
 * The account's Vector everywhere controls: a pure render of the model's state. Every action goes through the model,
 * which talks only to the account routes. There is no <form> anywhere, so no browser fallback can send a code in a
 * query string, and no allowlist (Q2).
 */

type Props = { readonly state: EverywhereState; readonly model: EverywhereAccountModel; readonly pathname: string }

export function EverywhereAccountView(props: Props) {
  const state = props.state
  if (state.kind === "loading") return <p className="everywhere-status">{EVERYWHERE_COPY.loading}</p>
  if (state.kind === "signed-out")
    return (
      <section className="acct-section">
        <p>{EVERYWHERE_COPY.signIn}</p>
        <a className="acct-button" href={signInPath(props.pathname)}>
          {EVERYWHERE_COPY.signInButton}
        </a>
      </section>
    )
  if (state.kind === "session-expired")
    return (
      <section className="acct-section">
        <p>{EVERYWHERE_COPY.expired}</p>
        <button className="acct-button" type="button" onClick={() => void props.model.signInAgain(props.pathname)}>
          {EVERYWHERE_COPY.expiredButton}
        </button>
      </section>
    )
  if (state.kind === "accounts-unavailable")
    return <p className="account-error">{EVERYWHERE_COPY.accountsUnavailable}</p>
  if (state.kind === "off") return <p className="everywhere-status">{EVERYWHERE_COPY.off}</p>
  return (
    <div className="everywhere">
      {state.notice && (
        <p className="auth-notice" role="status">
          {EVERYWHERE_COPY.notice[state.notice]}
        </p>
      )}
      {state.problem && (
        <p className="account-error" role="alert">
          {EVERYWHERE_COPY.problem[state.problem]}
        </p>
      )}
      {!state.loaded && !state.problem && <p className="everywhere-status">{EVERYWHERE_COPY.loading}</p>}
      {!state.loaded && state.problem && (
        <button className="acct-button acct-button-secondary" type="button" onClick={() => void props.model.refresh()}>
          {EVERYWHERE_COPY.retry}
        </button>
      )}
      {state.loaded && (
        <>
          {state.partial && <p className="acct-fine">{EVERYWHERE_COPY.partial}</p>}
          <InstallsSection state={state} model={props.model} />
          <LinksSection state={state} model={props.model} />
          <MappingsSection state={state} model={props.model} />
        </>
      )}
    </div>
  )
}

type SectionProps = { readonly state: EverywhereReady; readonly model: EverywhereAccountModel }

function InstallsSection(props: SectionProps) {
  const state = props.state
  return (
    <section className="acct-section">
      <h2>{EVERYWHERE_COPY.installsHeading}</h2>
      {state.installs.length === 0 && <p>{EVERYWHERE_COPY.installsEmpty}</p>}
      {state.installs.length > 0 && (
        <ul className="everywhere-list">
          {state.installs.map((install) => (
            <li key={install.installation}>
              <InstallRow install={install} state={state} model={props.model} />
            </li>
          ))}
        </ul>
      )}
      <div className="acct-actions">
        <button
          className="acct-button acct-button-secondary"
          type="button"
          disabled={state.busy}
          onClick={() => void props.model.startInstall("slack")}
        >
          {EVERYWHERE_COPY.connectSlack}
        </button>
        <button
          className="acct-button acct-button-secondary"
          type="button"
          disabled={state.busy}
          onClick={() => void props.model.startInstall("linear")}
        >
          {EVERYWHERE_COPY.connectLinear}
        </button>
      </div>
      <JiraConnect busy={state.busy} model={props.model} />
    </section>
  )
}

function InstallRow(props: { readonly install: EverywhereInstall } & SectionProps) {
  const install = props.install
  const label = installationLabel(install.installation)
  const asked =
    props.state.confirm?.action === "disconnect" && props.state.confirm.installation === install.installation
  // A retry finishes an interrupted disconnect; after an unconfirmed revoke a retry would change nothing.
  const canDisconnect = install.nextAction !== "review-native-revocation"
  return (
    <>
      <p className="everywhere-row">
        <strong>{PLATFORM_NAMES[install.platform]}</strong> <span>{label}</span>
      </p>
      <p className="acct-fine">Connected {formatDay(install.installedAt)}</p>
      {install.scopes.length > 0 && <p className="acct-fine">Scopes: {install.scopes.join(", ")}</p>}
      {install.nextAction === "retry-disconnect" && <p className="acct-fine">{EVERYWHERE_COPY.retryDisconnect}</p>}
      {install.nextAction === "review-native-revocation" && (
        <p className="acct-fine">{EVERYWHERE_COPY.reviewRevocation}</p>
      )}
      {canDisconnect && !asked && (
        <button
          className="acct-button acct-button-secondary"
          type="button"
          aria-label={`${EVERYWHERE_COPY.disconnect} ${label}`}
          disabled={props.state.busy}
          onClick={() => props.model.ask({ action: "disconnect", installation: install.installation })}
        >
          {EVERYWHERE_COPY.disconnect}
        </button>
      )}
      {canDisconnect && asked && (
        <Confirm
          text={EVERYWHERE_COPY.disconnectConfirm}
          action={EVERYWHERE_COPY.disconnect}
          busy={props.state.busy}
          model={props.model}
        />
      )}
    </>
  )
}

function JiraConnect(props: { readonly busy: boolean; readonly model: EverywhereAccountModel }) {
  const [code, setCode] = useState("")
  return (
    <div className="everywhere-field">
      <label htmlFor="everywhere-jira-code">{EVERYWHERE_COPY.jiraLabel}</label>
      <p className="acct-fine">{EVERYWHERE_COPY.jiraHint}</p>
      <div className="everywhere-field-row">
        <input
          id="everywhere-jira-code"
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <button
          className="acct-button acct-button-secondary"
          type="button"
          disabled={props.busy || !code.trim()}
          onClick={() => {
            const typed = code
            setCode("")
            void props.model.connectJira(typed)
          }}
        >
          {EVERYWHERE_COPY.connectJira}
        </button>
      </div>
    </div>
  )
}

function LinksSection(props: SectionProps) {
  const state = props.state
  const code = state.code
  return (
    <section className="acct-section">
      <h2>{EVERYWHERE_COPY.linksHeading}</h2>
      {state.links.length === 0 && <p>{EVERYWHERE_COPY.linksEmpty}</p>}
      {state.links.length > 0 && (
        <ul className="everywhere-list">
          {state.links.map((link) => {
            const label = installationLabel(link.installation)
            return (
              <li key={`${link.installation} ${link.userId}`}>
                <p className="everywhere-row">
                  <strong>{PLATFORM_NAMES[link.platform]}</strong> <span>{label}</span>{" "}
                  <span>
                    user <code>{link.userId}</code>
                  </span>
                </p>
                <p className="acct-fine">Linked {formatDay(link.linkedAt)}</p>
                <button
                  className="acct-button acct-button-secondary"
                  type="button"
                  aria-label={`${EVERYWHERE_COPY.unlink} ${link.userId} in ${label}`}
                  disabled={state.busy}
                  onClick={() => void props.model.unlink(link.installation, link.userId)}
                >
                  {EVERYWHERE_COPY.unlink}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="acct-actions">
        <button
          className="acct-button acct-button-secondary"
          type="button"
          onClick={() => void props.model.issueCode("slack")}
        >
          {EVERYWHERE_COPY.slackCode}
        </button>
        <button
          className="acct-button acct-button-secondary"
          type="button"
          onClick={() => void props.model.issueCode("jira")}
        >
          {EVERYWHERE_COPY.jiraCode}
        </button>
        <button
          className="acct-button acct-button-secondary"
          type="button"
          disabled={state.busy}
          onClick={() => void props.model.startLink()}
        >
          {EVERYWHERE_COPY.linearLink}
        </button>
      </div>
      {code && (
        <div className="everywhere-code">
          <p className="acct-fine">{EVERYWHERE_COPY.codeSend}</p>
          <div className="acct-code-row">
            <code>{`link ${code.code}`}</code>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(`link ${code.code}`)}>
              {EVERYWHERE_COPY.copy}
            </button>
            <button type="button" onClick={() => props.model.forgetCode()}>
              {EVERYWHERE_COPY.hide}
            </button>
          </div>
          <p className="acct-fine">{EVERYWHERE_COPY.codeNote[code.platform]}</p>
          <p className="acct-fine">{EVERYWHERE_COPY.codeExpiry}</p>
        </div>
      )}
    </section>
  )
}

function MappingsSection(props: SectionProps) {
  const state = props.state
  const open = state.installs.filter((install) => install.status === undefined)
  const mapped = open.filter((install) => (state.mappings[install.installation] ?? []).length > 0)
  // A connection whose read failed is named, so "no place" is said only when every read answered.
  const unread = open.filter((install) => state.unread.includes(install.installation))
  return (
    <section className="acct-section">
      <h2>{EVERYWHERE_COPY.mappingsHeading}</h2>
      {mapped.length === 0 && unread.length === 0 && <p>{EVERYWHERE_COPY.mappingsEmpty}</p>}
      {unread.map((install) => (
        <div className="everywhere-group" key={install.installation}>
          <h3>{installationLabel(install.installation)}</h3>
          <p className="acct-fine">{EVERYWHERE_COPY.mappingsUnread}</p>
        </div>
      ))}
      {mapped.map((install) => (
        <div className="everywhere-group" key={install.installation}>
          <h3>{installationLabel(install.installation)}</h3>
          <ul className="everywhere-list">
            {(state.mappings[install.installation] ?? []).map((mapping) => (
              <li key={mapping.place}>
                <MappingRow install={install} mapping={mapping} state={state} model={props.model} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      {open.some((install) => install.platform === "slack") && (
        <p className="acct-fine">{EVERYWHERE_COPY.slackMappingHint}</p>
      )}
      {open.some((install) => install.platform !== "slack") && (
        <p className="acct-fine">{EVERYWHERE_COPY.trackerMappingHint}</p>
      )}
    </section>
  )
}

function MappingRow(
  props: { readonly install: EverywhereInstall; readonly mapping: EverywhereMapping } & SectionProps,
) {
  const install = props.install
  const mapping = props.mapping
  const confirm = props.state.confirm
  const here =
    confirm !== undefined &&
    confirm.action !== "disconnect" &&
    confirm.installation === install.installation &&
    confirm.place === mapping.place
  return (
    <>
      <p className="everywhere-row">
        <strong>{placeLabel(install.platform, mapping.place)}</strong>
      </p>
      {mapping.repositories.length === 0 && <p className="acct-fine">{EVERYWHERE_COPY.noRepositories}</p>}
      {mapping.repositories.length > 0 && (
        <ul className="everywhere-repositories">
          {mapping.repositories.map((repository) => {
            // Narrowing a mapping sends the other repositories back, and the server needs each one's verified id.
            const droppable = mapping.repositories.every((other) => other === repository || other.id !== undefined)
            const asked = here && confirm.action === "drop-repository" && confirm.fullName === repository.fullName
            return (
              <li key={repository.fullName}>
                <code>{repository.fullName}</code>
                {repository.id === undefined && <span className="acct-fine"> {EVERYWHERE_COPY.unknownId}</span>}
                {droppable && !asked && (
                  <button
                    className="acct-button acct-button-secondary"
                    type="button"
                    aria-label={`${EVERYWHERE_COPY.removeRepository} ${repository.fullName} from ${placeLabel(install.platform, mapping.place)}`}
                    disabled={props.state.busy}
                    onClick={() =>
                      props.model.ask({
                        action: "drop-repository",
                        installation: install.installation,
                        place: mapping.place,
                        fullName: repository.fullName,
                      })
                    }
                  >
                    {EVERYWHERE_COPY.removeRepository}
                  </button>
                )}
                {asked && (
                  <Confirm
                    text={EVERYWHERE_COPY.dropRepositoryConfirm}
                    action={EVERYWHERE_COPY.remove}
                    busy={props.state.busy}
                    model={props.model}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
      {install.platform !== "slack" && (
        <>
          <p className="acct-fine">{mapping.private ? EVERYWHERE_COPY.markedPrivate : EVERYWHERE_COPY.notPrivate}</p>
          <p className="acct-fine">{EVERYWHERE_COPY.privateNote}</p>
        </>
      )}
      <p className="acct-fine">
        Set {formatDay(mapping.setAt)}
        {mapping.setByYou ? " by you" : ""}
      </p>
      {here && confirm.action === "remove-mapping" ? (
        <Confirm
          text={EVERYWHERE_COPY.removeMappingConfirm}
          action={EVERYWHERE_COPY.remove}
          busy={props.state.busy}
          model={props.model}
        />
      ) : (
        <button
          className="acct-button acct-button-secondary"
          type="button"
          aria-label={`${EVERYWHERE_COPY.removeMapping} for ${placeLabel(install.platform, mapping.place)}`}
          disabled={props.state.busy}
          onClick={() =>
            props.model.ask({ action: "remove-mapping", installation: install.installation, place: mapping.place })
          }
        >
          {EVERYWHERE_COPY.removeMapping}
        </button>
      )}
    </>
  )
}

function Confirm(props: {
  readonly text: string
  readonly action: string
  readonly busy: boolean
  readonly model: EverywhereAccountModel
}) {
  return (
    <div className="everywhere-confirm" role="group">
      <p className="acct-fine">{props.text}</p>
      <div className="acct-actions">
        <button className="acct-button" type="button" disabled={props.busy} onClick={() => void props.model.confirm()}>
          {props.action}
        </button>
        <button className="acct-button acct-button-secondary" type="button" onClick={() => props.model.cancel()}>
          {EVERYWHERE_COPY.keep}
        </button>
      </div>
    </div>
  )
}
