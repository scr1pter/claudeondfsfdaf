import { createEffect, createSignal, Show } from "solid-js"
import { sliderClip } from "./ops-model"

// A Ship Desk card's before and after shots of one route, one over the other, with a slider that uncovers the "after"
// shot from the left (WP A50). Shared by the phone app and the desktop. It writes no style attribute: the clip is set
// through the element's style object, which the phone origin's CSP (style-src 'self') allows, unlike inline styles.
// `base` names the CSS classes each surface styles in its own stylesheet.

export function BeforeAfter(props: { base: string; route: string; before?: string; after?: string }) {
  const [position, setPosition] = createSignal(50)
  let after: HTMLImageElement | undefined
  createEffect(() => {
    const clip = props.before ? sliderClip(position()) : ""
    if (after) after.style.clipPath = clip
  })
  return (
    <figure class={props.base}>
      <div class={`${props.base}-frame`}>
        <Show when={props.before}>
          {(src) => <img class={`${props.base}-image`} src={src()} alt={`Before the change: ${props.route}`} />}
        </Show>
        <Show when={props.after}>
          {(src) => (
            <img
              ref={(element) => {
                after = element
                if (props.before) element.style.clipPath = sliderClip(position())
              }}
              class={`${props.base}-image ${props.base}-image--after`}
              classList={{ [`${props.base}-image--alone`]: !props.before }}
              src={src()}
              alt={`After the change: ${props.route}`}
            />
          )}
        </Show>
      </div>
      <Show when={props.before && props.after}>
        <input
          class={`${props.base}-range`}
          type="range"
          min="0"
          max="100"
          value={position()}
          aria-label={`Slide to compare before and after on ${props.route}`}
          onInput={(event) => setPosition(Number(event.currentTarget.value))}
        />
      </Show>
      <figcaption class={`${props.base}-caption`}>
        {props.route}
        <Show when={props.before && props.after}> · before on the right, after on the left</Show>
        <Show when={!props.before && props.after}> · after only</Show>
        <Show when={props.before && !props.after}> · before only</Show>
      </figcaption>
    </figure>
  )
}
