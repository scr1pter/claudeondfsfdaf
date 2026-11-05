import type { IconProps } from "@vectordevai/ui/icon"
import type { SettingsSection } from "./general"

export type SettingsTab =
  | SettingsSection
  | "account"
  | "roadmap"
  | "remote"
  | "production"
  | "providers"
  | "models"
  | "servers"
  | "usage"
  | "spend"
  | "about"
  | "trust"
  | "subagents"
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
      // WP A34: shown only when the account's Codium plan includes the vote (dialog-settings-v2.tsx).
      {
        value: "roadmap",
        label: "Roadmap vote",
        icon: "checklist",
        keywords: ["roadmap", "vote", "ballot", "nominate", "nomination", "features", "what vector builds next"],
      },
      // WP A42: shown when the account's Codium plan includes the listed Remote, or this computer already has it on
      // or a phone paired (dialog-settings-v2.tsx), so it can always be turned off.
      {
        value: "remote",
        label: "Remote",
        icon: "link",
        keywords: ["remote", "phone", "mobile", "pair", "qr", "passkey", "approve from phone", "devices"],
      },
      // WP A50: shown on the desktop when the account's Codium plan includes a listed ops perk (On Call, Release Guard
      // or Ship Desk; dialog-settings-v2.tsx).
      {
        value: "production",
        label: "Production",
        icon: "warning",
        keywords: [
          "production",
          "on call",
          "release guard",
          "ship desk",
          "incidents",
          "revert",
          "rollback",
          "domains",
          "health checks",
          "monitors",
          "cards",
          "screenshots",
        ],
      },
      {
        value: "general",
        label: "General",
        icon: "sliders",
        // The Terminal shell picker lives here too.
        keywords: [
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
          // WP A45: Settings → Memory → Backup (desktop).
          "backup",
          "back up",
          "brain vault",
          "restore",
          "recovery code",
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
        keywords: ["subagent", "parallel", "delegation", "runtime"],
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
      {
        value: "notifications",
        label: "Notifications",
        icon: "status",
        keywords: ["alerts", "sound", "completion", "phone", "push", "quiet hours"],
      },
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
