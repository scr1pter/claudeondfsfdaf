import path from "path"
import { Effect, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse, type Multipart } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainEmbed } from "@vectordevai/core/brain/embed"
import { BrainErase } from "@vectordevai/core/brain/erase"
import { BrainExport } from "@vectordevai/core/brain/export"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import type { BrainSchema } from "@vectordevai/core/brain/schema"
import { Flag } from "@vectordevai/core/flag/flag"
import { ResearchStore } from "@vectordevai/core/research/store"
import { ResearchExport } from "@vectordevai/core/research/export"
import { Git } from "@/git"
import { Instruction } from "@/session/instruction"
import { SessionDistill } from "@/session/distill"
import { SessionPosting } from "@/session/posting"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { InstanceHttpApi } from "../api"
import {
  IMPORT_CHARS,
  MemoryApiError,
  MemoryTooLargeError,
  POSTING_CHARS,
  TEXT_BYTES,
  UPLOAD_BYTES,
} from "../groups/memory"

const refused = (message: string, reason?: string, document?: BrainSchema.Document) =>
  new MemoryApiError({
    name: "MemoryError",
    data: { code: "refused", message, ...(reason ? { reason } : {}), ...(document ? { document } : {}) },
  })
const missing = (id: string, message = `No memory ${id} here.`) =>
  new MemoryApiError({ name: "MemoryError", data: { code: "not-found", message } })
const tooLarge = (message: string) => new MemoryTooLargeError({ name: "MemoryTooLargeError", data: { message } })

type Form = {
  readonly fields: ReadonlyMap<string, string>
  readonly files: readonly { readonly name: string; readonly mime: string; readonly bytes: Uint8Array }[]
}

// A limit the form parser reached. A file's own content stream reports it as an internal error whose cause is the
// parser's ReachedLimit, so both shapes count.
function overLimit(error: Multipart.MultipartError) {
  const cause = error.reason.cause
  return (
    error.reason._tag === "FileTooLarge" ||
    error.reason._tag === "BodyTooLarge" ||
    (typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "ReachedLimit")
  )
}

/** A file over 1 MB, or a PDF over 20 pages, costs less remembered than sent with a message. */
const REMEMBER_INSTEAD = { bytes: 1024 * 1024, pages: 20 }

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const brain = yield* Brain.Service
    const instruction = yield* Instruction.Service
    const knowledge = yield* BrainKnowledge.Service
    const embed = yield* BrainEmbed.Service
    const distiller = yield* SessionDistill.Service
    const research = yield* ResearchStore.Service
    const sessions = yield* Session.Service
    const git = yield* Git.Service

    const list = Effect.fn("MemoryHttpApi.list")(function* (ctx: {
      query: { scope?: "repository" | "personal"; filter?: Brain.Filter; query?: string }
    }) {
      const place = yield* instruction.place()
      const entries = yield* brain.list(place, {
        ...(ctx.query.filter ? { filter: ctx.query.filter } : {}),
        ...(ctx.query.query ? { query: ctx.query.query } : {}),
        ...(ctx.query.scope ? { scope: ctx.query.scope } : {}),
      })
      return {
        entries,
        stats: yield* brain.stats(place),
        files: { ...brain.files(), repository: place.sources.map((source) => source.path) },
        held: place.held,
      }
    })

    const get = Effect.fn("MemoryHttpApi.get")(function* (ctx: { params: { memoryID: string } }) {
      const detail = yield* brain.get(yield* instruction.place(), ctx.params.memoryID, { personal: true })
      if (!detail) return yield* missing(ctx.params.memoryID)
      return detail
    })

    const create = Effect.fn("MemoryHttpApi.create")(function* (ctx: {
      payload: { kind: BrainSchema.LearnedKind; text: string; scope: "repository" | "personal" }
    }) {
      const result = yield* brain.propose(yield* instruction.place(), {
        kind: ctx.payload.kind,
        text: ctx.payload.text,
        scope: ctx.payload.scope,
        origin: "user",
        evidence: { type: "user" },
      })
      if (result.type === "refused") return yield* refused(result.message)
      return result.entry
    })

    const update = Effect.fn("MemoryHttpApi.update")(function* (ctx: {
      params: { memoryID: string }
      payload: Brain.Change
    }) {
      const result = yield* brain.update(yield* instruction.place(), ctx.params.memoryID, ctx.payload, "user")
      if (!result) return yield* missing(ctx.params.memoryID)
      if (result.type === "refused") return yield* refused(result.message)
      return result.entry
    })

    const remove = Effect.fn("MemoryHttpApi.remove")(function* (ctx: { params: { memoryID: string } }) {
      const result = yield* brain.forget(yield* instruction.place(), ctx.params.memoryID)
      if (result === "not-found") return yield* missing(ctx.params.memoryID)
      if (result === "file-entry")
        return yield* refused("This entry comes from a file you wrote; change it in that file.")
      return true
    })

    // Research goes with the memory erased (BrainErase): a repository's runs, every run, or the runs a session started.
    // The answer stays the count of entries.
    const erase = Effect.fn("MemoryHttpApi.erase")(function* (ctx: {
      payload: { scope: "repository" | "personal" | "all" }
    }) {
      const place = yield* instruction.place()
      return (yield* BrainErase.erase({ brain, research, place, scope: ctx.payload.scope })).entries
    })

    const eraseSession = Effect.fn("MemoryHttpApi.eraseSession")(function* (ctx: { params: { sessionID: string } }) {
      const place = yield* instruction.place()
      return (yield* BrainErase.session({ brain, research, place, sessionID: ctx.params.sessionID })).entries
    })

    // An attachment, never something a browser renders.
    const exportMemory = Effect.fn("MemoryHttpApi.export")(function* (ctx: {
      query: { scope?: BrainExport.Scope; format?: BrainExport.Format }
    }) {
      const place = yield* instruction.place()
      const format = ctx.query.format ?? "markdown"
      const body = yield* BrainExport.render({ brain, knowledge, place, scope: ctx.query.scope ?? "all", format })
      return HttpServerResponse.text(body, {
        contentType: `${format === "json" ? "application/json" : "text/markdown"}; charset=utf-8`,
        headers: {
          "content-disposition": `attachment; filename="vector-memory.${format === "json" ? "json" : "md"}"`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
          "cache-control": "no-store",
        },
      })
    })

    const importMemory = Effect.fn("MemoryHttpApi.import")(function* (ctx: { payload: { text: string } }) {
      if (ctx.payload.text.length > IMPORT_CHARS)
        return yield* refused("Vector imports at most 2 MB at a time.", "limit")
      return yield* BrainExport.importText({ brain, place: yield* instruction.place(), text: ctx.payload.text })
    })

    const tidy = Effect.fn("MemoryHttpApi.tidy")(function* () {
      const report = yield* brain.consolidate(yield* instruction.place(), { force: true })
      return {
        merged: report.merged,
        promoted: report.promoted,
        archived: report.archived,
        dropped: report.dropped,
        stale: report.stale,
      }
    })

    const settingsOf = Effect.fnUntraced(function* (place: Brain.Place) {
      const learn = yield* brain.learnSettings()
      return { ...learn, ...(yield* knowledge.settings(place)) }
    })

    const settings = Effect.fn("MemoryHttpApi.settings")(function* () {
      return yield* settingsOf(yield* instruction.place())
    })

    const configure = Effect.fn("MemoryHttpApi.configure")(function* (ctx: {
      payload: {
        learning?: boolean
        repositoryDocs?: boolean
        keepOriginals?: boolean
        facets?: Partial<Record<BrainSchema.Facet, boolean>>
        modelLearner?: Brain.ModelLearner
      }
    }) {
      const place = yield* instruction.place()
      if (ctx.payload.learning !== undefined || ctx.payload.facets || ctx.payload.modelLearner)
        yield* brain.setLearnSettings({
          ...(ctx.payload.learning === undefined ? {} : { learning: ctx.payload.learning }),
          ...(ctx.payload.facets ? { facets: ctx.payload.facets } : {}),
          ...(ctx.payload.modelLearner ? { modelLearner: ctx.payload.modelLearner } : {}),
        })
      if (ctx.payload.repositoryDocs !== undefined || ctx.payload.keepOriginals !== undefined)
        yield* knowledge.configure(place, {
          ...(ctx.payload.repositoryDocs === undefined ? {} : { repositoryDocs: ctx.payload.repositoryDocs }),
          ...(ctx.payload.keepOriginals === undefined ? {} : { keepOriginals: ctx.payload.keepOriginals }),
        })
      return yield* settingsOf(place)
    })

    // --- Documents ------------------------------------------------------------------------------------------------

    const documents = Effect.fn("MemoryHttpApi.documents")(function* () {
      const place = yield* instruction.place()
      const worker = yield* knowledge.worker()
      return {
        documents: yield* knowledge.documents(place, { personal: true }),
        model: yield* knowledge.model(place),
        settings: yield* settingsOf(place),
        limits: {
          upload: UPLOAD_BYTES,
          text: TEXT_BYTES,
          documents: BrainKnowledge.LIMIT.documents,
          repository: BrainKnowledge.LIMIT.repository,
          perMinute: BrainKnowledge.LIMIT.perMinute,
        },
        indexing: yield* knowledge.indexing(place),
        worker: { mode: worker.mode, ...(worker.reason ? { reason: worker.reason } : {}), threads: worker.threads },
      }
    })

    // --- Search model -------------------------------------------------------------------------------------------

    const model = Effect.fn("MemoryHttpApi.model")(function* () {
      return yield* knowledge.model(yield* instruction.place())
    })

    // A download runs in the background and the app polls; the rest finish before they answer.
    const changeModel = Effect.fn("MemoryHttpApi.changeModel")(function* (ctx: {
      payload: {
        action: "download" | "remove" | "install" | "pause" | "resume"
        model?: "arctic-embed-xs-q8" | "granite-small-r2-q8"
        variant?: BrainSchema.ModelVariant
        from?: string
      }
    }) {
      const place = yield* instruction.place()
      const choice = {
        ...(ctx.payload.model ? { model: ctx.payload.model } : {}),
        ...(ctx.payload.variant ? { variant: ctx.payload.variant } : {}),
      }
      if (ctx.payload.action === "download") {
        const status = yield* embed.status()
        if (status.downloads === false)
          return yield* refused("Downloads are turned off here. Install the model from a folder instead.", "off")
        yield* embed.start(choice)
      }
      if (ctx.payload.action === "install") {
        const from = ctx.payload.from?.trim()
        if (!from) return yield* refused("Name the folder that holds the model's files.", "missing")
        yield* embed
          .install(path.resolve(from), choice)
          .pipe(Effect.catch((error) => Effect.fail(refused(error.message, error.reason))))
      }
      if (ctx.payload.action === "remove") yield* knowledge.removeModel()
      if (ctx.payload.action === "pause" || ctx.payload.action === "resume")
        yield* embed.pause(ctx.payload.action === "pause")
      return yield* knowledge.model(place)
    })

    // What an add came to, as the routes answer it. A title the user gave goes in with a new document, and renames
    // one these bytes already are.
    const added = Effect.fnUntraced(function* (place: Brain.Place, result: BrainKnowledge.AddResult, title?: string) {
      if (result.type === "refused") return yield* refused(result.message, result.reason, result.document)
      const named = result.type === "unchanged" ? title?.trim() : undefined
      if (named) yield* knowledge.update(place, result.document.id, { title: named })
      const document = named
        ? ((yield* knowledge.document(place, result.document.id, { personal: true }))?.document ?? result.document)
        : result.document
      return { type: result.type, document, ...(result.previous ? { previous: result.previous } : {}) }
    })

    // One file in multipart form data, held in memory and never written to disk: the stream stops at 64 MB.
    const upload = Effect.fn("MemoryHttpApi.upload")(function* (ctx: {
      payload: Stream.Stream<Multipart.Part, Multipart.MultipartError>
    }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const length = Number(request.headers["content-length"])
      if (Number.isFinite(length) && length > UPLOAD_BYTES + 1024 * 1024)
        return yield* tooLarge("This file is over 64 MB, the most Vector reads.")
      const form = yield* Stream.runFoldEffect(
        ctx.payload,
        (): Form => ({ fields: new Map(), files: [] }),
        (form: Form, part: Multipart.Part): Effect.Effect<Form, Multipart.MultipartError> =>
          part._tag === "Field"
            ? Effect.succeed({ ...form, fields: new Map([...form.fields, [part.key, part.value]]) })
            : part.contentEffect.pipe(
                Effect.map((bytes) => ({
                  ...form,
                  files: [...form.files, { name: part.name, mime: part.contentType, bytes }],
                })),
              ),
      ).pipe(
        Effect.mapError((error) =>
          overLimit(error)
            ? tooLarge("This file is over 64 MB, the most Vector reads.")
            : refused("Vector could not read this upload. Send one file as multipart form data.", "invalid"),
        ),
      )
      const file = form.files[0]
      if (form.files.length !== 1 || !file) return yield* refused("Send one file, in the field named file.", "invalid")
      if (file.bytes.length > UPLOAD_BYTES) return yield* tooLarge("This file is over 64 MB, the most Vector reads.")
      const origin = form.fields.get("origin") === "chat" ? ("chat" as const) : ("upload" as const)
      const sessionID = form.fields.get("sessionID")
      const place = yield* instruction.place()
      const result = yield* knowledge.add(place, {
        type: "bytes",
        name: file.name,
        bytes: file.bytes,
        ...(file.mime ? { mime: file.mime } : {}),
        origin,
        ...(sessionID ? { sessionID } : {}),
        ...(form.fields.get("title")?.trim() ? { title: form.fields.get("title")! } : {}),
        replace: form.fields.get("replace") === "true",
      })
      return yield* added(place, result, form.fields.get("title"))
    })

    // A file on this computer, by path: the owner chose it (an absolute path) or it is the repository's own (a path
    // relative to it, which must stay inside it). Either way a regular file, never a link.
    const addPath = Effect.fn("MemoryHttpApi.addPath")(function* (ctx: {
      payload: { path: string; origin?: "upload" | "chat"; sessionID?: string; title?: string; replace?: boolean }
    }) {
      const place = yield* instruction.place()
      const result = yield* knowledge.add(place, {
        type: "path",
        path: ctx.payload.path,
        origin: ctx.payload.origin ?? "upload",
        attached: path.isAbsolute(ctx.payload.path),
        links: false,
        replace: ctx.payload.replace ?? false,
        ...(ctx.payload.sessionID ? { sessionID: ctx.payload.sessionID } : {}),
        ...(ctx.payload.title?.trim() ? { title: ctx.payload.title } : {}),
      })
      return yield* added(place, result, ctx.payload.title)
    })

    const addText = Effect.fn("MemoryHttpApi.addText")(function* (ctx: {
      payload: { name: string; text: string; sessionID?: string; replace?: boolean }
    }) {
      if (new TextEncoder().encode(ctx.payload.text).length > TEXT_BYTES)
        return yield* tooLarge("Pasted text can be at most 2 MB. Save it as a file and add the file.")
      if (!ctx.payload.name.trim()) return yield* refused("Give the text a name.", "invalid")
      const place = yield* instruction.place()
      const result = yield* knowledge.add(place, {
        type: "text",
        name: ctx.payload.name.trim(),
        text: ctx.payload.text,
        origin: "upload",
        replace: ctx.payload.replace ?? false,
        ...(ctx.payload.sessionID ? { sessionID: ctx.payload.sessionID } : {}),
      })
      return yield* added(place, result)
    })

    const probe = Effect.fn("MemoryHttpApi.probe")(function* (ctx: { payload: { path: string } }) {
      const place = yield* instruction.place()
      const file = yield* Effect.promise(() =>
        BrainKnowledge.read(place, {
          type: "path",
          path: ctx.payload.path,
          origin: "upload",
          attached: path.isAbsolute(ctx.payload.path),
          links: false,
        }),
      )
      if (file.type === "refused") return yield* refused(file.message, file.reason)
      const probed = yield* knowledge
        .probe({ name: file.name, bytes: file.bytes })
        .pipe(
          Effect.catch((error) => Effect.fail(refused(`Vector could not read this file: ${error.message}`, "invalid"))),
        )
      if ("type" in probed) return yield* refused(probed.message, probed.reason)
      const large =
        file.bytes.length > REMEMBER_INSTEAD.bytes ||
        (probed.format === "pdf" && (probed.pages ?? 0) > REMEMBER_INSTEAD.pages)
      return {
        format: probed.format,
        ...(probed.pages === undefined ? {} : { pages: probed.pages }),
        tokens: probed.tokens,
        suggest: large ? ("remember-instead" as const) : ("none" as const),
      }
    })

    const document = Effect.fn("MemoryHttpApi.document")(function* (ctx: { params: { documentID: string } }) {
      const detail = yield* knowledge.document(yield* instruction.place(), ctx.params.documentID, { personal: true })
      if (!detail) return yield* missing(ctx.params.documentID, `No document ${ctx.params.documentID} here.`)
      return {
        document: detail.document,
        outline: detail.sections,
        counts: detail.counts,
        records: detail.records,
        anchors: detail.anchors,
        held: detail.held,
        warnings: detail.document.warnings,
        versions: detail.versions,
        ...(detail.diff ? { diff: detail.diff } : {}),
        history: detail.history,
        usage: detail.usage,
        distill: Flag.VECTOR_KNOWLEDGE_DISTILL,
      }
    })

    const updateDocument = Effect.fn("MemoryHttpApi.updateDocument")(function* (ctx: {
      params: { documentID: string }
      payload: {
        title?: string
        visibility?: BrainSchema.Visibility
        action?: "approve" | "reject" | "reindex" | "pause" | "resume" | "keep-suggestions"
      }
    }) {
      const place = yield* instruction.place()
      const id = ctx.params.documentID
      const before = yield* knowledge.document(place, id, { personal: true })
      if (!before) return yield* missing(id, `No document ${id} here.`)
      const action = ctx.payload.action === "reindex" ? undefined : ctx.payload.action
      if (action || ctx.payload.title?.trim() || ctx.payload.visibility)
        yield* knowledge.update(place, id, {
          ...(action ? { action } : {}),
          ...(ctx.payload.title?.trim() ? { title: ctx.payload.title.trim() } : {}),
          ...(ctx.payload.visibility ? { visibility: ctx.payload.visibility } : {}),
        })
      if (ctx.payload.action === "reindex" && (yield* knowledge.reindex(place, id)) === 0)
        return yield* refused(
          "Vector cannot read this document again now: it is being read, or its file changed or is gone and no copy was kept.",
          "not-found",
        )
      return (yield* knowledge.document(place, id, { personal: true }))?.document ?? before.document
    })

    const removeDocument = Effect.fn("MemoryHttpApi.removeDocument")(function* (ctx: {
      params: { documentID: string }
    }) {
      const result = yield* knowledge.remove(yield* instruction.place(), ctx.params.documentID)
      if (result === "not-found")
        return yield* missing(ctx.params.documentID, `No document ${ctx.params.documentID} here.`)
      return true
    })

    const documentPage = Effect.fn("MemoryHttpApi.documentPage")(function* (ctx: {
      params: { documentID: string; page: string }
    }) {
      const number = /^\d{1,6}$/.test(ctx.params.page) ? Number(ctx.params.page) : Number.NaN
      const page = Number.isNaN(number)
        ? undefined
        : yield* knowledge.page(yield* instruction.place(), ctx.params.documentID, number, { personal: true })
      if (!page)
        return yield* missing(ctx.params.documentID, `No page ${ctx.params.page} in document ${ctx.params.documentID}.`)
      return page
    })

    // The original as a download only, never something a browser renders: a PDF or HTML file from anywhere could
    // carry script.
    const documentFile = Effect.fn("MemoryHttpApi.documentFile")(function* (ctx: { params: { documentID: string } }) {
      const original = yield* knowledge.original(yield* instruction.place(), ctx.params.documentID)
      if (!original)
        return yield* missing(
          ctx.params.documentID,
          `Vector keeps no copy of document ${ctx.params.documentID}'s file.`,
        )
      const ascii = original.name.replace(/[^A-Za-z0-9._ -]/g, "_")
      return HttpServerResponse.uint8Array(original.bytes, {
        contentType: "application/octet-stream",
        headers: {
          "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(original.name)}`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
          "cache-control": "no-store",
        },
      })
    })

    // What a model would read of a document for suggestions, and what that may cost; nothing is sent.
    const distillEstimate = Effect.fn("MemoryHttpApi.distillEstimate")(function* (ctx: {
      params: { documentID: string }
      query: { model?: string; maxTokens?: number }
    }) {
      return yield* distiller.estimate(yield* instruction.place(), {
        document: ctx.params.documentID,
        ...(ctx.query.model ? { model: ctx.query.model } : {}),
        ...(ctx.query.maxTokens ? { maxTokens: ctx.query.maxTokens } : {}),
      })
    })

    const distill = Effect.fn("MemoryHttpApi.distill")(function* (ctx: {
      params: { documentID: string }
      payload: { model?: string; maxTokens?: number; sessionID?: string }
    }) {
      const result = yield* distiller.run(yield* instruction.place(), {
        document: ctx.params.documentID,
        ...(ctx.payload.model ? { model: ctx.payload.model } : {}),
        ...(ctx.payload.maxTokens ? { maxTokens: ctx.payload.maxTokens } : {}),
        ...(ctx.payload.sessionID ? { sessionID: SessionID.make(ctx.payload.sessionID) } : {}),
      })
      if (result.type === "refused")
        return yield* result.reason === "not-found"
          ? missing(ctx.params.documentID, result.message)
          : refused(result.message, result.reason)
      return {
        model: result.model,
        sessionID: result.sessionID,
        records: result.records,
        duplicate: result.duplicate,
        dropped: result.dropped,
        tokens: result.tokens,
        cost: result.cost,
        costKind: result.costKind,
        ...(result.error ? { error: result.error } : {}),
      }
    })

    // --- Records --------------------------------------------------------------------------------------------------

    const records = Effect.fn("MemoryHttpApi.records")(function* (ctx: {
      query: {
        kind?: BrainSchema.RecordKind
        document?: string
        query?: string
        status?: "active" | "held" | "archived" | "all"
        cursor?: string
        limit?: number
      }
    }) {
      return yield* knowledge.records(yield* instruction.place(), {
        ...(ctx.query.kind ? { kind: ctx.query.kind } : {}),
        ...(ctx.query.document ? { document: ctx.query.document } : {}),
        ...(ctx.query.query ? { query: ctx.query.query } : {}),
        ...(ctx.query.status ? { status: ctx.query.status } : {}),
        ...(ctx.query.cursor ? { cursor: ctx.query.cursor } : {}),
        ...(ctx.query.limit ? { limit: ctx.query.limit } : {}),
        personal: true,
      })
    })

    const record = Effect.fn("MemoryHttpApi.record")(function* (ctx: { params: { recordID: string } }) {
      const detail = yield* knowledge.record(yield* instruction.place(), ctx.params.recordID, { personal: true })
      if (!detail) return yield* missing(ctx.params.recordID, `No record ${ctx.params.recordID} here.`)
      return detail
    })

    const updateRecord = Effect.fn("MemoryHttpApi.updateRecord")(function* (ctx: {
      params: { recordID: string }
      payload: BrainKnowledge.RecordChange
    }) {
      const result = yield* knowledge.changeRecord(yield* instruction.place(), ctx.params.recordID, ctx.payload)
      if (!result) return yield* missing(ctx.params.recordID, `No record ${ctx.params.recordID} here.`)
      if (result.type === "refused") return yield* refused(result.message)
      return { record: result.record, ...(result.entry ? { entry: result.entry } : {}) }
    })

    const links = Effect.fn("MemoryHttpApi.links")(function* (ctx: { query: { file: string } }) {
      return yield* knowledge.links(yield* instruction.place(), ctx.query.file, { personal: true })
    })

    const review = Effect.fn("MemoryHttpApi.review")(function* (ctx: { query: { check?: "true" | "false" } }) {
      const place = yield* instruction.place()
      if (ctx.query.check === "true") yield* knowledge.drift(place, { force: true })
      return yield* knowledge.review(place)
    })

    const resolveReview = Effect.fn("MemoryHttpApi.resolveReview")(function* (ctx: {
      params: { itemID: string }
      payload: BrainKnowledge.Resolution
    }) {
      const result = yield* knowledge.resolve(yield* instruction.place(), ctx.params.itemID, ctx.payload)
      if (!result)
        return yield* missing(ctx.params.itemID, `Nothing here needs a look as ${ctx.params.itemID}, or not that way.`)
      if (result.type === "refused") return yield* refused(result.message)
      if (result.type === "settled") return {}
      return { item: result.item, ...(result.entry ? { entry: result.entry } : {}) }
    })

    const cited = Effect.fn("MemoryHttpApi.knowledge")(function* (ctx: { query: { ids: string } }) {
      const ids = ctx.query.ids
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
      if (ids.length > BrainKnowledge.LIMIT.cards) return yield* refused("Ask for at most 50 ids at a time.", "limit")
      return yield* knowledge.cards(yield* instruction.place(), ids, { personal: true })
    })

    // --- Research -------------------------------------------------------------------------------------------------

    const researchList = Effect.fn("MemoryHttpApi.research")(function* () {
      const runs = yield* research.list(yield* instruction.place())
      return {
        runs,
        bytes: runs.reduce((sum, run) => sum + run.bytes, 0),
        limit: ResearchStore.LIMIT.repository,
        retain: ResearchStore.LIMIT.retain,
      }
    })

    const noRun = (id: string) => missing(id, `No research run ${id} here.`)

    const researchRun = Effect.fn("MemoryHttpApi.researchRun")(function* (ctx: { params: { runID: string } }) {
      const detail = yield* research.get(yield* instruction.place(), ctx.params.runID)
      if (!detail) return yield* noRun(ctx.params.runID)
      return detail
    })

    const keepResearch = Effect.fn("MemoryHttpApi.keepResearch")(function* (ctx: { params: { runID: string } }) {
      const place = yield* instruction.place()
      const kept = yield* research.keep(place, ctx.params.runID)
      if (!kept) return yield* noRun(ctx.params.runID)
      if (kept.type === "refused") return yield* refused(kept.message, "guest")
      return (yield* research.get(place, ctx.params.runID))!
    })

    const forgetResearch = Effect.fn("MemoryHttpApi.forgetResearch")(function* (ctx: { params: { runID: string } }) {
      if (!(yield* research.forget(yield* instruction.place(), ctx.params.runID))) return yield* noRun(ctx.params.runID)
      return true
    })

    const forgetAllResearch = Effect.fn("MemoryHttpApi.forgetAllResearch")(function* () {
      return yield* research.forgetAll(yield* instruction.place())
    })

    // An attachment, never something a browser renders.
    const exportResearch = Effect.fn("MemoryHttpApi.exportResearch")(function* (ctx: {
      params: { runID: string }
      query: { format?: "markdown" | "json" | "docx" | "pdf" }
    }) {
      const format = ctx.query.format ?? "markdown"
      const exported = yield* research.export(
        yield* instruction.place(),
        ctx.params.runID,
        format === "json" ? "json" : "markdown",
      )
      if (!exported) return yield* noRun(ctx.params.runID)
      if (format === "docx" || format === "pdf") {
        const converted = yield* Effect.tryPromise({
          try: () => ResearchExport.render(exported.body, format),
          catch: (cause) => refused(cause instanceof Error ? cause.message : "Vector could not export this report."),
        })
        return HttpServerResponse.uint8Array(converted.bytes, {
          contentType: converted.type,
          headers: {
            "content-disposition": `attachment; filename="${exported.name.replace(/\.md$/, `.${format}`).replace(/[^A-Za-z0-9._-]/g, "_")}"`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox",
            "cache-control": "no-store",
          },
        })
      }
      return HttpServerResponse.text(exported.body, {
        contentType: `${exported.type}; charset=utf-8`,
        headers: {
          "content-disposition": `attachment; filename="${exported.name.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
          "cache-control": "no-store",
        },
      })
    })

    const researchSource = Effect.fn("MemoryHttpApi.researchSource")(function* (ctx: {
      params: { runID: string; sourceID: string }
    }) {
      const saved = yield* research.source(yield* instruction.place(), ctx.params.runID, ctx.params.sourceID)
      if (!saved)
        return yield* missing(ctx.params.sourceID, `No source ${ctx.params.sourceID} in run ${ctx.params.runID}.`)
      return {
        source: { ...saved.source, ...(saved.forgotten ? { forgotten: true } : {}) },
        chunks: saved.chunks,
        private: saved.private,
      }
    })

    const forgetResearchSource = Effect.fn("MemoryHttpApi.forgetResearchSource")(function* (ctx: {
      params: { runID: string; sourceID: string }
    }) {
      if (!(yield* research.forgetSource(yield* instruction.place(), ctx.params.runID, ctx.params.sourceID)))
        return yield* missing(ctx.params.sourceID, `No source ${ctx.params.sourceID} in run ${ctx.params.runID}.`)
      return true
    })

    const postingCheck = Effect.fn("MemoryHttpApi.postingCheck")(function* (ctx: {
      payload: {
        parts: readonly string[]
        sessionIDs?: readonly string[]
        typed: boolean
        untrusted?: boolean
        hosts?: readonly string[]
      }
    }) {
      if (ctx.payload.parts.reduce((sum, part) => sum + part.length, 0) > POSTING_CHARS)
        return yield* refused("Vector checks at most 2,000,000 characters at a time.", "limit")
      return yield* SessionPosting.check(ctx.payload).pipe(
        Effect.provideService(Instruction.Service, instruction),
        Effect.provideService(Session.Service, sessions),
        Effect.provideService(Git.Service, git),
        Effect.provideService(Brain.Service, brain),
        Effect.provideService(BrainKnowledge.Service, knowledge),
      )
    })

    return handlers
      .handle("list", list)
      .handle("get", get)
      .handle("create", create)
      .handle("update", update)
      .handle("remove", remove)
      .handle("erase", erase)
      .handle("tidy", tidy)
      .handle("settings", settings)
      .handle("configure", configure)
      .handle("model", model)
      .handle("changeModel", changeModel)
      .handle("documents", documents)
      .handle("upload", upload)
      .handle("addPath", addPath)
      .handle("addText", addText)
      .handle("probe", probe)
      .handle("document", document)
      .handle("updateDocument", updateDocument)
      .handle("removeDocument", removeDocument)
      .handle("documentPage", documentPage)
      .handle("documentFile", documentFile)
      .handle("distillEstimate", distillEstimate)
      .handle("distill", distill)
      .handle("records", records)
      .handle("record", record)
      .handle("updateRecord", updateRecord)
      .handle("links", links)
      .handle("review", review)
      .handle("resolveReview", resolveReview)
      .handle("knowledge", cited)
      .handle("research", researchList)
      .handle("forgetAllResearch", forgetAllResearch)
      .handle("researchRun", researchRun)
      .handle("forgetResearch", forgetResearch)
      .handle("keepResearch", keepResearch)
      .handle("exportResearch", exportResearch)
      .handle("researchSource", researchSource)
      .handle("forgetResearchSource", forgetResearchSource)
      .handle("postingCheck", postingCheck)
      .handle("eraseSession", eraseSession)
      .handle("export", exportMemory)
      .handle("import", importMemory)
  }),
)
