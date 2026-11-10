import { createMemo, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Hands } from "@vectordevai/schema/hands"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import type { PermissionRequest } from "@vectordevai/sdk/v2"
import { Button } from "@vectordevai/ui/button"
import { DockPrompt } from "@vectordevai/session-ui/dock-prompt"
import { Icon } from "@vectordevai/ui/icon"
import { useLanguage } from "@/context/language"
import { cloudPermissionScope, permissionStatements } from "./cloud-permission-scope"
import { canAlwaysAllowPermission } from "@/context/permission-policy"
import { computerAsk } from "@/features/computer/ask-model"
import "./session-permission-dock.css"
import { readWorkflowAsk, reasonLine } from "@/features/background-tasks/workflow-model"
import { WorkflowPlanView } from "@/features/background-tasks/workflow-dialog"
import { terminalPermissionScope } from "./terminal-permission-scope"

type PermissionDockProps = {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void | Promise<boolean>
}

export function SessionPermissionDock(props: PermissionDockProps) {
  return (
    <Show when={PermissionPolicy.handsAsk(props.request.permission)} fallback={<GenericPermissionDock {...props} />}>
      <Show when={props.request.id} keyed>
        {(requestID) => <ComputerPermissionDock {...props} requestID={requestID} />}
      </Show>
    </Show>
  )
}

function GenericPermissionDock(props: PermissionDockProps) {
  const language = useLanguage()

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }
  const cloudScope = () => cloudPermissionScope(props.request)
  const statements = () => permissionStatements(props.request)
  const terminalScope = () => terminalPermissionScope(props.request)
  // A workflow ask carries its plan. Always allow shows only for a plan within the configured defaults ("run"); any
  // other pattern asks every time, and the reason line says why (G.3, I15).
  const workflow = () => readWorkflowAsk(props.request)
  const canAlways = () => {
    const ask = workflow()
    if (ask) return ask.canAlways
    return canAlwaysAllowPermission(props.request.permission, props.request.always)
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Show when={canAlways()}>
              <Button
                variant="secondary"
                size="normal"
                onClick={() => props.onDecide("always")}
                disabled={props.responding}
              >
                {language.t("ui.permission.allowAlways")}
              </Button>
            </Show>
            <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={workflow()}>
        {(ask) => (
          <>
            <Show when={ask().plan}>
              {(plan) => (
                <div data-slot="permission-row">
                  <span data-slot="permission-spacer" aria-hidden="true" />
                  <WorkflowPlanView plan={plan()} delegated={ask().delegated} />
                </div>
              )}
            </Show>
            <Show when={reasonLine(ask())}>
              {(line) => (
                <div data-slot="permission-row">
                  <span data-slot="permission-spacer" aria-hidden="true" />
                  <div data-slot="permission-hint" data-component="workflow-permission-reason">
                    {line()}
                  </div>
                </div>
              )}
            </Show>
          </>
        )}
      </Show>

      <Show when={cloudScope()}>
        {(scope) => (
          <>
            <Show when={scope().summary}>
              <div data-slot="permission-row">
                <span data-slot="permission-spacer" aria-hidden="true" />
                <div data-slot="permission-hint">{scope().summary}</div>
              </div>
            </Show>
            <Show when={scope().rows.length > 0}>
              <div data-slot="permission-row">
                <span data-slot="permission-spacer" aria-hidden="true" />
                <div data-slot="permission-patterns">
                  <For each={scope().rows}>
                    {(row) => (
                      <code class="text-12-regular text-text-base break-all">
                        {row.label}: {row.value}
                      </code>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </>
        )}
      </Show>

      <Show when={terminalScope()}>
        {(scope) => (
          <>
            <Show when={scope().terminal || scope().action}>
              <div data-slot="permission-row">
                <span data-slot="permission-spacer" aria-hidden="true" />
                <div data-slot="permission-patterns">
                  <Show when={scope().terminal}>
                    {(terminal) => (
                      <code class="text-12-regular text-text-base break-all">
                        {language.t("session.permission.terminal.name")}: {terminal()}
                      </code>
                    )}
                  </Show>
                  <Show when={scope().action}>
                    {(action) => (
                      <div data-slot="permission-hint">
                        {language.t(`session.permission.terminal.action.${action()}`)}
                      </div>
                    )}
                  </Show>
                </div>
              </div>
            </Show>
            <Show when={scope().text !== undefined}>
              <div data-slot="permission-row">
                <span data-slot="permission-spacer" aria-hidden="true" />
                <div data-slot="permission-statement">
                  <div class="text-12-medium text-text-base">{language.t("session.permission.terminal.text")}</div>
                  <pre class="text-12-regular text-text-base max-h-48 overflow-auto whitespace-pre-wrap break-words">
                    {scope().text}
                  </pre>
                  <Show when={scope().enter}>
                    <div data-slot="permission-hint">{language.t("session.permission.terminal.enter")}</div>
                  </Show>
                </div>
              </div>
            </Show>
            <Show when={scope().keys.length > 0}>
              <div data-slot="permission-row">
                <span data-slot="permission-spacer" aria-hidden="true" />
                <div data-slot="permission-statement">
                  <div class="text-12-medium text-text-base">{language.t("session.permission.terminal.keys")}</div>
                  <pre class="text-12-regular text-text-base whitespace-pre-wrap break-words">
                    {scope().keys.join(" ")}
                  </pre>
                </div>
              </div>
            </Show>
          </>
        )}
      </Show>

      <For each={statements()}>
        {(item) => (
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-statement">
              <div class="text-12-medium text-text-base">{item.label}</div>
              <pre class="text-12-regular text-text-base max-h-48 overflow-auto whitespace-pre-wrap break-words">
                {item.sql}
              </pre>
              <Show when={item.note}>
                <div data-slot="permission-hint">{item.note}</div>
              </Show>
            </div>
          </div>
        )}
      </For>

      <Show when={!cloudScope() && !workflow() && props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.patterns}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}

function ComputerPermissionDock(props: PermissionDockProps & { requestID: string }) {
  const language = useLanguage()
  const requestID = props.requestID
  const model = createMemo(() => computerAsk(props.request, { t: language.t }))
  const [state, setState] = createStore({ armed: false, decided: false })
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  onMount(() => {
    timer = setTimeout(() => setState("armed", true), model()?.armMs ?? 700)
  })
  onCleanup(() => {
    disposed = true
    clearTimeout(timer)
  })

  const decide = async (response: "once" | "always" | "reject") => {
    if (disposed || props.request.id !== requestID || props.responding || state.decided) return
    if (response !== "reject" && (!state.armed || !model())) return
    if (response === "always" && !model()?.canAlways) return
    setState("decided", true)
    // Acknowledged replies stay latched while the permission-removal event is in flight. Only an explicit
    // network failure unlocks this same request for retry; a stale completion cannot unlock its replacement.
    const retry = () => {
      if (!disposed && props.request.id === requestID) setState("decided", false)
    }
    try {
      if ((await props.onDecide(response)) === false) retry()
    } catch {
      retry()
    }
  }
  const click = (response: "once" | "always" | "reject", event: MouseEvent) => {
    if (!model()?.enterAllowed && event.detail === 0) return
    void decide(response)
  }
  const onKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    if (!event.currentTarget.contains(document.activeElement)) return
    if (editable(event.target) || editable(document.activeElement)) return
    if (event.key !== "Enter" && event.key !== "Escape" && event.key !== " ") return
    if (event.key === " " && model()?.enterAllowed) return
    // Suppress the native button activation too: sensitive asks respond only to pointer clicks, and an
    // early Enter on Deny must not bypass the dock's shared keyboard delay.
    event.preventDefault()
    event.stopPropagation()
    if (!model()?.enterAllowed || !state.armed) return
    if (event.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    void decide(event.key === "Escape" ? "reject" : "once")
  }
  const disabled = () => props.responding || state.decided
  const approvalDisabled = () => disabled() || !state.armed || !model()

  return (
    <DockPrompt
      kind="permission"
      onKeyDown={onKeyDown}
      header={
        <div data-slot="permission-row" data-variant="header" data-computer-ask={model()?.kind ?? "invalid"}>
          <span data-slot="permission-icon">
            <Show when={model()?.icon} fallback={<Icon name="warning" size="normal" />}>
              {(icon) => <img src={icon()} alt="" width="20" height="20" />}
            </Show>
          </span>
          <div data-slot="permission-header-title" role="heading" aria-level="2">
            {model()?.title ?? language.t("computer.name", { name: Hands.NAME })}
          </div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button
              variant="ghost"
              size="normal"
              onClick={(event: MouseEvent) => click("reject", event)}
              disabled={disabled()}
            >
              {language.t("computer.action.deny")}
            </Button>
            <Show when={model()?.canAlways}>
              <Button
                variant="secondary"
                size="normal"
                onClick={(event: MouseEvent) => click("always", event)}
                disabled={approvalDisabled()}
              >
                {language.t("computer.action.alwaysAllow")}
              </Button>
            </Show>
            <Show when={model()}>
              {(ask) => (
                <Button
                  variant="primary"
                  size="normal"
                  data-computer-arming={!state.armed ? "true" : undefined}
                  onClick={(event: MouseEvent) => click("once", event)}
                  disabled={approvalDisabled()}
                >
                  {ask().primaryLabel}
                </Button>
              )}
            </Show>
          </div>
        </>
      }
    >
      <Show when={model()}>
        {(ask) => (
          <div data-slot="computer-permission-details">
            <Show when={ask().body}>
              <p>{ask().body}</p>
            </Show>
            <Show when={ask().kind === "app" && ask().publisher.verified && ask().publisher.name}>
              {(publisher) => <p>{language.t("computer.ask.publisher", { publisher: publisher() })}</p>}
            </Show>
            <Show when={ask().mentioned}>
              <p>{ask().mentioned}</p>
            </Show>
            <For each={ask().warnings}>{(warning) => <p data-variant="warning">{warning}</p>}</For>
            <Show when={ask().reason}>
              <p>{ask().reason}</p>
            </Show>
            <Show when={ask().agentSays}>
              <p>{ask().agentSays}</p>
            </Show>
            <Show when={ask().alwaysHint}>
              <p data-variant="hint">{ask().alwaysHint}</p>
            </Show>
            <Show when={ask().alwaysWhyNot}>
              <p data-variant="hint">{ask().alwaysWhyNot}</p>
            </Show>
          </div>
        )}
      </Show>
    </DockPrompt>
  )
}

function editable(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
  )
}
