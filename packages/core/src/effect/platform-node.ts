// The "@effect/platform-node" index re-exports every module in the package, Redis (ioredis), cluster, worker and
// socket server support among them, so importing it loads all of them into every process. These are the modules
// Vector uses, each loaded from its own file.
export * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
export * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
export * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
export * as NodePath from "@effect/platform-node/NodePath"
export * as NodeSink from "@effect/platform-node/NodeSink"
export * as NodeStream from "@effect/platform-node/NodeStream"
