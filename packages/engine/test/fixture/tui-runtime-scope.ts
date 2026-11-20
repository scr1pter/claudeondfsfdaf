// Imported only after the TUI runtime plugin registers. That plugin rewrites import specifiers in a
// file's raw text, so this module holds the two text shapes that broke hub.test.ts on Linux shard 2/4:
// a runtime specifier (which made a file a "resolve parent") and a regex literal containing `from "ai"`.
export const marker = 'from "@opentui/keymap/solid"'
export const pattern = /from "ai"|from "@ai-sdk\/provider"/
