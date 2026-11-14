import type { IconProps } from "@vectordevai/ui/icon"
import type { SettingsSection } from "./general"
import { Hands } from "@vectordevai/schema/hands"

export type SettingsTab =
  | SettingsSection
  | "account"
  | "providers"
  | "models"
  | "servers"
  | "usage"
  | "spend"
  | "about"
  | "trust"
  | "subagents"
  | "computer"
  | "memory"
  | "local"
  | "shortcuts"

export type SettingsItem = {
  value: SettingsTab
  label: string
  icon: IconProps["name"]
  keywords: readonly string[]
}

export type SettingsGroup = {
  title: string
  items: readonly SettingsItem[]
}

export const settingsGroups: readonly SettingsGroup[] = [
  {
    title: "Personal",
    items: [
      {
        value: "account",
        label: "Account",
        icon: "user",
        keywords: [
          "sign in",
          "sign out",
          "profile",
          "email",
          "codium",
          "plan",
          "credits",
          "billing",
          "subscription",
          "delete",
        ],
      },
      {
        value: "general",
        label: "General",
        icon: "sliders",
        // The Terminal shell picker and "While Vector works" (follow-ups and the Stop button) live here too.
        keywords: [
          "follow-up",
          "followup",
          "steer",
          "queue",
          "stop button",
          "stop helpers",
          "while working",
          "data",
          "judge",
          "routing",
          "diagnostics",
          "privacy",
          "shell",
          "terminal",
          "bash",
          "zsh",
          "powershell",
        ],
      },
      {
        value: "memory",
        label: "Memory",
        icon: "brain",
        keywords: [
          "memory",
          "rules",
          "remember",
          "forget",
          "learned",
          "brain",
          "MEMORY.md",
          "RULES.md",
          "preferences",
          "lessons",
          "research",
          "deep research",
          "reports",
          "sources",
          "citations",
          "skills",
          "learned skills",
          "workflow",
          "insights",
          "effort",
          "tokenomics",
        ],
      },
      {
        value: "local",
        label: "Vector Local",
        icon: "server",
        keywords: [
          "vector local",
          "local models",
          "models you host",
          "ollama",
          "lm studio",
          "vllm",
          "llama.cpp",
          "offline",
          "network log",
          "what vector sent",
          "web access",
          "privacy",
          "company policy",
        ],
      },
      {
        value: "usage",
        label: "Usage & streak",
        icon: "status",
        keywords: ["tokens", "cost", "activity", "economics"],
      },
      {
        value: "spend",
        label: "Spend limits",
        icon: "shield",
        keywords: ["budget", "cap", "cost", "limit"],
      },
    ],
  },
  {
    title: "Agents & environment",
    items: [
      {
        value: "subagents",
        label: "Agents",
        icon: "task",
        // The subagent limits and the Workflows section (5.I.4) live here too.
        keywords: [
          "subagent",
          "parallel",
          "delegation",
          "runtime",
          "subagent limits",
          "at once",
          "per request",
          "spend ceiling",
          "workflows",
          "saved workflows",
        ],
      },
      {
        value: "computer",
        label: Hands.NAME,
        icon: "hands",
        keywords: [
          Hands.NAME,
          Hands.SHORT,
          "computer use",
          "use my computer",
          "screen recording",
          "accessibility permission",
          "always allowed apps",
          "blocked apps",
          "screenshots",
          "mouse",
        ],
      },
      {
        value: "providers",
        label: "Providers & keys",
        icon: "providers",
        keywords: ["api", "byok", "anthropic", "openai", "credentials"],
      },
      { value: "models", label: "Default models", icon: "models", keywords: ["llm", "model picker", "routing"] },
      {
        value: "servers",
        label: "Environment & servers",
        icon: "server",
        keywords: ["mcp", "connection", "local", "remote"],
      },
    ],
  },
  {
    title: "Workspace",
    items: [
      {
        value: "trust",
        label: "Repository trust",
        icon: "circle-check",
        keywords: ["trusted", "vector.json", ".vector", "repository settings", "project settings", "security"],
      },
      {
        value: "shortcuts",
        label: "Keyboard shortcuts",
        icon: "keyboard",
        keywords: ["keybindings", "keybinds", "key bindings", "hotkeys", "command palette"],
      },
      { value: "notifications", label: "Notifications", icon: "status", keywords: ["alerts", "sound", "completion"] },
      {
        value: "accessibility",
        label: "Accessibility",
        icon: "glasses",
        keywords: ["contrast", "scale", "focus", "motion"],
      },
    ],
  },
  {
    title: "More",
    items: [
      {
        value: "about",
        label: "Updates & about",
        icon: "download",
        keywords: ["version", "update", "restart", "license", "privacy"],
      },
    ],
  },
] as const

export function filterSettingsGroups(query: string) {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return settingsGroups

  return settingsGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        [group.title, item.label, item.value, ...item.keywords].some((text) =>
          text.toLocaleLowerCase().includes(normalized),
        ),
      ),
    }))
    .filter((group) => group.items.length > 0)
}

export function settingsItemCount(groups: readonly SettingsGroup[]) {
  return groups.reduce((total, group) => total + group.items.length, 0)
}

export function isSettingsTab(value: string): value is SettingsTab {
  return settingsGroups.some((group) => group.items.some((item) => item.value === value))
}
