import { Show, type JSX } from "solid-js"
import type { QuestionRequest } from "@vectordevai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { ResearchPlanCard } from "@/features/research/plan-card"
import { planCard, planPart } from "@/features/research/research-model"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import { SessionInterruptedDock } from "@/pages/session/composer/session-interrupted-dock"
import { SessionRevertDock } from "@/pages/session/composer/session-revert-dock"
import { SessionWorkingStatus } from "@/pages/session/composer/session-working-status"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"
import { useBackgroundTasks } from "@/features/background-tasks/use-background-tasks"
import { workingLine } from "@/features/background-tasks/computer-card-model"
import { useComputerState } from "@/features/computer/use-computer-state"
import { Hands } from "@vectordevai/schema/hands"
import type { SessionComposerRegionController } from "./session-composer-region-controller"

export function SessionComposerRegion(props: {
  controller: SessionComposerRegionController
  promptInput: JSX.Element
}) {
  const language = useLanguage()
  const sync = useSync()
  const controller = props.controller
  // A research_plan question is the plan card: the plan as Vector would run it is on its running part.
  const plan = (request: QuestionRequest) => {
    const part = planPart(sync().data.part?.[request.tool?.messageID ?? ""], request.tool)
    return part && "metadata" in part.state ? planCard(part.state.metadata) : undefined
  }
  // The same count as the header's Tasks button, so the two never disagree.
  const backgroundTasks = useBackgroundTasks()
  const runningTasks = () => backgroundTasks?.runningCount() ?? controller.runningTasks()
  // "Using Numbers" while this conversation holds the computer, "Waiting for the computer" while it is queued.
  const computerState = useComputerState()
  const computer = () => {
    const line = workingLine(computerState?.state(), controller.sessionID())
    return line && language.t(line.key, { name: Hands.NAME, ...line.params })
  }
  const rolled = () => {
    const revert = controller.revert()
    return revert?.items.length ? revert : undefined
  }

  return (
    <div
      ref={controller.setDockRef}
      data-component="session-prompt-dock"
      classList={{
        "w-full shrink-0 flex flex-col justify-center items-center pointer-events-none": true,
        "bg-transparent": true,
      }}
    >
      <div
        data-component="session-composer-region"
        classList={{
          "w-full pointer-events-auto": true,
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": controller.centered(),
        }}
      >
        <SessionWorkingStatus
          working={controller.working}
          startedAt={controller.startedAt}
          tokens={controller.tokens}
          codium={controller.codium}
          runningTasks={runningTasks}
          computer={computer}
          phrase={controller.phrase}
        />

        <Show when={controller.state.questionRequest()} keyed>
          {(request) => (
            <div>
              <Show
                when={plan(request)}
                fallback={<SessionQuestionDock request={request} onSubmit={controller.onResponseSubmit} />}
              >
                {(data) => <ResearchPlanCard request={request} data={data()} onSubmit={controller.onResponseSubmit} />}
              </Show>
            </div>
          )}
        </Show>

        <Show when={controller.state.permissionRequest()?.id} keyed>
          {(requestID) => (
            <div>
              <SessionPermissionDock
                request={controller.state.permissionRequest()!}
                responding={controller.state.permissionResponding()}
                onDecide={(response) => {
                  controller.onResponseSubmit()
                  return controller.state.decide(response, requestID)
                }}
              />
            </div>
          )}
        </Show>

        <Show when={controller.showComposer()}>
          <Show when={controller.dock()}>
            <div
              classList={{
                "overflow-hidden": true,
                "pointer-events-none": controller.dockProgress() < 0.98,
              }}
              style={{
                "max-height": `${controller.dockHeight() * controller.dockProgress()}px`,
              }}
            >
              <div ref={controller.setDockBodyRef}>
                <SessionTodoDock
                  todos={controller.state.todos()}
                  collapsed={controller.todo.collapsed()}
                  onToggle={controller.todo.onToggle}
                  collapseLabel={language.t("session.todo.collapse")}
                  expandLabel={language.t("session.todo.expand")}
                  dockProgress={controller.dockProgress()}
                />
              </div>
            </div>
          </Show>
          <Show
            when={controller.promptReady()}
            fallback={
              <>
                <Show when={rolled()} keyed>
                  {(revert) => (
                    <div class="pb-2">
                      <SessionRevertDock
                        items={revert.items}
                        restoring={revert.restoring}
                        disabled={revert.disabled}
                        onRestore={revert.onRestore}
                      />
                    </div>
                  )}
                </Show>
                <div
                  class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none"
                  style={{ "margin-top": `${-36 * controller.dockProgress()}px` }}
                >
                  {controller.handoffPrompt() || language.t("prompt.loading")}
                </div>
              </>
            }
          >
            <Show when={rolled()} keyed>
              {(revert) => (
                <div
                  style={{
                    "margin-top": `${-36 * controller.dockProgress()}px`,
                  }}
                >
                  <SessionRevertDock
                    items={revert.items}
                    restoring={revert.restoring}
                    disabled={revert.disabled}
                    onRestore={revert.onRestore}
                  />
                </div>
              )}
            </Show>
            <div
              classList={{
                "relative z-[70]": true,
              }}
              style={{
                "margin-top": `${-controller.lift()}px`,
              }}
            >
              <Show when={controller.interrupted()} keyed>
                {(dock) => (
                  <SessionInterruptedDock
                    count={dock.count}
                    resumable={dock.resumable}
                    resuming={dock.resuming}
                    onResumeAll={dock.onResumeAll}
                    onDismiss={dock.onDismiss}
                  />
                )}
              </Show>
              <Show when={controller.followup()?.items.length}>
                <SessionFollowupDock
                  items={controller.followup()!.items}
                  sending={controller.followup()!.sending}
                  paused={controller.followup()!.paused}
                  onSend={controller.followup()!.onSend}
                  onDelete={controller.followup()!.onDelete}
                  onResume={controller.followup()!.onResume}
                />
              </Show>
              <Show
                when={controller.child()}
                fallback={<Show when={controller.state.promptAllowed()}>{props.promptInput}</Show>}
              >
                <div
                  ref={controller.setPromptRef}
                  data-component="session-child-notice"
                  class="w-full rounded-[12px] border border-border-weak-base bg-background-base p-3 text-16-regular text-text-weak"
                >
                  <span>{language.t("session.child.notice")} </span>
                  <Show when={backgroundTasks}>
                    <button
                      type="button"
                      class="text-text-base transition-colors hover:text-text-strong"
                      onClick={controller.talkToChild}
                    >
                      {language.t("session.child.talk")}
                    </button>
                    <span aria-hidden="true"> · </span>
                  </Show>
                  <Show when={controller.parentID()}>
                    <button
                      type="button"
                      class="text-text-base transition-colors hover:text-text-strong"
                      onClick={controller.openParent}
                    >
                      {language.t("session.child.backToParent")}
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
