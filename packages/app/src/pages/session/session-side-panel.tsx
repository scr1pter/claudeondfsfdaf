import {
  For,
  Match,
  Show,
  Suspense,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  lazy,
  on,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Portal } from "solid-js/web"
import { agentColor, ATTRIBUTION_TTL_MS, resolveAgentColor } from "@/components/editor-attribution"
import {
  createAgentFollow,
  directoryFollowSource,
  eventFiles,
  fileFollowSource,
  followToastDue,
  latestTurn,
  messageAgent,
  sessionLineage,
  workspaceRelativePath,
  type AgentFollow,
  type ExternalActivityEntry,
  type FollowSource,
} from "@/pages/session/agent-follow"
import {
  MonacoCodeEditor,
  type InlineCompleteInput,
  type InlineEditSelection,
  type MonacoLanguageService,
} from "@/components/monaco-code-editor"
import { setOnboardingFlag } from "@/features/onboarding/onboarding-progress"
import { createMediaQuery } from "@solid-primitives/media"
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippetCompletion,
  type Completion,
  type CompletionContext,
} from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  HighlightStyle,
  StreamLanguage,
} from "@codemirror/language"
import { shell } from "@codemirror/legacy-modes/mode/shell"
import { highlightSelectionMatches } from "@codemirror/search"
import { EditorState, type Extension } from "@codemirror/state"
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightWhitespace,
  keymap,
  lineNumbers as codeMirrorLineNumbers,
  rectangularSelection,
} from "@codemirror/view"
import { tags as t } from "@lezer/highlight"
import { Tabs } from "@vectordevai/ui/tabs"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { IconButton } from "@vectordevai/ui/icon-button"
import { Icon } from "@vectordevai/ui/icon"
import { TooltipKeybind } from "@vectordevai/ui/tooltip"
import { ResizeHandle } from "@vectordevai/ui/resize-handle"
import { Mark } from "@vectordevai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { Message, Part, SnapshotFileDiff, VcsFileDiff } from "@vectordevai/sdk/v2"
import { Message as SessionMessage } from "@vectordevai/session-ui/message-part"
import { ResearchSourcesTab } from "@/features/research/sources-tab"
import { registerResearchReportCard } from "@/features/research/report-card"
import { registerLearnedChip } from "@/features/memory/learned-chip"
import { registerWorkflowChip } from "@/features/memory/workflow-chip"
import { OPEN_SOURCES, sessionRuns, type OpenSources } from "@/features/research/research-model"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { sameWorkspaceRevisions } from "@/utils/workspace-revisions"

import FileTree, { CODESPACE_EXCLUDED_DIRECTORIES, type FileTreeMarker, type Kind } from "@/components/file-tree"
import { PromptInput } from "@/components/prompt-input"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { modelVariantLabel } from "@/context/model-variant"
import { usePrompt } from "@/context/prompt"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { createPromptInputController } from "@/pages/session/composer"
import {
  createOpenSessionFileTab,
  createSessionTabs,
  getTabReorderIndex,
  shouldShowFileTree,
  type Sizing,
} from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import {
  clearEngineeringEvents,
  getEngineeringEvents,
  logEngineeringEvent,
  type EngineeringEventStatus,
  type EngineeringEventType,
  type EngineeringTimelineEvent,
} from "@/utils/engineering-timeline"
import { showToast } from "@/utils/toast"
import { resolveBrowserAddress, selectUnambiguousPreviewUrl } from "@/utils/browser-address"
import { boundInlineCompletionContext, sanitizeInlineCompletion } from "@/utils/codespace-ai"
import { createInlineCompletionQueue, requestInlineCompletion } from "@/utils/inline-completion-request"
import { notifyWorkspaceFileSaved } from "@/utils/workspace-file-saved"
import { announceWorkspaceMode } from "@/utils/workspace-mode"
import type { ExternalAgent } from "@vectordevai/schema/external-agent"

const DialogSelectFile = lazy(() =>
  import("@/components/dialog-select-file").then((module) => ({ default: module.DialogSelectFile })),
)

type RenderDiff = (SnapshotFileDiff & { file: string }) | VcsFileDiff

function renderDiff(value: SnapshotFileDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

type CodespaceView = "editor" | "problems"

type CodespaceLiveWorkspace = {
  id: string
  revision?: number
  name: string
  taskPrompt: string
  runtime: "vector" | ExternalAgent.ChatId
  sourcePath: string
  isolatedPath: string
  parentSessionId?: string
  gitBranch?: string
  status:
    | "queued"
    | "planning"
    | "editing"
    | "running commands"
    | "testing"
    | "complete"
    | "failed"
    | "needs review"
    | "stopped"
    | "merged"
    | "discarded"
  lastAction: string
  lastActivityAt: string
  changedFiles: string[]
  mergeState: "none" | "merged" | "discarded"
}

const workspaceColors = [
  "#a78bfa",
  "#67e8f9",
  "#f472b6",
  "#4ade80",
  "#fbbf24",
  "#60a5fa",
  "#fb7185",
  "#2dd4bf",
  "#c084fc",
  "#a3e635",
  "#f97316",
  "#818cf8",
  "#22d3ee",
  "#e879f9",
  "#34d399",
  "#facc15",
] as const

function workspaceColor(id: string) {
  const hash = [...id].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 7)
  return workspaceColors[hash % workspaceColors.length]!
}

function normalizedWorkspacePath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\.?\//, "")
}

function workspaceStatusLabel(status: CodespaceLiveWorkspace["status"]) {
  return status.replace(/\b\w/g, (character) => character.toUpperCase())
}

function workspaceIsRunning(status: CodespaceLiveWorkspace["status"]) {
  return ["queued", "planning", "editing", "running commands", "testing"].includes(status)
}

type CodespaceProblem = {
  severity: "error" | "warning" | "info"
  line: number
  message: string
}

type TimelineFilter = "all" | "ai" | "files" | "terminal" | "browser" | "checkpoints" | "errors"
type SkillMode = "beginner" | "intermediate" | "advanced"

type VectorReportFile = {
  path: string
  content: string
}

type VectorReportProblem = {
  severity: "error" | "warning" | "info"
  path: string
  message: string
}

type VectorLocalReport = {
  scannedAt: number
  fileCount: number
  lineCount: number
  charCount: number
  languageRows: Array<{ label: string; files: number; lines: number }>
  entrypoints: string[]
  frameworks: string[]
  runCommands: string[]
  problems: VectorReportProblem[]
  preview: {
    status: "ready" | "warning" | "blocked"
    title: string
    details: string[]
  }
  cost: {
    estimatedTokens: number
    risk: "Low" | "Medium" | "High"
    guidance: string[]
  }
  memory: {
    summary: string
    importantFiles: string[]
    nextSteps: string[]
  }
  promptGuard: {
    verdict: string
    suggestions: string[]
  }
  demoChecklist: string[]
  architecture: Array<{ path: string; role: string; summary: string; lines: number }>
  dependencies: Array<{ file: string; dependsOn: string[] }>
  symbols: Array<{ name: string; kind: string; path: string; line: number }>
  impact: {
    risk: "Low" | "Medium" | "High"
    notes: string[]
    affectedFiles: string[]
  }
  ownership: Array<{ file: string; owner: string; reason: string }>
  runbook: string[]
  learning: {
    appOverview: string[]
    changeExplanation: string[]
  }
  mistakeJournal: Array<{ title: string; detail: string; severity: "error" | "warning" | "info" }>
  modelFit: {
    strength: "Cheap" | "Balanced" | "Frontier" | "Unknown"
    verdict: string
    detail: string
    route: string
  }
  promptReplayBench: Array<{ model: string; quality: string; cost: string; recommendation: string }>
}

const SKILL_MODE_KEY = "vector.skill-mode.v1"

function textFromFileReadResponse(result: unknown) {
  const data = (result as { data?: unknown } | undefined)?.data
  if (typeof data === "string") return data
  if (!data || typeof data !== "object") return ""
  const file = data as { type?: string; content?: unknown }
  if (file.type === "text" && typeof file.content === "string") return file.content
  return ""
}

function reportLanguage(path: string) {
  const lower = path.toLowerCase()
  if (lower.endsWith(".tsx")) return "TSX"
  if (lower.endsWith(".jsx")) return "JSX"
  if (lower.endsWith(".ts")) return "TypeScript"
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "JavaScript"
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "HTML"
  if (lower.endsWith(".css")) return "CSS"
  if (lower.endsWith(".json")) return "JSON"
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "Markdown"
  if (lower.endsWith(".py")) return "Python"
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "Shell"
  return "Other"
}

function reportFileBasename(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path
}

function looksLikeTextProjectFile(path: string) {
  if (path.includes("/node_modules/") || path.startsWith("node_modules/")) return false
  if (path.includes("/.git/") || path.startsWith(".git/")) return false
  if (path.includes("/dist/") || path.startsWith("dist/")) return false
  if (path.includes("/build/") || path.startsWith("build/")) return false
  if (path.includes("/.next/") || path.startsWith(".next/")) return false
  return /\.(tsx?|jsx?|html?|css|json|mdx?|py|sh|bash|zsh|yml|yaml|toml|env\.example)$/i.test(path)
}

function readPackageScripts(packageJson: string) {
  try {
    const parsed = JSON.parse(packageJson) as {
      scripts?: Record<string, unknown>
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return {
      scripts: Object.entries(parsed.scripts ?? {})
        .filter(([, value]) => typeof value === "string")
        .map(([name]) => `npm run ${name}`),
      dependencies: { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) },
    }
  } catch {
    return { scripts: [], dependencies: {} as Record<string, unknown> }
  }
}

function riskRank(value: "Low" | "Medium" | "High") {
  return value === "High" ? 3 : value === "Medium" ? 2 : 1
}

function maxRisk(...values: Array<"Low" | "Medium" | "High">): "Low" | "Medium" | "High" {
  return values.reduce((highest, next) => (riskRank(next) > riskRank(highest) ? next : highest), "Low")
}

function normalizeProjectImportPath(path: string) {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
}

function pathDirectory(path: string) {
  const normalized = normalizeProjectImportPath(path)
  const parts = normalized.split("/")
  parts.pop()
  return parts.join("/")
}

function resolveRelativeDependency(fromPath: string, raw: string, paths: Set<string>) {
  if (!raw.startsWith(".") && !raw.startsWith("/")) return undefined
  const baseDir = raw.startsWith("/") ? "" : pathDirectory(fromPath)
  const rawBase = normalizeProjectImportPath(raw.startsWith("/") ? raw.slice(1) : `${baseDir}/${raw}`)
  const bases = [rawBase.replace(/\/$/, "")]
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".html", ".md", ".py"]
  for (const base of bases) {
    for (const ext of extensions) {
      const candidate = `${base}${ext}`
      if (paths.has(candidate)) return candidate
    }
    for (const ext of extensions.filter(Boolean)) {
      const candidate = `${base}/index${ext}`
      if (paths.has(candidate)) return candidate
    }
  }
  return undefined
}

function extractDependencyRefs(file: VectorReportFile, paths: Set<string>) {
  const refs = new Set<string>()
  const patterns = [
    /\bimport\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^'"]*\s+from\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\b(?:src|href)=["']([^"']+)["']/g,
    /@import\s+(?:url\()?["']?([^"')]+)["']?\)?/g,
  ]

  for (const pattern of patterns) {
    for (const match of file.content.matchAll(pattern)) {
      const raw = match[1]?.trim()
      if (!raw || raw.startsWith("http:") || raw.startsWith("https:") || raw.startsWith("data:") || raw.startsWith("#"))
        continue
      const resolved = resolveRelativeDependency(file.path, raw, paths)
      if (resolved && resolved !== file.path) refs.add(resolved)
    }
  }
  return [...refs].sort()
}

function extractCodeSymbols(file: VectorReportFile) {
  const symbols: Array<{ name: string; kind: string; path: string; line: number }> = []
  const patterns: Array<{ kind: string; regex: RegExp }> = [
    { kind: "function", regex: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g },
    { kind: "class", regex: /\bclass\s+([A-Za-z_$][\w$]*)/g },
    { kind: "interface", regex: /\binterface\s+([A-Za-z_$][\w$]*)/g },
    { kind: "type", regex: /\btype\s+([A-Za-z_$][\w$]*)\s*=/g },
    { kind: "component", regex: /\b(?:const|let)\s+([A-Z][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g },
    { kind: "function", regex: /^\s*def\s+([A-Za-z_][\w]*)\s*\(/gm },
    { kind: "class", regex: /^\s*class\s+([A-Za-z_][\w]*)\s*[:(]/gm },
    { kind: "heading", regex: /^#{1,6}\s+(.{1,90})$/gm },
  ]
  const seen = new Set<string>()
  for (const { kind, regex } of patterns) {
    for (const match of file.content.matchAll(regex)) {
      const name = match[1]?.trim()
      if (!name) continue
      const line = file.content.slice(0, match.index ?? 0).split("\n").length
      const key = `${kind}:${name}:${line}`
      if (seen.has(key)) continue
      seen.add(key)
      symbols.push({ name, kind, path: file.path, line })
      if (symbols.length >= 80) return symbols
    }
  }
  return symbols
}

function classifyArchitectureFile(path: string, content: string) {
  const name = reportFileBasename(path).toLowerCase()
  const language = reportLanguage(path)
  if (name === "package.json")
    return { role: "Manifest", summary: "Defines dependencies, scripts, and the repository's runtime expectations." }
  if (/vite\.config|next\.config|tailwind\.config|tsconfig|postcss\.config/i.test(path)) {
    return { role: "Build configuration", summary: "Controls how the repository builds, transforms, or styles code." }
  }
  if (/app|page|route|router|routes/i.test(path))
    return { role: "Route or app shell", summary: "Likely controls navigation, pages, or the main app surface." }
  if (/component|components|widget|card|button|modal/i.test(path))
    return { role: "UI component", summary: "Reusable interface code that other screens may depend on." }
  if (/api|server|endpoint|handler|service/i.test(path))
    return { role: "API or service", summary: "Connects the app to data, side effects, or backend-like behavior." }
  if (/style|theme|\.css$|\.scss$/i.test(path))
    return { role: "Styling", summary: "Controls visual presentation, layout, and theme." }
  if (language === "HTML")
    return { role: "HTML entry", summary: "Previewable document entry point for browser rendering." }
  if (language === "Python" || language === "Shell")
    return { role: "Runtime script", summary: "Script or command-oriented file that may run outside the browser." }
  if (language === "Markdown")
    return { role: "Documentation", summary: "Explains behavior, setup, or repository notes." }
  return { role: language, summary: "Repository source file included in Vector's local analysis." }
}

function modelStrengthFromLabel(label: string): VectorLocalReport["modelFit"]["strength"] {
  const value = label.toLowerCase()
  if (!value.trim() || value.includes("no model")) return "Unknown"
  if (/(opus|sonnet|gpt-5|gpt-4\.1|o3|gemini.*pro|deepseek.*r1|qwen.*coder.*plus)/i.test(value)) return "Frontier"
  if (/(haiku|gpt-4o|gpt-4|gemini|llama.*70b|mistral.*large|codestral|deepseek)/i.test(value)) return "Balanced"
  if (/(flash|mini|small|free|groq|llama.*8b|gemma|fast)/i.test(value)) return "Cheap"
  return "Balanced"
}

function readSkillModePreference(): SkillMode {
  try {
    const value = localStorage.getItem(SKILL_MODE_KEY)
    return value === "beginner" || value === "intermediate" || value === "advanced" ? value : "intermediate"
  } catch {
    return "intermediate"
  }
}

function buildVectorLocalReport(
  files: VectorReportFile[],
  diffs: readonly RenderDiff[],
  modelLabel: string,
): VectorLocalReport {
  const fileByPath = new Map(files.map((file) => [file.path, file.content]))
  const languageMap = new Map<string, { files: number; lines: number }>()
  const problems: VectorReportProblem[] = []
  let lineCount = 0
  let charCount = 0

  for (const file of files) {
    const lines = file.content.split("\n").length
    lineCount += lines
    charCount += file.content.length
    const language = reportLanguage(file.path)
    const current = languageMap.get(language) ?? { files: 0, lines: 0 }
    current.files += 1
    current.lines += lines
    languageMap.set(language, current)

    for (const secret of detectSecrets(file.content)) {
      problems.push({
        severity: "warning",
        path: file.path,
        message: `${secret} pattern found. Keep real credentials in environment variables.`,
      })
    }

    if (file.path.endsWith(".json")) {
      try {
        JSON.parse(file.content)
      } catch {
        problems.push({ severity: "error", path: file.path, message: "Invalid JSON syntax." })
      }
    }

    if (/TODO|FIXME/i.test(file.content)) {
      problems.push({ severity: "info", path: file.path, message: "TODO/FIXME notes remain in this file." })
    }
  }

  const packageText = fileByPath.get("package.json") ?? ""
  const packageInfo = readPackageScripts(packageText)
  const deps = packageInfo.dependencies
  const frameworks = [
    deps.react ? "React" : "",
    deps.vue ? "Vue" : "",
    deps.svelte ? "Svelte" : "",
    deps.next ? "Next.js" : "",
    deps.vite || packageText.includes('"vite"') ? "Vite" : "",
    deps.tailwindcss ? "Tailwind CSS" : "",
    files.some((file) => file.path.endsWith(".py")) ? "Python" : "",
  ].filter(Boolean)

  const entrypoints = [
    "index.html",
    "src/main.tsx",
    "src/main.jsx",
    "src/App.tsx",
    "src/App.jsx",
    "app/page.tsx",
    "pages/index.tsx",
    "main.py",
  ].filter((path) => fileByPath.has(path))

  const runCommands = packageInfo.scripts.length
    ? packageInfo.scripts.slice(0, 8)
    : files.some((file) => file.path.endsWith(".py"))
      ? ["python main.py"]
      : entrypoints.includes("index.html")
        ? ["Open index.html in Browser"]
        : []

  const htmlFiles = files.filter((file) => isHtmlPath(file.path))
  for (const htmlFile of htmlFiles) {
    const refs = previewAssetRefs(htmlFile.path, htmlFile.content)
    for (const ref of refs) {
      if (!fileByPath.has(ref))
        problems.push({ severity: "error", path: htmlFile.path, message: `Preview asset is missing: ${ref}` })
    }
  }

  const previewErrors = problems.filter((problem) => problem.severity === "error")
  const preview = htmlFiles.length
    ? previewErrors.length
      ? {
          status: "warning" as const,
          title: "Preview may load with missing assets",
          details: previewErrors.slice(0, 4).map((problem) => `${problem.path}: ${problem.message}`),
        }
      : {
          status: "ready" as const,
          title: "Preview has a reachable HTML entry",
          details: [`Vector found ${htmlFiles[0]?.path}.`, ...runCommands.slice(0, 2)],
        }
    : {
        status: "blocked" as const,
        title: "No previewable HTML entry found",
        details: ["Open Codespace and create or select an HTML/front-end entry file before using Browser."],
      }

  const estimatedTokens = Math.ceil(charCount / 4)
  const risk = estimatedTokens > 80_000 ? "High" : estimatedTokens > 24_000 ? "Medium" : "Low"
  const costGuidance = [
    risk === "High"
      ? "Use a frontier model and ask Vector to focus on specific files before broad refactors."
      : risk === "Medium"
        ? "This repository is moderate size. File selection and clear task scope will keep BYOK cost sane."
        : "This is a small context pack. Most capable coding models should handle focused tasks cheaply.",
    `Current model: ${modelLabel || "not selected"}.`,
    diffs.length
      ? `${diffs.length} pending review file${diffs.length === 1 ? "" : "s"} should be inspected before another large edit.`
      : "No pending review diffs detected.",
  ]

  const importantFiles = [
    ...entrypoints,
    ...files
      .filter((file) =>
        ["package.json", "vite.config.ts", "vite.config.js", "tailwind.config.js", "tsconfig.json"].includes(file.path),
      )
      .map((file) => file.path),
    ...diffs.map((diff) => diff.file),
  ]
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 10)

  const pathSet = new Set(files.map((file) => file.path))
  const architecture = files
    .map((file) => {
      const role = classifyArchitectureFile(file.path, file.content)
      return {
        path: file.path,
        role: role.role,
        summary: role.summary,
        lines: file.content.split("\n").length,
      }
    })
    .sort((a, b) => {
      const importantA = importantFiles.includes(a.path) ? 1 : 0
      const importantB = importantFiles.includes(b.path) ? 1 : 0
      return importantB - importantA || b.lines - a.lines
    })
    .slice(0, 60)

  const dependencies = files
    .map((file) => ({ file: file.path, dependsOn: extractDependencyRefs(file, pathSet) }))
    .filter((item) => item.dependsOn.length > 0)
    .slice(0, 80)

  const symbols = files.flatMap(extractCodeSymbols).slice(0, 500)

  const changedFiles = [...new Set(diffs.map((diff) => diff.file))]
  const affectedFiles = new Set(changedFiles)
  for (const item of dependencies) {
    if (item.dependsOn.some((dependency) => changedFiles.includes(dependency))) affectedFiles.add(item.file)
  }
  const diffRisk = diffs.length
    ? diffs.map(estimateDiffRisk).reduce((highest, next) => maxRisk(highest, next), "Low" as const)
    : "Low"
  const impactRisk = maxRisk(
    risk,
    diffRisk,
    problems.some((problem) => problem.severity === "error")
      ? "High"
      : problems.some((problem) => problem.severity === "warning")
        ? "Medium"
        : "Low",
  )
  const impactNotes = [
    changedFiles.length
      ? `${changedFiles.length} pending AI-touched file${changedFiles.length === 1 ? "" : "s"} can affect ${affectedFiles.size} known file${affectedFiles.size === 1 ? "" : "s"}.`
      : "No pending AI file edits are waiting for review.",
    dependencies.length
      ? "Dependency edges were inferred from imports, requires, HTML assets, and CSS imports."
      : "No internal dependency edges were detected in the scanned files.",
    impactRisk === "High"
      ? "Review carefully and run the app before accepting. Rewind code + chat undoes the last request if it goes wrong."
      : impactRisk === "Medium"
        ? "A targeted review and preview run should be enough before accepting."
        : "This appears low risk based on local file and diff analysis.",
  ]

  const ownership = [
    ...new Set([...changedFiles, ...importantFiles, ...architecture.slice(0, 8).map((item) => item.path)]),
  ]
    .slice(0, 24)
    .map((path) => ({
      file: path,
      owner: changedFiles.includes(path) ? "AI edited" : "Workspace",
      reason: changedFiles.includes(path)
        ? "The current AI task modified this file, so it appears in Review changes."
        : importantFiles.includes(path)
          ? "This file looks central to running or understanding the repository."
          : "This file is part of the detected architecture map.",
    }))

  const runbook = [
    runCommands[0]
      ? `Run locally with: ${runCommands[0]}`
      : "No obvious run command was detected. Open the main entry file or add scripts to package.json.",
    preview.status === "ready"
      ? `Preview should start from ${htmlFiles[0]?.path ?? entrypoints[0] ?? "the detected entry file"}.`
      : preview.title,
    problems.some((problem) => problem.severity === "error")
      ? "Fix blocking local problems before demoing or asking for another broad AI edit."
      : "Use the controlled Browser or terminal checks after each meaningful AI edit.",
    "If something breaks, inspect the review diff and use Rewind code + chat only if the change moved in the wrong direction.",
  ]

  const changedSummary = diffs.map(
    (diff) => `${diffActionLabel(diff)} ${diff.file} (+${diff.additions ?? 0}/-${diff.deletions ?? 0})`,
  )
  const learning = {
    appOverview: [
      `This repository currently looks like ${frameworks.join(" + ") || "a plain web/code"} workspace with ${files.length} scanned source file${files.length === 1 ? "" : "s"}.`,
      importantFiles.length
        ? `Start by reading: ${importantFiles.slice(0, 5).join(", ")}.`
        : "Vector did not find a clear entry point yet.",
      preview.status === "ready"
        ? "There is a previewable browser entry, so UI changes can be checked visually."
        : "Preview needs an entry file or missing asset fixes before it is reliable.",
    ],
    changeExplanation: changedSummary.length
      ? changedSummary
      : [
          "No pending AI change is waiting. Once Vector edits code, this section explains the change in plain language.",
        ],
  }

  const mistakeJournal = problems.slice(0, 12).map((problem) => ({
    title: `${problem.severity === "error" ? "Blocking issue" : problem.severity === "warning" ? "Risk noted" : "Follow-up"} in ${reportFileBasename(problem.path)}`,
    detail: problem.message,
    severity: problem.severity,
  }))

  const modelStrength = modelStrengthFromLabel(modelLabel)
  const modelFit =
    modelStrength === "Frontier"
      ? {
          strength: modelStrength,
          verdict: "Good fit for large edits",
          detail:
            "This model tier should handle multi-file planning, refactors, and repair loops if the task scope is clear.",
          route: "Use it for controlled-browser repair and complex architecture changes.",
        }
      : modelStrength === "Balanced"
        ? {
            strength: modelStrength,
            verdict: "Good fit for focused edits",
            detail:
              "This model tier should do well on bounded tasks, but large rewrites should be split into smaller requests.",
            route: "Use it for fixes, explanations, and small-to-medium file changes.",
          }
        : modelStrength === "Cheap"
          ? {
              strength: modelStrength,
              verdict: "Use carefully",
              detail: "Cheap, fast models can miss context or output incomplete edits on larger workspaces.",
              route: "Route simple questions here; use a stronger model for multi-file code generation.",
            }
          : {
              strength: modelStrength,
              verdict: "Select a model before serious edits",
              detail: "Vector cannot estimate capability until a model is selected.",
              route: "Connect/select a model, then run a narrow task or replay benchmark.",
            }

  const promptReplayBench = [
    {
      model: "Cheap / fast model",
      quality: risk === "High" ? "Low for this repository size" : "Useful for small questions",
      cost: "Lowest",
      recommendation: "Use for explanations, quick searches, and narrow one-file fixes.",
    },
    {
      model: "Balanced coding model",
      quality: risk === "High" ? "Good with selected files" : "Strong for normal edits",
      cost: "Moderate",
      recommendation: "Best default for day-to-day Vector work.",
    },
    {
      model: "Frontier model",
      quality: "Best for multi-file generation and repair loops",
      cost: "Highest",
      recommendation: "Use before demos, big refactors, and hard debugging.",
    },
  ]

  return {
    scannedAt: Date.now(),
    fileCount: files.length,
    lineCount,
    charCount,
    languageRows: [...languageMap.entries()]
      .map(([label, value]) => ({ label, ...value }))
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 8),
    entrypoints,
    frameworks: frameworks.length ? frameworks : ["Plain web / unknown stack"],
    runCommands,
    problems: problems.slice(0, 24),
    preview,
    cost: {
      estimatedTokens,
      risk,
      guidance: costGuidance,
    },
    memory: {
      summary: `${files.length} scanned text file${files.length === 1 ? "" : "s"}, ${lineCount.toLocaleString()} lines, ${frameworks.join(" + ") || "unknown stack"}.`,
      importantFiles,
      nextSteps: [
        preview.status === "blocked"
          ? "Create or select a previewable app entry."
          : "Open Browser and verify the main screen renders.",
        problems.some((problem) => problem.severity === "error")
          ? "Fix blocking syntax/missing-asset errors first."
          : "Keep changes small and inspect them through Review Changes.",
        "Use Rewind code + chat if a broad AI edit goes the wrong way.",
      ],
    },
    promptGuard: {
      verdict: risk === "High" ? "Ask narrower prompts." : "Prompt size is manageable.",
      suggestions: [
        "Name the exact behavior you want changed.",
        "Mention the target screen/file when you know it.",
        "Paste the runtime error or screenshot details for debugging tasks.",
        risk === "High"
          ? "Avoid “rewrite the whole app”; ask for one feature or one bug at a time."
          : "Ask for a plan first when the edit touches multiple files.",
      ],
    },
    demoChecklist: [
      "Open the repository in Vector Agent.",
      "Run one focused edit and wait for reviewable changes.",
      "Open Review changes to inspect changed files before accepting them.",
      preview.status === "ready" ? "Open Browser and show the rendered app." : "Fix preview blockers before demoing.",
      "Use Rewind code + chat if the edit is not trustworthy.",
    ],
    architecture,
    dependencies,
    symbols,
    impact: {
      risk: impactRisk,
      notes: impactNotes,
      affectedFiles: [...affectedFiles].slice(0, 40),
    },
    ownership,
    runbook,
    learning,
    mistakeJournal,
    modelFit,
    promptReplayBench,
  }
}

function splitPatchLines(value: string) {
  if (!value) return []
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value
  return normalized.split("\n")
}

const CODESPACE_CODE_PROBLEM_EXTENSIONS = new Set([
  "css",
  "html",
  "js",
  "jsx",
  "json",
  "mjs",
  "cjs",
  "py",
  "sh",
  "ts",
  "tsx",
])
const CODESPACE_SECRET_SCAN_EXTENSIONS = new Set([
  "cjs",
  "css",
  "env",
  "html",
  "js",
  "jsx",
  "json",
  "mjs",
  "py",
  "sh",
  "ts",
  "tsx",
  "yaml",
  "yml",
])
const CODESPACE_CONSOLE_SCAN_EXTENSIONS = new Set(["cjs", "html", "js", "jsx", "mjs", "ts", "tsx"])
const CODESPACE_BRACKET_SCAN_EXTENSIONS = new Set(["cjs", "css", "html", "js", "jsx", "json", "mjs", "ts", "tsx"])

function codespaceProblemExtension(path: string) {
  const name = path.split(/[\\/]/).pop() ?? path
  if (/^\.env(?:\.|$)/i.test(name)) return "env"
  const match = /\.([^.]+)$/.exec(name)
  return match?.[1]?.toLowerCase() ?? ""
}

function stripCodespaceQuotedText(line: string) {
  return line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""')
}

function stripCodespaceScanNoise(
  line: string,
  extension: string,
  state: { blockComment: boolean; htmlComment: boolean },
) {
  let next = stripCodespaceQuotedText(line)

  if (extension === "html") {
    if (state.htmlComment) {
      const end = next.indexOf("-->")
      if (end === -1) return ""
      next = next.slice(end + 3)
      state.htmlComment = false
    }
    while (next.includes("<!--")) {
      const start = next.indexOf("<!--")
      const end = next.indexOf("-->", start + 4)
      if (end === -1) {
        next = next.slice(0, start)
        state.htmlComment = true
        break
      }
      next = `${next.slice(0, start)} ${next.slice(end + 3)}`
    }
  }

  if (["css", "js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(extension)) {
    if (state.blockComment) {
      const end = next.indexOf("*/")
      if (end === -1) return ""
      next = next.slice(end + 2)
      state.blockComment = false
    }
    while (next.includes("/*")) {
      const start = next.indexOf("/*")
      const end = next.indexOf("*/", start + 2)
      if (end === -1) {
        next = next.slice(0, start)
        state.blockComment = true
        break
      }
      next = `${next.slice(0, start)} ${next.slice(end + 2)}`
    }
    next = next.replace(/\/\/.*$/, "")
  }

  if (extension === "py" || extension === "sh" || extension === "env" || extension === "yaml" || extension === "yml") {
    next = next.replace(/#.*$/, "")
  }

  return next
}

function analyzeCodespaceProblems(path: string | undefined, text: string): CodespaceProblem[] {
  const problems: CodespaceProblem[] = []
  if (!path) return problems

  const extension = codespaceProblemExtension(path)
  const codeLike = CODESPACE_CODE_PROBLEM_EXTENSIONS.has(extension)
  const secretLike = CODESPACE_SECRET_SCAN_EXTENSIONS.has(extension)
  if (!codeLike && !secretLike) return problems

  const lines = text.split("\n")
  const stack: { char: string; line: number }[] = []
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" }
  const closing = new Set(Object.values(pairs))
  const scanState = { blockComment: false, htmlComment: false }

  for (const [index, line] of lines.entries()) {
    const number = index + 1
    const scanLine = stripCodespaceScanNoise(line, extension, scanState)

    if (secretLike && /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"']{8,}/i.test(line)) {
      problems.push({
        severity: "error",
        line: number,
        message: "Possible hardcoded secret. Move credentials into environment variables or Vector settings.",
      })
    }
    if (CODESPACE_CONSOLE_SCAN_EXTENSIONS.has(extension) && /\bconsole\.log\s*\(/.test(scanLine)) {
      problems.push({
        severity: "warning",
        line: number,
        message: "Debug console output detected. Remove it before shipping if it is not intentional.",
      })
    }
    if (codeLike && /\bTODO\b|\bFIXME\b/i.test(scanLine)) {
      problems.push({
        severity: "info",
        line: number,
        message: "Follow-up marker found.",
      })
    }

    if (!CODESPACE_BRACKET_SCAN_EXTENSIONS.has(extension)) continue
    for (const char of scanLine) {
      if (pairs[char]) stack.push({ char, line: number })
      if (!closing.has(char)) continue
      const last = stack.at(-1)
      if (!last) continue
      if (pairs[last.char] === char) stack.pop()
    }
  }

  const lastOpen = stack.at(-1)
  if (lastOpen && CODESPACE_BRACKET_SCAN_EXTENSIONS.has(extension)) {
    problems.push({
      severity: "warning",
      line: lastOpen.line,
      message: `Possible unmatched "${lastOpen.char}".`,
    })
  }

  if (/\.html?$/i.test(path)) {
    const html = text.toLowerCase()
    if (html.includes("<script") && !html.includes("</script>")) {
      problems.push({ severity: "error", line: 1, message: "HTML contains an opening script tag without a close tag." })
    }
    if (html.includes("<style") && !html.includes("</style>")) {
      problems.push({ severity: "error", line: 1, message: "HTML contains an opening style tag without a close tag." })
    }
  }

  return problems
}

const SECRET_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    label: "Hardcoded credential",
    pattern: /\b(?:api[_-]?key|secret|password|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i,
  },
]

function detectSecrets(text: string) {
  return SECRET_PATTERNS.filter((item) => item.pattern.test(text)).map((item) => item.label)
}

// Earlier builds stored whole-file snapshots of every AI change (up to ~2M
// characters of the shared localStorage quota) for the removed Code Archaeology
// panel, plus a per-session "seen" key that the secret scan now keeps under
// vector.secret-scan.<session>. Nothing reads the old keys any more, so free
// that space once per app load. Best effort: storage may be blocked.
let legacyCheckpointsCleared = false
function clearLegacyCheckpoints() {
  if (legacyCheckpointsCleared) return
  legacyCheckpointsCleared = true
  try {
    const stale = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "").filter(
      (key) => key === "vector.ai-change-checkpoints.v1" || key.startsWith("vector.ai-change-checkpoint."),
    )
    for (const key of stale) localStorage.removeItem(key)
  } catch {
    // Leaving stale data behind is harmless.
  }
}

function estimateDiffRisk(diff: RenderDiff): "Low" | "Medium" | "High" {
  const additions = diff.additions ?? 0
  const deletions = diff.deletions ?? 0
  const touched = additions + deletions
  if (diff.status === "deleted" || deletions > 200 || touched > 500) return "High"
  if (diff.status === "added" || deletions > 40 || touched > 120) return "Medium"
  return "Low"
}

function diffActionLabel(diff: RenderDiff) {
  if (diff.status === "added") return "Created file"
  if (diff.status === "deleted") return "Deleted file"
  return "Edited file"
}

function timelineTypeLabel(type: EngineeringEventType) {
  const labels: Record<EngineeringEventType, string> = {
    ai: "AI",
    file: "Files",
    terminal: "Terminal",
    browser: "Browser",
    checkpoint: "Checkpoint",
    review: "Review",
    error: "Error",
    build: "Build",
    decision: "Decision",
  }
  return labels[type]
}

function timelineIcon(type: EngineeringEventType) {
  const icons: Record<EngineeringEventType, string> = {
    ai: "✦",
    file: "{}",
    terminal: "$",
    browser: "◉",
    checkpoint: "✓",
    review: "↳",
    error: "!",
    build: "▣",
    decision: "◇",
  }
  return icons[type]
}

function timelineStatusLabel(status: EngineeringEventStatus) {
  const labels: Record<EngineeringEventStatus, string> = {
    pending: "Pending",
    running: "Running",
    success: "Success",
    warning: "Warning",
    failed: "Failed",
  }
  return labels[status]
}

function fileLanguage(path: string | undefined) {
  if (!path) return "text"
  const ext = path.split(".").pop()?.toLowerCase()
  if (!ext) return "text"
  const map: Record<string, string> = {
    js: "JavaScript",
    jsx: "React JSX",
    ts: "TypeScript",
    tsx: "React TSX",
    css: "CSS",
    html: "HTML",
    json: "JSON",
    md: "Markdown",
    py: "Python",
    java: "Java",
    go: "Go",
    rs: "Rust",
    rb: "Ruby",
    php: "PHP",
    swift: "Swift",
    kt: "Kotlin",
    sql: "SQL",
    yaml: "YAML",
    yml: "YAML",
  }
  return map[ext] ?? ext.toUpperCase()
}

function fileBasename(path: string | undefined) {
  if (!path) return "Untitled"
  return path.split("/").at(-1) || path
}

function fileBadge(path: string | undefined) {
  const ext = path?.split(".").pop()?.toLowerCase()
  if (!ext) return { label: "TXT", color: "text-slate-300", ring: "border-slate-400/25 bg-slate-500/10" }
  if (ext === "html" || ext === "htm")
    return { label: "HTML", color: "text-violet-300", ring: "border-violet-400/25 bg-violet-500/10" }
  if (ext === "css") return { label: "CSS", color: "text-pink-300", ring: "border-pink-400/25 bg-pink-500/10" }
  if (ext === "js" || ext === "jsx")
    return { label: ext.toUpperCase(), color: "text-yellow-300", ring: "border-yellow-400/25 bg-yellow-500/10" }
  if (ext === "ts" || ext === "tsx")
    return { label: ext.toUpperCase(), color: "text-sky-300", ring: "border-sky-400/25 bg-sky-500/10" }
  if (ext === "json")
    return { label: "JSON", color: "text-emerald-300", ring: "border-emerald-400/25 bg-emerald-500/10" }
  if (ext === "md") return { label: "MD", color: "text-zinc-300", ring: "border-zinc-400/25 bg-zinc-500/10" }
  return { label: ext.toUpperCase(), color: "text-slate-300", ring: "border-slate-400/25 bg-slate-500/10" }
}

const vectorCodeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "#c678dd", fontWeight: "600" },
  { tag: [t.atom, t.bool, t.null], color: "#d19a66" },
  { tag: [t.number, t.integer, t.float], color: "#d19a66" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#98c379" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6f7a8f", fontStyle: "italic" },
  { tag: [t.definition(t.variableName), t.function(t.variableName)], color: "#61afef" },
  { tag: [t.variableName, t.self, t.propertyName], color: "#e5c07b" },
  { tag: [t.typeName, t.className], color: "#56b6c2" },
  { tag: [t.tagName, t.angleBracket], color: "#e06c75" },
  { tag: [t.attributeName], color: "#d19a66" },
  { tag: [t.heading, t.strong], color: "#e5c07b", fontWeight: "700" },
  { tag: [t.link], color: "#61afef", textDecoration: "underline" },
  { tag: [t.invalid], color: "#ff7b72", textDecoration: "wavy underline" },
])

const vectorCodeTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      color: "#e2e0e8",
      backgroundColor: "#1d1d1f",
      fontSize: "var(--vector-editor-font-size, 13px)",
    },
    ".cm-scroller": {
      fontFamily:
        'var(--vector-editor-font-family, "JetBrainsMono Nerd Font Mono", "SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace)',
      lineHeight: "var(--vector-editor-line-height, 1.55)",
      overflow: "auto",
    },
    ".cm-content": {
      minHeight: "100%",
      padding: "8px 0 40px 0",
      caretColor: "#c4b5fd",
    },
    ".cm-line": {
      padding: "0 12px",
    },
    ".cm-gutters": {
      backgroundColor: "#202023",
      color: "#7c7889",
      borderRight: "1px solid rgba(255, 255, 255, 0.06)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "36px",
      padding: "0 8px 0 6px",
    },
    ".cm-foldGutter .cm-gutterElement": {
      padding: "0 7px 0 2px",
      color: "#6e6a7b",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(155, 108, 255, 0.07)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(155, 108, 255, 0.1)",
      color: "#c9c4d6",
    },
    ".cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(139, 92, 246, 0.34) !important",
    },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "rgba(139, 92, 246, 0.26)",
      outline: "1px solid rgba(196, 181, 253, 0.65)",
      borderRadius: "3px",
    },
    ".cm-tooltip": {
      border: "1px solid rgba(255, 255, 255, 0.1)",
      backgroundColor: "#242428",
      color: "#e5e2ec",
      borderRadius: "10px",
      boxShadow: "0 18px 45px rgba(0,0,0,0.38)",
      overflow: "hidden",
    },
    ".cm-tooltip-autocomplete ul": {
      fontFamily:
        'var(--vector-editor-font-family, "JetBrainsMono Nerd Font Mono", "SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace)',
      padding: "6px",
    },
    ".cm-tooltip-autocomplete ul li": {
      borderRadius: "7px",
      padding: "4px 10px",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "rgba(124, 58, 237, 0.28)",
      color: "#ffffff",
    },
    ".cm-completionMatchedText": {
      color: "#c4b5fd",
      textDecoration: "none",
      fontWeight: "700",
    },
    ".cm-cursor": {
      borderLeftColor: "#c4b5fd",
    },
    ".cm-indent-guide": {
      borderLeft: "1px solid rgba(255, 255, 255, 0.08)",
    },
    ".cm-scroller::-webkit-scrollbar": {
      width: "12px",
      height: "12px",
    },
    ".cm-scroller::-webkit-scrollbar-track": {
      background: "#202023",
    },
    ".cm-scroller::-webkit-scrollbar-thumb": {
      background: "#3a3742",
      border: "3px solid #202023",
      borderRadius: "999px",
    },
    ".cm-scroller::-webkit-scrollbar-thumb:hover": {
      background: "#4c4857",
    },
  },
  { dark: true },
)

const commonKeywordCompletions: Completion[] = [
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "else",
  "export",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "let",
  "new",
  "null",
  "return",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "undefined",
  "var",
  "while",
].map((label) => ({ label, type: "keyword", detail: "keyword", boost: 55 }))

const javascriptSnippets: Completion[] = [
  snippetCompletion("function ${name}(${params}) {\n\t${}\n}", {
    label: "function",
    type: "snippet",
    detail: "function declaration",
    boost: 90,
  }),
  snippetCompletion("const ${name} = (${params}) => {\n\t${}\n}", {
    label: "arrow function",
    type: "snippet",
    detail: "const arrow function",
    boost: 86,
  }),
  snippetCompletion('import ${name} from "${module}"', {
    label: "import",
    type: "snippet",
    detail: "ES module import",
    boost: 84,
  }),
  snippetCompletion("if (${condition}) {\n\t${}\n}", {
    label: "if",
    type: "snippet",
    detail: "if statement",
    boost: 82,
  }),
  snippetCompletion("for (const ${item} of ${items}) {\n\t${}\n}", {
    label: "for of",
    type: "snippet",
    detail: "for...of loop",
    boost: 78,
  }),
  snippetCompletion("export default function ${Component}() {\n\treturn (\n\t\t<div>${}</div>\n\t)\n}", {
    label: "React component",
    type: "snippet",
    detail: "functional component",
    boost: 88,
  }),
]

const pythonCompletions: Completion[] = [
  "and",
  "as",
  "class",
  "def",
  "elif",
  "else",
  "False",
  "for",
  "from",
  "if",
  "import",
  "in",
  "None",
  "not",
  "or",
  "return",
  "True",
  "try",
  "while",
  "with",
].map((label) => ({ label, type: "keyword", detail: "Python keyword", boost: 58 }))

const pythonSnippets: Completion[] = [
  snippetCompletion("def ${name}(${params}):\n\t${}", {
    label: "def",
    type: "snippet",
    detail: "Python function",
    boost: 90,
  }),
  snippetCompletion("class ${Name}:\n\tdef __init__(self):\n\t\t${}", {
    label: "class",
    type: "snippet",
    detail: "Python class",
    boost: 82,
  }),
  snippetCompletion("if ${condition}:\n\t${}", { label: "if", type: "snippet", detail: "Python if block", boost: 80 }),
]

const htmlCompletions: Completion[] = [
  "a",
  "article",
  "body",
  "button",
  "div",
  "footer",
  "form",
  "h1",
  "h2",
  "head",
  "header",
  "html",
  "img",
  "input",
  "label",
  "li",
  "main",
  "meta",
  "nav",
  "p",
  "script",
  "section",
  "span",
  "style",
  "ul",
].map((label) => ({ label, type: "keyword", detail: "HTML tag", boost: 62 }))

const htmlSnippets: Completion[] = [
  snippetCompletion("<${tag}>${}</${tag}>", { label: "tag", type: "snippet", detail: "HTML element", boost: 86 }),
  snippetCompletion('<div class="${className}">\n\t${}\n</div>', {
    label: "div",
    type: "snippet",
    detail: "div with class",
    boost: 84,
  }),
  snippetCompletion('<button type="button">${label}</button>', {
    label: "button",
    type: "snippet",
    detail: "button element",
    boost: 76,
  }),
]

const cssCompletions: Completion[] = [
  "align-items",
  "background",
  "background-color",
  "border",
  "border-radius",
  "box-shadow",
  "color",
  "display",
  "flex",
  "font-family",
  "font-size",
  "gap",
  "grid",
  "height",
  "justify-content",
  "margin",
  "max-width",
  "min-height",
  "padding",
  "position",
  "transition",
  "width",
].map((label) => ({ label, type: "property", detail: "CSS property", boost: 60 }))

const cssSnippets: Completion[] = [
  snippetCompletion("display: flex;\nalign-items: ${center};\njustify-content: ${center};", {
    label: "flex center",
    type: "snippet",
    detail: "center with flexbox",
    boost: 82,
  }),
  snippetCompletion("grid-template-columns: repeat(${count}, minmax(0, 1fr));", {
    label: "grid columns",
    type: "snippet",
    detail: "responsive grid columns",
    boost: 78,
  }),
]

const jsonCompletions: Completion[] = ["true", "false", "null"].map((label) => ({
  label,
  type: "constant",
  detail: "JSON value",
  boost: 70,
}))

const shellCompletions: Completion[] = [
  "cat",
  "cd",
  "chmod",
  "cp",
  "done",
  "echo",
  "elif",
  "else",
  "export",
  "fi",
  "for",
  "grep",
  "if",
  "mkdir",
  "npm",
  "python",
  "rm",
  "then",
].map((label) => ({ label, type: "keyword", detail: "shell", boost: 54 }))

function fileExtension(path: string | undefined) {
  if (!path) return ""
  const name = fileBasename(path).toLowerCase()
  if (name === "dockerfile") return "dockerfile"
  if (name.startsWith(".env")) return "env"
  return path.split(".").pop()?.toLowerCase() ?? ""
}

function looksLikeHtml(text: string) {
  const value = text.trimStart().toLowerCase()
  return value.startsWith("<!doctype") || value.startsWith("<html") || /<([a-z][\w:-]*)(\s|>|\/>)/i.test(value)
}

function inferExtensionFromContent(text: string) {
  const value = text.trim()
  if (!value) return ""
  if (looksLikeHtml(value)) return "html"
  if (
    /^#!.*\b(bash|sh|zsh)\b/.test(value) ||
    /\b(npm|pnpm|bun|python|pip|echo|export)\b/.test(value.split("\n").slice(0, 8).join("\n"))
  )
    return "sh"
  if (/^\s*[{[]/.test(value)) {
    try {
      JSON.parse(value)
      return "json"
    } catch {
      // Keep looking; JavaScript and CSS can also start with braces.
    }
  }
  if (/(^|\n)\s*(def|class|import|from)\s+[\w*.]+/m.test(value) || /(^|\n)\s*print\(/m.test(value)) return "py"
  if (/(^|\n)\s*(@import|:root|body\s*\{|[.#][\w-]+\s*\{|[\w-]+\s*:\s*[^;\n]+;)/m.test(value)) return "css"
  if (/(^|\n)\s*(import|export|const|let|var|function|class|interface|type)\s+/m.test(value)) {
    if (/(^|\n)\s*(interface|type)\s+\w+\s*=|:\s*React\.|<\w+[\s>]/m.test(value)) return "tsx"
    return "js"
  }
  return ""
}

function languageExtension(path: string | undefined, content = "") {
  const ext = fileExtension(path)
  if (!ext || ext === "txt" || ext === "text") return inferExtensionFromContent(content) || ext
  return ext
}

function codeMirrorLanguage(path: string, content = ""): Extension {
  const ext = languageExtension(path, content)
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return javascript({ jsx: true })
  if (ext === "ts") return javascript({ typescript: true })
  if (ext === "tsx") return javascript({ jsx: true, typescript: true })
  if (ext === "html" || ext === "htm" || ext === "xml" || ext === "vue" || ext === "svelte") return html()
  if (ext === "css" || ext === "scss" || ext === "less") return css()
  if (ext === "json" || ext === "jsonc") return json()
  if (ext === "py" || ext === "pyw") return python()
  if (ext === "md" || ext === "markdown") return markdown()
  if (ext === "sh" || ext === "bash" || ext === "zsh" || ext === "env") return StreamLanguage.define(shell)
  return []
}

function languageCompletions(path: string, content = "") {
  const ext = languageExtension(path, content)
  if (ext === "py" || ext === "pyw") return [...pythonCompletions, ...pythonSnippets]
  if (ext === "html" || ext === "htm" || ext === "xml" || ext === "vue" || ext === "svelte") {
    return [...htmlCompletions, ...htmlSnippets, ...commonKeywordCompletions]
  }
  if (ext === "css" || ext === "scss" || ext === "less") return [...cssCompletions, ...cssSnippets]
  if (ext === "json" || ext === "jsonc") return jsonCompletions
  if (ext === "sh" || ext === "bash" || ext === "zsh" || ext === "env") return [...shellCompletions]
  if (ext === "md" || ext === "markdown") return [...commonKeywordCompletions]
  return [...commonKeywordCompletions, ...javascriptSnippets]
}

function localWordCompletions(text: string): Completion[] {
  const seen = new Set<string>()
  const out: Completion[] = []
  const matches = text.matchAll(/\b[A-Za-z_$][\w$-]{2,}\b/g)
  for (const match of matches) {
    const label = match[0]
    if (seen.has(label)) continue
    seen.add(label)
    out.push({ label, type: /^[A-Z]/.test(label) ? "class" : "variable", detail: "current file", boost: 18 })
    if (out.length >= 650) break
  }
  return out
}

function vectorCompletionSource(path: string) {
  return (context: CompletionContext) => {
    const word = context.matchBefore(/[A-Za-z_$][\w$-]*/)
    if (!word || (!context.explicit && word.from === word.to)) return null
    const text = context.state.doc.toString()
    const options = [...languageCompletions(path, text), ...localWordCompletions(text)]
    return {
      from: word.from,
      options,
      validFor: /^[A-Za-z_$][\w$-]*$/,
    }
  }
}

function VectorCodeEditor(props: { path: string; value: string; onChange: (next: string) => void }) {
  const editorSettings = useSettings().editor
  let mount: HTMLDivElement | undefined
  let view: EditorView | undefined
  let internalUpdate = false

  const destroy = () => {
    view?.destroy()
    view = undefined
  }

  createEffect(
    on(
      () =>
        [
          props.path,
          editorSettings.wordWrap(),
          editorSettings.showLineNumbers(),
          editorSettings.highlightActiveLine(),
          editorSettings.renderWhitespace(),
        ] as const,
      ([path, wordWrap, showLineNumbers, activeLine, whitespace]) => {
        if (!mount) return
        destroy()
        mount.textContent = ""
        const doc = untrack(() => props.value ?? "")
        view = new EditorView({
          parent: mount,
          state: EditorState.create({
            doc,
            extensions: [
              ...(showLineNumbers ? [codeMirrorLineNumbers()] : []),
              foldGutter(),
              ...(activeLine ? [highlightActiveLineGutter()] : []),
              history(),
              drawSelection(),
              dropCursor(),
              EditorState.allowMultipleSelections.of(true),
              indentOnInput(),
              bracketMatching(),
              closeBrackets(),
              rectangularSelection(),
              crosshairCursor(),
              ...(activeLine ? [highlightActiveLine()] : []),
              ...(wordWrap ? [EditorView.lineWrapping] : []),
              ...(whitespace ? [highlightWhitespace()] : []),
              highlightSelectionMatches(),
              indentUnit.of("  "),
              codeMirrorLanguage(path, doc),
              syntaxHighlighting(vectorCodeHighlight, { fallback: true }),
              vectorCodeTheme,
              autocompletion({
                activateOnTyping: true,
                defaultKeymap: true,
                override: [vectorCompletionSource(path)],
              }),
              keymap.of([
                indentWithTab,
                ...closeBracketsKeymap,
                ...defaultKeymap,
                ...historyKeymap,
                ...completionKeymap,
              ]),
              EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                  internalUpdate = true
                  props.onChange(update.state.doc.toString())
                }
              }),
            ],
          }),
        })
      },
      { defer: false },
    ),
  )

  createEffect(() => {
    const next = props.value ?? ""
    if (!view) return
    const current = view.state.doc.toString()
    if (internalUpdate) internalUpdate = false
    if (next === current) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: next } })
  })

  onCleanup(destroy)

  return <div ref={mount} class="h-full w-full overflow-hidden bg-[#1d1d1f]" />
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

function compactTask(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 180)
}

function previewDiffLines(before: string, after: string) {
  const oldLines = splitPatchLines(before)
  const newLines = splitPatchLines(after)
  return newLines.map((line, index) => ({
    number: index + 1,
    line,
    added: oldLines[index] !== line,
  }))
}

function extractModelText(value: unknown, depth = 0): string {
  if (!value || depth > 5) return ""
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value))
    return value
      .map((item) => extractModelText(item, depth + 1))
      .filter(Boolean)
      .join("\n\n")
      .trim()
  if (typeof value !== "object") return ""

  const candidate = value as Record<string, unknown>
  if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text.trim()

  for (const key of ["text", "content", "message", "output", "output_text", "response"]) {
    const next = candidate[key]
    if (typeof next === "string" && next.trim()) return next.trim()
  }

  for (const key of ["parts", "content", "messages", "data", "message", "output"]) {
    const next = candidate[key]
    const text = extractModelText(next, depth + 1)
    if (text) return text
  }

  return ""
}

function extractModelTextRaw(value: unknown, depth = 0): string {
  if (!value || depth > 5) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value
      .map((item) => extractModelTextRaw(item, depth + 1))
      .filter((item) => item.trim())
      .join("\n\n")
  if (typeof value !== "object") return ""

  const candidate = value as Record<string, unknown>
  if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text

  for (const key of ["text", "content", "message", "output", "output_text", "response"]) {
    const next = candidate[key]
    if (typeof next === "string" && next.trim()) return next
  }

  for (const key of ["parts", "content", "messages", "data", "message", "output"]) {
    const text = extractModelTextRaw(candidate[key], depth + 1)
    if (text.trim()) return text
  }

  return ""
}

function extractFirstCodeBlock(text: string) {
  const match = text.match(/```[^\n`]*\n([\s\S]*?)```/)
  return match?.[1]?.replace(/\s+$/, "")
}

function extractGeneratedCodeProposal(text: string, current: string) {
  const block = extractFirstCodeBlock(text)
  if (block?.trim()) return block.replace(/\s+$/, "")

  const trimmed = text.trim()
  if (!trimmed) return
  const looksLikeCode = [
    /^\s*<!doctype\s+html/i,
    /^\s*<html[\s>]/i,
    /^\s*(import|export|const|let|var|function|class|def|from|#include)\b/m,
    /^\s*(body|html|main|\.|#)[\w\s.#:[\]-]*\{/m,
    /^\s*[\[{][\s\S]*[\]}]\s*$/m,
    /<\/[a-z][\w-]*>/i,
  ].some((pattern) => pattern.test(trimmed))

  if (!looksLikeCode) return
  if (current.length > 800 && trimmed.length < current.length * 0.35) return
  return trimmed.replace(/\s+$/, "")
}

function isHtmlPath(path: string | undefined) {
  return Boolean(path?.match(/\.html?$/i))
}

function pathDirname(path: string) {
  const index = path.lastIndexOf("/")
  return index === -1 ? "" : path.slice(0, index)
}

function previewAssetPath(htmlPath: string, asset: string) {
  const clean = asset.split(/[?#]/)[0]?.trim()
  if (!clean || /^(https?:|data:|blob:|\/\/)/i.test(clean)) return
  if (clean.startsWith("/")) {
    const stripped = clean.replace(/^\/+/, "")
    const previewRoot = pathDirname(htmlPath).split("/")[0]
    if ((previewRoot === "dist" || previewRoot === "build") && stripped) return `${previewRoot}/${stripped}`
    return stripped
  }
  const dir = pathDirname(htmlPath)
  const parts = `${dir ? `${dir}/` : ""}${clean}`.split("/")
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return out.join("/")
}

function looksLikeBundledAppHtml(html: string) {
  return (
    /<script\b[^>]*type=(["'])module\1[^>]*src=/i.test(html) ||
    /\/src\/[^"']+\.(?:m?js|jsx|ts|tsx)(?:\?[^"']*)?/i.test(html)
  )
}

function looksLikeViteProject(packageJson: string) {
  return /"vite"\s*:/.test(packageJson) || /"@vitejs\//.test(packageJson)
}

function previewAssetRefs(htmlPath: string, html: string) {
  const out = new Set<string>()
  html.replace(/<link\b[^>]*?href=(["'])([^"']+\.css(?:\?[^"']*)?)\1[^>]*?>/gi, (_match, _quote, href) => {
    const path = previewAssetPath(htmlPath, href)
    if (path) out.add(path)
    return ""
  })
  html.replace(
    /<script\b[^>]*?src=(["'])([^"']+\.(?:m?js|jsx|ts|tsx)(?:\?[^"']*)?)\1[^>]*?>\s*<\/script>/gi,
    (_match, _quote, src) => {
      const path = previewAssetPath(htmlPath, src)
      if (path) out.add(path)
      return ""
    },
  )
  return [...out]
}

export function CodespaceWorkbench(props: {
  modified: () => readonly string[]
  kinds: () => ReadonlyMap<string, Kind>
  empty: () => JSX.Element
  diffs: () => readonly RenderDiff[]
  focusReviewDiff: (path: string) => void
  sessionId?: () => string | undefined
  onClose: () => void
  embedded?: boolean
  portalMount?: Node
  externalAgent?: {
    label: string
    running: boolean
    panel: JSX.Element
    /**
     * The runner's activity. Steps that report files are followed before the
     * watcher fires. Undefined until it has been read: the first snapshot is history.
     */
    activity?: () => readonly ExternalActivityEntry[] | undefined
  }
  /** The session panel's follow store, which outlives this editor. */
  follow?: AgentFollow
}) {
  const file = useFile()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const settings = useSettings()
  const dialog = useDialog()
  const command = useCommand()
  const [selectedPath, setSelectedPath] = createSignal<string | undefined>()
  const [activeView, setActiveView] = createSignal<CodespaceView>("editor")
  const [saving, setSaving] = createSignal(false)
  const [openFiles, setOpenFiles] = createSignal<string[]>([])
  const [drafts, setDrafts] = createStore<Record<string, string>>({})
  const [draftBases, setDraftBases] = createStore<Record<string, string>>({})
  const [externalConflicts, setExternalConflicts] = createStore<Record<string, boolean>>({})
  const [inlineEditOpen, setInlineEditOpen] = createSignal(false)
  const [inlineEditInput, setInlineEditInput] = createSignal("")
  const [inlineEditRunning, setInlineEditRunning] = createSignal(false)
  const [inlineEditSelection, setInlineEditSelection] = createSignal<InlineEditSelection>()
  const [agentOpen, setAgentOpen] = createSignal(true)
  const [agentWidth, setAgentWidth] = createSignal(520)
  const [explorerOpen, setExplorerOpen] = createSignal(true)
  const [explorerWidth, setExplorerWidth] = createSignal(260)
  const [ignoredProblems, setIgnoredProblems] = createSignal<Set<string>>(new Set())
  const [liveWorkspaces, setLiveWorkspaces] = createSignal<CodespaceLiveWorkspace[]>([], {
    equals: sameWorkspaceRevisions,
  })
  const [liveWorkspaceError, setLiveWorkspaceError] = createSignal("")
  // Parallel workspaces that run in another directory: the files their writes
  // named (marked before the next poll), the watched copy's text as read from
  // that directory, and the copy the user is watching.
  const [workspaceTouches, setWorkspaceTouches] = createStore<Record<string, string[]>>({})
  const [workspaceTexts, setWorkspaceTexts] = createStore<Record<string, string>>({})
  const [workspaceView, setWorkspaceView] = createSignal<{
    id: string
    name: string
    color: string
    directory: string
    relative: string
    key: string
    error?: string
  }>()
  const [followedWorkspace, setFollowedWorkspace] = createSignal<string>()

  const state = createMemo(() => {
    const path = selectedPath()
    if (!path) return
    return file.get(path)
  })
  const contents = createMemo(() => state()?.content?.content ?? "")
  const draft = createMemo(() => {
    const path = selectedPath()
    if (!path) return ""
    return drafts[path] ?? contents()
  })
  const dirty = createMemo(() => {
    const path = selectedPath()
    if (!path) return false
    return draft() !== contents()
  })
  const problemKey = (problem: CodespaceProblem) => `${problem.line}:${problem.severity}:${problem.message}`
  const problems = createMemo(() =>
    analyzeCodespaceProblems(selectedPath(), draft()).filter((problem) => !ignoredProblems().has(problemKey(problem))),
  )
  const lineCount = createMemo(() => draft().split("\n").length)
  const fileText = (path: string | undefined) => {
    if (!path) return ""
    return drafts[path] ?? file.get(path)?.content?.content ?? ""
  }
  const activeBadge = createMemo(() => fileBadge(selectedPath()))
  const breakpointCount = createMemo(() => problems().filter((problem) => problem.severity === "error").length)
  const selectedModelPayload = createMemo(() => {
    const model = local.model.current()
    if (!model) return
    return {
      providerID: model.provider.id,
      modelID: model.id,
    }
  })
  const activeVariant = createMemo(() => local.model.variant.current())
  const activeAgentName = createMemo(() => local.agent.current()?.name ?? "build")
  const editorSessionID = createMemo(() => props.sessionId?.())
  const editorSessionStatus = createMemo(() => {
    const id = editorSessionID()
    if (!id) return "idle"
    return sync().data.session_status[id]?.type ?? "idle"
  })
  const agentLabel = () => props.externalAgent?.label ?? "Vector Agent"
  const agentRunning = createMemo(() => props.externalAgent?.running ?? editorSessionStatus() !== "idle")
  const agentStatus = createMemo(() => {
    if (props.externalAgent) return props.externalAgent.running ? "Working" : "Ready"
    const status = editorSessionStatus()
    if (status === "idle") return "Ready"
    if (status === "busy") return "Working"
    if (status === "retry") return "Retrying"
    return "Working"
  })
  const editorMessages = createMemo<Message[]>(() => {
    const id = editorSessionID()
    if (!id) return []
    return sync().data.message[id] ?? []
  })
  const editorMessageParts = (messageID: string): Part[] => sync().data.part[messageID] ?? []
  const editorInputController = createPromptInputController({
    sessionKey: () => `${sdk().scope}\0${sdk().directory}\0${editorSessionID() ?? "codespace"}`,
    sessionID: editorSessionID,
    queryOptions: serverSync().queryOptions,
  })

  createEffect(() => {
    const id = editorSessionID()
    if (!id) return
    void sync().session.sync(id)
  })
  const editorWorkspaces = createMemo(() =>
    liveWorkspaces().filter(
      (workspace) =>
        workspace.mergeState === "none" && !["failed", "stopped", "merged", "discarded"].includes(workspace.status),
    ),
  )
  const activeFileWorkspaces = createMemo(() => {
    const path = selectedPath()
    if (!path) return []
    const normalized = normalizedWorkspacePath(path)
    return editorWorkspaces().filter((workspace) =>
      workspace.changedFiles.some((filePath) => normalizedWorkspacePath(filePath) === normalized),
    )
  })
  const liveFileMarkers = createMemo(() => {
    const markers = new Map<string, FileTreeMarker[]>()
    for (const workspace of editorWorkspaces()) {
      const marker = {
        id: workspace.id,
        color: workspaceColor(workspace.id),
        label: `${workspace.name}: ${workspace.lastAction}`,
      }
      for (const changedFile of [...workspace.changedFiles, ...(workspaceTouches[workspace.id] ?? [])]) {
        const path = normalizedWorkspacePath(changedFile)
        const parts = path.split("/").filter(Boolean)
        for (const [index] of parts.entries()) {
          const target = parts.slice(0, index + 1).join("/")
          const existing = markers.get(target) ?? []
          if (existing.some((item) => item.id === marker.id)) continue
          markers.set(target, [...existing, marker])
        }
      }
    }
    return markers
  })

  const refreshLiveWorkspaces = async () => {
    const api = globalThis.window?.api?.parallelWorkspaces
    if (!api) return
    const parentSessionId = props.sessionId?.()
    const scope = parentSessionId ? { sourcePath: sdk().directory, parentSessionId } : { sourcePath: sdk().directory }
    await api
      .list(scope)
      .then((records) => {
        setLiveWorkspaces(records)
        setLiveWorkspaceError("")
      })
      .catch((error) => {
        setLiveWorkspaceError(error instanceof Error ? error.message : "Agent activity is temporarily unavailable.")
      })
  }

  onMount(() => {
    void refreshLiveWorkspaces()
    const timer = globalThis.setInterval(() => void refreshLiveWorkspaces(), 1_000)
    onCleanup(() => globalThis.clearInterval(timer))
  })

  const invokeCodespaceModel = async (input: { title: string; system: string; prompt: string }) => {
    const model = selectedModelPayload()
    if (!model) {
      throw new Error("Select a model in Vector before using Codespace AI.")
    }

    // A helper session (see utils/internal-sessions.ts): out of every session list, kept so what it spent stays in
    // usage, and counted towards the open session's cost.
    const parentID = editorSessionID()
    const session = await sdk().client.session.create({
      directory: sdk().directory,
      title: input.title,
      internal: "codespace.edit",
      ...(parentID ? { parentID } : {}),
      agent: activeAgentName(),
      model: {
        providerID: model.providerID,
        id: model.modelID,
        variant: activeVariant(),
      },
      metadata: { source: "vector-codespace", engine: "vector-compatible" },
    })
    const sessionID = session.data?.id
    if (!sessionID) throw new Error("Vector could not create a Codespace AI session.")
    const result = await sdk().client.session.prompt({
      sessionID,
      directory: sdk().directory,
      agent: activeAgentName(),
      model,
      variant: activeVariant(),
      executionMode: "normal",
      system: input.system,
      // The editor applies the returned text. No model tool or question can be handled in this hidden session.
      tools: { "*": false },
      parts: [{ type: "text", text: input.prompt }],
    })
    const text = extractModelTextRaw(result.data)
    if (!text) throw new Error("The selected model returned an empty response.")
    return text
  }

  const openFile = (path: string) => {
    // Opening one of the user's own files ends watching a workspace's copy.
    setFollowedWorkspace(undefined)
    setWorkspaceView(undefined)
    setSelectedPath(path)
    setOpenFiles((items) => (items.includes(path) ? items : [...items, path]))
    setActiveView("editor")
    void file.load(path)
  }

  // Live agent edits. The follow store (agent-follow.ts) reads the raw server
  // events: it opens the file an agent's running edit tool names, marks where
  // the change will land, and attributes the changed lines once file.edited
  // lands. The session panel owns the store, so following survives this editor
  // closing and reopening. The external-agent mount has no session panel, so
  // it makes its own, which also follows the watcher and the files the runner
  // reports.
  const followAgent = settings.editor.followAgent
  const follow =
    props.follow ??
    createAgentFollow({
      listen: (fn) => sdk().event.listen(fn),
      source: fileFollowSource(file, CODESPACE_EXCLUDED_DIRECTORIES),
      followAgent,
      agents: () => sync().data.agent,
      agentFor: (sessionID, messageID) => messageAgent(sync().data.message[sessionID], messageID),
      external: () => props.externalAgent,
      saving,
    })
  // Unsaved drafts are what the editor shows, so they are the "before".
  follow.setBuffer((path) => drafts[path])
  onCleanup(() => follow.setBuffer(undefined))

  const followingAgent = createMemo(() => {
    const last = follow.following()
    if (last) return last
    if (props.externalAgent) return { name: props.externalAgent.label, color: agentColor(props.externalAgent.label) }
    const name = activeAgentName()
    return { name, color: resolveAgentColor(name, sync().data.agent, editorSessionID() ?? name) }
  })
  createEffect(() => {
    if (!agentRunning()) follow.clearFollowing()
  })
  const followStatus = createMemo(() => {
    const agent = followingAgent()
    if ("state" in agent && agent.state === "waiting") return `Following ${agent.name}: waiting for approval`
    if ("state" in agent && agent.state === "editing") {
      return `Following ${agent.name}: editing ${fileBasename(agent.path)}`
    }
    return `Following ${agent.name}`
  })

  // The editor goes where the agent is. This also runs on mount, so opening
  // the Codespace mid-edit lands on the file being edited. It never takes the
  // editor during the user's own save, or while they watch a workspace's copy.
  createEffect(
    on(follow.target, (target) => {
      if (!target || !followAgent() || saving() || followedWorkspace()) return
      if (Date.now() - target.token >= ATTRIBUTION_TTL_MS) {
        // An agent still editing, or waiting for approval, is followed however
        // long ago its call started: re-issue its target so the editor reveals it.
        const live = follow
          .cursorsFor(target.path)
          .some((cursor) => cursor.agentId === target.agentId && cursor.state !== "landed")
        if (live) follow.refreshTarget()
        return
      }
      if (selectedPath() === target.path && activeView() === "editor") return
      openFile(target.path)
    }),
  )

  // Reveal, cursors and typing only apply to the file on screen; a reveal for
  // a tab the user has since switched away from must not scroll the new one.
  const editorReveal = createMemo(() => {
    const target = follow.target()
    if (!target || target.path !== selectedPath()) return
    return { line: target.line, endLine: target.endLine, token: target.token }
  })

  // Parallel workspaces run in their own directory, so this editor's event
  // stream never sees their edits. Listen on the server-wide stream for those
  // directories instead: mark the file tree the moment a write lands (rather
  // than on the next one-second poll), and feed the workspace being watched to
  // the same follow store, so its copy shows its agent's cursor, colour and
  // typing.
  const sameDirectory = (a: string, b: string | undefined) =>
    b !== undefined && a.replace(/\\/g, "/").replace(/\/+$/, "") === b.replace(/\\/g, "/").replace(/\/+$/, "")
  const isForeignWorkspace = (workspace: CodespaceLiveWorkspace) =>
    !sameDirectory(workspace.isolatedPath, sdk().directory)
  const foreignWorkspaces = createMemo(() => editorWorkspaces().filter(isForeignWorkspace))
  const workspaceSources = new Map<string, { directory: string; source: FollowSource }>()
  const workspaceSource = (workspace: CodespaceLiveWorkspace) => {
    const cached = workspaceSources.get(workspace.id)
    if (cached?.directory === workspace.isolatedPath) return cached.source
    const client = serverSDK().createClient({ directory: workspace.isolatedPath, throwOnError: true })
    const source = directoryFollowSource({
      directory: workspace.isolatedPath,
      excluded: CODESPACE_EXCLUDED_DIRECTORIES,
      peek: (key) => workspaceTexts[key],
      read: async (relative, key) => {
        // Only the copy being watched is read: nothing else shows it.
        if (untrack(followedWorkspace) !== workspace.id) return
        const result = await client.file.read({ path: relative }).catch(() => undefined)
        const text = result?.data?.content
        // Watching may have stopped while the read was in flight.
        if (typeof text !== "string" || untrack(followedWorkspace) !== workspace.id) return
        setWorkspaceTexts(key, text)
        return text
      },
    })
    workspaceSources.set(workspace.id, { directory: workspace.isolatedPath, source })
    return source
  }

  // A memo, so the one-second poll (a new list every time) does not tear the
  // subscription down and open it again.
  const hasForeignWorkspaces = createMemo(() => foreignWorkspaces().length > 0)
  createEffect(
    on(hasForeignWorkspaces, (active) => {
      if (!active) return
      const stop = serverSDK().event.listen((event) => {
        const workspace = untrack(foreignWorkspaces).find((item) => sameDirectory(item.isolatedPath, event.name))
        if (!workspace) return
        const details = event.details
        const source = workspaceSource(workspace)
        // Only a write marks the tree. A running call can still be rejected or
        // fail, and its mark would then name a file the agent never changed.
        const wrote = details.type === "file.edited" || details.type === "file.watcher.updated"
        const touched = (wrote ? eventFiles(details) : []).flatMap((path) => {
          const key = source.key(path)
          const relative = key ? workspaceRelativePath(workspace.isolatedPath, key) : undefined
          return relative ? [relative] : []
        })
        if (touched.length) {
          // Newest last, so the chip opens the file the agent wrote most recently.
          setWorkspaceTouches(workspace.id, (current) => [
            ...(current ?? []).filter((path) => !touched.includes(path)),
            ...touched,
          ])
        }
        // Only the workspace being watched is followed: following reads the
        // agent's files over HTTP and keeps their text in memory.
        if (untrack(followedWorkspace) !== workspace.id) return
        follow.handle(details, {
          source,
          identity: { id: `workspace:${workspace.id}`, name: workspace.name, color: workspaceColor(workspace.id) },
          // Nothing but the external runner writes an external agent's copy.
          watcherEdits: workspace.runtime !== "vector",
        })
      })
      onCleanup(stop)
    }),
  )

  const openWorkspaceFile = async (workspace: CodespaceLiveWorkspace, relative: string) => {
    const source = workspaceSource(workspace)
    const key = source.key(relative)
    if (!key) return
    setWorkspaceView({
      id: workspace.id,
      name: workspace.name,
      color: workspaceColor(workspace.id),
      directory: workspace.isolatedPath,
      relative,
      key,
    })
    setActiveView("editor")
    if ((await source.read(key)) !== undefined) return
    setWorkspaceView((view) =>
      view?.key === key ? { ...view, error: "Vector could not read this file from the agent's workspace." } : view,
    )
  }
  const watchWorkspace = (workspace: CodespaceLiveWorkspace, relative: string) => {
    setFollowedWorkspace(workspace.id)
    void openWorkspaceFile(workspace, relative)
  }
  const stopWatchingWorkspace = () => {
    setFollowedWorkspace(undefined)
    setWorkspaceView(undefined)
  }
  // Watching stopped, or moved to another workspace: that copy's text is no
  // longer shown or followed, so it is not kept.
  createEffect(
    on(
      followedWorkspace,
      (id, previous) => {
        const directory = previous && previous !== id ? workspaceSources.get(previous)?.directory : undefined
        if (!directory) return
        const root = `${directory.replace(/\\/g, "/").replace(/\/+$/, "")}/`
        setWorkspaceTexts(
          produce((texts) => {
            for (const key of Object.keys(texts)) if (key.startsWith(root)) delete texts[key]
          }),
        )
      },
      { defer: true },
    ),
  )

  // While the user watches a workspace, follow its agent from file to file.
  createEffect(
    on(
      () => {
        const id = followedWorkspace()
        const workspace = id ? untrack(foreignWorkspaces).find((item) => item.id === id) : undefined
        return workspace ? follow.targetFor(workspace.isolatedPath) : undefined
      },
      (target) => {
        const id = followedWorkspace()
        const workspace = id ? foreignWorkspaces().find((item) => item.id === id) : undefined
        if (!target || !workspace || !followAgent()) return
        if (Date.now() - target.token >= ATTRIBUTION_TTL_MS) return
        if (workspaceView()?.key === target.path) return
        const relative = workspaceRelativePath(workspace.isolatedPath, target.path)
        if (relative) void openWorkspaceFile(workspace, relative)
      },
    ),
  )
  const workspaceReveal = createMemo(() => {
    const view = workspaceView()
    if (!view) return
    const target = follow.targetFor(view.directory)
    if (!target || target.path !== view.key) return
    return { line: target.line, endLine: target.endLine, token: target.token }
  })

  const openQuickFileSearch = () => {
    dialog.show(() => (
      <DialogSelectFile
        mode="files"
        presentation="palette"
        onSelectFile={(path) => {
          openFile(path)
        }}
      />
    ))
  }

  const closeFile = (path: string) => {
    const remaining = openFiles().filter((item) => item !== path)
    setOpenFiles(remaining)
    if (selectedPath() !== path) return
    const next = remaining.at(-1)
    setSelectedPath(next)
    if (next) void file.load(next)
  }

  createEffect(
    on(
      () => [selectedPath(), contents(), Boolean(state()?.loaded)] as const,
      ([path, nextContent, loaded]) => {
        if (!path || !loaded) return
        const currentDraft = drafts[path]
        const previousBase = draftBases[path]
        if (currentDraft === undefined || previousBase === undefined || currentDraft === previousBase) {
          setDrafts(path, nextContent)
          setDraftBases(path, nextContent)
          setExternalConflicts(path, false)
          return
        }
        if (nextContent === previousBase || externalConflicts[path]) return
        setExternalConflicts(path, true)
        showToast({
          title: "Workspace file changed",
          description: `${fileBasename(path)} changed outside the editor. Vector kept your unsaved draft instead of overwriting either version.`,
        })
      },
    ),
  )

  const updateDraft = (path: string, nextContent: string) => {
    if (externalConflicts[path]) {
      setDraftBases(path, file.get(path)?.content?.content ?? "")
      setExternalConflicts(path, false)
    }
    setDrafts(path, nextContent)
  }

  createEffect(() => {
    if (selectedPath()) return
    const first = props.modified()[0]
    if (!first) return
    openFile(first)
  })

  const saveDraft = async (options?: {
    path?: string
    content?: string
    base?: string
    loaded?: boolean
    silent?: boolean
  }) => {
    const path = options?.path ?? selectedPath()
    if (!path) return
    const nextContent = options?.content ?? draft()
    const baseContent = options?.base ?? contents()
    if (nextContent === baseContent) {
      if (!options?.silent) showToast({ title: "Already saved", description: "There are no local edits to apply." })
      return
    }

    setSaving(true)
    try {
      await sdk().client.file.write({ directory: sdk().directory, path, content: nextContent })
      notifyWorkspaceFileSaved({ directory: sdk().directory, path })
      if (selectedPath() === path) await file.load(path, { force: true })
      await file.tree.refresh("")
      setDrafts(path, nextContent)
      setDraftBases(path, nextContent)
      setExternalConflicts(path, false)
      if (!options?.silent)
        showToast({ title: "Saved to workspace", description: `${path} was updated from Codespace.` })
    } catch (error) {
      showToast({
        variant: "error",
        title: "Could not save edit",
        description:
          error instanceof Error && error.message ? error.message : "Vector could not apply this file patch.",
      })
    } finally {
      setSaving(false)
    }
  }

  let autosaveTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(
      () =>
        [
          selectedPath(),
          draft(),
          contents(),
          Boolean(state()?.loaded),
          Boolean(externalConflicts[selectedPath() ?? ""]),
        ] as const,
      ([path, nextContent, baseContent, loaded, hasExternalConflict]) => {
        if (!path || !loaded || hasExternalConflict || nextContent === baseContent) return
        if (autosaveTimer) clearTimeout(autosaveTimer)
        autosaveTimer = setTimeout(() => {
          void saveDraft({ path, content: nextContent, base: baseContent, loaded, silent: true })
        }, 650)
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    if (autosaveTimer) clearTimeout(autosaveTimer)
  })

  // Models often wrap output in ``` fences even when told not to; strip them.
  const stripFences = (text: string) => {
    const normalized = text.replace(/\r\n/g, "\n")
    const match = normalized.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/)
    return match ? match[1] : normalized
  }

  // Cursor-style ghost-text autocomplete. Completions reuse ONE helper session
  // (recycled every few requests / on model change) instead of creating a fresh
  // session per keystroke, which would add a round-trip each time. Recycling
  // bounds the history the model sees so suggestions stay relevant to the
  // current cursor context. A recycled session is kept, not deleted: what its
  // completions spent stays in the open session's cost and in usage.
  let completionSessionId: string | undefined
  let completionSessionKey = ""
  let completionTurns = 0
  const completionCache = new Map<string, string>()
  const completionQueue = createInlineCompletionQueue()
  const AUTOCOMPLETE_SESSION_TURNS = 6

  const recycleCompletionSession = () => {
    completionSessionId = undefined
    completionTurns = 0
  }
  onCleanup(() => {
    completionQueue.cancel()
    recycleCompletionSession()
  })

  createEffect(
    on(
      () => {
        const model = selectedModelPayload()
        return [
          sdk().url,
          sdk().directory,
          editorSessionID(),
          selectedPath(),
          model?.providerID,
          model?.modelID,
          settings.editor.aiAutocomplete(),
          props.externalAgent,
        ].join("\u0000")
      },
      () => completionQueue.cancel(),
      { defer: true },
    ),
  )

  const completionSessionFor = async (
    model: { providerID: string; modelID: string },
    server = sdk(),
    parentID = editorSessionID(),
  ) => {
    const key = `${server.url}:${server.directory}:${parentID ?? ""}:${model.providerID}:${model.modelID}`
    if (completionSessionId && completionSessionKey === key && completionTurns < AUTOCOMPLETE_SESSION_TURNS) {
      return completionSessionId
    }
    if (completionSessionId) recycleCompletionSession()
    completionSessionKey = key
    const created = await server.client.session
      .create({
        directory: server.directory,
        title: "Autocomplete",
        internal: "codespace.autocomplete",
        ...(parentID ? { parentID } : {}),
        agent: "autocomplete",
        model: { providerID: model.providerID, id: model.modelID },
        metadata: { source: "vector-codespace", engine: "vector-compatible" },
      })
      .catch(() => undefined)
    completionSessionId = created?.data?.id
    return completionSessionId
  }

  const aiComplete = (input: InlineCompleteInput, signal?: AbortSignal) => {
    const context = boundInlineCompletionContext({ ...input, path: selectedPath() ?? input.path })
    return completionQueue.run(signal, async (active) => {
      if (props.externalAgent || !settings.editor.aiAutocomplete()) return
      const model = selectedModelPayload()
      if (!model) return
      const server = sdk()
      const parentID = editorSessionID()
      const cacheKey = [
        server.url,
        server.directory,
        parentID,
        model.providerID,
        model.modelID,
        context.path,
        context.language,
        context.prefix.slice(-2_000),
        context.suffix.slice(0, 800),
      ].join("\u0000")
      const cached = completionCache.get(cacheKey)
      if (cached) return cached
      const sessionID = await completionSessionFor(model, server, parentID)
      if (!sessionID) return
      if (active.aborted) {
        recycleCompletionSession()
        return
      }
      completionTurns += 1
      const result = await requestInlineCompletion({
        signal: active,
        // Retire the cancelled helper so a late abort can never stop the replacement or the user's chat.
        abort: async () => {
          if (completionSessionId === sessionID) recycleCompletionSession()
          await server.client.session.abort(
            { sessionID, directory: server.directory },
            { signal: AbortSignal.timeout(5_000) },
          )
        },
        request: (signal) =>
          server.client.session.prompt(
            {
              sessionID,
              directory: server.directory,
              // Ghost text uses only its bounded cursor context, with no tools or conversation history.
              agent: "autocomplete",
              model,
              executionMode: "normal",
              tools: { "*": false },
              parts: [
                {
                  type: "text",
                  text: `File: ${context.path}\nLanguage: ${context.language}\nCursor line: ${context.cursorLine}\n\nNearby code before the cursor:\n${context.prefix}\n\nNearby code after the cursor:\n${context.suffix}\n\nReturn only the insertion.`,
                },
              ],
            },
            { signal },
          ),
      }).catch(() => undefined)
      if (active.aborted) return
      const text = extractModelText(result?.data)
      const suggestion = text ? sanitizeInlineCompletion(text, context.suffix) : undefined
      if (!suggestion) return
      completionCache.set(cacheKey, suggestion)
      if (completionCache.size > 40) completionCache.delete(completionCache.keys().next().value ?? "")
      return suggestion
    })
  }

  // Cmd+K is an explicit edit action, so the returned replacement is applied to
  // the live file immediately. The separate workspace review surface remains
  // available for git-level review; the editor itself stays focused on coding.
  const runInlineEdit = async (instruction: string) => {
    if (props.externalAgent) return
    const path = selectedPath()
    const trimmed = instruction.trim()
    if (!path || !trimmed || inlineEditRunning()) return
    if (!selectedModelPayload()) {
      showToast({
        variant: "error",
        title: "Select a model",
        description: "Choose a model in Vector before using inline edit.",
      })
      return
    }
    setInlineEditRunning(true)
    try {
      const current = draft()
      const selection = inlineEditSelection()
      if (selection?.text && current.slice(selection.startOffset, selection.endOffset) !== selection.text) {
        throw new Error("The selected code changed while Inline Edit was open. Select it again and retry.")
      }
      const text = await invokeCodespaceModel(
        selection?.text
          ? {
              title: "Inline selection edit",
              system:
                "You are Vector's inline code editor. Rewrite only the selected code to satisfy the instruction. Return only the replacement code, without markdown fences or explanation. Preserve the surrounding style, public behavior, and indentation.",
              prompt: `Instruction: ${trimmed}\nFile: ${path}\nSelected lines: ${selection.startLine}-${selection.endLine}\n\nCode before selection:\n${current.slice(Math.max(0, selection.startOffset - 4_000), selection.startOffset)}\n\nSelected code:\n${selection.text}\n\nCode after selection:\n${current.slice(selection.endOffset, selection.endOffset + 2_000)}`,
            }
          : {
              title: "Inline file edit",
              system:
                "You are Vector's inline code editor. Rewrite the given file so it satisfies the instruction. Return only the full updated file content, without explanation or markdown fences. Preserve unrelated code.",
              prompt: `Instruction: ${trimmed}\n\nFile: ${path}\n\nCurrent content:\n${current}`,
            },
      )
      const replacement = stripFences(text)
      const next = selection?.text
        ? `${current.slice(0, selection.startOffset)}${replacement}${current.slice(selection.endOffset)}`
        : replacement
      if (next === current) {
        showToast({ title: "No changes", description: "Vector did not change the file." })
        return
      }
      updateDraft(path, next)
      await saveDraft({ path, content: next, silent: true })
      showToast({ title: "Applied", description: `Vector edited ${fileBasename(path)}.` })
      setInlineEditOpen(false)
      setInlineEditInput("")
      setInlineEditSelection(undefined)
    } catch (error) {
      showToast({
        variant: "error",
        title: "Inline edit failed",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setInlineEditRunning(false)
    }
  }

  const readWorkspaceText = (path: string) =>
    sdk()
      .client.file.read({ directory: sdk().directory, path })
      .then((result) => (result.data?.type === "text" ? result.data.content : undefined))
      .catch(() => undefined)

  const refreshWorkspaceFiles = async (paths: string[]) => {
    const files = [...new Set(paths)]
    await file.tree.refresh("").catch(() => undefined)
    await Promise.all(
      files.map(async (path) => {
        const content = await readWorkspaceText(path)
        await file.load(path, { force: true }).catch(() => undefined)
        if (content !== undefined) {
          setDrafts(path, content)
          setDraftBases(path, content)
          setExternalConflicts(path, false)
        }
      }),
    )
    return files
  }

  const workspacePath = (input: string) => {
    const root = sdk().directory.replace(/\\/g, "/").replace(/\/+$/, "")
    const normalized = input.replace(/\\/g, "/")
    if (normalized === root) return ""
    if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1)
    return input
  }

  const workspaceAbsolutePath = (input: string) => {
    if (/^(?:[A-Za-z]:[\\/]|\/)/.test(input)) return input
    return `${sdk().directory.replace(/[\\/]+$/, "")}/${input.replace(/^[\\/]+/, "")}`
  }

  const languageService: MonacoLanguageService = {
    diagnostics: (path) =>
      sdk()
        .client.lsp.diagnostics({ directory: sdk().directory, file: workspacePath(path) })
        .then((result) => result.data ?? []),
    hover: (path, position) =>
      sdk()
        .client.lsp.hover({
          directory: sdk().directory,
          lspRequest: { file: workspacePath(path), ...position },
        })
        .then((result) => result.data ?? undefined),
    definition: (path, position) =>
      sdk()
        .client.lsp.definition({
          directory: sdk().directory,
          lspRequest: { file: workspacePath(path), ...position },
        })
        .then((result) => result.data ?? []),
    references: (path, position) =>
      sdk()
        .client.lsp.references({
          directory: sdk().directory,
          lspRequest: { file: workspacePath(path), ...position },
        })
        .then((result) => result.data ?? []),
    symbols: (path) =>
      sdk()
        .client.lsp.symbols({ directory: sdk().directory, file: workspacePath(path) })
        .then((result) => result.data ?? []),
    rename: (path, position, newName) =>
      sdk()
        .client.lsp.rename({
          directory: sdk().directory,
          lspRenameRequest: { file: workspacePath(path), ...position, newName },
        })
        .then((result) => result.data?.files ?? []),
    codeActions: (path, range) =>
      sdk()
        .client.lsp.codeAction({
          directory: sdk().directory,
          lspCodeActionRequest: { file: workspacePath(path), range },
        })
        .then((result) => result.data?.actions ?? []),
    readFile: async (path) => {
      const result = await sdk().client.file.read({
        directory: sdk().directory,
        path: workspacePath(path),
      })
      if (result.data?.type !== "text") throw new Error(`Vector cannot open ${workspacePath(path)} as text.`)
      return result.data.content
    },
    writeFile: async (path, content) => {
      await sdk().client.file.write({
        directory: sdk().directory,
        path: workspacePath(path),
        content,
      })
    },
    filesChanged: async (paths) => {
      await refreshWorkspaceFiles(paths.map(workspacePath))
    },
  }

  const [outlineSymbols] = createResource(selectedPath, (path) => languageService.symbols(path).catch(() => []))

  let agentTimelineRef: HTMLDivElement | undefined
  createEffect(() => {
    const messages = editorMessages()
    const last = messages.at(-1)
    const partCount = last ? editorMessageParts(last.id).length : 0
    editorSessionStatus()
    partCount
    requestAnimationFrame(() => {
      const element = agentTimelineRef
      if (!element) return
      element.scrollTop = element.scrollHeight
    })
  })

  return (
    <Portal mount={props.portalMount}>
      <div
        data-vector-codespace
        data-embedded={props.embedded ? "true" : undefined}
        class={`${props.embedded ? "absolute inset-0 z-0" : "fixed inset-0 z-[140]"} flex min-h-0 flex-col overflow-hidden bg-[#101010] text-[#e8e8e8]`}
      >
        <header
          data-tauri-drag-region
          class="relative flex h-12 shrink-0 items-center border-b border-[#292929] bg-[#101010] px-2 text-[#878787]"
        >
          <div class="shrink-0" style={{ width: props.embedded ? "4px" : "76px" }} />
          <div
            class="flex h-8 shrink-0 items-center rounded-[7px] border border-[#37343d] bg-[#19171d] p-0.5 [app-region:no-drag]"
            aria-label="Workspace mode"
          >
            <button
              type="button"
              class="h-7 rounded-[5px] px-3 text-[11px] font-medium text-[#8f8999] transition-colors hover:bg-white/[0.05] hover:text-[#ddd]"
              aria-label={`Back to ${agentLabel()}`}
              title={`Back to ${agentLabel()}`}
              onClick={props.onClose}
            >
              Agent
            </button>
            <button
              type="button"
              aria-pressed="true"
              class="h-7 rounded-[5px] bg-[color-mix(in_oklab,var(--vx-purple)_28%,#25222b)] px-3 text-[11px] font-medium text-[#f2eff8] shadow-sm"
              aria-label="Editor"
              title="Editor"
            >
              Editor
            </button>
          </div>
          <button
            type="button"
            class="absolute left-1/2 flex h-8 w-[min(38vw,720px)] -translate-x-1/2 items-center justify-center gap-2 rounded-[7px] border border-[#373737] bg-[#1a1a1a] px-3 text-[12px] text-[#aaa] shadow-sm transition-colors hover:border-[#484848] hover:bg-[#1e1e1e] hover:text-[#ddd] [app-region:no-drag]"
            aria-label="Search files in this workspace"
            title="Search files in this workspace"
            onClick={openQuickFileSearch}
          >
            <Icon name="magnifying-glass" size="small" />
            <span class="truncate">{fileBasename(sdk().directory) || "Search workspace"}</span>
            <span class="ml-auto shrink-0 rounded border border-[#343434] px-1 py-0.5 font-mono text-[9px] text-[#666]">
              ⌘P
            </span>
          </button>
          <div class="ml-auto flex shrink-0 items-center gap-0.5 [app-region:no-drag]">
            <Show when={followAgent() && agentRunning()}>
              <span
                class="mr-1 flex h-6 max-w-[280px] items-center gap-1.5 rounded-full border border-[#343434] bg-[#1a1a1a] px-2 text-[10px] font-medium text-[#bdbdbd]"
                title={`${followStatus()}. The editor opens and scrolls to what it edits.`}
                aria-live="polite"
              >
                <span
                  class="size-1.5 shrink-0 animate-pulse rounded-full"
                  style={{ background: followingAgent().color }}
                />
                <span class="truncate">{followStatus()}</span>
              </span>
            </Show>
            <button
              type="button"
              class="grid size-7 place-items-center rounded-[5px] transition-colors hover:bg-white/[0.06] hover:text-[#ddd]"
              classList={{ "bg-white/[0.06] text-[#d8d8d8]": followAgent() }}
              aria-pressed={followAgent()}
              aria-label={followAgent() ? "Stop following the agent" : "Follow the agent"}
              title={
                followAgent()
                  ? "Following the agent: the editor opens and scrolls to what it edits. Click to stop."
                  : "Follow the agent in the editor"
              }
              onClick={() => settings.editor.setFollowAgent(!followAgent())}
            >
              <Icon name="eye" size="small" />
            </button>
            <button
              type="button"
              class="grid size-7 place-items-center rounded-[5px] transition-colors hover:bg-white/[0.06] hover:text-[#ddd]"
              classList={{ "bg-white/[0.06] text-[#d8d8d8]": explorerOpen() }}
              aria-label={explorerOpen() ? "Hide Explorer" : "Show Explorer"}
              title={explorerOpen() ? "Hide Explorer" : "Show Explorer"}
              onClick={() => setExplorerOpen((open) => !open)}
            >
              <Icon name="layout-left" size="small" />
            </button>
            <button
              type="button"
              class="grid size-7 place-items-center rounded-[5px] transition-colors hover:bg-white/[0.06] hover:text-[#ddd]"
              classList={{ "bg-white/[0.06] text-[#d8d8d8]": agentOpen() }}
              aria-label={`${agentOpen() ? "Hide" : "Show"} ${agentLabel()}`}
              title={`${agentOpen() ? "Hide" : "Show"} ${agentLabel()}`}
              onClick={() => setAgentOpen((open) => !open)}
            >
              <Icon name="layout-right" size="small" />
            </button>
          </div>
        </header>
        <main class="min-h-0 flex-1 flex">
          <Show when={explorerOpen()}>
            <aside
              class="relative flex shrink-0 flex-col border-r border-[#272727] bg-[#141414]"
              style={{ width: props.externalAgent ? `min(${explorerWidth()}px, 20%)` : `${explorerWidth()}px` }}
            >
              <ResizeHandle
                direction="horizontal"
                edge="end"
                size={explorerWidth()}
                min={190}
                max={480}
                onResize={setExplorerWidth}
              />
              <div class="flex h-10 items-center gap-1 border-b border-[#272727] px-2 text-[#8a8a8a]">
                <button
                  class="grid size-7 place-items-center rounded-[4px] transition-colors hover:bg-white/[0.06] hover:text-[#ddd]"
                  classList={{ "bg-white/[0.055] text-[#ddd]": activeView() === "editor" }}
                  aria-label="Explorer"
                  title="Explorer"
                  onClick={() => setActiveView("editor")}
                >
                  <Icon name="file-tree" size="small" />
                </button>
                <button
                  class="grid size-7 place-items-center rounded-[4px] transition-colors hover:bg-white/[0.06] hover:text-[#ddd]"
                  aria-label="Search files in Code Editor"
                  title="Search files in Code Editor"
                  onClick={openQuickFileSearch}
                >
                  <Icon name="magnifying-glass" size="small" />
                </button>
                <button
                  class="relative grid size-7 place-items-center rounded-[4px] transition-colors hover:bg-white/[0.06] hover:text-[#ddd]"
                  classList={{ "bg-white/[0.055] text-[#ddd]": activeView() === "problems" }}
                  aria-label="Problems"
                  title="Problems"
                  onClick={() => setActiveView("problems")}
                >
                  <Icon name="warning" size="small" />
                  <Show when={problems().length > 0}>
                    <span class="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-amber-400" />
                  </Show>
                </button>
                <div class="flex-1" />
              </div>
              <div class="flex h-8 items-center justify-between px-3">
                <div class="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.04em] text-[#9d9d9d]">
                  {fileBasename(sdk().directory) || "Workspace"}
                </div>
                <button
                  class="grid size-6 place-items-center rounded text-[#737373] hover:bg-white/[0.06] hover:text-[#d8d8d8]"
                  aria-label="Refresh explorer"
                  title="Refresh explorer"
                  onClick={() => void file.tree.refresh("")}
                >
                  <Icon name="reset" size="small" />
                </button>
              </div>
              <div class="min-h-0 flex-1 overflow-auto px-1 pb-2 group/filetree">
                <Switch>
                  <Match when={file.tree.state("")?.loaded && file.tree.children("").length === 0}>
                    {props.empty()}
                  </Match>
                  <Match when={true}>
                    <FileTree
                      path=""
                      class="py-1"
                      modified={props.modified()}
                      kinds={props.kinds()}
                      markers={liveFileMarkers()}
                      excludeDirectories={CODESPACE_EXCLUDED_DIRECTORIES}
                      active={selectedPath()}
                      onFileClick={(node) => openFile(node.path)}
                    />
                  </Match>
                </Switch>
              </div>
              <div class="max-h-[34%] min-h-[112px] shrink-0 border-t border-[#292929] bg-[#121212]">
                <div class="flex h-8 items-center justify-between px-3 text-[10px] font-semibold uppercase text-[#969696]">
                  <span>Outline</span>
                  <span class="font-normal text-[#555]">{outlineSymbols()?.length ?? 0}</span>
                </div>
                <div class="max-h-[calc(100%-32px)] overflow-y-auto px-2 pb-2">
                  <For
                    each={outlineSymbols() ?? []}
                    fallback={
                      <div class="px-2 py-2 text-[10px] leading-4 text-[#606060]">
                        {selectedPath() ? "No symbols reported for this file." : "Open a file to see its outline."}
                      </div>
                    }
                  >
                    {(symbol) => (
                      <div
                        class="flex h-6 min-w-0 items-center gap-1.5 rounded-[4px] px-2 text-[10px] text-[#999] hover:bg-white/[0.045] hover:text-[#d2d2d2]"
                        title={symbol.name}
                      >
                        <span class="size-1.5 shrink-0 rounded-full bg-[#b394ff]/65" />
                        <span class="truncate">{symbol.name}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </aside>
          </Show>

          <section class="relative min-w-0 flex-1 flex flex-col bg-[#151515]">
            {/* Over the editor only, so the Problems view stays usable while a workspace is watched. */}
            <Show when={activeView() === "editor" ? workspaceView() : undefined}>
              {(view) => (
                <div data-vector-workspace-copy class="absolute inset-0 z-20 flex flex-col bg-[#151515]">
                  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-[#272727] bg-[#121212] px-3 text-[12px]">
                    <span class="size-2 shrink-0 rounded-full" style={{ background: view().color }} />
                    <span class="max-w-[160px] shrink-0 truncate font-medium text-[#e4e4e4]">{view().name}</span>
                    <span class="text-[#55515e]">·</span>
                    <span class="min-w-0 truncate font-mono text-[11px] text-[#9a96a3]" title={view().relative}>
                      {view().relative}
                    </span>
                    <span class="shrink-0 rounded border border-[#343434] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.06em] text-[#7d7986]">
                      Agent's copy · read-only
                    </span>
                    <span class="flex-1" />
                    <button
                      type="button"
                      class="h-7 shrink-0 rounded-[5px] px-2 text-[11px] text-[#aaa] transition-colors hover:bg-[#222] hover:text-[#ddd]"
                      onClick={() => openFile(view().relative)}
                    >
                      Open your version
                    </button>
                    <button
                      type="button"
                      class="grid size-7 shrink-0 place-items-center rounded-[5px] text-[#aaa] transition-colors hover:bg-[#222] hover:text-[#ddd]"
                      aria-label={`Stop watching ${view().name}`}
                      title={`Stop watching ${view().name}`}
                      onClick={stopWatchingWorkspace}
                    >
                      <Icon name="close-small" size="small" />
                    </button>
                  </div>
                  <div class="relative min-h-0 flex-1 overflow-hidden bg-[#111111]">
                    <Show
                      when={workspaceTexts[view().key] !== undefined}
                      fallback={
                        <div class="grid h-full place-items-center px-8 text-center text-[12px] text-[#8f8f8f]">
                          {view().error ?? "Loading the agent's copy…"}
                        </div>
                      }
                    >
                      <MonacoCodeEditor
                        path={view().key}
                        value={workspaceTexts[view().key] ?? ""}
                        readOnly
                        attributions={follow.attributionsFor(view().key)}
                        reveal={workspaceReveal()}
                        cursors={follow.cursorsFor(view().key)}
                        typing={followAgent() ? follow.typingFor(view().key) : undefined}
                        onChange={() => undefined}
                      />
                    </Show>
                  </div>
                </div>
              )}
            </Show>
            <Show
              when={selectedPath()}
              fallback={
                <div class="h-full flex items-center justify-center px-8 text-center bg-[#151515]">
                  <div class="max-w-72 text-[#8f8f8f]">
                    <img
                      src="/vector-logo.png"
                      alt=""
                      class="mx-auto mb-4 size-9 rounded-[8px] opacity-75"
                      draggable={false}
                    />
                    <div class="text-14-medium text-[#d8d8d8]">Open a file to begin</div>
                    <div class="mt-1.5 text-12-regular">Select a workspace file from Explorer or use Quick Open.</div>
                  </div>
                </div>
              }
            >
              {(path) => (
                <Switch>
                  <Match when={state()?.loaded}>
                    <Switch>
                      <Match when={activeView() === "editor"}>
                        <div class="relative h-full min-h-0 flex flex-col overflow-hidden bg-[#151515]">
                          <div class="flex h-10 shrink-0 items-stretch justify-between border-b border-[#272727] bg-[#121212]">
                            <div class="flex min-w-0 flex-1 items-stretch overflow-x-auto no-scrollbar">
                              <For each={openFiles()}>
                                {(openPath) => {
                                  const active = () => selectedPath() === openPath
                                  const changed = () =>
                                    drafts[openPath] !== undefined &&
                                    drafts[openPath] !== (file.get(openPath)?.content?.content ?? "")
                                  return (
                                    <button
                                      type="button"
                                      class="group/tab relative flex h-full min-w-[132px] max-w-[224px] items-center gap-2 border-r border-[#272727] px-3 text-left text-[12px] transition-colors"
                                      classList={{
                                        "bg-[#151515] text-[#e4e4e4]": active(),
                                        "bg-[#121212] text-[#838383] hover:bg-[#181818] hover:text-[#d0d0d0]":
                                          !active(),
                                      }}
                                      onClick={() => openFile(openPath)}
                                    >
                                      <Show when={active()}>
                                        <span class="absolute inset-x-0 top-0 h-px bg-[#a98cff]" />
                                      </Show>
                                      <span class="text-[#b4d273]">{"{}"}</span>
                                      <span class="min-w-0 flex-1 truncate">{fileBasename(openPath)}</span>
                                      <Show
                                        when={changed()}
                                        fallback={
                                          <span
                                            role="button"
                                            tabindex="0"
                                            class="grid size-4 shrink-0 place-items-center rounded opacity-0 group-hover/tab:opacity-100 hover:bg-white/10 hover:text-white"
                                            aria-label={`Close ${fileBasename(openPath)}`}
                                            onPointerDown={(event) => event.stopPropagation()}
                                            onClick={(event) => {
                                              event.stopPropagation()
                                              closeFile(openPath)
                                            }}
                                          >
                                            <Icon name="close-small" size="small" />
                                          </span>
                                        }
                                      >
                                        <span class="size-2 shrink-0 rounded-full bg-[#aaa]" title="Unsaved changes" />
                                      </Show>
                                    </button>
                                  )
                                }}
                              </For>
                            </div>
                          </div>
                          <div class="flex h-7 shrink-0 items-center justify-between gap-3 border-b border-[#252525] bg-[#1b1b1b] px-3 font-mono text-[10px] text-[#777]">
                            <div class="flex min-w-0 items-center gap-1 overflow-hidden">
                              <For each={path().split("/")}>
                                {(part, index) => (
                                  <>
                                    <Show when={index() > 0}>
                                      <Icon name="chevron-right" size="small" class="shrink-0 text-[#505050]" />
                                    </Show>
                                    <span
                                      class="truncate"
                                      classList={{ "text-[#bcbcbc]": index() === path().split("/").length - 1 }}
                                    >
                                      {part}
                                    </span>
                                  </>
                                )}
                              </For>
                            </div>
                            <Show when={activeFileWorkspaces().length}>
                              <div
                                class="flex shrink-0 items-center gap-1.5 text-[#9a95a5]"
                                title="Agents editing isolated copies of this file"
                              >
                                <div class="flex -space-x-0.5">
                                  <For each={activeFileWorkspaces().slice(0, 4)}>
                                    {(workspace) => (
                                      <span
                                        class="size-2 rounded-full border border-[#1b1b1b] shadow-[0_0_7px_currentColor]"
                                        style={{
                                          color: workspaceColor(workspace.id),
                                          "background-color": workspaceColor(workspace.id),
                                        }}
                                      />
                                    )}
                                  </For>
                                </div>
                                <span>
                                  {activeFileWorkspaces().length} agent
                                  {activeFileWorkspaces().length === 1 ? "" : "s"} on this file
                                </span>
                              </div>
                            </Show>
                          </div>
                          <Show when={editorWorkspaces().length || liveWorkspaceError()}>
                            <div
                              class="flex h-8 shrink-0 items-center gap-2 overflow-x-auto border-b border-[#292929] bg-[#181818] px-2.5 no-scrollbar"
                              aria-label="Live agent activity"
                            >
                              <span class="sticky left-0 z-[1] shrink-0 bg-[#181818] pr-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-[#837e8d]">
                                Live agents
                              </span>
                              <Show
                                when={!liveWorkspaceError()}
                                fallback={
                                  <span class="truncate text-[10px] text-red-300/80">{liveWorkspaceError()}</span>
                                }
                              >
                                <For each={editorWorkspaces()}>
                                  {(workspace) => {
                                    const color = workspaceColor(workspace.id)
                                    // The newest file its events named, else the newest the poll found.
                                    const latestFile = () =>
                                      workspaceTouches[workspace.id]?.at(-1) ?? workspace.changedFiles.at(-1)
                                    return (
                                      <button
                                        type="button"
                                        class="flex h-5.5 max-w-[310px] shrink-0 items-center gap-1.5 rounded-[5px] border border-white/[0.07] bg-white/[0.035] px-2 text-left text-[10px] text-[#aaa5b2] transition-colors hover:border-white/[0.12] hover:bg-white/[0.06] hover:text-[#ddd]"
                                        classList={{
                                          "border-[color:var(--vx-purple)]": followedWorkspace() === workspace.id,
                                        }}
                                        title={`${workspace.taskPrompt}\n${workspace.lastAction}\n${workspace.gitBranch ?? workspace.isolatedPath}`}
                                        aria-pressed={followedWorkspace() === workspace.id}
                                        onClick={() => {
                                          const filePath = latestFile()
                                          if (!filePath) return
                                          const relative = normalizedWorkspacePath(filePath)
                                          // Another directory: show that agent's copy, not the untouched source file.
                                          if (isForeignWorkspace(workspace)) watchWorkspace(workspace, relative)
                                          else openFile(relative)
                                        }}
                                      >
                                        <span
                                          class="size-1.5 shrink-0 rounded-full shadow-[0_0_8px_currentColor]"
                                          classList={{ "animate-pulse": workspaceIsRunning(workspace.status) }}
                                          style={{ color, "background-color": color }}
                                        />
                                        <span class="max-w-[100px] truncate font-medium text-[#d5d1dc]">
                                          {workspace.name}
                                        </span>
                                        <span class="text-[#55515e]">·</span>
                                        <span class="max-w-[150px] truncate">{workspace.lastAction}</span>
                                        <span class="shrink-0 text-[9px]" style={{ color }}>
                                          {workspaceStatusLabel(workspace.status)}
                                        </span>
                                      </button>
                                    )
                                  }}
                                </For>
                              </Show>
                            </div>
                          </Show>
                          <div class="relative flex min-h-0 flex-1 overflow-hidden">
                            <div class="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-[#111111]">
                              <Show when={inlineEditOpen()}>
                                <form
                                  class="absolute left-1/2 top-3 z-10 flex w-[min(720px,calc(100%-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-[rgba(178,140,255,0.3)] bg-[#242428]/97 shadow-[0_18px_48px_rgba(0,0,0,0.5)] backdrop-blur"
                                  onSubmit={(event) => {
                                    event.preventDefault()
                                    void runInlineEdit(inlineEditInput())
                                  }}
                                >
                                  <div class="flex items-center gap-2 px-3 pt-2.5">
                                    <span class="shrink-0 rounded border border-[rgba(178,140,255,0.32)] px-1.5 py-0.5 text-10-medium text-[#b7a6e6]">
                                      ⌘K
                                    </span>
                                    <input
                                      autofocus
                                      value={inlineEditInput()}
                                      disabled={inlineEditRunning()}
                                      onInput={(event) => setInlineEditInput(event.currentTarget.value)}
                                      onKeyDown={(event) => {
                                        event.stopPropagation()
                                        if (event.key === "Escape") {
                                          event.preventDefault()
                                          setInlineEditOpen(false)
                                          setInlineEditSelection(undefined)
                                        }
                                      }}
                                      placeholder={
                                        inlineEditSelection()?.text
                                          ? "Describe how to change the selected code…"
                                          : "Describe how to change this file…"
                                      }
                                      class="min-w-0 flex-1 bg-transparent text-13-regular text-white outline-none placeholder:text-[#6f6980] disabled:opacity-60"
                                    />
                                    <button
                                      type="submit"
                                      disabled={inlineEditRunning() || !inlineEditInput().trim()}
                                      class="shrink-0 rounded-full border border-[rgba(178,140,255,0.3)] bg-[rgba(147,116,236,0.22)] px-3 py-1 text-11-bold text-white transition-opacity hover:enabled:bg-[rgba(147,116,236,0.34)] disabled:opacity-50"
                                    >
                                      {inlineEditRunning() ? "Editing…" : "Edit ↵"}
                                    </button>
                                  </div>
                                  <div class="flex items-center gap-2 px-3 pb-2 pt-2 text-10-regular text-[#8a8595]">
                                    <Show when={inlineEditSelection()?.text}>
                                      <span class="rounded border border-[color:var(--vx-line)] bg-white/[0.04] px-1.5 py-0.5 text-[#b9b4c3]">
                                        Lines {inlineEditSelection()!.startLine}-{inlineEditSelection()!.endLine}
                                      </span>
                                    </Show>
                                    <span class="flex-1" />
                                    <span class="text-[#9a8bc1]">Explicit inline edits apply directly</span>
                                    <span class="text-[#6f6980]">esc</span>
                                  </div>
                                </form>
                              </Show>
                              <MonacoCodeEditor
                                path={workspaceAbsolutePath(path())}
                                value={draft()}
                                attributions={follow.attributionsFor(path())}
                                reveal={editorReveal()}
                                cursors={follow.cursorsFor(path())}
                                typing={followAgent() ? follow.typingFor(path()) : undefined}
                                onChange={(next) => updateDraft(path(), next)}
                                inlineComplete={props.externalAgent ? undefined : aiComplete}
                                languageService={languageService}
                                onInlineEdit={
                                  props.externalAgent
                                    ? undefined
                                    : (selection) => {
                                        setInlineEditSelection(selection)
                                        setInlineEditOpen(true)
                                      }
                                }
                              />
                            </div>
                            <Show when={agentOpen() && !props.externalAgent}>
                              <aside
                                class="vector-editor-agent-pane relative flex shrink-0 flex-col border-l border-[#272727] bg-[#121212]"
                                style={{ width: `${agentWidth()}px` }}
                              >
                                <ResizeHandle
                                  direction="horizontal"
                                  edge="start"
                                  size={agentWidth()}
                                  min={360}
                                  max={typeof window === "undefined" ? 900 : Math.min(900, window.innerWidth * 0.72)}
                                  onResize={setAgentWidth}
                                />

                                <header class="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-[#272727] px-3">
                                  <div class="flex min-w-0 items-center gap-2 text-[12px] font-medium text-[#e0e0e0]">
                                    <Icon name="prompt" size="small" class="text-[#aaa]" />
                                    <span class="truncate">Vector Agent</span>
                                    <span
                                      class="size-1.5 shrink-0 rounded-full"
                                      classList={{
                                        "animate-pulse bg-[#a98cff]": agentRunning(),
                                        "bg-emerald-400/70": !agentRunning(),
                                      }}
                                      title={agentStatus()}
                                    />
                                  </div>
                                </header>

                                <div
                                  ref={(element) => (agentTimelineRef = element)}
                                  class="vector-editor-agent-timeline flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
                                >
                                  <Show when={editorMessages().length === 0}>
                                    <div class="pt-1 text-[11px] leading-5 text-[#707070]">
                                      This is the same Vector agent and conversation as the main workspace. Ask a
                                      question, attach context, or request a file edit here.
                                    </div>
                                  </Show>
                                  <For each={editorMessages()}>
                                    {(message) => (
                                      <div
                                        class="min-w-0"
                                        classList={{
                                          "rounded-[9px] border border-[#303030] bg-[#1b1b1b] px-3 py-2.5":
                                            message.role === "user",
                                        }}
                                      >
                                        <SessionMessage
                                          message={message}
                                          parts={editorMessageParts(message.id)}
                                          showReasoningSummaries={settings.general.showReasoningSummaries()}
                                          useV2Actions
                                        />
                                      </div>
                                    )}
                                  </For>
                                  <Show when={agentRunning()}>
                                    <div class="flex items-center gap-2 pb-2 text-[11px] text-[#8c8c8c]">
                                      <span class="size-1.5 animate-pulse rounded-full bg-[#a98cff]" />
                                      {agentStatus()}…
                                    </div>
                                  </Show>
                                </div>

                                <div class="shrink-0 border-t border-[#242424] px-3 py-2.5">
                                  <Show
                                    when={editorSessionID()}
                                    fallback={
                                      <div class="rounded-[10px] border border-[#303030] bg-[#191919] px-3 py-4 text-[12px] leading-5 text-[#888]">
                                        Open Codespace from a Vector session to use the shared agent.
                                      </div>
                                    }
                                  >
                                    <PromptInput
                                      controls={editorInputController()}
                                      class="vector-editor-agent-composer !min-h-[104px] !rounded-[10px] !border-[#343434] !bg-[#181818] shadow-[0_8px_24px_rgba(0,0,0,0.2)]"
                                    />
                                  </Show>
                                </div>
                              </aside>
                            </Show>
                          </div>
                          <footer class="flex h-5.5 shrink-0 items-center justify-between border-t border-[#292929] bg-[#181818] px-2.5 font-mono text-[9px] text-[#777]">
                            <div class="flex min-w-0 items-center gap-3">
                              <span class="flex items-center gap-1 text-[#9a9a9a]">
                                <Icon name="branch" size="small" />
                                workspace
                              </span>
                              <span class="truncate">{path()}</span>
                            </div>
                            <div class="flex items-center gap-3">
                              {/* The only switch for Vector Tab since Settings lost its Editor page. Suggestions
                                  spend the selected model's tokens, so the choice is remembered. */}
                              <Show when={!props.externalAgent}>
                                <button
                                  type="button"
                                  data-vector-tab-toggle
                                  class="rounded-[3px] px-1 transition-colors hover:bg-[#262626] hover:text-[#c8c8c8] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#ad95f5]"
                                  classList={{ "text-[#ad95f5]": settings.editor.aiAutocomplete() }}
                                  aria-label="Vector Tab"
                                  aria-pressed={settings.editor.aiAutocomplete()}
                                  title={
                                    settings.editor.aiAutocomplete()
                                      ? "Turn off Vector Tab, the AI suggestions shown as you type. They use the selected model."
                                      : "Turn on Vector Tab: AI suggestions as you type, accepted with Tab. They use the selected model."
                                  }
                                  onClick={() => settings.editor.setAiAutocomplete(!settings.editor.aiAutocomplete())}
                                >
                                  Vector Tab {settings.editor.aiAutocomplete() ? "on" : "off"}
                                </button>
                              </Show>
                              <span>Ln {lineCount()}, Col 1</span>
                              <span>Spaces: 2</span>
                              <span>UTF-8</span>
                              <span>{activeBadge().label}</span>
                            </div>
                          </footer>
                        </div>
                      </Match>

                      <Match when={activeView() === "problems"}>
                        <div class="h-full overflow-auto bg-[#1b1b1b] p-3">
                          <For
                            each={problems()}
                            fallback={
                              <div class="rounded-[6px] border border-emerald-400/20 bg-emerald-500/[0.06] p-3 text-[12px] text-emerald-100">
                                No obvious local problems detected in this file.
                              </div>
                            }
                          >
                            {(problem) => (
                              <div class="mb-2 rounded-[6px] border border-[#2d2d2d] bg-[#191919] p-3">
                                <div class="flex items-center justify-between gap-3">
                                  <div class="text-[12px] font-medium text-[#d8d8d8]">Line {problem.line}</div>
                                  <div class="flex items-center gap-2">
                                    <div
                                      class="rounded-[4px] px-2 py-0.5 text-[9px] font-semibold uppercase"
                                      classList={{
                                        "bg-red-500/15 text-red-200": problem.severity === "error",
                                        "bg-amber-500/15 text-amber-200": problem.severity === "warning",
                                        "bg-sky-500/15 text-sky-200": problem.severity === "info",
                                      }}
                                    >
                                      {problem.severity}
                                    </div>
                                    <button
                                      class="rounded-[4px] border border-[#323232] bg-white/[0.04] px-2.5 py-1 text-[11px] text-[#cfcfcf] hover:bg-white/[0.08]"
                                      onClick={() => setActiveView("editor")}
                                    >
                                      Open File
                                    </button>
                                    <button
                                      class="rounded-[4px] border border-[#323232] bg-transparent px-2.5 py-1 text-[11px] text-[#858585] hover:bg-white/[0.05] hover:text-white"
                                      onClick={() => {
                                        const next = new Set(ignoredProblems())
                                        next.add(problemKey(problem))
                                        setIgnoredProblems(next)
                                      }}
                                    >
                                      Ignore
                                    </button>
                                  </div>
                                </div>
                                <div class="mt-2 text-[12px] text-[#8f8f8f]">{problem.message}</div>
                              </div>
                            )}
                          </For>
                        </div>
                      </Match>
                    </Switch>
                  </Match>
                  <Match when={state()?.loading}>
                    <div class="px-6 py-5 text-13-regular text-[#a8adba]">Loading {path()}...</div>
                  </Match>
                  <Match when={state()?.error}>
                    {(err) => <div class="px-6 py-5 text-13-regular text-[#a8adba]">{err()}</div>}
                  </Match>
                </Switch>
              )}
            </Show>
          </section>
          <Show when={agentOpen() && props.externalAgent}>
            {(agent) => (
              <aside
                class="vector-editor-agent-pane vector-external-editor-agent relative flex shrink-0 flex-col"
                style={{ width: `min(${agentWidth()}px, 42%)` }}
              >
                <ResizeHandle
                  direction="horizontal"
                  edge="start"
                  size={agentWidth()}
                  min={360}
                  max={typeof window === "undefined" ? 900 : Math.min(900, window.innerWidth * 0.72)}
                  onResize={setAgentWidth}
                />
                <header class="vector-external-editor-agent-header">
                  <Icon name="prompt" size="small" />
                  <span>{agent().label}</span>
                  <span class="vector-agent-workspace-status" data-running={agent().running}>
                    <span />
                    {agentStatus()}
                  </span>
                </header>
                {agent().panel}
              </aside>
            )}
          </Show>
        </main>
      </div>
    </Portal>
  )
}

function StableCodespaceWorkbench(props: {
  modified: () => readonly string[]
  kinds: () => ReadonlyMap<string, Kind>
  empty: () => JSX.Element
  diffs: () => readonly RenderDiff[]
  focusReviewDiff: (path: string) => void
  sessionKey: () => string
  onClose: () => void
}) {
  const file = useFile()
  const sdk = useSDK()
  const local = useLocal()
  const prompt = usePrompt()
  const command = useCommand()
  const [selectedPath, setSelectedPath] = createSignal<string | undefined>()
  const [activeView, setActiveView] = createSignal<"editor" | "problems">("editor")
  const [saving, setSaving] = createSignal(false)
  const [drafts, setDrafts] = createStore<Record<string, string>>({})

  const state = createMemo(() => {
    const path = selectedPath()
    if (!path) return
    return file.get(path)
  })
  const contents = createMemo(() => state()?.content?.content ?? "")
  const draft = createMemo(() => {
    const path = selectedPath()
    if (!path) return ""
    return drafts[path] ?? contents()
  })
  const dirty = createMemo(() => Boolean(selectedPath()) && draft() !== contents())
  const activeBadge = createMemo(() => fileBadge(selectedPath()))
  const lineCount = createMemo(() => (draft() ? draft().split("\n").length : 0))
  const problems = createMemo(() => analyzeCodespaceProblems(selectedPath(), draft()))
  const modifiedSet = createMemo(() => new Set(props.modified()))

  const fileText = (path: string | undefined) => {
    if (!path) return ""
    return drafts[path] ?? file.get(path)?.content?.content ?? ""
  }

  const openFile = (path: string) => {
    setSelectedPath(path)
    setActiveView("editor")
    void file.load(path)
  }

  const sendProblemToAgent = (problem: CodespaceProblem, mode: "fix" | "explain") => {
    const path = selectedPath()
    if (!path) return
    const lines = draft().split("\n")
    const start = Math.max(0, problem.line - 4)
    const excerpt = lines
      .slice(start, problem.line + 3)
      .map((line, index) => `${start + index + 1}: ${line}`)
      .join("\n")
    const fence = "```"
    const context = `\n\nContext:\n${fence}\n${excerpt}\n${fence}\n\n`
    const text =
      mode === "fix"
        ? `Fix this problem in ${path} at line ${problem.line}: ${problem.message}${context}Make the smallest safe change and keep it reviewable.`
        : `Explain this problem in ${path} at line ${problem.line}: ${problem.message}${context}Explain what causes it, why it matters, and how to fix it.`
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    props.onClose()
    command.trigger("input.focus")
    showToast({
      title: mode === "fix" ? "Repair request ready" : "Explanation request ready",
      description: "The exact file, line, and code context are in the prompt. Send when ready.",
    })
  }

  const saveCurrentFile = async (options?: { silent?: boolean; path?: string; content?: string; base?: string }) => {
    const path = options?.path ?? selectedPath()
    if (!path) return
    const nextContent = options?.content ?? draft()
    const baseContent = options?.base ?? contents()
    if (nextContent === baseContent) {
      if (!options?.silent) showToast({ title: "Already saved", description: "There are no local changes to save." })
      return
    }
    setSaving(true)
    try {
      await sdk().client.file.write({ directory: sdk().directory, path, content: nextContent })
      await file.load(path, { force: true })
      await file.tree.refresh("")
      setDrafts(path, nextContent)
      const secrets = detectSecrets(nextContent)
      if (secrets.length > 0) {
        showToast({
          variant: "error",
          title: "Possible secret in " + fileBasename(path),
          description: `Looks like ${secrets.join(", ")}. Move real keys into environment variables before sharing or committing.`,
        })
      }
      if (!options?.silent) showToast({ title: "Saved", description: `${path} was saved locally.` })
    } catch (error) {
      showToast({
        variant: "error",
        title: "Could not save file",
        description: error instanceof Error && error.message ? error.message : "Vector could not write this file.",
      })
    } finally {
      setSaving(false)
    }
  }

  const copyCurrentFile = async () => {
    const path = selectedPath()
    if (!path) return
    await navigator.clipboard.writeText(draft())
    showToast({ title: "Copied", description: `${path} copied to clipboard.` })
  }

  const exportCurrentFile = () => {
    const path = selectedPath()
    if (!path) return
    const blob = new Blob([draft()], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = fileBasename(path)
    link.click()
    URL.revokeObjectURL(url)
  }

  createEffect(() => {
    const path = selectedPath()
    if (!path || !state()?.loaded || drafts[path] !== undefined) return
    setDrafts(path, contents())
  })

  createEffect(() => {
    if (selectedPath()) return
    const first = props.modified()[0]
    if (first) openFile(first)
  })

  let autosaveTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(
      () => [selectedPath(), draft(), contents(), Boolean(state()?.loaded)] as const,
      ([path, nextContent, baseContent, loaded]) => {
        if (!path || !loaded || nextContent === baseContent) return
        if (autosaveTimer) clearTimeout(autosaveTimer)
        autosaveTimer = setTimeout(() => {
          void saveCurrentFile({ path, content: nextContent, base: baseContent, silent: true })
        }, 900)
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    if (autosaveTimer) clearTimeout(autosaveTimer)
  })

  return (
    <div data-vector-codespace class="h-full min-h-0 flex flex-col overflow-hidden bg-[#0c0911] text-[#ebe7f5]">
      <header class="h-[72px] shrink-0 border-b border-[rgba(255,255,255,0.08)] bg-[#15101f]">
        <div class="flex h-full items-center gap-3 px-3">
          <button
            class="flex size-8 items-center justify-center rounded-xl text-[#9589a7] transition duration-200 hover:bg-white/6 hover:text-white"
            aria-label="Back to Vector Agent"
            onClick={props.onClose}
          >
            ‹
          </button>
          <img
            src="/vector-logo.png"
            alt=""
            class="size-8 rounded-xl shadow-[0_0_18px_rgba(139,92,246,0.35)]"
            draggable={false}
          />

          <nav class="mx-auto flex items-center gap-1 rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[#242428] p-1">
            <button
              class="h-7 rounded-xl px-3 text-12-medium transition duration-200"
              classList={{
                "bg-[#6d3bd2] text-white shadow-[0_0_18px_rgba(139,92,246,0.3)]": activeView() === "editor",
                "text-[#a9a4b5] hover:bg-white/6 hover:text-white": activeView() !== "editor",
              }}
              onClick={() => setActiveView("editor")}
            >
              Editor
            </button>
            <button
              class="h-7 rounded-xl px-3 text-12-medium transition duration-200"
              classList={{
                "bg-[#6d3bd2] text-white shadow-[0_0_18px_rgba(139,92,246,0.3)]": activeView() === "problems",
                "text-[#a9a4b5] hover:bg-white/6 hover:text-white": activeView() !== "problems",
              }}
              onClick={() => setActiveView("problems")}
            >
              Problems
              <Show when={problems().length > 0}>
                <span class="ml-2 rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  {problems().length}
                </span>
              </Show>
            </button>
          </nav>

          <div class="flex items-center gap-1.5">
            <button
              class="rounded-xl px-3 py-1.5 text-12-medium transition duration-200 hover:bg-white/6 hover:text-white"
              classList={{
                "text-violet-200": dirty(),
                "text-[#a9a4b5]": !dirty(),
              }}
              disabled={saving() || !selectedPath() || !dirty()}
              onClick={() => void saveCurrentFile()}
            >
              {saving() ? "Saving..." : "Save"}
            </button>
            <button
              class="rounded-xl px-3 py-1.5 text-12-medium text-[#a9a4b5] transition duration-200 hover:bg-white/6 hover:text-white"
              onClick={copyCurrentFile}
            >
              Copy
            </button>
            <button
              class="rounded-xl px-3 py-1.5 text-12-medium text-[#a9a4b5] transition duration-200 hover:bg-white/6 hover:text-white"
              onClick={exportCurrentFile}
            >
              Export
            </button>
          </div>
        </div>
      </header>

      <main class="min-h-0 flex-1 flex overflow-hidden">
        <aside class="w-[260px] shrink-0 border-r border-[rgba(255,255,255,0.08)] bg-[#1d1d1f]">
          <div class="flex h-11 items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-3">
            <div class="text-12-medium uppercase tracking-[0.18em] text-[#8a8595]">Files</div>
          </div>
          <div class="h-[calc(100%-2.75rem)] overflow-auto px-1 py-2 group/filetree">
            <Switch>
              <Match when={file.tree.state("")?.loaded && file.tree.children("").length === 0}>{props.empty()}</Match>
              <Match when={true}>
                <FileTree
                  path=""
                  class="py-1"
                  modified={[...modifiedSet()]}
                  kinds={props.kinds()}
                  excludeDirectories={CODESPACE_EXCLUDED_DIRECTORIES}
                  active={selectedPath()}
                  onFileClick={(node) => openFile(node.path)}
                />
              </Match>
            </Switch>
          </div>
        </aside>

        <section class="relative min-w-0 flex-1 flex flex-col overflow-hidden bg-[#1d1d1f]">
          <Show
            when={selectedPath()}
            fallback={
              <div class="flex h-full items-center justify-center bg-[#1d1d1f] px-8 text-center">
                <div class="max-w-sm">
                  <img
                    src="/vector-logo.png"
                    alt=""
                    class="mx-auto mb-5 size-14 rounded-2xl opacity-85"
                    draggable={false}
                  />
                  <div class="text-19-medium text-white">Open a file to start editing.</div>
                  <div class="mt-2 text-13-regular leading-relaxed text-[#a9a4b5]">
                    Vector Codespace is in stable editor mode with a file tree, syntax highlighting, autocomplete, and
                    local save.
                  </div>
                </div>
              </div>
            }
          >
            {(path) => (
              <Switch>
                <Match when={state()?.loaded || drafts[path()] !== undefined}>
                  <Switch>
                    <Match when={activeView() === "editor"}>
                      <div class="flex h-full min-h-0 flex-col overflow-hidden">
                        <div class="flex h-12 shrink-0 items-center justify-between border-b border-[#202023] bg-[#111018] px-4">
                          <div class="min-w-0 flex items-center gap-3">
                            <span class="size-2.5 rounded-full bg-[#9b6cff]" />
                            <span class="truncate font-mono text-14-medium text-white">{path()}</span>
                            <span
                              class={`rounded-xl border px-2.5 py-1 text-11-medium ${activeBadge().ring} ${activeBadge().color}`}
                            >
                              {activeBadge().label}
                            </span>
                            <span class="rounded-xl border border-[rgba(255,255,255,0.10)] bg-[#242428] px-2.5 py-1 text-11-medium text-[#a9a4b5]">
                              {lineCount()} lines
                            </span>
                          </div>
                          <div class="flex items-center gap-2">
                            <span class="text-12-regular text-[#8a8595]">
                              {dirty() ? "Unsaved changes" : "Saved locally"}
                            </span>
                            <button
                              class="rounded-xl border border-[rgba(255,255,255,0.10)] bg-[#242428] px-3 py-1.5 text-12-medium text-[#e2dfe9] transition duration-200 hover:bg-[#211f28]"
                              onClick={copyCurrentFile}
                            >
                              Copy
                            </button>
                          </div>
                        </div>
                        <div class="m-2 min-h-0 flex-1 overflow-hidden rounded-xl border border-[color:var(--vx-line)] bg-[#1d1d1f]">
                          <MonacoCodeEditor
                            path={path()}
                            value={draft()}
                            onChange={(next) => setDrafts(path(), next)}
                          />
                        </div>
                      </div>
                    </Match>
                    <Match when={activeView() === "problems"}>
                      <div class="h-full overflow-auto bg-[#1d1d1f] p-5">
                        <For
                          each={problems()}
                          fallback={
                            <div class="rounded-2xl border border-emerald-400/20 bg-emerald-500/8 p-4 text-13-regular text-emerald-100">
                              No obvious local problems detected in this file.
                            </div>
                          }
                        >
                          {(problem) => (
                            <div class="mb-3 w-full rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[#202023] p-4 text-left transition duration-200 hover:border-violet-400/35">
                              <div class="flex items-center justify-between gap-3">
                                <div class="text-13-medium text-[#edeaf3]">Line {problem.line}</div>
                                <div
                                  class="rounded-full px-2 py-0.5 text-11-medium uppercase"
                                  classList={{
                                    "bg-red-500/15 text-red-200": problem.severity === "error",
                                    "bg-amber-500/15 text-amber-200": problem.severity === "warning",
                                    "bg-sky-500/15 text-sky-200": problem.severity === "info",
                                  }}
                                >
                                  {problem.severity}
                                </div>
                              </div>
                              <div class="mt-2 text-13-regular text-[#a9a4b5]">{problem.message}</div>
                              <div class="mt-3 flex flex-wrap items-center gap-2">
                                <button
                                  class="rounded-full bg-[var(--vx-purple)] px-3 py-1.5 text-12-medium text-white transition duration-200 hover:brightness-110"
                                  onClick={() => sendProblemToAgent(problem, "fix")}
                                >
                                  Fix with AI
                                </button>
                                <button
                                  class="rounded-full border border-[rgba(255,255,255,0.12)] px-3 py-1.5 text-12-medium text-[#d6d2df] transition duration-200 hover:bg-white/6"
                                  onClick={() => sendProblemToAgent(problem, "explain")}
                                >
                                  Explain
                                </button>
                                <button
                                  class="rounded-full border border-[rgba(255,255,255,0.12)] px-3 py-1.5 text-12-medium text-[#d6d2df] transition duration-200 hover:bg-white/6"
                                  onClick={() => setActiveView("editor")}
                                >
                                  Go to editor
                                </button>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Match>
                  </Switch>
                </Match>
                <Match when={state()?.loading}>
                  <div class="px-6 py-5 text-13-regular text-[#a9a4b5]">Loading {path()}...</div>
                </Match>
                <Match when={state()?.error}>
                  {(err) => <div class="px-6 py-5 text-13-regular text-[#a9a4b5]">{err()}</div>}
                </Match>
              </Switch>
            )}
          </Show>
        </section>
      </main>
    </div>
  )
}

// The session timeline draws a research report as the app's report card, with its chips and actions.
registerResearchReportCard()
// Under a reply, what Vector learned from the request it answers, with Undo.
registerLearnedChip()
// Under a reply a learned workflow default shaped, what it changed and why.
registerWorkflowChip()

// A page the Sources tab asked Preview to open, for the browser context it names.
const [previewRequest, setPreviewRequest] = createSignal<{ contextId: string; url: string }>()

const PREVIEW_URL_STORAGE_PREFIX = "vector.preview.url.v1:"
// Lovable-style app preview: no chrome by default — Vector finds the running
// dev server on its own and just shows the app. A manual URL lives behind the
// slim top bar. Publishing lives in Vector Cloud, reached from Home.
// 5000 deliberately excluded: macOS AirPlay Receiver listens there by default
// and answers HTTP, so probing it produces a false-positive "dev server found".
const PREVIEW_PROBE_PORTS = [5173, 3000, 3001, 5174, 4321, 8080, 8000, 4000, 4173, 1420]

async function probePreviewUrl(candidate: string, timeoutMs = 1200) {
  try {
    await fetch(candidate, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}

export function PreviewPanel(props: {
  sessionKey: string
  contextId: string
  directory?: string
  onClose: () => void
}) {
  const command = useCommand()
  const storageKey = () => `${PREVIEW_URL_STORAGE_PREFIX}${props.sessionKey}`
  const readSavedUrl = () => {
    try {
      return localStorage.getItem(storageKey()) ?? ""
    } catch {
      return ""
    }
  }
  const [url, setUrl] = createSignal("")
  const [draftUrl, setDraftUrl] = createSignal(readSavedUrl())
  const [canGoBack, setCanGoBack] = createSignal(false)
  const [canGoForward, setCanGoForward] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  let viewportRef: HTMLDivElement | undefined
  let resizeObserver: ResizeObserver | undefined

  const browserApi = () => globalThis.window?.api?.runBrowserAgent

  const viewportBounds = () => {
    const rect = viewportRef?.getBoundingClientRect()
    if (!rect) return
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }

  const syncBrowserBounds = () => {
    const bounds = viewportBounds()
    const run = browserApi()
    if (!bounds || !run || !url()) return
    void run({ contextId: props.contextId, command: "setBounds", bounds }).catch(() => undefined)
  }

  const runBrowserCommand = async (
    input: Omit<import("@/features/browser-agent/types").BrowserAgentInput, "contextId">,
  ) => {
    const run = browserApi()
    if (!run) return undefined
    const report = await run({ ...input, contextId: props.contextId })
    if (report.finalUrl) {
      setUrl(report.finalUrl)
      setDraftUrl(report.finalUrl)
    }
    return report
  }

  const applyUrl = (next: string, allowExternal = false) => {
    setLoading(true)
    setUrl(next)
    setDraftUrl(next)
    try {
      localStorage.setItem(storageKey(), next)
    } catch {
      // Local convenience only.
    }
    requestAnimationFrame(syncBrowserBounds)
    void runBrowserCommand({ command: "openUrl", url: next, allowExternal })
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }

  // A source the Sources tab opened: the user asked for this page, so it may be on any site.
  const [attached, setAttached] = createSignal(false)
  createEffect(() => {
    const request = previewRequest()
    if (!request || request.contextId !== props.contextId || !attached()) return
    setPreviewRequest(undefined)
    applyUrl(request.url, true)
  })

  // Auto-detect the running app: saved URL first, then common dev-server
  // ports. Keeps polling quietly until something is up.
  const ownPort = globalThis.location?.port ?? ""
  const detect = async () => {
    if (url()) return
    const saved = readSavedUrl()
    // A saved URL pointing at Vector's own origin (possible in the web build)
    // would preview the workspace inside itself — ignore it and re-detect.
    const savedIsSelf = (() => {
      try {
        return Boolean(saved) && new URL(saved).origin === globalThis.location?.origin
      } catch {
        return false
      }
    })()
    if (saved && !savedIsSelf && (await probePreviewUrl(saved))) {
      if (!url()) applyUrl(saved)
      return
    }
    const candidates = PREVIEW_PROBE_PORTS.filter((port) => String(port) !== ownPort).map(
      (port) => `http://localhost:${port}`,
    )
    const results = await Promise.all(
      candidates.map(async (candidate) => ({ candidate, ok: await probePreviewUrl(candidate) })),
    )
    if (url()) return
    const hit = selectUnambiguousPreviewUrl(results)
    if (hit) applyUrl(hit)
  }

  onMount(() => {
    setOnboardingFlag("preview")
    const run = browserApi()
    if (!run) return
    void run({ contextId: props.contextId, command: "attach" })
      .then(() => {
        setAttached(true)
        return detect()
      })
      .catch(() => undefined)
    resizeObserver = new ResizeObserver(() => syncBrowserBounds())
    if (viewportRef) resizeObserver.observe(viewportRef)
    const removePageListener = globalThis.window?.api?.onBrowserAgentPageEvent?.((event) => {
      if (event.contextId !== props.contextId) return
      setCanGoBack(event.canGoBack)
      setCanGoForward(event.canGoForward)
      setLoading(event.loading)
      if (event.url) {
        setUrl(event.url)
        setDraftUrl(event.url)
        try {
          localStorage.setItem(storageKey(), event.url)
        } catch {
          // Local convenience only.
        }
      }
      requestAnimationFrame(syncBrowserBounds)
    })
    const removeZoomListener = globalThis.window?.api?.onZoomFactorChanged?.(() => syncBrowserBounds())
    const detectionTimer = setInterval(() => void detect(), 2_500)
    onCleanup(() => {
      clearInterval(detectionTimer)
      resizeObserver?.disconnect()
      removePageListener?.()
      removeZoomListener?.()
      void run({ contextId: props.contextId, command: "detach" }).catch(() => undefined)
    })
  })

  createEffect(() => {
    if (!url()) return
    requestAnimationFrame(syncBrowserBounds)
  })

  return (
    <div
      data-vector-browser-panel
      class="flex h-full min-h-0 flex-col bg-[color-mix(in_srgb,var(--vx-stage,#242428)_88%,transparent)] text-white backdrop-blur-xl"
    >
      <div class="flex h-11 shrink-0 items-center gap-1.5 border-b border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-surface,#232228)_94%,transparent)] px-2">
        <button
          data-vector-browser-forward
          type="button"
          aria-label="Go back"
          title="Go back"
          disabled={!canGoBack()}
          class="grid size-7 shrink-0 place-items-center rounded-[8px] text-white/55 transition hover:bg-white/[0.07] hover:text-white disabled:pointer-events-none disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(147,116,236,0.55)]"
          onClick={() => void runBrowserCommand({ command: "goBack" }).catch(() => undefined)}
        >
          <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
            <path
              d="m9.75 3.5-4.5 4.5 4.5 4.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.35"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Go forward"
          title="Go forward"
          disabled={!canGoForward()}
          class="grid size-7 shrink-0 place-items-center rounded-[8px] text-white/55 transition hover:bg-white/[0.07] hover:text-white disabled:pointer-events-none disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(147,116,236,0.55)]"
          onClick={() => void runBrowserCommand({ command: "goForward" }).catch(() => undefined)}
        >
          <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
            <path
              d="m6.25 3.5 4.5 4.5-4.5 4.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.35"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Reload page"
          title="Reload page"
          disabled={!url()}
          class="grid size-7 shrink-0 place-items-center rounded-[8px] text-white/55 transition hover:bg-white/[0.07] hover:text-white disabled:pointer-events-none disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(147,116,236,0.55)]"
          onClick={() => void runBrowserCommand({ command: "reload" }).catch(() => undefined)}
        >
          <svg viewBox="0 0 16 16" class={`size-3.5 ${loading() ? "motion-safe:animate-spin" : ""}`} aria-hidden="true">
            <path
              d="M12.5 5.25V2.8m0 0h-2.45m2.45 0-1.3 1.3A4.75 4.75 0 1 0 12.5 8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>

        <form
          class="mx-1 flex h-8 min-w-0 flex-1 items-center rounded-[9px] border border-[color:var(--vx-line)] bg-black/25 px-2.5 transition focus-within:border-[rgba(147,116,236,0.5)] focus-within:bg-black/35 focus-within:ring-2 focus-within:ring-[rgba(147,116,236,0.16)]"
          onSubmit={(event) => {
            event.preventDefault()
            applyUrl(resolveBrowserAddress(draftUrl()), true)
            event.currentTarget.querySelector("input")?.blur()
          }}
        >
          <span
            class={`mr-2 size-1.5 shrink-0 rounded-full ${url() ? "bg-emerald-400" : "motion-safe:animate-pulse bg-white/30"}`}
          />
          <input
            type="text"
            aria-label="Browser address"
            class="min-w-0 flex-1 bg-transparent text-[12px] text-white/80 outline-none placeholder:text-white/30"
            value={draftUrl()}
            placeholder="Search Google or type a URL"
            spellcheck={false}
            autocomplete="off"
            onFocus={(event) => event.currentTarget.select()}
            onInput={(event) => setDraftUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              setDraftUrl(url())
              event.currentTarget.blur()
            }}
          />
          <button
            type="submit"
            aria-label="Open URL"
            title="Open URL"
            class="ml-1 grid size-6 shrink-0 place-items-center rounded-[7px] text-white/35 transition hover:bg-white/[0.07] hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(147,116,236,0.55)]"
          >
            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
              <path
                d="M3.5 8h9M9 4.5 12.5 8 9 11.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </form>

        <div data-vector-browser-secondary class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Toggle Vector sidebar"
            title="Toggle Vector sidebar"
            class="grid size-7 place-items-center rounded-[8px] text-white/50 transition hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(147,116,236,0.55)]"
            onClick={() => command.trigger("vector.navigation.toggle")}
          >
            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
              <rect
                x="2.25"
                y="2.5"
                width="11.5"
                height="11"
                rx="1.75"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
              />
              <path d="M6 2.75v10.5" fill="none" stroke="currentColor" stroke-width="1.15" />
            </svg>
          </button>
          <Show when={url()}>
            <button
              type="button"
              aria-label="Open in system browser"
              title="Open in system browser"
              class="grid size-7 place-items-center rounded-[8px] text-white/50 transition hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(147,116,236,0.55)]"
              onClick={() => {
                const target = url()
                if (!target) return
                const desktop = (globalThis.window as unknown as { api?: { openLink?: (value: string) => void } })?.api
                  ?.openLink
                if (desktop) {
                  desktop(target)
                  return
                }
                const opened = globalThis.window?.open(target, "_blank")
                if (opened) {
                  opened.opener = null
                  return
                }
                showToast({ title: "Could not open browser", description: "Allow pop-ups and try again." })
              }}
            >
              <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                <path
                  d="M6.5 3.5H3.75A1.25 1.25 0 0 0 2.5 4.75v7.5a1.25 1.25 0 0 0 1.25 1.25h7.5a1.25 1.25 0 0 0 1.25-1.25V9.5M9.5 2.75h3.75V6.5M13 3 7.75 8.25"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.25"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </Show>
        </div>
      </div>

      <div class="relative flex min-h-0 flex-1 bg-[var(--vx-stage,#242428)]">
        <div ref={viewportRef} class="relative min-w-0 flex-1 overflow-hidden bg-[#242428]">
          <Show when={!url()}>
            <div class="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
              <img
                src="/vector-logo.png"
                alt=""
                class="size-11 motion-safe:animate-pulse rounded-[12px] object-cover opacity-80"
                draggable={false}
              />
              <div class="text-[15px] font-semibold text-white">Waiting for your app</div>
              <div class="max-w-sm text-[12.5px] leading-6 text-white/50">
                Start your app and Vector will attach its controlled browser here automatically.
              </div>
              <Show when={!browserApi()}>
                <div class="max-w-sm text-[12px] leading-5 text-amber-200/70">
                  The controlled browser is available in the Vector desktop app.
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  size: Sizing
}) {
  const layout = useLayout()
  const settings = useSettings()
  const sync = useSync()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const sdk = useSDK()
  const local = useLocal()
  const { sessionKey, tabs, view, params } = useSessionLayout()

  // Agent following lives here rather than in the Codespace. This panel stays
  // mounted for the whole session, so an edit made while the chat is showing
  // is not lost, and opening the editor lands on the file being edited.
  const agentFollow = createAgentFollow({
    listen: (fn) => sdk().event.listen(fn),
    source: fileFollowSource(file, CODESPACE_EXCLUDED_DIRECTORIES),
    followAgent: settings.editor.followAgent,
    agents: () => sync().data.agent,
    agentFor: (sessionID, messageID) => messageAgent(sync().data.message[sessionID], messageID),
  })

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const shown = settings.visibility.fileTree

  const reviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const fileOpen = createMemo(
    () =>
      isDesktop() &&
      shouldShowFileTree({
        visible: shown(),
        opened: layout.fileTree.opened(),
      }),
  )
  const open = createMemo(() => reviewOpen() || fileOpen())
  const reviewTab = createMemo(() => isDesktop())
  const codespaceOpen = createMemo(() => reviewOpen() && tabs().active() === "codespace")
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (codespaceOpen()) return "100%"
    if (reviewOpen()) return "auto"
    return `${layout.fileTree.width()}px`
  })
  const treeWidth = createMemo(() => (fileOpen() ? `${layout.fileTree.width()}px` : "0px"))

  const diffs = createMemo(() => props.diffs().filter(renderDiff))
  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const aiChangeSignature = createMemo(() => {
    const source = JSON.stringify(diffs())
    if (!source || source === "[]") return ""
    let hash = 2166136261
    for (let index = 0; index < source.length; index++) {
      hash = Math.imul(hash ^ source.charCodeAt(index), 16777619)
    }
    return (hash >>> 0).toString(36)
  })
  const activeSessionStatus = createMemo(() => {
    const id = params.id
    if (!id) return undefined
    return sync().data.session_status[id]?.type
  })
  const [timelineRefresh, setTimelineRefresh] = createSignal(0)
  const [timelineFilter, setTimelineFilter] = createSignal<TimelineFilter>("all")
  const [timelineSearch, setTimelineSearch] = createSignal("")
  const [expandedTimelineEvents, setExpandedTimelineEvents] = createSignal<Record<string, boolean>>({})
  const [projectReport, setProjectReport] = createSignal<VectorLocalReport | undefined>()
  const [projectReportLoading, setProjectReportLoading] = createSignal(false)
  const [skillMode, setSkillMode] = createSignal<SkillMode>(readSkillModePreference())
  createEffect(() => {
    try {
      localStorage.setItem(SKILL_MODE_KEY, skillMode())
    } catch {
      // Local preference only.
    }
  })
  const storedEngineeringTimeline = createMemo(() => {
    timelineRefresh()
    return getEngineeringEvents(sessionKey())
  })
  const diffTimelineEvents = createMemo<EngineeringTimelineEvent[]>(() =>
    diffs().map((diff) => {
      const risk = estimateDiffRisk(diff)
      const additions = diff.additions ?? 0
      const deletions = diff.deletions ?? 0
      const status: EngineeringEventStatus = risk === "High" ? "warning" : "success"
      return {
        id: `review:${diff.file}:${diff.status}:${additions}:${deletions}`,
        timestamp: Date.now(),
        type: "file",
        status,
        title: `${diffActionLabel(diff)} · ${fileBasename(diff.file)}`,
        summary: `${diff.file} has ${additions} added and ${deletions} removed line${additions + deletions === 1 ? "" : "s"}.`,
        details: [`Diff status: ${diff.status}`, `Risk level: ${risk}`, `Pending review in the changed-file panel.`],
        files: [diff.file],
        source: "Review",
      } satisfies EngineeringTimelineEvent
    }),
  )
  const riskTimelineEvents = createMemo<EngineeringTimelineEvent[]>(() => {
    const report = projectReport()
    if (!report) return []
    return report.problems.map((problem, index) => ({
      id: `risk:${report.scannedAt}:${index}:${problem.path}:${problem.message}`,
      timestamp: report.scannedAt,
      type: problem.severity === "error" ? "error" : "review",
      status: problem.severity === "error" ? "failed" : problem.severity === "warning" ? "warning" : "success",
      title: `${problem.severity === "error" ? "Error" : problem.severity === "warning" ? "Warning" : "Info"} · ${fileBasename(problem.path)}`,
      summary: problem.message,
      files: [problem.path],
      source: "Repository Doctor",
    }))
  })
  const engineeringTimeline = createMemo<EngineeringTimelineEvent[]>(() => {
    const byId = new Map<string, EngineeringTimelineEvent>()
    for (const event of storedEngineeringTimeline()) byId.set(event.id, event)
    for (const event of diffTimelineEvents()) byId.set(event.id, event)
    for (const event of riskTimelineEvents()) byId.set(event.id, event)
    return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp)
  })
  const filteredEngineeringTimeline = createMemo(() => {
    const query = timelineSearch().trim().toLowerCase()
    return engineeringTimeline().filter((event) => {
      const filter = timelineFilter()
      const matchesFilter =
        filter === "all" ||
        (filter === "ai" && (event.type === "ai" || event.type === "decision")) ||
        (filter === "files" && (event.type === "file" || event.type === "review")) ||
        (filter === "terminal" && (event.type === "terminal" || event.type === "build")) ||
        (filter === "browser" && event.type === "browser") ||
        (filter === "checkpoints" && event.type === "checkpoint") ||
        (filter === "errors" && (event.type === "error" || event.status === "failed" || event.status === "warning"))
      if (!matchesFilter) return false
      if (!query) return true
      return [
        event.title,
        event.summary,
        event.source,
        event.command,
        event.output,
        event.browserAction,
        ...(event.details ?? []),
        ...(event.files ?? []),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query))
    })
  })
  const projectDecisionEvents = createMemo<EngineeringTimelineEvent[]>(() => {
    const report = projectReport()
    const explicit = engineeringTimeline().filter((event) => event.type === "decision")
    if (!report) return explicit
    return [
      {
        id: `decision:memory:${report.scannedAt}`,
        timestamp: report.scannedAt,
        type: "decision",
        title: "Repository memory summary",
        summary: report.memory.summary,
        status: "success",
        details: report.memory.nextSteps,
        files: report.memory.importantFiles,
        source: "Repository Doctor",
      },
      ...explicit,
    ]
  })
  const taskInbox = createMemo(() =>
    engineeringTimeline()
      .filter(
        (event) =>
          event.type === "ai" ||
          event.type === "file" ||
          event.type === "review" ||
          event.type === "browser" ||
          event.type === "terminal" ||
          event.type === "build",
      )
      .slice(0, 18)
      .map((event) => ({
        id: event.id,
        title: event.title,
        summary: event.summary,
        status:
          event.status === "pending"
            ? "planning"
            : event.status === "running"
              ? "editing"
              : event.status === "failed" || event.status === "warning"
                ? "reviewing"
                : "done",
        source: event.source ?? timelineTypeLabel(event.type),
        timestamp: event.timestamp,
      })),
  )
  const copyOneClickRepairContext = async () => {
    const report = projectReport()
    const context = [
      "Vector one-click repair context",
      report?.problems.length ? "Problems:" : "Problems: none detected by local scan.",
      ...(report?.problems
        .slice(0, 8)
        .map((problem) => `- [${problem.severity}] ${problem.path}: ${problem.message}`) ?? []),
      diffs().length ? "Pending changed files:" : "Pending changed files: none.",
      ...diffs()
        .slice(0, 8)
        .map((diff) => `- ${diff.file} (+${diff.additions ?? 0}/-${diff.deletions ?? 0})`),
      report?.runCommands.length
        ? `Run command candidates: ${report.runCommands.join(", ")}`
        : "Run command candidates: none detected.",
    ].join("\n")

    try {
      await navigator.clipboard.writeText(context)
      logEngineeringEvent(sessionKey(), {
        type: "review",
        status: "success",
        title: "Prepared one-click repair context",
        summary: "Copied local errors, pending files, and run commands for a focused repair prompt.",
        details: context.split("\n").slice(1, 10),
        source: "Review tools",
      })
      showToast({
        title: "Repair context copied",
        description: "Paste it into Vector Agent or a focused AI repair request.",
      })
    } catch {
      showToast({
        variant: "error",
        title: "Could not copy repair context",
        description: "Clipboard access was not available.",
      })
    }
  }
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  onMount(clearLegacyCheckpoints)

  // Once an AI change settles, read the changed files once to scan them for
  // credentials. The contents are only scanned, never stored.
  createEffect(
    on(
      () => [aiChangeSignature(), activeSessionStatus()] as const,
      ([signature, sessionStatus]) => {
        if (!signature) return
        if (sessionStatus && sessionStatus !== "idle") return
        const session = sessionKey()
        const seenKey = `vector.secret-scan.${session}`
        if (localStorage.getItem(seenKey) === signature) return
        localStorage.setItem(seenKey, signature)

        const createdAt = Date.now()
        const files = [...diffFiles()]
        void (async () => {
          const contents = (
            await Promise.all(
              files.map(async (path) => {
                try {
                  const result = await sdk().client.file.read({ path })
                  const content = textFromFileReadResponse(result)
                  if (!content) return undefined
                  return { path, content }
                } catch {
                  return undefined
                }
              }),
            )
          ).filter((item) => item !== undefined)

          const flagged = contents.flatMap((file) =>
            detectSecrets(file.content).map((label) => `${fileBasename(file.path)} (${label})`),
          )
          if (flagged.length > 0) {
            showToast({
              variant: "error",
              title: "Secret scanner: review before accepting",
              description: `AI-modified files may contain credentials: ${[...new Set(flagged)].slice(0, 3).join("; ")}. Keep real keys in environment variables.`,
            })
          }

          logEngineeringEvent(session, {
            id: `file-edit:${session}-${createdAt}`,
            timestamp: createdAt,
            type: "file",
            status: flagged.length > 0 ? "warning" : "success",
            title: `Edited ${files.length} ${files.length === 1 ? "file" : "files"}`,
            summary:
              flagged.length > 0
                ? "AI changes are waiting for review, and the secret scanner flagged possible credentials."
                : "AI changes are waiting for review.",
            details:
              flagged.length > 0
                ? [`Potential secrets: ${[...new Set(flagged)].slice(0, 5).join("; ")}`]
                : ["Review these files before continuing."],
            files,
            source: "AI Agent",
          })
          setTimelineRefresh((value) => value + 1)
        })()
      },
      { defer: true },
    ),
  )

  const readWorkspaceTextFile = async (path: string) => {
    const result = await sdk().client.file.read({ path })
    return textFromFileReadResponse(result)
  }

  const collectWorkspaceReportFiles = async () => {
    const files: VectorReportFile[] = []
    const maxFiles = 220
    const maxChars = 900_000
    let chars = 0

    const visit = async (dir: string, depth: number): Promise<void> => {
      if (files.length >= maxFiles || chars >= maxChars || depth > 7) return
      const result = await sdk().client.file.list({ path: dir })
      const nodes = result.data ?? []
      const sorted = [...nodes].sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1
        return a.path.localeCompare(b.path)
      })

      for (const node of sorted) {
        if (node.ignored) continue
        const base = reportFileBasename(node.path)
        if (node.type === "directory") {
          if ([".git", "node_modules", "dist", "build", ".next", "coverage", "out", "target", "vendor"].includes(base))
            continue
          await visit(node.path, depth + 1)
          continue
        }
        if (!looksLikeTextProjectFile(node.path)) continue
        if (files.length >= maxFiles || chars >= maxChars) break
        try {
          const content = await readWorkspaceTextFile(node.path)
          if (!content) continue
          chars += content.length
          files.push({ path: node.path, content })
        } catch {
          // Binary, missing, or unreadable files are intentionally skipped by the local report.
        }
      }
    }

    await visit("", 0)
    return files
  }

  const runProjectDoctor = async () => {
    setProjectReportLoading(true)
    try {
      const files = await collectWorkspaceReportFiles()
      const model = local.model.current()
      const variant = local.model.variant.current()
      const report = buildVectorLocalReport(
        files,
        diffs(),
        `${model?.name ?? "No model selected"}${variant ? ` · ${modelVariantLabel(variant)}` : ""}`,
      )
      setProjectReport(report)
      logEngineeringEvent(sessionKey(), {
        id: `project-doctor:${report.scannedAt}`,
        timestamp: report.scannedAt,
        type: "review",
        status: report.problems.some((problem) => problem.severity === "error") ? "warning" : "success",
        title: "Scanned repository health",
        summary: `Scanned ${files.length} workspace file${files.length === 1 ? "" : "s"} locally. Preview status: ${report.preview.status}.`,
        details: [
          `Files: ${report.fileCount}`,
          `Lines: ${report.lineCount.toLocaleString()}`,
          `Context risk: ${report.cost.risk}`,
          `Problems: ${report.problems.length}`,
        ],
        files: report.memory.importantFiles,
        source: "Repository Doctor",
      })
      showToast({
        title: "Repository Doctor finished",
        description: `Scanned ${files.length} workspace file${files.length === 1 ? "" : "s"} locally.`,
      })
    } catch (error) {
      logEngineeringEvent(sessionKey(), {
        type: "error",
        status: "failed",
        title: "Repository Doctor failed",
        summary: error instanceof Error && error.message ? error.message : "Vector could not scan this workspace.",
        source: "Repository Doctor",
      })
      showToast({
        variant: "error",
        title: "Repository Doctor failed",
        description: error instanceof Error && error.message ? error.message : "Vector could not scan this workspace.",
      })
    } finally {
      setProjectReportLoading(false)
    }
  }

  const toggleTimelineEvent = (id: string) => {
    setExpandedTimelineEvents((previous) => ({ ...previous, [id]: !previous[id] }))
  }

  const clearEngineeringTimelineForSession = () => {
    clearEngineeringEvents(sessionKey())
    setTimelineRefresh((value) => value + 1)
  }

  const refreshEngineeringTimeline = (event?: Event) => {
    const detail = (event as CustomEvent<{ projectId?: string }> | undefined)?.detail
    if (!detail?.projectId || detail.projectId === sessionKey()) setTimelineRefresh((value) => value + 1)
  }

  // Persisting "vector:engineering-event" is owned by the layout-level
  // activity bridge (installActivityEventBridge); this panel only re-renders
  // when the timeline store broadcasts an update.
  globalThis.window?.addEventListener("vector:engineering-timeline-updated", refreshEngineeringTimeline)
  onCleanup(() => {
    globalThis.window?.removeEventListener("vector:engineering-timeline-updated", refreshEngineeringTimeline)
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
  })
  const contextOpen = tabState.contextOpen
  const previewOpen = tabState.previewOpen
  const sourcesOpen = tabState.sourcesOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const contextActive = createMemo(() => activeTab() === "context")

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const closePanel = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    if (tabs().active() === "context") tabs().close("context")
    if (tabs().active() === "codespace") tabs().close("codespace")
    if (tabs().active() === "preview") tabs().close("preview")
    if (tabs().active() === "sources") tabs().close("sources")
    announceWorkspaceMode("agent")
  }

  const vectorspaceTab = () => {
    view().reviewPanel.open("other")
    layout.fileTree.close()
    void tabs().open("codespace")
    tabs().setActive("codespace")
    announceWorkspaceMode("editor")
  }

  // With the Codespace closed, say once per agent turn what the agent is
  // editing, with a way to watch it. Following stays opt-in, and nothing
  // takes over the chat by itself. A turn is the root session's latest user
  // message, so a subagent's edits belong to the turn that started it.
  // Root session → the turn last toasted; undefined when it was not known.
  const followToasts = new Map<string, string | undefined>()
  const sessionParent = (sessionID: string) => sync().session.get(sessionID)?.parentID
  // A toast whose turn was not known stands until the session goes idle.
  createEffect(() => {
    const page = params.id
    if (!page) return
    const root = sessionLineage(page, sessionParent).at(-1)!
    if ((sync().data.session_status[root]?.type ?? "idle") !== "idle") return
    if (followToasts.has(root) && followToasts.get(root) === undefined) followToasts.delete(root)
  })
  createEffect(
    on(
      agentFollow.target,
      (target) => {
        // The Codespace only opens at desktop widths, so there is nothing to watch below them.
        if (!target || !settings.editor.followAgent() || !isDesktop() || codespaceOpen()) return
        if (Date.now() - target.token > 5_000) return
        // Only this chat's session and its subagents. Another tab's session,
        // or a multiplayer guest's, in the same directory is not this chat's.
        const page = params.id
        if (!page) return
        const lineage = sessionLineage(target.sessionID ?? target.agentId, sessionParent)
        if (!lineage.includes(page)) return
        const root = lineage.at(-1)!
        const turn = latestTurn(sync().data.message[root])
        const seen = followToasts.has(root)
        const last = followToasts.get(root)
        if (!followToastDue(seen, last, turn)) {
          // The turn became known after its toast: keep it, so the next turn still toasts.
          if (seen && last === undefined && turn !== undefined) followToasts.set(root, turn)
          return
        }
        followToasts.set(root, turn)
        showToast({
          title: `${target.agentName} is editing ${fileBasename(target.path)}`,
          description: target.path,
          actions: [{ label: "Watch", onClick: vectorspaceTab }],
        })
      },
      { defer: true },
    ),
  )

  const openPreviewTab = () => {
    view().reviewPanel.open("other")
    layout.fileTree.close()
    void tabs().open("preview")
    tabs().setActive("preview")
    announceWorkspaceMode("agent")
  }

  // Deep research's Sources tab: offered once the session has a research run, and opened by the report card's
  // citations and Sources button.
  const [sourcesRequest, setSourcesRequest] = createSignal<OpenSources>()
  const hasResearch = createMemo(() => {
    const id = params.id
    if (!id) return false
    return (
      sessionRuns((sync().data.message[id] ?? []).flatMap((message) => sync().data.part[message.id] ?? [])).length > 0
    )
  })
  const openSourcesTab = (request?: OpenSources) => {
    view().reviewPanel.open("other")
    layout.fileTree.close()
    void tabs().open("sources")
    tabs().setActive("sources")
    if (request) setSourcesRequest({ ...request })
    announceWorkspaceMode("agent")
  }
  const onOpenSources = (event: Event) => {
    const detail = (event as CustomEvent<OpenSources>).detail
    const page = params.id
    if (!detail || !page) return
    if (!sessionLineage(detail.sessionID, sessionParent).includes(page) && detail.sessionID !== page) return
    openSourcesTab(detail)
  }
  globalThis.window?.addEventListener(OPEN_SOURCES, onOpenSources)
  onCleanup(() => globalThis.window?.removeEventListener(OPEN_SOURCES, onOpenSources))
  // "Open in browser" from a source: Preview on the desktop, the system browser elsewhere.
  const openInBrowser = (url: string) => {
    if (!globalThis.window?.api?.runBrowserAgent) {
      const openLink = globalThis.window?.api?.openLink
      if (openLink) openLink(url)
      else globalThis.window?.open(url, "_blank", "noopener,noreferrer")
      return
    }
    setPreviewRequest({ contextId: params.id ?? sessionKey(), url })
    openPreviewTab()
  }

  const handleTabChange = (value: string) => {
    if (value === "codespace") {
      vectorspaceTab()
      return
    }
    if (value === "preview") {
      openPreviewTab()
      return
    }
    if (value === "sources") {
      openSourcesTab()
      return
    }
    announceWorkspaceMode("agent")
    openTab(value)
  }

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open() || event.defaultPrevented) return
    if (
      document.querySelector(
        '[data-dialog-layer], [role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]',
      )
    )
      return
    // This capture listener runs before everything else's Esc. Leave it to the
    // surfaces that close on their own: the diff find bar (portalled to the body),
    // the Background tasks pane, and a field in the panel (the Changes filter clears
    // first; once it is empty, Esc there leaves the field and the next one closes).
    const target = event.target
    if (target instanceof Element && target.closest('[data-component="file-search"], .vector-bg-tasks')) return
    if (
      target instanceof HTMLElement &&
      target.closest("#review-panel") &&
      (target.isContentEditable || target.closest("input, textarea, select"))
    )
      return
    // A file open in Changes takes this Esc and goes Back to the list (SessionReviewV2
    // listens in the bubble phase, after this capture listener); the next Esc closes.
    const reader = document.querySelector('#review-panel [data-component="session-review-v2"][data-view="file"]')
    if (reader && (target === document.body || (target instanceof Node && reader.contains(target)))) return
    event.preventDefault()
    closePanel()
  }

  globalThis.window?.addEventListener("keydown", handleKeydown, { capture: true })
  onCleanup(() => globalThis.window?.removeEventListener("keydown", handleKeydown, { capture: true }))

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop() && !(settings.general.newLayoutDesigns() && !params.id)}>
      <aside
        id="review-panel"
        data-vector-review-panel
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active() && !props.reviewSnap,
          "rounded-[10px] shadow-[var(--v2-elevation-raised)] overflow-hidden":
            settings.general.newLayoutDesigns() && !codespaceOpen(),
          "flex-1": reviewOpen(),
        }}
        style={{ width: panelWidth() }}
      >
        <Show when={open()}>
          <div
            class="size-full flex"
            classList={{
              "border-l border-border-weaker-base": !settings.general.newLayoutDesigns() && !codespaceOpen(),
            }}
          >
            <div
              aria-hidden={!reviewOpen()}
              inert={!reviewOpen()}
              class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
              classList={{
                "pointer-events-none": !reviewOpen(),
              }}
            >
              <div class="size-full min-w-0 h-full bg-background-base">
                <DragDropProvider
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragOver={handleDragOver}
                  collisionDetector={closestCenter}
                >
                  <DragDropSensors />
                  <ConstrainDragYAxis />
                  <Tabs value={activeTab()} onChange={handleTabChange}>
                    <Show when={activeTab() !== "codespace"}>
                      <Show
                        when={contextActive()}
                        fallback={
                          <div class="sticky top-0 shrink-0 flex">
                            <Tabs.List
                              ref={(el: HTMLDivElement) => {
                                const stop = createFileTabListSync({ el, contextOpen })
                                onCleanup(stop)
                              }}
                            >
                              <Show when={contextOpen()}>
                                <Tabs.Trigger
                                  value="context"
                                  closeButton={
                                    <TooltipKeybind
                                      title={language.t("common.closeTab")}
                                      keybind={command.keybind("tab.close")}
                                      placement="bottom"
                                      gutter={10}
                                    >
                                      <IconButton
                                        icon="close-small"
                                        variant="ghost"
                                        class="h-5 w-5"
                                        onClick={() => tabs().close("context")}
                                        aria-label={language.t("common.closeTab")}
                                      />
                                    </TooltipKeybind>
                                  }
                                  hideCloseButton
                                  onMiddleClick={() => tabs().close("context")}
                                >
                                  <div class="flex items-center gap-2">
                                    <SessionContextUsage variant="indicator" />
                                    <div>{language.t("session.tab.context")}</div>
                                  </div>
                                </Tabs.Trigger>
                              </Show>
                              <Show when={previewOpen()}>
                                <Tabs.Trigger
                                  value="preview"
                                  closeButton={
                                    <TooltipKeybind
                                      title="Close browser"
                                      keybind={command.keybind("tab.close")}
                                      placement="bottom"
                                      gutter={10}
                                    >
                                      <IconButton
                                        icon="close-small"
                                        variant="ghost"
                                        class="h-5 w-5"
                                        onClick={() => tabs().close("preview")}
                                        aria-label="Close browser"
                                      />
                                    </TooltipKeybind>
                                  }
                                  hideCloseButton
                                  onMiddleClick={() => tabs().close("preview")}
                                >
                                  <div class="flex items-center gap-2">
                                    <svg viewBox="0 0 16 16" class="size-4 text-[#c4a6ff]" aria-hidden="true">
                                      <path
                                        d="M2.25 4.25A1.25 1.25 0 0 1 3.5 3h9A1.25 1.25 0 0 1 13.75 4.25v6.5A1.25 1.25 0 0 1 12.5 12h-9a1.25 1.25 0 0 1-1.25-1.25v-6.5Z"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="1.25"
                                      />
                                      <path
                                        d="M2.75 5.5h10.5"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="1.2"
                                        stroke-linecap="round"
                                      />
                                    </svg>
                                    <div>Browser</div>
                                  </div>
                                </Tabs.Trigger>
                              </Show>
                              <Show when={sourcesOpen() || hasResearch()}>
                                <Tabs.Trigger
                                  value="sources"
                                  closeButton={
                                    <IconButton
                                      icon="close-small"
                                      variant="ghost"
                                      class="h-5 w-5"
                                      onClick={() => tabs().close("sources")}
                                      aria-label="Close Sources"
                                    />
                                  }
                                  hideCloseButton={!sourcesOpen()}
                                  onMiddleClick={() => tabs().close("sources")}
                                >
                                  <div class="flex items-center gap-2">
                                    <Icon name="bullet-list" size="small" />
                                    <div>Sources</div>
                                  </div>
                                </Tabs.Trigger>
                              </Show>
                              <Show when={activeTab() !== "preview" && reviewTab() && props.canReview()}>
                                <Tabs.Trigger
                                  value="review"
                                  closeButton={
                                    <IconButton
                                      icon="close-small"
                                      variant="ghost"
                                      onClick={closePanel}
                                      aria-label="Close the Changes tab"
                                    />
                                  }
                                >
                                  <Icon name="review" size="small" data-slot="review-tab-icon" />
                                  <span>Changes</span>
                                  <Show when={props.hasReview()}>
                                    <span data-slot="review-tab-count">{props.reviewCount()}</span>
                                  </Show>
                                </Tabs.Trigger>
                              </Show>
                              <Show when={activeTab() !== "preview"}>
                                <SortableProvider ids={openedTabs()}>
                                  <For each={openedTabs()}>
                                    {(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}
                                  </For>
                                </SortableProvider>
                              </Show>
                              <div
                                data-slot="review-panel-close"
                                class="h-full shrink-0 sticky right-0 z-10 flex items-center justify-center"
                              >
                                <TooltipKeybind title="Close panel" keybind="Esc" placement="bottom" gutter={10}>
                                  <IconButton
                                    icon="close"
                                    variant="ghost"
                                    iconSize="small"
                                    onClick={closePanel}
                                    aria-label="Close review panel"
                                  />
                                </TooltipKeybind>
                              </div>
                            </Tabs.List>
                          </div>
                        }
                      >
                        <div class="sticky top-0 z-20 h-10 shrink-0 flex items-center justify-between border-b border-border-weaker-base bg-background-stronger px-3">
                          <div class="flex min-w-0 items-center gap-2 text-12-medium text-text-base">
                            <SessionContextUsage variant="indicator" />
                            <span>Context</span>
                          </div>
                          <TooltipKeybind title="Close context" keybind="Esc" placement="bottom" gutter={10}>
                            <IconButton
                              icon="close-small"
                              variant="ghost"
                              iconSize="large"
                              class="!rounded-md"
                              onClick={() => {
                                tabs().close("context")
                                view().reviewPanel.close()
                              }}
                              aria-label="Close context"
                            />
                          </TooltipKeybind>
                        </div>
                      </Show>
                    </Show>

                    <Show when={reviewTab() && props.canReview()}>
                      <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={reviewOpen() && activeTab() === "review"}>{props.reviewPanel()}</Show>
                      </Tabs.Content>
                    </Show>

                    <Tabs.Content value="codespace" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={reviewOpen() && activeTab() === "codespace"}>
                        <CodespaceWorkbench
                          modified={diffFiles}
                          kinds={kinds}
                          empty={() => empty(language.t("session.files.empty"))}
                          diffs={diffs}
                          focusReviewDiff={props.focusReviewDiff}
                          sessionId={() => params.id}
                          onClose={closePanel}
                          follow={agentFollow}
                        />
                      </Show>
                    </Tabs.Content>

                    <Tabs.Content value="preview" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={reviewOpen() && activeTab() === "preview"}>
                        <PreviewPanel
                          sessionKey={sessionKey()}
                          contextId={params.id ?? sessionKey()}
                          directory={sdk().directory}
                          onClose={() => {
                            tabs().close("preview")
                            view().reviewPanel.close()
                          }}
                        />
                      </Show>
                    </Tabs.Content>

                    <Tabs.Content value="sources" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={reviewOpen() && activeTab() === "sources" && params.id}>
                        {(id) => (
                          <Suspense
                            fallback={
                              <div role="status" class="p-4 text-13-regular text-text-weak">
                                Reading sources…
                              </div>
                            }
                          >
                            <ResearchSourcesTab
                              sessionID={id()}
                              request={sourcesRequest()}
                              onOpenInBrowser={openInBrowser}
                            />
                          </Suspense>
                        )}
                      </Show>
                    </Tabs.Content>

                    <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "empty"}>
                        <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                          <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                            <Mark class="w-14 opacity-10" />
                            <div class="text-14-regular text-text-weak max-w-56">
                              {language.t("session.files.selectToOpen")}
                            </div>
                          </div>
                        </div>
                      </Show>
                    </Tabs.Content>

                    <Show when={contextOpen()}>
                      <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={activeTab() === "context"}>
                          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                            <SessionContextTab />
                          </div>
                        </Show>
                      </Tabs.Content>
                    </Show>

                    <Show when={activeFileTab()} keyed>
                      {(tab) => <FileTabContent tab={tab} />}
                    </Show>
                  </Tabs>
                  <DragOverlay>
                    <Show when={store.activeDraggable} keyed>
                      {(tab) => {
                        const path = file.pathFromTab(tab)
                        return (
                          <div data-component="tabs-drag-preview">
                            <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                          </div>
                        )
                      }}
                    </Show>
                  </DragOverlay>
                </DragDropProvider>
              </div>
            </div>

            <Show when={shown()}>
              <div
                id="file-tree-panel"
                aria-hidden={!fileOpen()}
                inert={!fileOpen()}
                class="relative min-w-0 h-full shrink-0 overflow-hidden"
                classList={{
                  "pointer-events-none": !fileOpen(),
                  "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                    !props.size.active(),
                }}
                style={{ width: treeWidth() }}
              >
                <div
                  class="h-full flex flex-col overflow-hidden group/filetree"
                  classList={{ "border-l border-border-weaker-base": reviewOpen() }}
                >
                  <Tabs
                    variant="pill"
                    value={fileTreeTab()}
                    onChange={setFileTreeTabValue}
                    class="h-full"
                    data-scope="filetree"
                  >
                    <Tabs.List>
                      <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                        {props.reviewCount()}{" "}
                        {language.t(
                          props.reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                        )}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                        {language.t("session.files.all")}
                      </Tabs.Trigger>
                    </Tabs.List>
                    <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                      <Switch>
                        <Match when={props.hasReview() || !props.diffsReady()}>
                          <Show
                            when={props.diffsReady()}
                            fallback={
                              <div class="px-2 py-2 text-12-regular text-text-weak">
                                {language.t("common.loading")}
                                {language.t("common.loading.ellipsis")}
                              </div>
                            }
                          >
                            <FileTree
                              path=""
                              class="pt-3"
                              allowed={diffFiles()}
                              kinds={kinds()}
                              draggable={false}
                              active={props.activeDiff}
                              onFileClick={(node) => props.focusReviewDiff(node.path)}
                            />
                          </Show>
                        </Match>
                      </Switch>
                    </Tabs.Content>
                    <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                      <Switch>
                        <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                        <Match when={true}>
                          <FileTree
                            path=""
                            class="pt-3"
                            modified={diffFiles()}
                            kinds={kinds()}
                            onFileClick={(node) => openTab(file.tab(node.path))}
                          />
                        </Match>
                      </Switch>
                    </Tabs.Content>
                  </Tabs>
                </div>
                <Show when={fileOpen()}>
                  <div onPointerDown={() => props.size.start()}>
                    <ResizeHandle
                      direction="horizontal"
                      edge="start"
                      size={layout.fileTree.width()}
                      min={200}
                      max={typeof window === "undefined" ? 1200 : Math.max(720, window.innerWidth * 0.72)}
                      onResize={(width) => {
                        props.size.touch()
                        layout.fileTree.resize(width)
                      }}
                    />
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </aside>
    </Show>
  )
}
