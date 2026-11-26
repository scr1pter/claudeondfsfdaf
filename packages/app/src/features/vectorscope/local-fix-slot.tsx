import { Show, type JSX } from "solid-js"
import type { Config } from "@vectordevai/sdk/v2"
import type { LocalFixInput, LocalFixPullRequest } from "./local-fix"

// The fix panel's mount boundary (SF-10b), kept apart from the panel and its controller so the layout and the pull
// request panel load neither until a review result shows it.

/** The global setting the engine checks too (ReviewOwner.enabled): experimental.vectorscope on, VectorScope not off. */
export function localFixesEnabled(config: Pick<Config, "experimental" | "agent"> | undefined) {
  return config?.experimental?.vectorscope === true && config.agent?.vectorscope?.disable !== true
}

/**
 * Whether the pull request panel mounts the fix panel at all: only for an engine with the owner fix API
 * (`vectorscopeLocalFixes`, SF-10a) and with the global setting on. Otherwise the panel renders exactly as before.
 */
export function localFixesMounted(capability: boolean, config: Pick<Config, "experimental" | "agent"> | undefined) {
  return capability === true && localFixesEnabled(config)
}

/** What the layout passes the pull request panel when the fix panel may mount (localFixesMounted); undefined if not. */
export type LocalFixRender = (input: LocalFixInput) => JSX.Element

/**
 * Where the pull request panel's review result shows local fixes (SF-10b): only for a pull request's review and only
 * when the layout passed `render`, so without it the panel renders exactly as before. The Show is not keyed, so a
 * dismissal or a re-render never remounts the fix panel and its controller.
 */
export function LocalFixSlot(props: Omit<LocalFixInput, "pr"> & { pr?: LocalFixPullRequest; render?: LocalFixRender }) {
  return (
    <Show when={props.pr && props.render}>
      {(render) =>
        render()({
          outcome: props.outcome,
          pr: () => props.pr!,
          dismissed: props.dismissed,
          applied: props.applied,
        })
      }
    </Show>
  )
}
