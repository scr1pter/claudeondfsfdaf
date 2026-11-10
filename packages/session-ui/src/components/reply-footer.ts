import type { Component } from "solid-js"
import type { AssistantMessage } from "@vectordevai/sdk/v2"

/** What the app draws under a finished reply, below its copy button and details. */
export type ReplyFooterComponent = Component<{ message: AssistantMessage }>

const footers: ReplyFooterComponent[] = []

/**
 * The app's slot under a reply, such as the "Learned 2 things" chip for what Vector learned from the request it
 * answers, or "Learned default · Why" for a reply a learned workflow default shaped. session-ui has no engine client
 * of its own, so the app registers the components that read one. Each registered component draws under the reply, in
 * registration order, and decides on its own whether it shows anything: a later registration never replaces an
 * earlier one, and registering the same component again changes nothing.
 */
export const ReplyFooter = {
  register(component: ReplyFooterComponent) {
    if (!footers.includes(component)) footers.push(component)
  },
  /** The registered components, in registration order. */
  list(): readonly ReplyFooterComponent[] {
    return footers
  },
}
