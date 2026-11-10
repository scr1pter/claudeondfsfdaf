import { createEffect, onCleanup, onMount, untrack } from "solid-js"
import * as monaco from "monaco-editor"
import { TYPING_ARM_MS, typingPlan, typingSteps } from "./agent-edit-intent"
import { activeAttributions, ATTRIBUTION_TTL_MS, type AgentAttribution, type LineRange } from "./editor-attribution"
import { useSettings } from "@/context/settings"
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker"
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker"
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker"
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker"

// VS Code's actual editor component (Monaco), themed to Vector's charcoal
// ramp. This is the same engine VS Code ships — intellisense, multi-cursor,
// minimap, find/replace, command palette — without forking the application.

export type InlineCompleteInput = {
  path: string
  prefix: string
  suffix: string
  language: string
  cursorLine: number
}
export type InlineCompleteFn = (input: InlineCompleteInput, signal?: AbortSignal) => Promise<string | undefined>
export type InlineEditSelection = {
  startOffset: number
  endOffset: number
  startLine: number
  endLine: number
  text: string
}

type LanguagePosition = {
  line: number
  character: number
}

type LanguageRange = {
  start: LanguagePosition
  end: LanguagePosition
}

export type MonacoLanguageDiagnostic = {
  range: LanguageRange
  severity?: number
  code?: string
  source?: string
  message: string
}

export type MonacoLanguageLocation = {
  uri: string
  range: LanguageRange
}

export type MonacoLanguageHover = {
  contents: string[]
  range?: LanguageRange
}

export type MonacoLanguageSymbol = {
  name: string
  detail?: string
  kind: number
  range?: LanguageRange
  selectionRange?: LanguageRange
  location?: MonacoLanguageLocation
}

export type MonacoLanguageFileEdit = {
  uri: string
  edits: {
    range: LanguageRange
    newText: string
  }[]
}

export type MonacoLanguageCodeAction = {
  title: string
  kind?: string
  isPreferred?: boolean
  files: MonacoLanguageFileEdit[]
}

export type MonacoLanguageService = {
  diagnostics: (file: string) => Promise<MonacoLanguageDiagnostic[]>
  hover: (file: string, position: LanguagePosition) => Promise<MonacoLanguageHover | undefined>
  definition: (file: string, position: LanguagePosition) => Promise<MonacoLanguageLocation[]>
  references: (file: string, position: LanguagePosition) => Promise<MonacoLanguageLocation[]>
  symbols: (file: string) => Promise<MonacoLanguageSymbol[]>
  rename: (file: string, position: LanguagePosition, newName: string) => Promise<MonacoLanguageFileEdit[]>
  codeActions?: (file: string, range: LanguageRange) => Promise<MonacoLanguageCodeAction[]>
  readFile: (file: string) => Promise<string>
  writeFile: (file: string, content: string) => Promise<void>
  filesChanged?: (files: string[]) => Promise<void>
}

let environmentReady = false

// Cursor-style inline (ghost-text) AI completions. Monaco resolves providers by
// model, so we register ONE global provider and route each model's request to the
// editor instance that owns it via this registry (keyed by model URI).
const completionRegistry = new Map<string, InlineCompleteFn>()
const completionRequests = new Map<string, AbortController>()
const languageServiceRegistry = new Map<string, MonacoLanguageService>()
let inlineProviderReady = false
let languageProvidersReady = false

const APPLY_CODE_ACTION = "vector.applyCodeAction"

function languagePosition(position: monaco.Position): LanguagePosition {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1,
  }
}

// Monaco ranges are 1-based; the language protocol is 0-based. The inverse of
// monacoRange below.
function languageRange(range: monaco.IRange): LanguageRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  }
}

function monacoRange(range: LanguageRange) {
  return new monaco.Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1)
}

function locationUri(uri: string) {
  if (uri.startsWith("file:")) return monaco.Uri.parse(uri)
  return monaco.Uri.file(uri)
}

async function loadLocation(service: MonacoLanguageService, location: MonacoLanguageLocation) {
  const uri = locationUri(location.uri)
  if (!monaco.editor.getModel(uri)) {
    const content = await service.readFile(uri.fsPath)
    monaco.editor.createModel(content, undefined, uri)
  }
  return {
    uri,
    range: monacoRange(location.range),
  }
}

async function applyRenameEdits(service: MonacoLanguageService, edits: MonacoLanguageFileEdit[]) {
  const changed = await Promise.all(
    edits.map(async (file) => {
      const uri = locationUri(file.uri)
      const model =
        monaco.editor.getModel(uri) ?? monaco.editor.createModel(await service.readFile(uri.fsPath), undefined, uri)
      model.pushEditOperations(
        [],
        file.edits.map((edit) => ({
          range: monacoRange(edit.range),
          text: edit.newText,
          forceMoveMarkers: true,
        })),
        () => null,
      )
      await service.writeFile(uri.fsPath, model.getValue())
      return uri.fsPath
    }),
  )
  await service.filesChanged?.(changed)
}

function ensureLanguageProviders() {
  if (languageProvidersReady) return
  languageProvidersReady = true

  monaco.languages.registerHoverProvider(
    { pattern: "**" },
    {
      provideHover: async (model, position) => {
        const service = languageServiceRegistry.get(model.uri.toString())
        if (!service) return
        const result = await service.hover(model.uri.fsPath, languagePosition(position)).catch(() => undefined)
        if (!result?.contents.length) return
        return {
          contents: result.contents.map((value) => ({ value })),
          range: result.range ? monacoRange(result.range) : undefined,
        }
      },
    },
  )

  monaco.languages.registerDefinitionProvider(
    { pattern: "**" },
    {
      provideDefinition: async (model, position) => {
        const service = languageServiceRegistry.get(model.uri.toString())
        if (!service) return []
        const locations = await service.definition(model.uri.fsPath, languagePosition(position)).catch(() => [])
        return Promise.all(locations.map((location) => loadLocation(service, location)))
      },
    },
  )

  monaco.languages.registerReferenceProvider(
    { pattern: "**" },
    {
      provideReferences: async (model, position) => {
        const service = languageServiceRegistry.get(model.uri.toString())
        if (!service) return []
        const locations = await service.references(model.uri.fsPath, languagePosition(position)).catch(() => [])
        return Promise.all(locations.map((location) => loadLocation(service, location)))
      },
    },
  )

  monaco.languages.registerDocumentSymbolProvider(
    { pattern: "**" },
    {
      provideDocumentSymbols: async (model) => {
        const service = languageServiceRegistry.get(model.uri.toString())
        if (!service) return []
        const symbols = await service.symbols(model.uri.fsPath).catch(() => [])
        return symbols.flatMap((symbol) => {
          const range = symbol.range ?? symbol.location?.range
          const selectionRange = symbol.selectionRange ?? range
          if (!range || !selectionRange) return []
          return [
            {
              name: symbol.name,
              detail: symbol.detail ?? "",
              kind: symbol.kind as monaco.languages.SymbolKind,
              range: monacoRange(range),
              selectionRange: monacoRange(selectionRange),
              tags: [],
            },
          ]
        })
      },
    },
  )

  // The lightbulb: extract function, inline variable, add the missing import,
  // fix this diagnostic. Edits are applied through the same path as rename
  // rather than handed back to Monaco, because an action can touch files that
  // have no open model and Monaco will not create one for us.
  monaco.editor.registerCommand(APPLY_CODE_ACTION, async (_accessor, key: string, files: MonacoLanguageFileEdit[]) => {
    const service = languageServiceRegistry.get(key)
    if (!service || !files?.length) return
    await applyRenameEdits(service, files)
  })

  monaco.languages.registerCodeActionProvider(
    { pattern: "**" },
    {
      provideCodeActions: async (model, range) => {
        const key = model.uri.toString()
        const service = languageServiceRegistry.get(key)
        if (!service?.codeActions) return { actions: [], dispose: () => {} }
        // The server reads the file from disk, so unsaved edits must land first
        // or it computes actions against stale text.
        await service.writeFile(model.uri.fsPath, model.getValue())
        const found = await service.codeActions(model.uri.fsPath, languageRange(range)).catch(() => [])
        return {
          actions: found.map((action) => ({
            title: action.title,
            kind: action.kind ?? "refactor",
            isPreferred: action.isPreferred,
            command: { id: APPLY_CODE_ACTION, title: action.title, arguments: [key, action.files] },
          })),
          dispose: () => {},
        }
      },
    },
  )

  monaco.languages.registerRenameProvider(
    { pattern: "**" },
    {
      provideRenameEdits: async (model, position, newName) => {
        const service = languageServiceRegistry.get(model.uri.toString())
        if (!service) return { edits: [] }
        await service.writeFile(model.uri.fsPath, model.getValue())
        const edits = await service.rename(model.uri.fsPath, languagePosition(position), newName)
        await applyRenameEdits(service, edits)
        return { edits: [] }
      },
    },
  )
}

function ensureInlineProvider() {
  if (inlineProviderReady) return
  inlineProviderReady = true
  monaco.languages.registerInlineCompletionsProvider(
    { pattern: "**" },
    {
      provideInlineCompletions: async (model, position, _context, token) => {
        const uri = model.uri.toString()
        const complete = completionRegistry.get(uri)
        if (!complete) return { items: [] }
        completionRequests.get(uri)?.abort()
        const controller = new AbortController()
        completionRequests.set(uri, controller)
        const cancellation = token.onCancellationRequested(() => controller.abort())
        if (token.isCancellationRequested) controller.abort()
        try {
          // Debounce: only ask the model once the user pauses; keep cancellation connected during generation too.
          await new Promise((resolve) => setTimeout(resolve, 400))
          if (controller.signal.aborted) return { items: [] }
          const prefix = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column))
          const lastLine = model.getLineCount()
          const suffix = model.getValueInRange(
            new monaco.Range(position.lineNumber, position.column, lastLine, model.getLineMaxColumn(lastLine)),
          )
          const suggestion = await complete(
            {
              path: model.uri.fsPath,
              prefix,
              suffix,
              language: model.getLanguageId(),
              cursorLine: position.lineNumber,
            },
            controller.signal,
          ).catch(() => undefined)
          if (!suggestion || controller.signal.aborted) return { items: [] }
          return {
            items: [
              {
                insertText: suggestion,
                range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
              },
            ],
          }
        } finally {
          cancellation.dispose()
          if (completionRequests.get(uri) === controller) completionRequests.delete(uri)
        }
      },
      disposeInlineCompletions: () => {},
    },
  )
}

function ensureMonacoEnvironment() {
  if (environmentReady) return
  environmentReady = true
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === "json") return new jsonWorker()
      if (label === "css" || label === "scss" || label === "less") return new cssWorker()
      if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker()
      if (label === "typescript" || label === "javascript") return new tsWorker()
      return new editorWorker()
    },
  }
  // Vector's editor is backed by the repository LSP below, which resolves the
  // workspace tsconfig, package graph, and aliases. Monaco's standalone worker
  // sees only one open model and otherwise paints valid imports and JSX red.
  // Keep its completions and syntax services, but let the workspace LSP own
  // diagnostics so users see the same result as the repository toolchain.
  const diagnostics = { noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true }
  const typescript = monaco.languages.typescript as unknown as {
    typescriptDefaults: { setDiagnosticsOptions: (options: typeof diagnostics) => void }
    javascriptDefaults: { setDiagnosticsOptions: (options: typeof diagnostics) => void }
  }
  typescript.typescriptDefaults.setDiagnosticsOptions(diagnostics)
  typescript.javascriptDefaults.setDiagnosticsOptions(diagnostics)
  monaco.editor.defineTheme("vector-dark", {
    base: "vs-dark",
    inherit: true,
    // Keep syntax expressive while the editor chrome stays neutral and mature.
    rules: [
      { token: "comment", foreground: "6f5f96", fontStyle: "italic" },
      { token: "keyword", foreground: "b18aff" },
      { token: "string", foreground: "f5a3e0" },
      { token: "number", foreground: "9ff0c8" },
      { token: "regexp", foreground: "ff9ab8" },
      { token: "type", foreground: "82e8e0" },
      { token: "class", foreground: "82e8e0" },
      { token: "function", foreground: "d0b8ff" },
      { token: "variable", foreground: "c7d6ff" },
      { token: "constant", foreground: "b18aff" },
      { token: "operator", foreground: "9d8fc0" },
      { token: "delimiter", foreground: "9d8fc0" },
      { token: "tag", foreground: "b18aff" },
      { token: "attribute.name", foreground: "c7d6ff" },
      { token: "attribute.value", foreground: "f5a3e0" },
      { token: "string.key.json", foreground: "c7d6ff" },
      { token: "string.value.json", foreground: "f5a3e0" },
      { token: "keyword.json", foreground: "b18aff" },
      { token: "number.json", foreground: "9ff0c8" },
    ],
    colors: {
      "editor.background": "#111111",
      "editor.foreground": "#dedede",
      "editorGutter.background": "#111111",
      "editorLineNumber.foreground": "#626262",
      "editorLineNumber.activeForeground": "#bdbdbd",
      "editor.lineHighlightBackground": "#1b1b1b",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#4b2f8f80",
      "editor.inactiveSelectionBackground": "#40335f59",
      "editor.selectionHighlightBackground": "#40335f4d",
      "editorCursor.foreground": "#c9b0ff",
      "editorIndentGuide.background1": "#282828",
      "editorIndentGuide.activeBackground1": "#555555",
      "editorWhitespace.foreground": "#303030",
      "editorWidget.background": "#191919",
      "editorWidget.border": "#383838",
      "editorHoverWidget.background": "#191919",
      "editorHoverWidget.border": "#383838",
      "editorSuggestWidget.background": "#191919",
      "editorSuggestWidget.border": "#383838",
      "editorSuggestWidget.selectedBackground": "#292929",
      "editorGhostText.foreground": "#6f6f6f",
      "editorBracketMatch.background": "#00000000",
      "editorBracketMatch.border": "#7c5ce6",
      "minimap.background": "#111111",
      "editorStickyScroll.background": "#111111",
      "editorStickyScrollHover.background": "#1b1b1b",
      "editorOverviewRuler.border": "#00000000",
      "scrollbarSlider.background": "#ffffff20",
      "scrollbarSlider.hoverBackground": "#ffffff32",
      "scrollbarSlider.activeBackground": "#ffffff46",
    },
  })
}

function modelFor(path: string, value: string) {
  const uri = monaco.Uri.file(path || "untitled.txt")
  const existing = monaco.editor.getModel(uri)
  if (existing) {
    if (existing.getValue() !== value) existing.setValue(value)
    return existing
  }
  return monaco.editor.createModel(value, undefined, uri)
}

const cssId = (value: string) => value.replace(/[^a-z0-9_-]/gi, "")

// Monaco decorations take class names, not inline colours, so each colour is
// injected as a rule once and reused. The rules carry nothing but the colour,
// so they are keyed by it rather than by agent: the colours are bounded by the
// palette and the configured agent colours, while agent ids (one per session)
// are not, and the stylesheet would otherwise grow and be rewritten for each.
// Rules accumulate, so two editors never drop each other's colours.
const colorClass = (color: string) => `c-${cssId(color.toLowerCase())}`

const attributionRules = new Map<string, string>()
let attributionStyleEl: HTMLStyleElement | undefined
function attributionStyles(entries: readonly Pick<AgentAttribution, "color">[]) {
  let changed = false
  for (const entry of entries) {
    const id = colorClass(entry.color)
    if (attributionRules.has(id)) continue
    attributionRules.set(
      id,
      [
        `.vector-agent-gutter.vector-agent-${id}{border-left:2px solid ${entry.color};margin-left:2px}`,
        `.vector-agent-line.vector-agent-${id}{background:${entry.color}14}`,
      ].join(""),
    )
    changed = true
  }
  if (!changed) return
  attributionStyleEl ??= (() => {
    const el = document.createElement("style")
    el.dataset.vectorAgentAttribution = "true"
    document.head.appendChild(el)
    return el
  })()
  attributionStyleEl.textContent = [...attributionRules.values()].join("")
}

export type MonacoReveal = {
  line: number
  endLine?: number
  /** Date.now() at the reveal: a change key so the same lines can be revealed
      twice in a row, and the clock the agent cursor fades on. */
  token: number
}

export type MonacoAgentCursor = {
  agentId: string
  agentName: string
  color: string
  line: number
  /** editing: the call is running. waiting: it needs approval. landed (the default): the edit is on disk. */
  state?: "editing" | "waiting" | "landed"
  /** Where an editing or waiting agent's change will land. */
  pending?: LineRange
  /** When the cursor last moved. A landed cursor clears ATTRIBUTION_TTL_MS after it. */
  token?: number
}

/** Replay the next change to the value as typing, in this agent's colour. */
export type MonacoTyping = {
  /** Date.now() when armed. Each token plays at most once, and only while fresh. */
  token: number
  agentId?: string
  agentName?: string
  color?: string
}

// The agent cursor is a collaborator-style marker: a tinted line with a
// blinking caret and the agent's name after the text, in the agent's colour.
// A call still running or waiting for approval also tints, dashed, the lines
// its change will land on.
const CURSOR_BASE_RULES = [
  "@keyframes vector-agent-caret{0%,49%{opacity:1}50%,100%{opacity:.15}}",
  ".vector-agent-cursor-label{display:inline-block;margin-left:14px;padding:0 6px;border-radius:4px;font-size:10px;font-weight:600;line-height:1.5;letter-spacing:.02em;font-family:ui-sans-serif,system-ui,sans-serif;font-style:normal;vertical-align:middle;white-space:nowrap;pointer-events:none;user-select:none}",
  '.vector-agent-cursor-label::before{content:"";display:inline-block;width:2px;height:1.1em;margin-right:6px;vertical-align:text-bottom;border-radius:1px;background:currentColor;animation:vector-agent-caret 1s steps(1) infinite}',
  ".vector-agent-cursor-waiting{font-style:italic}",
  ".vector-agent-cursor-waiting::before{animation:none;opacity:.55}",
].join("")

const cursorRules = new Map<string, string>()
let cursorStyleEl: HTMLStyleElement | undefined
function cursorStyles(cursors: readonly Pick<MonacoAgentCursor, "color">[]) {
  if (!cursors.length) return
  let changed = !cursorStyleEl
  for (const cursor of cursors) {
    const id = colorClass(cursor.color)
    if (cursorRules.has(id)) continue
    cursorRules.set(
      id,
      [
        `.vector-agent-cursor-line.vector-agent-cursor-${id}{box-shadow:inset 2px 0 0 ${cursor.color}}`,
        `.vector-agent-cursor-label.vector-agent-cursor-${id}{color:${cursor.color};background:${cursor.color}22}`,
        `.vector-agent-pending.vector-agent-pending-${id}{background:${cursor.color}0d}`,
        `.vector-agent-pending-gutter.vector-agent-pending-${id}{border-left:2px dashed ${cursor.color};margin-left:2px}`,
      ].join(""),
    )
    changed = true
  }
  if (!changed) return
  cursorStyleEl ??= (() => {
    const el = document.createElement("style")
    el.dataset.vectorAgentCursor = "true"
    document.head.appendChild(el)
    return el
  })()
  cursorStyleEl.textContent = CURSOR_BASE_RULES + [...cursorRules.values()].join("")
}

// Time between typed chunks: at most TYPING_MAX_STEPS of these, so a replay
// stays well under a second.
const TYPING_FRAME_MS = 24

function prefersReducedMotion() {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  } catch {
    return false
  }
}

export function MonacoCodeEditor(props: {
  path: string
  value: string
  /** Agents whose recent edits should be attributed in the gutter and margin. */
  attributions?: AgentAttribution[]
  /** Scroll the given lines into view (only when this editor shows the matching model). */
  reveal?: MonacoReveal
  /** Where an agent last typed; drawn as a named caret that clears after ATTRIBUTION_TTL_MS. */
  cursor?: MonacoAgentCursor
  /** Every agent's cursor on this file. Takes precedence over `cursor`. */
  cursors?: MonacoAgentCursor[]
  /** Replay the next external change to `value` as the agent typing it. */
  typing?: MonacoTyping
  readOnly?: boolean
  onChange: (next: string) => void
  onSave?: (value: string) => void
  /** Cursor-style ghost-text completion source. When provided (and enabled by the
      caller), Monaco shows the returned code as an inline suggestion; Tab accepts. */
  inlineComplete?: InlineCompleteFn
  /** Invoked when the user presses Cmd/Ctrl+K to request an inline AI edit. */
  onInlineEdit?: (selection: InlineEditSelection) => void
  /** Real compiler/language-server features supplied by the active workspace. */
  languageService?: MonacoLanguageService
}) {
  const editorSettings = useSettings().editor
  let host: HTMLDivElement | undefined
  let attributionCollection: ReturnType<monaco.editor.IStandaloneCodeEditor["createDecorationsCollection"]> | undefined
  let cursorCollection: ReturnType<monaco.editor.IStandaloneCodeEditor["createDecorationsCollection"]> | undefined
  let cursorTimer: ReturnType<typeof setTimeout> | undefined
  let revealedToken: number | undefined
  let editor: monaco.editor.IStandaloneCodeEditor | undefined
  let applyingExternal = false
  let registeredUri: string | undefined
  let diagnosticsTimer: ReturnType<typeof setTimeout> | undefined
  // An agent edit being replayed as typing (see playTyping).
  let animation: { model: monaco.editor.ITextModel; target: string; token: number; finish: () => void } | undefined
  let consumedTyping: number | undefined
  let typingCaret: { agentId: string; agentName: string; color: string; line: number } | undefined

  // Route this editor's model to props.inlineComplete (read lazily so it stays current).
  const syncCompletion = () => {
    const uri = editor?.getModel()?.uri.toString()
    if (registeredUri && registeredUri !== uri) {
      completionRequests.get(registeredUri)?.abort()
      completionRegistry.delete(registeredUri)
    }
    registeredUri = uri
    if (!uri) return
    if (props.inlineComplete) completionRegistry.set(uri, (input, signal) => props.inlineComplete!(input, signal))
    else {
      completionRequests.get(uri)?.abort()
      completionRegistry.delete(uri)
    }
    if (props.languageService) languageServiceRegistry.set(uri, props.languageService)
    else languageServiceRegistry.delete(uri)
  }

  const refreshDiagnostics = async () => {
    const model = editor?.getModel()
    if (!model) return
    const service = languageServiceRegistry.get(model.uri.toString())
    if (!service) {
      monaco.editor.setModelMarkers(model, "vector-lsp", [])
      return
    }
    const diagnostics = await service.diagnostics(model.uri.fsPath).catch(() => [])
    if (editor?.getModel() !== model) return
    monaco.editor.setModelMarkers(
      model,
      "vector-lsp",
      diagnostics.map((diagnostic) => ({
        ...monacoRange(diagnostic.range),
        severity:
          diagnostic.severity === 1
            ? monaco.MarkerSeverity.Error
            : diagnostic.severity === 2
              ? monaco.MarkerSeverity.Warning
              : diagnostic.severity === 3
                ? monaco.MarkerSeverity.Info
                : monaco.MarkerSeverity.Hint,
        code: diagnostic.code,
        source: diagnostic.source ?? "language server",
        message: diagnostic.message,
      })),
    )
  }

  const scheduleDiagnostics = (delay = 1_100) => {
    if (diagnosticsTimer) clearTimeout(diagnosticsTimer)
    diagnosticsTimer = setTimeout(() => void refreshDiagnostics(), delay)
  }

  onMount(() => {
    if (!host) return
    ensureMonacoEnvironment()
    ensureInlineProvider()
    ensureLanguageProviders()
    editor = monaco.editor.create(host, {
      model: modelFor(props.path, props.value),
      theme: "vector-dark",
      automaticLayout: true,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", ui-monospace, monospace',
      fontLigatures: true,
      fontWeight: "450",
      minimap: { enabled: true, renderCharacters: false, maxColumn: 80, side: "right" },
      smoothScrolling: true,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      scrollBeyondLastLine: false,
      padding: { top: 14, bottom: 14 },
      bracketPairColorization: { enabled: true },
      stickyScroll: { enabled: true },
      renderLineHighlight: "all",
      renderLineHighlightOnlyWhenFocus: false,
      roundedSelection: true,
      guides: { indentation: true, bracketPairs: false },
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      tabSize: 2,
      inlineSuggest: { enabled: true },
      quickSuggestions: { other: true, comments: false, strings: true },
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnEnter: "on",
      tabCompletion: "on",
      snippetSuggestions: "top",
      wordBasedSuggestions: "matchingDocuments",
      formatOnPaste: true,
      formatOnType: true,
      autoClosingBrackets: "always",
      autoClosingQuotes: "always",
      autoIndent: "full",
      readOnly: Boolean(props.readOnly),
    })
    // The user took the editor: land the rest of a replay at once.
    editor.onDidFocusEditorText(() => animation?.finish())
    editor.onDidChangeModelContent(() => {
      const uri = editor?.getModel()?.uri.toString()
      if (uri) completionRequests.get(uri)?.abort()
      if (applyingExternal) return
      props.onChange(editor!.getValue())
      scheduleDiagnostics()
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      props.onSave?.(editor!.getValue())
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
      const selection = editor?.getSelection()
      const model = editor?.getModel()
      if (!selection || !model) return
      props.onInlineEdit?.({
        startOffset: model.getOffsetAt(selection.getStartPosition()),
        endOffset: model.getOffsetAt(selection.getEndPosition()),
        startLine: selection.startLineNumber,
        endLine: selection.endLineNumber,
        text: model.getValueInRange(selection),
      })
    })
    syncCompletion()
    scheduleDiagnostics(0)
    onCleanup(() => {
      if (registeredUri) completionRequests.get(registeredUri)?.abort()
      if (registeredUri) completionRegistry.delete(registeredUri)
      if (registeredUri) languageServiceRegistry.delete(registeredUri)
      if (diagnosticsTimer) clearTimeout(diagnosticsTimer)
      if (cursorTimer) clearTimeout(cursorTimer)
      // Models outlive the editor, so never leave one half-typed.
      animation?.finish()
      editor?.dispose()
    })
  })

  // Sync an external value in without setValue: setValue discards decorations
  // and the undo stack, so per-agent attribution would vanish on the very
  // update that produced it.
  const applyExternal = (model: monaco.editor.ITextModel, value: string) => {
    if (!editor || model.getValue() === value) return
    applyingExternal = true
    model.pushEditOperations(
      editor.getSelections(),
      [{ range: model.getFullModelRange(), text: value, forceMoveMarkers: true }],
      () => null,
    )
    applyingExternal = false
  }

  // Replays an agent's landed edit as typing. The replaced span goes at once,
  // then the new text arrives over at most TYPING_MAX_STEPS frames with the
  // agent's caret at its end. The model's own text is the "before", so nothing
  // else needs plumbing. Every step is an external edit (no drafts, no
  // language-server churn), and the whole replay is one undo step.
  const playTyping = (model: monaco.editor.ITextModel, after: string, typing: MonacoTyping) => {
    if (!editor) return false
    const plan = typingPlan(model.getValue(), after)
    const steps = plan ? typingSteps(plan.insert) : []
    if (!plan || !steps.length) return false
    const selections = editor.getSelections()
    const at = (offset: number) => model.getPositionAt(offset)
    const edit = (range: monaco.IRange, text: string) => {
      applyingExternal = true
      model.pushEditOperations(selections, [{ range, text, forceMoveMarkers: true }], () => null)
      applyingExternal = false
    }
    const agent = {
      agentId: typing.agentId ?? "agent",
      agentName: typing.agentName ?? "Agent",
      color: typing.color ?? "#9374ec",
    }
    let typed = 0
    let index = 0
    let frame = 0
    let last = 0
    const insert = (text: string) => {
      const position = at(plan.offset + typed)
      edit(monaco.Range.fromPositions(position, position), text)
      typed += text.length
    }
    const finish = () => {
      if (animation?.finish !== finish) return
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      // Land whatever is left in one edit, so the model always ends on the agent's text.
      if (typed < plan.insert.length) insert(plan.insert.slice(typed))
      model.pushStackElement()
      animation = undefined
      typingCaret = undefined
      if (editor?.getModel() === model) paintAttributions(model)
      paintCursors()
    }
    const tick = (time: number) => {
      frame = 0
      if (animation?.finish !== finish) return
      if (editor?.getModel() !== model) return finish()
      if (last && time - last < TYPING_FRAME_MS) {
        frame = requestAnimationFrame(tick)
        return
      }
      last = time
      insert(steps[index]!)
      index += 1
      const end = at(plan.offset + typed)
      typingCaret = { ...agent, line: end.lineNumber }
      paintCursors()
      editor.revealLineInCenterIfOutsideViewport(end.lineNumber, monaco.editor.ScrollType.Smooth)
      if (index >= steps.length) return finish()
      frame = requestAnimationFrame(tick)
    }
    model.pushStackElement()
    if (plan.deleteLength) edit(monaco.Range.fromPositions(at(plan.offset), at(plan.offset + plan.deleteLength)), "")
    animation = { model, target: after, token: typing.token, finish }
    typingCaret = { ...agent, line: at(plan.offset).lineNumber }
    paintCursors()
    editor.revealLineInCenterIfOutsideViewport(typingCaret.line, monaco.editor.ScrollType.Smooth)
    frame = requestAnimationFrame(tick)
    return true
  }

  // Keep the completion route pointed at the current model / callback.
  createEffect(() => {
    props.inlineComplete
    props.languageService
    syncCompletion()
    scheduleDiagnostics(0)
  })

  // Honor the app's editor settings live.
  createEffect(() => {
    editor?.updateOptions({
      wordWrap: editorSettings.wordWrap() ? "on" : "off",
      lineNumbers: editorSettings.showLineNumbers() ? "on" : "off",
      renderLineHighlight: editorSettings.highlightActiveLine() ? "all" : "none",
      renderWhitespace: editorSettings.renderWhitespace() ? "all" : "selection",
      readOnly: Boolean(props.readOnly),
    })
  })

  createEffect(() => {
    const path = props.path
    const value = props.value
    const typing = props.typing
    if (!editor) return
    const current = editor.getModel()
    const nextUri = monaco.Uri.file(path || "untitled.txt")
    if (current?.uri.toString() !== nextUri.toString()) {
      animation?.finish()
      applyingExternal = true
      editor.setModel(modelFor(path, value))
      applyingExternal = false
      syncCompletion()
      scheduleDiagnostics(0)
      return
    }
    if (!current) return
    if (animation) {
      // Still typing towards this text: the replay paints when it ends. A newer
      // value or a newer agent edit lands the rest at once instead.
      if (animation.model === current && animation.target === value && (!typing || typing.token === animation.token))
        return
      animation.finish()
    }
    // Sync the agent's text in BEFORE painting: applyExternal replaces the whole
    // model range, which drags every decoration inside it to the end of the
    // edit. Painting first would collapse the stripes onto one line.
    if (!editor.hasTextFocus()) {
      const replay =
        typing !== undefined &&
        typing.token !== consumedTyping &&
        Date.now() - typing.token < TYPING_ARM_MS &&
        current.getValue() !== value &&
        !prefersReducedMotion()
      if (replay) {
        consumedTyping = typing.token
        if (playTyping(current, value, typing)) return
      }
      applyExternal(current, value)
    }
    paintAttributions(current)
  })

  // Paint one gutter stripe and line highlight per agent that recently edited
  // this file, so several agents working at once are visually distinguishable.
  const paintAttributions = (current: monaco.editor.ITextModel) => {
    if (!editor) return
    const attributions = activeAttributions(props.attributions ?? [], Date.now())
    {
      attributionStyles(attributions)
      attributionCollection ??= editor.createDecorationsCollection()
      attributionCollection.set(
        attributions.flatMap((entry) =>
          entry.ranges
            .filter((range) => range.start >= 1 && range.end >= range.start)
            .map((range) => ({
              range: new monaco.Range(range.start, 1, Math.min(range.end, current.getLineCount()), 1),
              options: {
                isWholeLine: true,
                className: `vector-agent-line vector-agent-${colorClass(entry.color)}`,
                linesDecorationsClassName: `vector-agent-gutter vector-agent-${colorClass(entry.color)}`,
                hoverMessage: { value: `Edited by ${entry.agentName}` },
                overviewRuler: { color: entry.color, position: monaco.editor.OverviewRulerLane.Left },
              },
            })),
        ),
      )
    }
  }

  // Follow-the-agent reveal. Keyed on the token so a repeat edit to the same
  // lines still scrolls. The user opted into following, so this reveals even
  // while the editor has focus, and first syncs the agent's text in (the
  // focus guard above would otherwise leave the buffer stale).
  createEffect(() => {
    const reveal = props.reveal
    if (!reveal || !editor || reveal.token === revealedToken) return
    // The token is the edit's timestamp. On a remount revealedToken starts
    // empty again, so without this an edit from minutes ago would scroll the
    // editor the moment the user reopens that tab.
    if (Date.now() - reveal.token >= ATTRIBUTION_TTL_MS) return
    const model = editor.getModel()
    if (!model || model.uri.toString() !== monaco.Uri.file(props.path || "untitled.txt").toString()) return
    revealedToken = reveal.token
    // A replay in progress scrolls with its own caret and paints when it ends.
    if (animation?.model === model) return
    // Untracked: a reveal is a one-shot on its token, not a reaction to typing.
    applyExternal(
      model,
      untrack(() => props.value),
    )
    // That replace moved the decorations painted above, so put them back.
    paintAttributions(model)
    const total = model.getLineCount()
    const line = Math.min(Math.max(1, reveal.line), total)
    const endLine = Math.min(Math.max(line, reveal.endLine ?? line), total)
    editor.revealRangeInCenterIfOutsideViewport(new monaco.Range(line, 1, endLine, 1), monaco.editor.ScrollType.Smooth)
  })

  const cursorList = (): MonacoAgentCursor[] => {
    if (props.cursors) return props.cursors
    return props.cursor ? [{ ...props.cursor, token: props.cursor.token ?? props.reveal?.token }] : []
  }

  // The agents' cursors: a tinted line plus a caret-and-name label injected
  // after the text, one per agent, so subagents, parallel agents and external
  // agents stay distinguishable on one file. A landed cursor fades on the same
  // clock as the line attributions; a running or waiting one stays until its
  // call resolves. During a replay the typing agent's caret follows the text.
  const paintCursors = () => {
    if (!editor) return
    if (cursorTimer) clearTimeout(cursorTimer)
    cursorTimer = undefined
    cursorCollection ??= editor.createDecorationsCollection()
    const model = editor.getModel()
    if (!model || model.uri.toString() !== monaco.Uri.file(untrack(() => props.path) || "untitled.txt").toString()) {
      cursorCollection.clear()
      return
    }
    const now = Date.now()
    let expires = Infinity
    const list = untrack(cursorList).filter((cursor) => {
      if (cursor.state === "editing" || cursor.state === "waiting" || cursor.token === undefined) return true
      const remaining = ATTRIBUTION_TTL_MS - (now - cursor.token)
      if (remaining <= 0) return false
      expires = Math.min(expires, remaining)
      return true
    })
    const caret = typingCaret
    const shown: MonacoAgentCursor[] =
      caret && !list.some((cursor) => cursor.agentId === caret.agentId)
        ? [...list, { agentId: caret.agentId, agentName: caret.agentName, color: caret.color, line: caret.line }]
        : list
    cursorStyles(shown)
    const total = model.getLineCount()
    const clamp = (line: number) => Math.min(Math.max(1, line), total)
    cursorCollection.set(
      shown.flatMap((cursor) => {
        const id = colorClass(cursor.color)
        const typingHere = caret !== undefined && caret.agentId === cursor.agentId
        const line = clamp(typingHere && caret ? caret.line : cursor.line)
        const column = model.getLineMaxColumn(line)
        const waiting = cursor.state === "waiting" && !typingHere
        const label = waiting
          ? `${cursor.agentName} · waiting for approval`
          : typingHere || cursor.state === "editing"
            ? `${cursor.agentName} · editing`
            : cursor.agentName
        const decorations: monaco.editor.IModelDeltaDecoration[] = [
          {
            range: new monaco.Range(line, column, line, column),
            options: {
              isWholeLine: true,
              className: `vector-agent-cursor-line vector-agent-cursor-${id}`,
              after: {
                content: label,
                inlineClassName: `vector-agent-cursor-label vector-agent-cursor-${id}${waiting ? " vector-agent-cursor-waiting" : ""}`,
              },
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          },
        ]
        const pending = cursor.pending
        if (pending && !typingHere && (cursor.state === "editing" || cursor.state === "waiting")) {
          const start = clamp(pending.start)
          decorations.push({
            range: new monaco.Range(start, 1, clamp(Math.max(start, pending.end)), 1),
            options: {
              isWholeLine: true,
              className: `vector-agent-pending vector-agent-pending-${id}`,
              linesDecorationsClassName: `vector-agent-pending-gutter vector-agent-pending-${id}`,
              hoverMessage: {
                value: waiting
                  ? `${cursor.agentName} is waiting for approval to change these lines`
                  : `${cursor.agentName} is about to change these lines`,
              },
              overviewRuler: { color: cursor.color, position: monaco.editor.OverviewRulerLane.Left },
            },
          })
        }
        return decorations
      }),
    )
    if (expires < Infinity) cursorTimer = setTimeout(paintCursors, expires)
  }

  createEffect(() => {
    cursorList()
    props.path
    paintCursors()
  })

  return <div ref={host} class="vector-neon-editor relative h-full min-h-0 w-full overflow-hidden" />
}
