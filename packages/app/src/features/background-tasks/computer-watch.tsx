import { Show } from "solid-js"
import { Hands } from "@vectordevai/schema/hands"
import { Dialog } from "@vectordevai/ui/dialog"
import { ComputerRunCard } from "@vectordevai/session-ui/computer-tool"
import { useLanguage } from "@/context/language"
import { ComputerCard, type ComputerCardProps } from "./computer-card"

/**
 * Watch: the live viewer for the holder's run. The Tasks card's status and controls above the timeline's own run
 * card, expanded, so the step list, each step's screenshot and its click marker read exactly as in the conversation.
 */
export function ComputerWatch(props: Omit<ComputerCardProps, "onWatch"> & { busy: () => boolean }) {
  const language = useLanguage()
  return (
    <Dialog title={language.t("computer.tasks.title", { name: Hands.NAME })} size="large">
      <div class="vector-computer-watch">
        <ComputerCard rootID={props.rootID} run={props.run} onOpen={props.onOpen} onReview={props.onReview} />
        <Show when={props.run?.()}>{(parts) => <ComputerRunCard parts={parts()} open busy={props.busy()} />}</Show>
      </div>
    </Dialog>
  )
}
