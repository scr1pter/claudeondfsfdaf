import { expect } from "bun:test"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { Database } from "../../src/database/database"
import { Flag } from "../../src/flag/flag"
import { EventV2 } from "../../src/event"
import { SessionV1 } from "../../src/v1/session"
import { ProjectV2 } from "../../src/project"
import { SessionSchema } from "../../src/session/schema"
import { SessionAudience } from "../../src/session/audience"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/tmpdir"

const it = testEffect(
  Layer.mergeAll(SessionAudience.layer, EventV2.layerWith()).pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
  ),
)

it.effect("a private descendant fences its connected ancestors, siblings and future children", () =>
  Effect.gen(function* () {
    const audience = yield* SessionAudience.Service
    yield* audience.register({ sessionID: "ses_root" })
    yield* audience.register({ sessionID: "ses_left", parentID: "ses_root" })
    yield* audience.register({ sessionID: "ses_right", parentID: "ses_root" })
    yield* audience.register({ sessionID: "ses_leaf", parentID: "ses_left" })
    yield* audience.register({ sessionID: "ses_other" })
    yield* audience.fenceIsolation({ sessionID: "ses_leaf", actor: "owner" })
    for (const id of ["ses_root", "ses_left", "ses_right", "ses_leaf"]) expect(yield* audience.isPrivate(id)).toBe(true)
    expect(yield* audience.isPrivate("ses_other")).toBe(false)
    yield* audience.register({ sessionID: "ses_future", parentID: "ses_right" })
    yield* audience.register({ sessionID: "ses_fork", forkOf: "ses_left" })
    expect(yield* audience.isPrivate("ses_future")).toBe(true)
    expect(yield* audience.isPrivate("ses_fork")).toBe(true)
    expect(yield* audience.knows("ses_missing")).toBe(false)
    expect(yield* audience.knows("ses_future")).toBe(true)
  }),
)

it.effect("preflight does not privatize, verified guests cannot isolate, and later guest input is refused", () =>
  Effect.gen(function* () {
    const audience = yield* SessionAudience.Service
    yield* audience.register({ sessionID: "ses_root" })
    expect(yield* audience.canIsolate("ses_root", "owner")).toBe(true)
    expect(yield* audience.canIsolate("ses_root", "guest")).toBe(false)
    expect(yield* audience.isPrivate("ses_root")).toBe(false)
    expect(
      Exit.isFailure(yield* audience.fenceIsolation({ sessionID: "ses_root", actor: "guest" }).pipe(Effect.exit)),
    ).toBe(true)
    yield* audience.fenceIsolation({ sessionID: "ses_root", actor: "owner" })
    expect(Exit.isFailure(yield* audience.markGuest("ses_root").pipe(Effect.exit))).toBe(true)
    expect(yield* audience.hasGuestInput("ses_root")).toBe(false)
  }),
)

it.effect("guest input anywhere permanently prevents isolation throughout the family", () =>
  Effect.gen(function* () {
    const audience = yield* SessionAudience.Service
    yield* audience.register({ sessionID: "ses_root" })
    yield* audience.register({ sessionID: "ses_child", parentID: "ses_root" })
    yield* audience.markGuest("ses_child")
    expect(yield* audience.hasGuestInput("ses_root")).toBe(true)
    expect(yield* audience.canIsolate("ses_root", "owner")).toBe(false)
    expect(
      Exit.isFailure(yield* audience.fenceIsolation({ sessionID: "ses_root", actor: "owner" }).pipe(Effect.exit)),
    ).toBe(true)
    yield* audience.register({ sessionID: "ses_fork", forkOf: "ses_child" })
    expect(yield* audience.hasGuestInput("ses_fork")).toBe(true)
    expect(yield* audience.isPrivate("ses_root")).toBe(false)
  }),
)

it.effect(
  "guest input in a fork stays out of its source and the source's other forks, and a source's reaches them",
  () =>
    Effect.gen(function* () {
      const audience = yield* SessionAudience.Service
      yield* audience.register({ sessionID: "ses_source" })
      yield* audience.register({ sessionID: "ses_source_child", parentID: "ses_source" })
      yield* audience.register({ sessionID: "ses_guest_fork", forkOf: "ses_source" })
      yield* audience.register({ sessionID: "ses_owner_fork", forkOf: "ses_source" })
      yield* audience.register({ sessionID: "ses_fork_helper", parentID: "ses_guest_fork" })
      // A forked helper is its parent's child as well as its copy: reports flow both ways along that edge.
      yield* audience.register({ sessionID: "ses_forked_helper", parentID: "ses_owner_fork", forkOf: "ses_owner_fork" })
      yield* audience.markGuest("ses_fork_helper")
      // The guest's text reaches the fork through its helper's report.
      for (const id of ["ses_fork_helper", "ses_guest_fork"]) expect(yield* audience.hasGuestInput(id), id).toBe(true)
      // The source, its child and its other forks never show the fork's messages.
      for (const id of ["ses_source", "ses_source_child", "ses_owner_fork", "ses_forked_helper"])
        expect(yield* audience.hasGuestInput(id), id).toBe(false)
      // The fence covers forks in both directions, so the source still cannot isolate while a fork holds guest input.
      expect(yield* audience.canIsolate("ses_source", "owner")).toBe(false)
      expect(
        Exit.isFailure(yield* audience.fenceIsolation({ sessionID: "ses_source", actor: "owner" }).pipe(Effect.exit)),
      ).toBe(true)
      yield* audience.markGuest("ses_forked_helper")
      expect(yield* audience.hasGuestInput("ses_owner_fork")).toBe(true)
      expect(yield* audience.hasGuestInput("ses_source")).toBe(false)
      // Guest input in the source tree reaches every fork, earlier and later ones alike.
      yield* audience.markGuest("ses_source_child")
      yield* audience.register({ sessionID: "ses_late_fork", forkOf: "ses_source" })
      for (const id of ["ses_source", "ses_owner_fork", "ses_guest_fork", "ses_late_fork"])
        expect(yield* audience.hasGuestInput(id), id).toBe(true)
    }),
)

it.effect("legacy live lineage is captured before an intermediate session is deleted", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const audience = yield* SessionAudience.Service
    yield* db
      .run(
        sql`INSERT INTO project(id, worktree, sandboxes, time_created, time_updated) VALUES ('audience-project', '/project', '[]', 0, 0)`,
      )
      .pipe(Effect.orDie)
    for (const [id, parent] of [
      ["ses_root", null],
      ["ses_middle", "ses_root"],
      ["ses_leaf", "ses_middle"],
      ["ses_sibling", "ses_root"],
    ] as const) {
      yield* db
        .run(
          sql`INSERT INTO session(id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (${id}, 'audience-project', ${parent}, ${id}, '/project', ${id}, 'test', 0, 0)`,
        )
        .pipe(Effect.orDie)
    }
    yield* audience.fenceIsolation({ sessionID: "ses_leaf", actor: "owner" })
    yield* db.run(sql`DELETE FROM session`).pipe(Effect.orDie)
    for (const id of ["ses_root", "ses_middle", "ses_leaf", "ses_sibling"]) {
      expect(yield* audience.isPrivate(id)).toBe(true)
      expect(yield* audience.knows(id)).toBe(true)
    }
    yield* audience.register({ sessionID: "ses_future", parentID: "ses_middle" })
    expect(yield* audience.isPrivate("ses_future")).toBe(true)
    // The family relation walks the captured lineage too, through the deleted middle session.
    expect(yield* audience.inFamily("ses_sibling", "ses_leaf")).toBe(true)
    expect(yield* audience.inFamily("ses_leaf", "ses_future")).toBe(true)
  }),
)

it.effect(
  "inFamily is a conversation's own lineage both ways, never across a fork in either direction nor to a guest next to it",
  () =>
    Effect.gen(function* () {
      const audience = yield* SessionAudience.Service
      yield* audience.register({ sessionID: "ses_root" })
      yield* audience.register({ sessionID: "ses_child", parentID: "ses_root" })
      yield* audience.register({ sessionID: "ses_leaf", parentID: "ses_child" })
      yield* audience.register({ sessionID: "ses_sibling", parentID: "ses_root" })
      yield* audience.register({ sessionID: "ses_fork", forkOf: "ses_child" })
      yield* audience.register({ sessionID: "ses_fork_helper", parentID: "ses_fork" })
      // Work the source starts after the fork, which the fork never shows.
      yield* audience.register({ sessionID: "ses_late", parentID: "ses_child" })
      yield* audience.fenceIsolation({ sessionID: "ses_child", actor: "owner" })
      yield* audience.register({ sessionID: "ses_guest", actor: "guest" })
      const pairs = (list: ReadonlyArray<readonly [string, string]>) =>
        Effect.forEach(list, ([caller, member]) =>
          audience.inFamily(caller, member).pipe(Effect.map((found) => `${caller} ${member} ${found}`)),
        )
      // Itself, its ancestors and descendants, and siblings through them; a fork's own helpers are its lineage.
      const lineage = [
        ["ses_leaf", "ses_leaf"],
        ["ses_leaf", "ses_root"],
        ["ses_root", "ses_leaf"],
        ["ses_leaf", "ses_sibling"],
        ["ses_leaf", "ses_late"],
        ["ses_fork", "ses_fork_helper"],
        ["ses_fork_helper", "ses_fork"],
      ] as const
      expect(yield* pairs(lineage)).toEqual(lineage.map(([caller, member]) => `${caller} ${member} true`))
      // A fork and its source are outside each other's lineage in both directions: a fork shows its source only up to
      // the fork point, so it is not told about the source's later work, and a source never shows its fork's messages.
      // Nor is a guest's conversation in the same folder, or an unknown ID.
      const outside = [
        ["ses_fork", "ses_child"],
        ["ses_fork", "ses_late"],
        ["ses_fork_helper", "ses_leaf"],
        ["ses_fork", "ses_sibling"],
        ["ses_child", "ses_fork"],
        ["ses_root", "ses_fork_helper"],
        ["ses_leaf", "ses_fork"],
        ["ses_guest", "ses_leaf"],
        ["ses_leaf", "ses_guest"],
        ["ses_guest", "ses_root"],
        ["ses_leaf", "ses_missing"],
      ] as const
      expect(yield* pairs(outside)).toEqual(outside.map(([caller, member]) => `${caller} ${member} false`))
      // The fence, unlike this relation, covers the fork in both directions.
      expect(yield* audience.isPrivate("ses_fork_helper")).toBe(true)
      expect(yield* audience.isPrivate("ses_guest")).toBe(false)
    }),
)

it.effect("joining a guest-bearing family to a private family is refused atomically", () =>
  Effect.gen(function* () {
    const audience = yield* SessionAudience.Service
    yield* audience.fenceIsolation({ sessionID: "ses_private", actor: "owner" })
    yield* audience.markGuest("ses_guest")
    const joined = yield* audience.register({ sessionID: "ses_guest", forkOf: "ses_private" }).pipe(Effect.exit)
    expect(Exit.isFailure(joined)).toBe(true)
    expect(yield* audience.isPrivate("ses_guest")).toBe(false)
    expect(yield* audience.hasGuestInput("ses_private")).toBe(false)
  }),
)

it.live("a racing guest admission and owner fence cannot both succeed", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const first = SessionAudience.make(database)
    const second = SessionAudience.make(database)
    const results = yield* Effect.all(
      [
        first.markGuest("ses_race").pipe(Effect.exit),
        second.fenceIsolation({ sessionID: "ses_race", actor: "owner" }).pipe(Effect.exit),
      ],
      { concurrency: "unbounded" },
    )
    expect(results.filter(Exit.isSuccess)).toHaveLength(1)
    expect((yield* first.isPrivate("ses_race")) && (yield* first.hasGuestInput("ses_race"))).toBe(false)
  }),
)

it.live("linked Git metadata stays private without making the ordinary checkout above its .git private", () =>
  Effect.gen(function* () {
    const audience = yield* SessionAudience.Service
    const temporary = yield* Effect.acquireRelease(Effect.promise(tmpdir), (value) =>
      Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    const repository = path.join(temporary.path, "repository")
    const metadata = path.join(repository, ".git", "worktrees", "ses_task")
    yield* Effect.promise(() => fs.mkdir(metadata, { recursive: true }))
    yield* audience.fenceIsolation({ sessionID: "ses_git_metadata", actor: "owner", directory: metadata })
    // Listing or searching the checkout, or a folder above it, does not reach into .git.
    expect(yield* audience.overlapsPrivateDirectory(repository)).toBe(false)
    expect(yield* audience.overlapsPrivateDirectory(temporary.path)).toBe(false)
    // Selecting .git itself, its worktrees folder, or the metadata does.
    expect(yield* audience.overlapsPrivateDirectory(path.join(repository, ".git"))).toBe(true)
    expect(yield* audience.overlapsPrivateDirectory(path.join(repository, ".git", "worktrees"))).toBe(true)
    expect(yield* audience.overlapsPrivateDirectory(path.join(metadata, "HEAD"))).toBe(true)
    expect(yield* audience.isPrivateDirectory(path.join(metadata, "gitdir"))).toBe(true)
  }),
)

it.live("private directory identity survives deletion and denies canonical aliases and subpaths", () =>
  Effect.gen(function* () {
    const audience = yield* SessionAudience.Service
    const temporary = yield* Effect.acquireRelease(Effect.promise(tmpdir), (value) =>
      Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    const directory = path.join(temporary.path, "private")
    const alias = path.join(temporary.path, "alias")
    yield* Effect.promise(async () => {
      await fs.mkdir(directory)
      await fs.symlink(directory, alias, process.platform === "win32" ? "junction" : "dir")
    })
    yield* audience.fenceIsolation({ sessionID: "ses_private", actor: "owner", directory })
    expect(yield* audience.isPrivateDirectory(path.join(alias, "nested", "file.ts"))).toBe(true)
    expect(yield* audience.overlapsPrivateDirectory(temporary.path)).toBe(true)
    expect(yield* audience.isPrivateDirectory(temporary.path)).toBe(false)
    expect(yield* audience.overlapsPrivateDirectory(path.join(temporary.path, "ordinary.txt"))).toBe(false)
    expect(yield* audience.containsPrivateText(`worktree ${directory}`)).toBe(true)
    expect(yield* audience.containsPrivateText(JSON.stringify({ directory }))).toBe(true)
    expect(yield* audience.containsPrivateText("an unrelated public response")).toBe(false)
    expect(yield* audience.isPrivateDirectory(path.join(temporary.path, "private-lookalike"))).toBe(false)
    yield* Effect.promise(() => fs.rm(directory, { recursive: true }))
    expect(yield* audience.isPrivateDirectory(path.join(directory, "later"))).toBe(true)
  }),
)

it.live("on macOS private directories match case-folded spellings, as engine file-lock keys fold them", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const mac = SessionAudience.make(database, "darwin")
    const linux = SessionAudience.make(database, "linux")
    const temporary = yield* Effect.acquireRelease(Effect.promise(tmpdir), (value) =>
      Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    const directory = path.join(temporary.path, "Task-Worktree", "Ses_Mixed")
    yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
    yield* mac.fenceIsolation({ sessionID: "ses_case_folded", actor: "owner", directory })
    // A case-insensitive volume's lock key is the lowercased real path; a guest may also type any spelling.
    const folded = path.join(directory, "src", "secret.ts").toLowerCase()
    expect(yield* mac.isPrivateDirectory(folded)).toBe(true)
    expect(yield* mac.overlapsPrivateDirectory(path.dirname(directory).toUpperCase())).toBe(true)
    expect(yield* mac.containsPrivateText(`cat ${folded}`)).toBe(true)
    expect(yield* mac.containsPrivateText(`cat ${path.join(directory, "x").toUpperCase()}`)).toBe(true)
    expect(yield* mac.isPrivateDirectory(path.join(temporary.path, "ordinary").toLowerCase())).toBe(false)
    // A case-sensitive platform keeps exact spellings: another spelling is another folder. On a host that ignores case
    // (Windows here) it names the same folder, whose real path is the private one.
    const exact = path.join(temporary.path, "Exact-Case")
    yield* Effect.promise(() => fs.mkdir(exact))
    yield* linux.fenceIsolation({ sessionID: "ses_exact_case", actor: "owner", directory: exact })
    expect(yield* linux.isPrivateDirectory(path.join(exact, "src"))).toBe(true)
    const distinct = !existsSync(path.join(temporary.path, "EXACT-CASE"))
    expect(yield* linux.isPrivateDirectory(path.join(temporary.path, "EXACT-CASE"))).toBe(!distinct)
  }),
)

it.live("family checks stay indexed lookups in a large database", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const audience = yield* SessionAudience.Service
    yield* database.db
      .run(
        sql`INSERT INTO project(id, worktree, sandboxes, time_created, time_updated) VALUES ('scale-project', '/project', '[]', 0, 0)`,
      )
      .pipe(Effect.orDie)
    // 20,000 unrelated sessions in short chains, and one 20-helper conversation.
    yield* database.db
      .run(
        sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 20000)
      INSERT INTO session(id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
      SELECT 'ses_scale_' || x, 'scale-project', CASE WHEN x % 3 = 0 THEN 'ses_scale_' || (x - 1) END, 's' || x,
        '/project', 't', 'test', 0, 0 FROM n`,
      )
      .pipe(Effect.orDie)
    yield* audience.register({ sessionID: "ses_scale_root" })
    for (const index of Array.from({ length: 20 }, (_, item) => item))
      yield* audience.register({ sessionID: `ses_scale_helper_${index}`, parentID: "ses_scale_root" })
    yield* database.db
      .run(
        sql`INSERT INTO session_lineage(session_id, parent_id) SELECT id, parent_id FROM session WHERE parent_id IS NOT NULL`,
      )
      .pipe(Effect.orDie)
    yield* audience.fenceIsolation({ sessionID: "ses_scale_helper_7", actor: "owner" })
    const started = performance.now()
    for (const index of Array.from({ length: 100 }, (_, item) => item)) {
      expect(yield* audience.hasGuestInput(`ses_scale_helper_${index % 20}`)).toBe(false)
      expect(yield* audience.isPrivate(`ses_scale_helper_${(index + 1) % 20}`)).toBe(true)
    }
    // A walk that rebuilds every edge per family member takes tens of milliseconds per check at this size.
    expect(performance.now() - started).toBeLessThan(2000)
    expect(yield* audience.isPrivate("ses_scale_9")).toBe(false)
  }),
)

it.live("lineage, owner-only fences and directory guards survive a database restart and deleted history", () =>
  Effect.gen(function* () {
    const temporary = yield* Effect.acquireRelease(Effect.promise(tmpdir), (value) =>
      Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    const filename = path.join(temporary.path, "audience.db")
    const directory = path.join(temporary.path, "private-work")
    yield* Effect.gen(function* () {
      const database = yield* Database.Service
      const audience = SessionAudience.make(database)
      yield* database.db
        .run(
          sql`INSERT INTO project(id, worktree, sandboxes, time_created, time_updated) VALUES ('restart-project', '/project', '[]', 0, 0)`,
        )
        .pipe(Effect.orDie)
      for (const [id, parent] of [
        ["ses_restart_root", null],
        ["ses_restart_middle", "ses_restart_root"],
        ["ses_restart_leaf", "ses_restart_middle"],
      ] as const) {
        yield* database.db
          .run(
            sql`INSERT INTO session(id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (${id}, 'restart-project', ${parent}, ${id}, '/project', ${id}, 'test', 0, 0)`,
          )
          .pipe(Effect.orDie)
      }
      yield* audience.fenceIsolation({ sessionID: "ses_restart_leaf", actor: "owner", directory })
      yield* database.db.run(sql`DELETE FROM session`).pipe(Effect.orDie)
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped)
    yield* Effect.gen(function* () {
      const database = yield* Database.Service
      const audience = SessionAudience.make(database)
      expect(yield* audience.isPrivate("ses_restart_root")).toBe(true)
      expect(yield* audience.knows("ses_restart_middle")).toBe(true)
      yield* audience.register({ sessionID: "ses_restart_fork", forkOf: "ses_restart_middle" })
      expect(yield* audience.isPrivate("ses_restart_fork")).toBe(true)
      expect(yield* audience.isPrivateDirectory(path.join(directory, "nested"))).toBe(true)
      expect(Exit.isFailure(yield* audience.markGuest("ses_restart_fork").pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped)
  }),
)

it.effect("versioned replay pre-scans later isolation hints before the first Created notification", () =>
  Effect.gen(function* () {
    const audience = yield* SessionAudience.Service
    const events = yield* EventV2.Service
    const root = SessionSchema.ID.make("ses_replay_root")
    const child = SessionSchema.ID.make("ses_replay_child")
    yield* audience.register({ sessionID: root })
    const info = SessionV1.SessionInfo.make({
      id: child,
      parentID: root,
      projectID: ProjectV2.ID.global,
      slug: "replayed",
      directory: "/owner",
      title: "Replayed child",
      version: "test",
      time: { created: 1, updated: 1 },
    })
    const observed: boolean[] = []
    const off = yield* events.listen((event) =>
      event.type === SessionV1.Event.Created.type
        ? audience.isPrivate(root).pipe(
            Effect.tap((value) => Effect.sync(() => observed.push(value))),
            Effect.asVoid,
          )
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => off)
    yield* events.replayAll(
      [
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SessionV1.Event.Created.type, 1),
          seq: 0,
          aggregateID: child,
          data: { sessionID: child, info },
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SessionV1.Event.Updated.type, 1),
          seq: 1,
          aggregateID: child,
          data: {
            sessionID: child,
            info: { ...info, metadata: { subagent: { isolation: { directory: "/forged-untrusted-directory" } } } },
          },
        },
      ],
      { publish: true },
    )
    expect(observed).toEqual([true])
    expect(yield* audience.isPrivate(child)).toBe(true)
    expect(yield* audience.isPrivateDirectory("/forged-untrusted-directory")).toBe(false)
  }),
)

it.effect("live undefined isolation stays public while serialized null and false hints only restrict", () =>
  Effect.gen(function* () {
    const audience = yield* SessionAudience.Service
    const events = yield* EventV2.Service
    for (const [isolation, restricted] of [
      [undefined, false],
      [null, true],
      [false, true],
    ] as const) {
      const id = SessionSchema.ID.create()
      const info = SessionV1.SessionInfo.make({
        id,
        projectID: ProjectV2.ID.global,
        slug: "hint",
        directory: "/owner",
        title: "Hint fixture",
        version: "test",
        time: { created: 1, updated: 1 },
        metadata: { subagent: { isolation } },
      })
      yield* events.publish(SessionV1.Event.Created, { sessionID: id, info })
      expect(yield* audience.isPrivate(id)).toBe(restricted)
      const admitted = yield* audience.markGuest(id).pipe(Effect.exit)
      expect(Exit.isSuccess(admitted)).toBe(!restricted)
    }
  }),
)

it.effect("malformed owner replay identities are rejected before any batch projector or listener", () =>
  Effect.gen(function* () {
    const audience = yield* SessionAudience.Service
    const events = yield* EventV2.Service
    const other = SessionSchema.ID.create()
    yield* audience.fenceIsolation({ sessionID: other, actor: "owner" })
    const projected: string[] = []
    const notified: string[] = []
    yield* events.project(SessionV1.Event.Created, () =>
      Effect.sync(() => {
        projected.push("created")
      }),
    )
    const off = yield* events.listen((event) =>
      Effect.sync(() => {
        notified.push(event.type)
      }),
    )
    yield* Effect.addFinalizer(() => off)
    for (const type of [
      SessionV1.Event.Created.type,
      SessionV1.Event.Updated.type,
      SessionV1.Event.MessageUpdated.type,
      SessionV1.Event.PartUpdated.type,
    ]) {
      const id = SessionSchema.ID.create()
      const info = SessionV1.SessionInfo.make({
        id,
        projectID: ProjectV2.ID.global,
        slug: "mismatch",
        directory: "/owner",
        title: "Mismatch",
        version: "test",
        time: { created: 1, updated: 1 },
      })
      const nested =
        type === SessionV1.Event.Created.type || type === SessionV1.Event.Updated.type
          ? { info: { ...info, id: other } }
          : type === SessionV1.Event.MessageUpdated.type
            ? { info: { sessionID: other } }
            : { part: { sessionID: other } }
      const malformed = {
        id: EventV2.ID.create(),
        type: EventV2.versionedType(type, 1),
        seq: 1,
        aggregateID: id,
        data: { sessionID: id, ...nested },
      }
      const result = yield* events
        .replayAll(
          [
            {
              id: EventV2.ID.create(),
              type: EventV2.versionedType(SessionV1.Event.Created.type, 1),
              seq: 0,
              aggregateID: id,
              data: { sessionID: id, info },
            },
            malformed,
          ],
          { publish: true },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* audience.knows(id)).toBe(false)
      expect(projected).toEqual([])
      expect(notified).toEqual([])
      expect(Exit.isFailure(yield* events.replay(malformed, { publish: true }).pipe(Effect.exit))).toBe(true)
    }
    const id = SessionSchema.ID.create()
    const info = SessionV1.SessionInfo.make({
      id: other,
      projectID: ProjectV2.ID.global,
      slug: "mismatch",
      directory: "/owner",
      title: "Mismatch",
      version: "test",
      time: { created: 1, updated: 1 },
    })
    expect(
      Exit.isFailure(yield* events.publish(SessionV1.Event.Created, { sessionID: id, info }).pipe(Effect.exit)),
    ).toBe(true)
    expect(projected).toEqual([])
    expect(notified).toEqual([])
  }),
)

it.effect("new guest creation atomically links and admits before publication, without entering a private parent", () =>
  Effect.gen(function* () {
    const audience = yield* SessionAudience.Service
    yield* audience.register({ sessionID: "ses_new_guest_root", actor: "guest" })
    expect(yield* audience.hasGuestInput("ses_new_guest_root")).toBe(true)
    expect(yield* audience.canIsolate("ses_new_guest_root", "owner")).toBe(false)
    yield* audience.fenceIsolation({ sessionID: "ses_private_parent", actor: "owner" })
    const result = yield* audience
      .register({ sessionID: "ses_refused_guest_child", parentID: "ses_private_parent", actor: "guest" })
      .pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(yield* audience.knows("ses_refused_guest_child")).toBe(false)
    expect(yield* audience.hasGuestInput("ses_private_parent")).toBe(false)
    expect(yield* audience.isPrivate("ses_private_parent")).toBe(true)
  }),
)

it.live("historical guest marks use the actual session ID decoder and become durable", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const temporary = yield* Effect.acquireRelease(Effect.promise(tmpdir), (value) =>
      Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = Flag.VECTOR_AGENT_DB
        Flag.VECTOR_AGENT_DB = path.join(temporary.path, "fixture.db")
        return previous
      }),
      (previous) =>
        Effect.sync(() => {
          Flag.VECTOR_AGENT_DB = previous
        }),
    )
    const file = path.join(temporary.path, "free-model-guest-sessions.txt")
    yield* Effect.promise(() => fs.writeFile(file, "ses_legacy_guest_root\ninvalid\n"))
    const audience = SessionAudience.make(database)
    expect(yield* audience.canIsolate("ses_legacy_guest_root", "owner")).toBe(false)
    expect(
      Exit.isFailure(
        yield* audience.fenceIsolation({ sessionID: "ses_legacy_guest_root", actor: "owner" }).pipe(Effect.exit),
      ),
    ).toBe(true)
    yield* Effect.promise(() => fs.rm(file))
    expect(yield* audience.hasGuestInput("ses_legacy_guest_root")).toBe(true)
    expect(yield* audience.isPrivate("ses_legacy_guest_root")).toBe(false)
  }),
)

// An older engine on the same data folder lets a guest into a conversation it does not know is fenced, and lists it.
it.live("a legacy guest mark written after the fence leaves the fenced family working for its owner", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const temporary = yield* Effect.acquireRelease(Effect.promise(tmpdir), (value) =>
      Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = Flag.VECTOR_AGENT_DB
        Flag.VECTOR_AGENT_DB = path.join(temporary.path, "fixture.db")
        return previous
      }),
      (previous) =>
        Effect.sync(() => {
          Flag.VECTOR_AGENT_DB = previous
        }),
    )
    const audience = SessionAudience.make(database)
    yield* audience.register({ sessionID: "ses_marked_root" })
    yield* audience.register({ sessionID: "ses_marked_child", parentID: "ses_marked_root" })
    yield* audience.fenceIsolation({ sessionID: "ses_marked_child", actor: "owner", directory: temporary.path })
    yield* Effect.promise(() =>
      fs.writeFile(path.join(temporary.path, "free-model-guest-sessions.txt"), "ses_marked_root\n"),
    )
    // The calls the owner's work keeps making in the family: a new child (Session.createNext, and the event-level
    // registration of its Created event), a fork, and the fence asserted again (notes, recovery, isolation hints).
    yield* audience.register({ sessionID: "ses_marked_later", parentID: "ses_marked_root", actor: "owner" })
    yield* audience.register({ sessionID: "ses_marked_event", parentID: "ses_marked_child" })
    yield* audience.register({ sessionID: "ses_marked_fork", forkOf: "ses_marked_root" })
    yield* audience.fenceIsolation({ sessionID: "ses_marked_child", actor: "owner" })
    // The family stays private, refuses a guest, and the list still counts: no new isolation starts in it.
    expect(yield* audience.isPrivate("ses_marked_later")).toBe(true)
    expect(Exit.isFailure(yield* audience.markGuest("ses_marked_root").pipe(Effect.exit))).toBe(true)
    expect(
      Exit.isFailure(
        yield* audience
          .register({ sessionID: "ses_marked_guest", parentID: "ses_marked_root", actor: "guest" })
          .pipe(Effect.exit),
      ),
    ).toBe(true)
    expect(yield* audience.hasGuestInput("ses_marked_root")).toBe(true)
    expect(yield* audience.canIsolate("ses_marked_root", "owner")).toBe(false)
    // An unfenced conversation the list names is still imported, durably.
    yield* Effect.promise(() =>
      fs.appendFile(path.join(temporary.path, "free-model-guest-sessions.txt"), "ses_marked_other\n"),
    )
    yield* audience.register({ sessionID: "ses_marked_other" })
    yield* Effect.promise(() => fs.rm(path.join(temporary.path, "free-model-guest-sessions.txt")))
    expect(yield* audience.hasGuestInput("ses_marked_other")).toBe(true)
  }),
)

// Imports run inside each decision's write transaction, and a refused registration rolls its transaction back. What
// it imported must then be imported again, however often the unchanged list has been read meanwhile.
it.live("legacy guest marks a refused registration imported are imported again by the next decision", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const temporary = yield* Effect.acquireRelease(Effect.promise(tmpdir), (value) =>
      Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = Flag.VECTOR_AGENT_DB
        Flag.VECTOR_AGENT_DB = path.join(temporary.path, "fixture.db")
        return previous
      }),
      (previous) =>
        Effect.sync(() => {
          Flag.VECTOR_AGENT_DB = previous
        }),
    )
    const audience = SessionAudience.make(database)
    yield* audience.register({ sessionID: "ses_rollback_root" })
    yield* audience.fenceIsolation({ sessionID: "ses_rollback_root", actor: "owner", directory: temporary.path })
    yield* Effect.promise(() =>
      fs.writeFile(path.join(temporary.path, "free-model-guest-sessions.txt"), "ses_rollback_guest\n"),
    )
    expect(
      Exit.isFailure(
        yield* audience
          .register({ sessionID: "ses_rollback_child", parentID: "ses_rollback_root", actor: "guest" })
          .pipe(Effect.exit),
      ),
    ).toBe(true)
    // The list is unchanged, and the listed conversation is still a guest's: it may not be fenced.
    expect(
      Exit.isFailure(
        yield* audience.fenceIsolation({ sessionID: "ses_rollback_guest", actor: "owner" }).pipe(Effect.exit),
      ),
    ).toBe(true)
    yield* audience.register({ sessionID: "ses_rollback_later" })
    yield* audience.register({ sessionID: "ses_rollback_last" })
    // The mark is durable: it holds once the list is gone.
    yield* Effect.promise(() => fs.rm(path.join(temporary.path, "free-model-guest-sessions.txt")))
    expect(yield* audience.hasGuestInput("ses_rollback_guest")).toBe(true)
    expect(yield* audience.canIsolate("ses_rollback_guest", "owner")).toBe(false)
  }),
)

it.live("an unreadable legacy guest list fails closed for privacy decisions and stops nothing else", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const temporary = yield* Effect.acquireRelease(Effect.promise(tmpdir), (value) =>
      Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = Flag.VECTOR_AGENT_DB
        Flag.VECTOR_AGENT_DB = path.join(temporary.path, "fixture.db")
        return previous
      }),
      (previous) =>
        Effect.sync(() => {
          Flag.VECTOR_AGENT_DB = previous
        }),
    )
    const audience = SessionAudience.make(database)
    yield* audience.register({ sessionID: "ses_unreadable_fenced" })
    yield* audience.fenceIsolation({ sessionID: "ses_unreadable_fenced", actor: "owner" })
    // The list's path is now a folder, so reading it fails with something other than "not found", as a file a
    // scanner holds open does on Windows.
    const file = path.join(temporary.path, "free-model-guest-sessions.txt")
    yield* Effect.promise(() => fs.mkdir(file))
    // Registering conversations still works.
    yield* audience.register({ sessionID: "ses_unreadable_root" })
    yield* audience.register({ sessionID: "ses_unreadable_child", parentID: "ses_unreadable_root" })
    // An unfenced family is treated as having guest input: guards apply and isolation is refused.
    expect(yield* audience.hasGuestInput("ses_unreadable_child")).toBe(true)
    expect(yield* audience.canIsolate("ses_unreadable_root", "owner")).toBe(false)
    const refused = yield* audience
      .fenceIsolation({ sessionID: "ses_unreadable_root", actor: "owner" })
      .pipe(Effect.exit)
    expect(Exit.isFailure(refused)).toBe(true)
    expect(yield* audience.isPrivate("ses_unreadable_root")).toBe(false)
    // A fenced family read the list when it was fenced and refuses guest input since, so it stays its owner's and may
    // add roots.
    expect(yield* audience.hasGuestInput("ses_unreadable_fenced")).toBe(false)
    yield* audience.fenceIsolation({ sessionID: "ses_unreadable_fenced", actor: "owner", directory: temporary.path })
    expect(yield* audience.isPrivateDirectory(path.join(temporary.path, "src"))).toBe(true)
    // Once it can be read again, a missing list marks nothing.
    yield* Effect.promise(() => fs.rm(file, { recursive: true }))
    expect(yield* audience.hasGuestInput("ses_unreadable_child")).toBe(false)
    yield* audience.fenceIsolation({ sessionID: "ses_unreadable_root", actor: "owner" })
    expect(yield* audience.isPrivate("ses_unreadable_child")).toBe(true)
  }),
)

it.effect(
  "thousands of private roots keep text and directory checks fast, and a root added later is seen at once",
  () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const audience = yield* SessionAudience.Service
      // 5,000 roots, about what 1,700 isolated tasks leave behind, written directly as another engine would.
      yield* db.run(
        sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
      INSERT INTO session_private_directory(directory, session_id)
      SELECT '/data/vector/task-worktree/prj/ses_' || i, 'ses_' || i FROM n`,
      )
      const text = JSON.stringify({ output: `${"x".repeat(8_000)} /data/vector/task-worktree/prj/ses_other/a.ts` })
      const started = performance.now()
      for (const _ of Array.from({ length: 200 })) {
        expect(yield* audience.containsPrivateText(text)).toBe(false)
        expect(yield* audience.isPrivateDirectory("/data/vector/task-worktree/prj/elsewhere/a.ts")).toBe(false)
      }
      // The earlier per-root scan took several seconds for these checks.
      expect(performance.now() - started).toBeLessThan(2_000)
      // Any spelling of a root deep in the list is found, and so is anything inside one.
      expect(yield* audience.containsPrivateText("see /data/vector/task-worktree/prj/ses_4999/src")).toBe(true)
      expect(
        yield* audience.containsPrivateText(JSON.stringify({ path: "/data/vector/task-worktree/prj/ses_2500" })),
      ).toBe(true)
      expect(yield* audience.isPrivateDirectory("/data/vector/task-worktree/prj/ses_3000/src/index.ts")).toBe(true)
      // A root another engine adds after the roots were read is seen by the next check.
      yield* db.run(
        sql`INSERT INTO session_private_directory(directory, session_id) VALUES ('/data/late/root', 'ses_late')`,
      )
      expect(yield* audience.containsPrivateText("cd /data/late/root && ls")).toBe(true)
      expect(yield* audience.isPrivateDirectory("/data/late/root/a")).toBe(true)
    }),
)
