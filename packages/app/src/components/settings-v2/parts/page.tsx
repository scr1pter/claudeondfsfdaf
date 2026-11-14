import { Component, JSX, Show } from "solid-js"
import { Switch } from "@vectordevai/ui/v2/switch-v2"
import { SelectV2 } from "@vectordevai/ui/v2/select-v2"
import { Icon, type IconProps } from "@vectordevai/ui/icon"
import "../settings-v2.css"

// The page, card and row pieces Settings → General, Notifications and Accessibility share.

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const Page: Component<{
  eyebrow: string
  title: string
  description: string
  children: JSX.Element
}> = (props) => (
  <section class="settings-v2-page">
    <div class="settings-v2-page-hero">
      <div>
        <p class="settings-v2-page-kicker">{props.eyebrow}</p>
        <h2 class="settings-v2-page-title">{props.title}</h2>
        <p class="settings-v2-page-subtitle">{props.description}</p>
      </div>
    </div>
    {props.children}
  </section>
)

export const Card: Component<{
  icon?: IconProps["name"]
  title: string
  description?: string
  wide?: boolean
  children: JSX.Element
}> = (props) => (
  <div class="settings-v2-card" classList={{ "settings-v2-card--wide": !!props.wide }}>
    <div class="settings-v2-card-head">
      <Show when={props.icon} keyed>
        {(icon) => (
          <div class="settings-v2-card-icon">
            <Icon name={icon} />
          </div>
        )}
      </Show>
      <div class="settings-v2-card-copy">
        <h3 class="settings-v2-card-title">{props.title}</h3>
        <Show when={props.description}>
          <p class="settings-v2-card-description">{props.description}</p>
        </Show>
      </div>
    </div>
    <div class="settings-v2-card-body">{props.children}</div>
  </div>
)

export const ToggleRow: Component<{
  title: string
  description?: string
  checked: boolean
  onChange: (value: boolean) => void
}> = (props) => (
  <div class="settings-v2-row-modern">
    <div class="settings-v2-row-copy">
      <div class="settings-v2-row-title">{props.title}</div>
      <Show when={props.description}>
        <div class="settings-v2-row-description">{props.description}</div>
      </Show>
    </div>
    <div class="settings-v2-row-control settings-v2-row-control--compact">
      <Switch checked={props.checked} onChange={props.onChange} />
    </div>
  </div>
)

export type Option = {
  value: string
  label: string
}

const pickOption = (options: Option[], value: string) => options.find((option) => option.value === value) ?? options[0]

export const SelectRow: Component<{
  title: string
  description?: string
  options: Option[]
  value: string
  onChange: (value: string) => void
}> = (props) => (
  <div class="settings-v2-row-modern">
    <div class="settings-v2-row-copy">
      <div class="settings-v2-row-title">{props.title}</div>
      <Show when={props.description}>
        <div class="settings-v2-row-description">{props.description}</div>
      </Show>
    </div>
    <div class="settings-v2-row-control">
      <SelectV2
        appearance="inline"
        options={props.options}
        current={pickOption(props.options, props.value)}
        value={(option) => option.value}
        label={(option) => option.label}
        onSelect={(option) => option && props.onChange(option.value)}
      />
    </div>
  </div>
)

export const RangeRow: Component<{
  title: string
  description?: string
  value: number
  min: number
  max: number
  step?: number
  format?: (value: number) => string
  onInput: (value: number) => void
}> = (props) => (
  <div class="settings-v2-row-modern settings-v2-row-modern--stacked">
    <div class="settings-v2-row-copy">
      <div class="settings-v2-row-title">{props.title}</div>
      <Show when={props.description}>
        <div class="settings-v2-row-description">{props.description}</div>
      </Show>
    </div>
    <div class="settings-v2-range-row">
      <input
        class="settings-v2-range"
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onInput={(event) => props.onInput(clamp(Number(event.currentTarget.value), props.min, props.max))}
      />
      <span class="settings-v2-range-value">{props.format ? props.format(props.value) : props.value}</span>
    </div>
  </div>
)
