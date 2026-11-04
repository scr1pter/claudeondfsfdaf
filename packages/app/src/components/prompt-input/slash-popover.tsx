import { Component, For, Match, Show, Switch } from "solid-js"
import { FileIcon } from "@vectordevai/ui/file-icon"
import { Icon } from "@vectordevai/ui/icon"
import { Tag } from "@vectordevai/ui/v2/badge-v2"
import { KeybindV2 } from "@vectordevai/ui/v2/keybind-v2"
import { getDirectory, getFilename } from "@vectordevai/core/util/path"

export type AtOption =
  | { type: "agent"; name: string; display: string; description?: string }
  | {
      type: "resource"
      name: string
      uri: string
      client: string
      display: string
      description?: string
      mime?: string
    }
  | { type: "reference"; name: string; path: string; display: string; description: string }
  | { type: "file"; path: string; display: string; recent?: boolean }

/** The palette command behind `/workflow`, registered by the session page (use-session-commands.tsx). */
export const WORKFLOW_COMMAND = "workflow.open"

export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom"
  source?: "command" | "mcp" | "skill"
}

type PromptPopoverProps = {
  popover: "at" | "slash" | null
  setSlashPopoverRef: (el: HTMLDivElement) => void
  atFlat: AtOption[]
  atActive?: string
  atKey: (item: AtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: AtOption) => void
  slashFlat: SlashCommand[]
  slashActive?: string
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashCommand) => void
  commandKeybind: (id: string) => string | undefined
  commandKeybindParts: (id: string) => string[]
  newLayoutDesigns: boolean
  t: (key: string) => string
}

function VectorSubagentMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      class="size-4 shrink-0 text-icon-info-active"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 2.25 10.15 4.4 8 6.55 5.85 4.4 8 2.25ZM3.1 8l1.7-1.7L6.5 8 4.8 9.7 3.1 8Zm6.4 0 1.7-1.7L12.9 8l-1.7 1.7L9.5 8ZM8 9.45l2.15 2.15L8 13.75 5.85 11.6 8 9.45Z"
        stroke="currentColor"
        stroke-width="1.15"
        stroke-linejoin="round"
      />
      <path d="M6.15 5.35 5.1 6.65m4.75-1.3 1.05 1.3m0 2.7-1.05 1.3m-3.7 0L5.1 9.35" stroke="currentColor" stroke-width="1" />
    </svg>
  )
}

export const PromptPopover: Component<PromptPopoverProps> = (props) => {
  return (
    <Show when={props.popover}>
      <div
        ref={(el) => {
          if (props.popover === "slash") props.setSlashPopoverRef(el)
        }}
        class="absolute inset-x-0 -top-2 -translate-y-full origin-bottom-left max-h-80 min-h-10
                 overflow-auto no-scrollbar flex flex-col p-2"
        classList={{
          "z-[70] rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]": props.newLayoutDesigns,
          "rounded-[12px] bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-lg-border-base)]":
            !props.newLayoutDesigns,
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        <Switch>
          <Match when={props.popover === "at"}>
            <Show
              when={props.atFlat.length > 0}
              fallback={
                <div
                  class="px-2 py-1"
                  classList={{
                    "text-v2-text-text-muted": props.newLayoutDesigns,
                    "text-text-weak": !props.newLayoutDesigns,
                  }}
                >
                  {props.t("prompt.popover.emptyResults")}
                </div>
              }
            >
              <For each={props.atFlat.slice(0, 10)}>
                {(item) => {
                  const key = props.atKey(item)

                  if (item.type === "agent") {
                    return (
                      <button
                        class="w-full flex items-center gap-x-2 px-2 py-0.5"
                        classList={{
                          "rounded-[4px]": props.newLayoutDesigns,
                          "rounded-md": !props.newLayoutDesigns,
                          "bg-v2-overlay-simple-overlay-hover": props.newLayoutDesigns && props.atActive === key,
                          "bg-surface-raised-base-hover": !props.newLayoutDesigns && props.atActive === key,
                        }}
                        onClick={() => props.onAtSelect(item)}
                        onPointerMove={() => props.setAtActive(key)}
                      >
                        <VectorSubagentMark />
                        <span
                          class="whitespace-nowrap shrink-0"
                          classList={{
                            "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]":
                              props.newLayoutDesigns,
                            "text-v2-text-text-base": props.newLayoutDesigns,
                            "text-14-regular": !props.newLayoutDesigns,
                            "text-text-strong": !props.newLayoutDesigns,
                          }}
                        >
                          @{item.name}
                        </span>
                        <Show when={item.description}>
                          {(description) => (
                            <span
                              class="min-w-0 truncate text-left text-[12px]"
                              classList={{
                                "text-v2-text-text-muted": props.newLayoutDesigns,
                                "text-text-weak": !props.newLayoutDesigns,
                              }}
                            >
                              {description()}
                            </span>
                          )}
                        </Show>
                      </button>
                    )
                  }

                  if (item.type === "resource") {
                    return (
                      <button
                        class="w-full flex items-center gap-x-2 px-2 py-0.5"
                        classList={{
                          "rounded-[4px]": props.newLayoutDesigns,
                          "rounded-md": !props.newLayoutDesigns,
                          "bg-v2-overlay-simple-overlay-hover": props.newLayoutDesigns && props.atActive === key,
                          "bg-surface-raised-base-hover": !props.newLayoutDesigns && props.atActive === key,
                        }}
                        onClick={() => props.onAtSelect(item)}
                        onPointerMove={() => props.setAtActive(key)}
                      >
                        <FileIcon node={{ path: item.uri, type: "file" }} class="shrink-0 size-4" />
                        <div
                          class="flex items-center min-w-0"
                          classList={{
                            "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]":
                              props.newLayoutDesigns,
                            "text-14-regular": !props.newLayoutDesigns,
                          }}
                        >
                          <span
                            class="text-text-strong whitespace-nowrap"
                            classList={{ "text-v2-text-text-base": props.newLayoutDesigns }}
                          >
                            @{item.name}
                          </span>
                          <Show when={item.description}>
                            {(description) => (
                              <span
                                class="whitespace-nowrap truncate min-w-0 ml-2"
                                classList={{
                                  "text-v2-text-text-muted": props.newLayoutDesigns,
                                  "text-text-weak": !props.newLayoutDesigns,
                                }}
                              >
                                {description()}
                              </span>
                            )}
                          </Show>
                        </div>
                      </button>
                    )
                  }

                  if (item.type === "reference") {
                    return (
                      <button
                        class="w-full flex items-center gap-x-2 px-2 py-0.5"
                        classList={{
                          "rounded-[4px]": props.newLayoutDesigns,
                          "rounded-md": !props.newLayoutDesigns,
                          "bg-v2-overlay-simple-overlay-hover": props.newLayoutDesigns && props.atActive === key,
                          "bg-surface-raised-base-hover": !props.newLayoutDesigns && props.atActive === key,
                        }}
                        onClick={() => props.onAtSelect(item)}
                        onPointerMove={() => props.setAtActive(key)}
                      >
                        <FileIcon node={{ path: item.path, type: "directory" }} class="shrink-0 size-4" />
                        <div
                          class="flex items-center min-w-0"
                          classList={{
                            "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]":
                              props.newLayoutDesigns,
                            "text-14-regular": !props.newLayoutDesigns,
                          }}
                        >
                          <span
                            class="text-text-strong whitespace-nowrap"
                            classList={{ "text-v2-text-text-base": props.newLayoutDesigns }}
                          >
                            @{item.name}
                          </span>
                          <span
                            class="whitespace-nowrap truncate min-w-0 ml-2"
                            classList={{
                              "text-v2-text-text-muted": props.newLayoutDesigns,
                              "text-text-weak": !props.newLayoutDesigns,
                            }}
                          >
                            {item.description}
                          </span>
                        </div>
                      </button>
                    )
                  }

                  const isDirectory = item.path.endsWith("/")
                  const directory = isDirectory ? item.path : getDirectory(item.path)
                  const filename = isDirectory ? "" : getFilename(item.path)

                  return (
                    <button
                      class="w-full flex items-center gap-x-2 px-2 py-0.5"
                      classList={{
                        "rounded-[4px]": props.newLayoutDesigns,
                        "rounded-md": !props.newLayoutDesigns,
                        "bg-v2-overlay-simple-overlay-hover": props.newLayoutDesigns && props.atActive === key,
                        "bg-surface-raised-base-hover": !props.newLayoutDesigns && props.atActive === key,
                      }}
                      onClick={() => props.onAtSelect(item)}
                      onPointerMove={() => props.setAtActive(key)}
                    >
                      <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-4" />
                      <div
                        class="flex items-center min-w-0"
                        classList={{
                          "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]":
                            props.newLayoutDesigns,
                          "text-14-regular": !props.newLayoutDesigns,
                        }}
                      >
                        <span
                          class="whitespace-nowrap truncate min-w-0"
                          classList={{
                            "text-v2-text-text-muted": props.newLayoutDesigns,
                            "text-text-weak": !props.newLayoutDesigns,
                          }}
                        >
                          {directory}
                        </span>
                        <Show when={!isDirectory}>
                          <span
                            class="whitespace-nowrap"
                            classList={{
                              "text-v2-text-text-base": props.newLayoutDesigns,
                              "text-text-strong": !props.newLayoutDesigns,
                            }}
                          >
                            {filename}
                          </span>
                        </Show>
                      </div>
                    </button>
                  )
                }}
              </For>
            </Show>
          </Match>
          <Match when={props.popover === "slash"}>
            <Show
              when={props.slashFlat.length > 0}
              fallback={
                <div
                  class="px-2 py-1"
                  classList={{
                    "text-v2-text-text-muted": props.newLayoutDesigns,
                    "text-text-weak": !props.newLayoutDesigns,
                  }}
                >
                  {props.t("prompt.popover.emptyCommands")}
                </div>
              }
            >
              <For each={props.slashFlat}>
                {(cmd) => {
                  const keybind = () => props.commandKeybind(cmd.id)
                  const keybindParts = () => props.commandKeybindParts(cmd.id)
                  return (
                    <button
                      data-slash-id={cmd.id}
                      classList={{
                        "w-full flex items-center justify-between gap-4 px-2 py-1": true,
                        "rounded-[4px] scroll-my-2": props.newLayoutDesigns,
                        "rounded-md": !props.newLayoutDesigns,
                        "bg-v2-overlay-simple-overlay-hover": props.newLayoutDesigns && props.slashActive === cmd.id,
                        "bg-surface-raised-base-hover": !props.newLayoutDesigns && props.slashActive === cmd.id,
                      }}
                      onClick={() => props.onSlashSelect(cmd)}
                      onPointerMove={() => props.setSlashActive(cmd.id)}
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <span
                          class="whitespace-nowrap"
                          classList={{
                            "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]":
                              props.newLayoutDesigns,
                            "text-v2-text-text-base": props.newLayoutDesigns,
                            "text-14-regular": !props.newLayoutDesigns,
                            "text-text-strong": !props.newLayoutDesigns,
                          }}
                        >
                          /{cmd.trigger}
                        </span>
                        <Show when={cmd.description}>
                          <span
                            class="truncate"
                            classList={{
                              "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]":
                                props.newLayoutDesigns,
                              "text-v2-text-text-muted": props.newLayoutDesigns,
                              "text-14-regular": !props.newLayoutDesigns,
                              "text-text-weak": !props.newLayoutDesigns,
                            }}
                          >
                            {cmd.description}
                          </span>
                        </Show>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        {/* /workflow opens the saved-workflow form (5.I.4); the badge tells it from a typed command. */}
                        <Show when={cmd.type === "builtin" && cmd.id === WORKFLOW_COMMAND}>
                          <Show
                            when={props.newLayoutDesigns}
                            fallback={
                              <span class="text-11-regular px-1.5 py-0.5 rounded bg-surface-base text-text-subtle">
                                {props.t("prompt.slash.badge.workflow")}
                              </span>
                            }
                          >
                            <Tag>{props.t("prompt.slash.badge.workflow")}</Tag>
                          </Show>
                        </Show>
                        <Show when={cmd.type === "custom" && cmd.source !== "command"}>
                          <Show
                            when={props.newLayoutDesigns}
                            fallback={
                              <span class="text-11-regular px-1.5 py-0.5 rounded bg-surface-base text-text-subtle">
                                {cmd.source === "skill"
                                  ? props.t("prompt.slash.badge.skill")
                                  : cmd.source === "mcp"
                                    ? props.t("prompt.slash.badge.mcp")
                                    : props.t("prompt.slash.badge.custom")}
                              </span>
                            }
                          >
                            <Tag>
                              {cmd.source === "skill"
                                ? props.t("prompt.slash.badge.skill")
                                : cmd.source === "mcp"
                                  ? props.t("prompt.slash.badge.mcp")
                                  : props.t("prompt.slash.badge.custom")}
                            </Tag>
                          </Show>
                        </Show>
                        <Show when={props.newLayoutDesigns ? keybindParts().length > 0 : keybind()}>
                          <Show
                            when={props.newLayoutDesigns}
                            fallback={<span class="text-12-regular text-text-subtle">{keybind()}</span>}
                          >
                            <KeybindV2 keys={keybindParts()} variant="neutral" />
                          </Show>
                        </Show>
                      </div>
                    </button>
                  )
                }}
              </For>
            </Show>
          </Match>
        </Switch>
      </div>
    </Show>
  )
}
