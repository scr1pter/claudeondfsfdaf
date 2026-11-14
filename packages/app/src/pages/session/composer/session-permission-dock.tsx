import { For, Show } from "solid-js"
import type { PermissionRequest } from "@vectordevai/sdk/v2"
import { Button } from "@vectordevai/ui/button"
import { DockPrompt } from "@vectordevai/session-ui/dock-prompt"
import { Icon } from "@vectordevai/ui/icon"
import { connectConsentDetails } from "@/features/connect/consent"
import { useLanguage } from "@/context/language"
import { cloudPermissionScope, permissionStatements } from "./cloud-permission-scope"
import { canAlwaysAllowPermission } from "@/context/permission-policy"
import { readWorkflowAsk, reasonLine } from "@/features/background-tasks/workflow-model"
import { WorkflowPlanView } from "@/features/background-tasks/workflow-dialog"
import { terminalPermissionScope } from "./terminal-permission-scope"

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
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

      <Show when={connectConsentDetails(props.request)}>
        {(details) => (
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-hint" data-component="connect-permission-details">
              {details()}
            </div>
          </div>
        )}
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
