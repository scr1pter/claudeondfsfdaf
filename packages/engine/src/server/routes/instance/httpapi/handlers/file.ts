import * as InstanceState from "@/effect/instance-state"
import { FileSystem } from "@vectordevai/core/filesystem"
import { LocationServiceMap, locationServiceMapLayer } from "@vectordevai/core/location-services"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Location } from "@vectordevai/core/location"
import { AbsolutePath, RelativePath } from "@vectordevai/core/schema"
import { Effect, Layer, Option } from "effect"
import ignore from "ignore"
import path from "path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError } from "../errors"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { SessionAudienceHttp } from "@vectordevai/server/session-audience"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { Git } from "@/git"
import { PrivateAccess } from "@/tool/private-access"
import { ForbiddenError } from "@vectordevai/protocol/errors"

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    const locations = yield* LocationServiceMap.Service
    const git = yield* Git.Service
    const audience = yield* SessionAudience.Service
    const read = Effect.fn("FileHttpApi.privateRead")(function* (file: string, ancestors = false) {
      const access = PrivateAccess.make({
        guest: !(yield* RequestOwner.owner),
        audience,
        git,
        instance: yield* InstanceState.context,
      })
      yield* access
        .read([file], { ancestors })
        .pipe(
          Effect.mapError(
            () => new ForbiddenError({ message: "This filesystem selection could expose private task data." }),
          ),
        )
    })

    const filesystem = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
      )
    })

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      yield* read(".", true)
      return (yield* ripgrep
        .grep({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(
          Effect.orDie,
          Effect.tap(() => read(".", true)),
        )).map((match) => ({
        path: { text: match.entry.path },
        lines: { text: match.text },
        line_number: match.line,
        absolute_offset: match.offset,
        submatches: match.submatches.map((submatch) => ({
          match: { text: submatch.text },
          start: submatch.start,
          end: submatch.end,
        })),
      }))
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      const directory = (yield* InstanceState.context).directory
      yield* read(".", true)
      const limit = ctx.query.limit ?? 10
      const type = ctx.query.type ?? (ctx.query.dirs === "false" ? "file" : undefined)
      const started = performance.now()
      const found = yield* filesystem(FileSystem.Service.use((fs) => fs.find({ query: ctx.query.query, limit, type })))
      yield* read(".", true)
      yield* Effect.logInfo("find file", {
        query: ctx.query.query,
        type,
        directory,
        limit,
        results: found.length,
        duration: Math.round(performance.now() - started),
      })
      return found.map((item) => item.path)
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      yield* read(ctx.query.path, true)
      return yield* filesystem(
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const raw = yield* FSUtil.Service
          const location = yield* Location.Service
          const ignored = ignore()
          const gitignore = yield* raw
            .readFileString(path.join(location.project.directory, ".gitignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (gitignore) ignored.add(gitignore)
          const ignorefile = yield* raw
            .readFileString(path.join(location.project.directory, ".ignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (ignorefile) ignored.add(ignorefile)
          return (yield* fs.list({ path: RelativePath.make(ctx.query.path) })).map((item) => ({
            name: path.basename(item.path),
            path: item.path,
            absolute: path.resolve(location.directory, item.path),
            type: item.type,
            ignored: ignored.ignores(
              path.relative(location.project.directory, path.resolve(location.directory, item.path)) +
                (item.type === "directory" ? "/" : ""),
            ),
          }))
        }),
      ).pipe(Effect.tap(() => read(ctx.query.path, true)))
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      const file = path.resolve(directory, ctx.query.path)
      yield* read(file)
      if (!FSUtil.contains(directory, file)) return yield* Effect.die(new Error("Path escapes the location"))
      if (!(yield* FSUtil.Service.use((fs) => fs.existsSafe(file)))) return { type: "text" as const, content: "" }
      return yield* filesystem(
        FileSystem.Service.use((fs) => fs.read({ path: RelativePath.make(ctx.query.path) })),
      ).pipe(
        Effect.flatMap((item) =>
          Effect.gen(function* () {
            const text = item.content.includes(0)
              ? Option.none<string>()
              : yield* Effect.sync(() => new TextDecoder("utf-8", { fatal: true }).decode(item.content)).pipe(
                  Effect.option,
                )
            return { item, text }
          }),
        ),
        Effect.map(({ item, text }) =>
          Option.isSome(text)
            ? { type: "text" as const, content: text.value }
            : {
                type: "binary" as const,
                content: Buffer.from(item.content).toString("base64"),
                encoding: "base64" as const,
                mimeType: item.mime,
              },
        ),
        Effect.tap(() => read(file)),
      )
    })

    const write = Effect.fn("FileHttpApi.write")(function* (ctx: { payload: { path: string; content: string } }) {
      const directory = (yield* InstanceState.context).directory
      const target = path.resolve(directory, ctx.payload.path)
      yield* read(target)
      const owner = yield* RequestOwner.owner
      yield* SessionAudienceHttp.assertDirectory(target, owner)
      // Decided on where the write really lands: a link inside the workspace passes a textual check while the
      // write goes through it to the rest of the disk.
      if (
        !FSUtil.contains(directory, target) ||
        !FSUtil.contains(FSUtil.realpath(directory), FSUtil.realpath(target))
      ) {
        return yield* new InvalidRequestError({ message: "Path escapes the workspace.", field: "path" })
      }
      // git runs the programs its own directory names (hooks, config) as the owner, so a guest writing there would be
      // running a command. Judged on both the requested and the real path, in every spelling a file system reads as .git.
      if (
        !owner &&
        [path.relative(directory, target), path.relative(FSUtil.realpath(directory), FSUtil.realpath(target))].some(
          (item) => item.split(/[\\/]/).some(gitDirectoryName),
        )
      ) {
        return yield* new InvalidRequestError({
          message: "Only the server owner can write git's files.",
          field: "path",
        })
      }
      const fs = yield* FSUtil.Service
      yield* fs
        .writeWithDirs(target, ctx.payload.content)
        .pipe(Effect.mapError((error) => new InvalidRequestError({ message: `${error}`, field: "path" })))
      return {
        path: ctx.payload.path,
        bytes: Buffer.byteLength(ctx.payload.content, "utf8"),
      }
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return []
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("write", write)
      .handle("status", status)
  }),
).pipe(Layer.provide(locationServiceMapLayer))

// Every spelling a file system may open as .git, after git's own checkout guards (is_ntfs_dotgit, is_hfs_dotgit): any
// case, the trailing dots and spaces Windows drops, an NTFS stream suffix (`.git::$INDEX_ALLOCATION`), the 8.3 short
// name (`GIT~1`) and the invisible characters HFS+ ignores. realpath keeps a missing target's spelling, so the name
// itself is judged, on every system: a guest has no use for these names anywhere.
function gitDirectoryName(segment: string) {
  const name = segment
    .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "")
    .split(":")[0]
    .replace(/[. ]+$/, "")
    .toUpperCase()
  return name === ".GIT" || /^GIT~\d+$/.test(name)
}
