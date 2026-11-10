export * as PublicSessionShare from "./public-session-share"

import { createHash, randomBytes } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Fiber, Layer, Option, Schema, Scope, Semaphore } from "effect"
import { PublicSession } from "@vectordevai/schema/public-session"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { FreeModels } from "./free-models"
import { EventV2 } from "./event"
import { SessionEvent } from "./session/event"
import { SessionSchema } from "./session/schema"
import { SessionTable } from "./session/sql"
import { SessionAudience } from "./session/audience"
import { PublicSessionShareTable, PublicSessionConsentTable } from "./share/public.sql"
import { SessionArchive } from "./share/archive"
import { accountOwner, encodedBody, makeShareTransport, shareID } from "./share/transport"

export { shareID }
export interface Interface extends SessionArchive.Interface {
  readonly publish: (
    input: SessionArchive.Selection & PublicSession.Publish,
  ) => Effect.Effect<PublicSession.Info, PublicSession.Error>
  readonly flush: (sessionID: SessionSchema.ID) => Effect.Effect<PublicSession.Info, PublicSession.Error>
  readonly unshare: (sessionID: SessionSchema.ID) => Effect.Effect<void, PublicSession.Error>
  readonly removeTree: (sessionID: SessionSchema.ID) => Effect.Effect<void, PublicSession.Error>
  readonly auto: (input: SessionArchive.Selection) => Effect.Effect<PublicSession.Info | undefined, PublicSession.Error>
  readonly read: (url: string) => Effect.Effect<PublicSession.Archive, PublicSession.Error>
}
export class Service extends Context.Service<Service, Interface>()("@vector/PublicSessionShare") {}
const unavailable = (error: unknown) =>
  error instanceof PublicSession.Error
    ? error
    : new PublicSession.Error({
        code: "UNAVAILABLE",
        message: "Vector could not update the public session. Try again; your local conversation is safe.",
      })

export const layerWith = (options?: { fetch?: typeof fetch }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const audience = SessionAudience.make({ db })
      const privateShare = () =>
        new PublicSession.Error({
          code: "INVALID",
          message: "Private conversations cannot be published or publicly exported.",
        })
      const archive = yield* SessionArchive.Service
      // The local export reads the history and its privacy flag in one read snapshot, with no write lock. A fence only
      // adds rows and comes before any private bytes, so a snapshot that does not show it holds none of them. Building,
      // encoding and scanning the public archive run after that snapshot is released: a live share captures about once
      // a second, and must neither hold back another engine's writes nor wait on them.
      const captureArchive = (input: SessionArchive.Selection) =>
        Effect.gen(function* () {
          const local = yield* archive.export(input)
          if (local.privacy === "owner-only") return yield* privateShare()
          const snapshot = yield* Effect.try({ try: () => SessionArchive.publicArchive(local), catch: unavailable })
          const body = yield* Effect.try({ try: () => encodedBody(snapshot), catch: unavailable })
          if (yield* audience.containsPrivateText(body)) return yield* privateShare()
          return snapshot
        })
      const credentials = yield* FreeModels.CredentialsService
      const events = yield* EventV2.Service
      const scope = yield* Scope.Scope
      const locks = new Map<string, Semaphore.Semaphore>()
      const pending = new Map<string, Fiber.Fiber<void>>()
      const dirty = new Set<SessionSchema.ID>()
      const touched = new Set<SessionSchema.ID>()
      const lock = (id: string) => {
        const prior = locks.get(id)
        if (prior) return prior
        const semaphore = Semaphore.makeUnsafe(1)
        locks.set(id, semaphore)
        return semaphore
      }
      const stored = (sessionID: SessionSchema.ID) =>
        db
          .select()
          .from(PublicSessionShareTable)
          .where(eq(PublicSessionShareTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
      const token = credentials
        .get("vector")
        .pipe(
          Effect.flatMap((value) =>
            Effect.try({ try: () => ({ token: value!, owner: accountOwner(value) }), catch: unavailable }),
          ),
        )
      const info = (row: typeof PublicSessionShareTable.$inferSelect): PublicSession.Info => ({
        id: row.id,
        url: `https://vectordev.ai/s/${row.id}`,
        expiresAt: row.expires_at,
        updatedAt: row.updated_at,
        revision: row.revision,
        updates: row.updates,
      })
      const changed = (sessionID: SessionSchema.ID, value: PublicSession.Info | null) =>
        events
          .publish(SessionEvent.ShareChanged, { sessionID, timestamp: DateTime.nowUnsafe(), share: value })
          .pipe(Effect.asVoid)
      const conflict = () =>
        new PublicSession.Error({
          code: "CONFLICT",
          message: "This share changed in another Vector process. Refresh before trying again.",
        })
      const same = (row: typeof PublicSessionShareTable.$inferSelect) =>
        and(
          eq(PublicSessionShareTable.session_id, row.session_id),
          eq(PublicSessionShareTable.id, row.id),
          eq(PublicSessionShareTable.owner, row.owner),
        )
      const refreshDirty = (row: typeof PublicSessionShareTable.$inferSelect) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              const latest = yield* archive.preview({
                sessionID: SessionSchema.ID.make(row.session_id),
                engine: row.engine,
              })
              yield* db
                .update(PublicSessionShareTable)
                .set({
                  dirty:
                    row.updates && createHash("sha256").update(encodedBody(latest)).digest("hex") !== row.content_hash,
                })
                .where(
                  and(
                    same(row),
                    eq(PublicSessionShareTable.state, "active"),
                    eq(PublicSessionShareTable.revision, row.revision),
                  ),
                )
                .run()
                .pipe(Effect.orDie)
            }),
          )
          .pipe(Effect.mapError(unavailable))
      const persist = (row: typeof PublicSessionShareTable.$inferSelect, value: PublicSession.Info, hash: string) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              const updated = yield* db
                .update(PublicSessionShareTable)
                .set({
                  state: "active",
                  initial_archive: null,
                  content_hash: hash,
                  expires_at: value.expiresAt,
                  updated_at: value.updatedAt,
                  revision: value.revision,
                  updates: value.updates,
                })
                .where(
                  and(
                    same(row),
                    eq(PublicSessionShareTable.state, row.state),
                    eq(PublicSessionShareTable.revision, row.revision),
                  ),
                )
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (!updated) return yield* conflict()
              yield* changed(SessionSchema.ID.make(row.session_id), value)
              yield* refreshDirty(updated)
              return updated
            }),
          )
          .pipe(Effect.mapError(unavailable))
      const write = Effect.fn("PublicSessionShare.write")(function* (
        row: typeof PublicSessionShareTable.$inferSelect,
        auth: { token: string; owner: string },
      ) {
        if (row.owner !== auth.owner)
          return yield* new PublicSession.Error({
            code: "SIGN_IN_REQUIRED",
            message: "Sign in to the Vector account that owns this share.",
          })
        if (row.state === "deleting")
          return yield* new PublicSession.Error({
            code: "CONFLICT",
            message: "This share is being removed. Retry Unshare before publishing again.",
          })
        if (row.expires_at <= Date.now())
          return yield* new PublicSession.Error({
            code: "NOT_FOUND",
            message: "This public session has expired. Unshare it before creating a new link.",
          })
        if (row.state === "active" && !row.updates) return info(row)
        // The network sends only these captured bytes, which a later fence cannot reach.
        const snapshot = yield* captureArchive({
          sessionID: SessionSchema.ID.make(row.session_id),
          engine: row.engine,
        })
        const hash = createHash("sha256").update(encodedBody(snapshot)).digest("hex")
        touched.add(SessionSchema.ID.make(row.session_id))
        if (row.state === "active" && row.content_hash === hash) {
          yield* refreshDirty(row)
          return info(row)
        }
        const remote = makeShareTransport({ fetch: options?.fetch, token: async () => auth.token })
        const initial = row.initial_archive ?? snapshot
        const response = yield* Effect.tryPromise({
          try: () =>
            row.state === "creating"
              ? remote.create({
                  id: row.id,
                  secret: row.secret,
                  consent: { version: 1, public: true, updates: row.updates },
                  expiresAt: row.expires_at,
                  archive: initial,
                })
              : remote.update(row.id, { secret: row.secret, revision: row.revision, archive: snapshot }),
          catch: unavailable,
        })
        if (response.id !== row.id)
          return yield* new PublicSession.Error({
            code: "INVALID",
            message: "Vector returned a different share identity.",
          })
        const initialHash =
          row.state === "creating" ? createHash("sha256").update(encodedBody(initial)).digest("hex") : hash
        const saved = yield* persist(row, response, initialHash)
        if (row.state === "creating" && row.updates && initialHash !== hash) {
          const latest = yield* Effect.tryPromise({
            try: () => remote.update(row.id, { secret: row.secret, revision: response.revision, archive: snapshot }),
            catch: unavailable,
          })
          return info(yield* persist(saved, latest, hash))
        }
        return info(saved)
      })
      const flush = (sessionID: SessionSchema.ID) =>
        lock(sessionID).withPermit(
          Effect.gen(function* () {
            const row = yield* stored(sessionID)
            if (!row)
              return yield* new PublicSession.Error({ code: "NOT_FOUND", message: "This session has not been shared." })
            return yield* write(row, yield* token)
          }),
        )
      const publish = (input: SessionArchive.Selection & PublicSession.Publish) =>
        lock(input.sessionID).withPermit(
          Effect.gen(function* () {
            if (yield* audience.isPrivate(input.sessionID)) return yield* privateShare()
            if (!Schema.is(PublicSession.Consent)(input.consent))
              return yield* new PublicSession.Error({
                code: "CONSENT_REQUIRED",
                message: "Confirm that this conversation will be public before sharing it.",
              })
            if (
              !Number.isSafeInteger(input.expiresAt) ||
              input.expiresAt <= Date.now() ||
              input.expiresAt > Date.now() + PublicSession.MAX_AGE_MS
            )
              return yield* new PublicSession.Error({
                code: "INVALID",
                message: "Choose a share expiry within the next 30 days.",
              })
            const auth = yield* token
            const prior = yield* stored(input.sessionID)
            if (prior) return yield* write(prior, auth)
            const snapshot = yield* captureArchive(input)
            yield* Effect.try({ try: () => encodedBody(snapshot), catch: unavailable })
            if (
              !input.consent.updates &&
              createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") !== input.previewHash
            )
              return yield* new PublicSession.Error({
                code: "CONFLICT",
                message: "The conversation changed after the preview. Review the updated transcript before sharing.",
              })
            const row = yield* db
              .insert(PublicSessionShareTable)
              .values({
                session_id: input.sessionID,
                id: randomBytes(16).toString("hex"),
                secret: randomBytes(32).toString("hex"),
                owner: auth.owner,
                engine: snapshot.engine,
                expires_at: input.expiresAt,
                updated_at: Date.now(),
                revision: 0,
                content_hash: "",
                initial_archive: snapshot,
                updates: input.consent.updates,
                state: "creating",
              })
              .onConflictDoNothing()
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* conflict()
            const result = yield* write(row, auth)
            if (input.remember)
              yield* db
                .insert(PublicSessionConsentTable)
                .values({
                  owner: auth.owner,
                  version: PublicSession.CONSENT_VERSION,
                  updates: input.consent.updates,
                  created_at: Date.now(),
                })
                .onConflictDoUpdate({
                  target: PublicSessionConsentTable.owner,
                  set: {
                    version: PublicSession.CONSENT_VERSION,
                    updates: input.consent.updates,
                    created_at: Date.now(),
                  },
                })
                .run()
                .pipe(Effect.orDie)
            return result
          }),
        )
      const unshare = (sessionID: SessionSchema.ID) =>
        lock(sessionID).withPermit(
          Effect.gen(function* () {
            const row = yield* stored(sessionID)
            if (!row) return
            const auth = yield* token
            if (auth.owner !== row.owner)
              return yield* new PublicSession.Error({
                code: "SIGN_IN_REQUIRED",
                message: "Sign in to the Vector account that owns this share.",
              })
            // Persist deletion intent before the request so a crash/retry cannot resume publishing.
            const marked = yield* db
              .update(PublicSessionShareTable)
              .set({ state: "deleting" })
              .where(same(row))
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!marked) return yield* conflict()
            yield* Effect.tryPromise({
              try: () =>
                makeShareTransport({ fetch: options?.fetch, token: async () => auth.token }).remove(row.id, row.secret),
              catch: unavailable,
            })
            yield* db
              .transaction(() =>
                Effect.gen(function* () {
                  const removed = yield* db
                    .delete(PublicSessionShareTable)
                    .where(and(same(row), eq(PublicSessionShareTable.state, "deleting")))
                    .returning()
                    .get()
                    .pipe(Effect.orDie)
                  if (removed) yield* changed(sessionID, null)
                }),
              )
              .pipe(Effect.orDie)
          }),
        )

      const queue = (sessionID: SessionSchema.ID) =>
        Effect.gen(function* () {
          dirty.add(sessionID)
          if (pending.has(sessionID)) return
          const fiber = yield* Effect.gen(function* () {
            while (dirty.delete(sessionID)) {
              yield* Effect.sleep("1 second")
              const row = yield* stored(sessionID)
              if (!row?.updates || row.state === "deleting") return
              for (const attempt of [0, 1, 2]) {
                const result = yield* flush(sessionID).pipe(Effect.result)
                if (result._tag === "Success") break
                if (result.failure.code !== "UNAVAILABLE" || attempt === 2) {
                  yield* Effect.logWarning("Public session update deferred", { code: result.failure.code })
                  return
                }
                yield* Effect.sleep(`${attempt + 1} seconds`)
              }
              if ((yield* stored(sessionID))?.dirty) dirty.add(sessionID)
            }
          }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(sessionID))), Effect.forkIn(scope))
          pending.set(sessionID, fiber)
        })
      const unsubscribe = yield* events.listen((event) =>
        Effect.gen(function* () {
          if (
            !event.durable ||
            event.type === SessionEvent.ShareChanged.type ||
            !event.data ||
            typeof event.data !== "object" ||
            !("sessionID" in event.data)
          )
            return
          const sessionID = SessionSchema.ID.make(String(event.data.sessionID))
          const marked = yield* db
            .update(PublicSessionShareTable)
            .set({ dirty: true })
            .where(and(eq(PublicSessionShareTable.session_id, sessionID), eq(PublicSessionShareTable.updates, true)))
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (marked && marked.state !== "deleting") yield* queue(sessionID)
        }),
      )
      const retryRows = yield* db
        .select()
        .from(PublicSessionShareTable)
        // Also reconcile the narrow crash window between transcript commit and its dirty notification.
        // Unchanged archives are compared locally and never uploaded again.
        .where(eq(PublicSessionShareTable.updates, true))
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        retryRows.filter((row) => row.updates && row.state !== "deleting" && row.expires_at > Date.now()),
        (row) => queue(SessionSchema.ID.make(row.session_id)),
        { discard: true },
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const flushIDs = new Set([...touched, ...dirty, ...pending.keys()].map((id) => SessionSchema.ID.make(id)))
          yield* Fiber.interruptAll([...pending.values()])
          yield* Effect.forEach(
            flushIDs,
            (sessionID) =>
              Effect.gen(function* () {
                const row = yield* stored(sessionID)
                if (row?.updates && row.state === "active") yield* flush(sessionID).pipe(Effect.ignore)
              }),
            { concurrency: "unbounded", discard: true },
          )
        }),
      )
      return Service.of({
        ...archive,
        publish,
        flush,
        unshare,
        read: (url) =>
          Effect.tryPromise({
            try: () => makeShareTransport({ fetch: options?.fetch, token: async () => undefined }).read(url),
            catch: unavailable,
          }).pipe(Effect.map((snapshot) => snapshot.archive)),
        auto: (input) =>
          Effect.gen(function* () {
            const auth = yield* token.pipe(Effect.option)
            if (Option.isNone(auth)) return
            const consent = yield* db
              .select()
              .from(PublicSessionConsentTable)
              .where(eq(PublicSessionConsentTable.owner, auth.value.owner))
              .get()
              .pipe(Effect.orDie)
            // Snapshot consent covers only a reviewed transcript, never future sessions.
            if (consent?.version !== PublicSession.CONSENT_VERSION || !consent.updates) return
            return yield* publish({
              ...input,
              consent: { version: 1, public: true, updates: consent.updates },
              expiresAt: Date.now() + PublicSession.MAX_AGE_MS,
            })
          }),
        removeTree: (sessionID) =>
          Effect.gen(function* () {
            const rows = yield* db
              .all<{
                id: string
              }>(
                sql`WITH RECURSIVE descendants(id) AS (SELECT ${sessionID} UNION SELECT session.id FROM session JOIN descendants ON session.parent_id = descendants.id) SELECT session_id AS id FROM session_public_share WHERE session_id IN (SELECT id FROM descendants)`,
              )
              .pipe(Effect.orDie)
            yield* Effect.forEach(rows, (row) => unshare(SessionSchema.ID.make(row.id)), { discard: true })
          }),
      })
    }),
  )

export const node = makeGlobalNode({
  service: Service,
  layer: layerWith(),
  deps: [Database.node, SessionArchive.node, EventV2.node, FreeModels.credentialsNode],
})
