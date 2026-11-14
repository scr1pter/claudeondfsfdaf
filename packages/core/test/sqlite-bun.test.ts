import { Database } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result } from "effect"
import { SafeIntegers, SqlClient } from "effect/unstable/sql/SqlClient"
import { Sqlite } from "../src/database/sqlite"
import { layer } from "../src/database/sqlite.bun"

function inspect(native: Database) {
  // Keep prepared statements reachable: passing must not depend on GC finalizing an unowned statement.
  const prepared = spyOn(native, "prepare")
  const close = native.close.bind(native)
  const state = { closed: 0 }
  native.close = () => {
    close(true)
    state.closed++
  }
  return {
    prepared,
    state,
    cleanup() {
      // A failed strict close has already failed the test; release its handles without hiding that failure.
      for (const result of prepared.mock.results) {
        if (result.type === "return" && !Reflect.get(result.value, "isFinalized")) result.value.finalize()
      }
      prepared.mockRestore()
      close()
    },
  }
}

test("Bun SQLite finalizes overflow statements before its scoped connection closes", async () => {
  let inspected: ReturnType<typeof inspect> | undefined
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        inspected = inspect((yield* Sqlite.Native) as Database)
        const client = yield* SqlClient
        for (let i = 0; i < 45; i++) {
          const query = client.unsafe(`SELECT ${i} AS value`)
          if (i % 2 === 0) expect(yield* query).toEqual([{ value: i }])
          else expect(yield* query.values).toEqual([[i]])
        }
        expect(
          inspected.prepared.mock.results.filter(
            (result) => result.type === "return" && !Reflect.get(result.value, "isFinalized"),
          ),
        ).toHaveLength(20)
      }).pipe(Effect.provide(layer({ filename: ":memory:" })), Effect.scoped),
    )
    expect(inspected?.state.closed).toBe(1)
    expect(inspected?.prepared.mock.results.filter((result) => result.type === "return").length).toBe(45)
    for (const result of inspected!.prepared.mock.results) {
      if (result.type === "return") expect(Reflect.get(result.value, "isFinalized")).toBe(true)
    }
  } finally {
    inspected?.cleanup()
  }
})

test("Bun SQLite reuses statements, resets integer mode and recovers after SQL errors", async () => {
  let inspected: ReturnType<typeof inspect> | undefined
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        inspected = inspect((yield* Sqlite.Native) as Database)
        const client = yield* SqlClient
        expect(yield* client.unsafe("SELECT ? AS value", [7])).toEqual([{ value: 7 }])
        expect(yield* client.unsafe("SELECT ? AS value", [8]).values).toEqual([[8]])
        expect(inspected.prepared).toHaveBeenCalledTimes(1)
        expect(yield* client.unsafe("SELECT ? AS value", [9]).pipe(Effect.provideService(SafeIntegers, true))).toEqual([
          { value: 9n },
        ])
        expect(yield* client.unsafe("SELECT ? AS value", [10])).toEqual([{ value: 10 }])
        expect(inspected.prepared).toHaveBeenCalledTimes(1)
        const malformed = yield* client.unsafe("THIS IS NOT SQL").pipe(Effect.result)
        expect(Result.isFailure(malformed)).toBe(true)
        if (Result.isFailure(malformed)) expect(malformed.failure._tag).toBe("SqlError")
        yield* client.unsafe("CREATE TABLE example (id INTEGER PRIMARY KEY)")
        yield* client.unsafe("INSERT INTO example VALUES (?)", [1])
        const failure = yield* client.unsafe("INSERT INTO example VALUES (?)", [1]).pipe(Effect.result)
        expect(Result.isFailure(failure)).toBe(true)
        yield* client.unsafe("INSERT INTO example VALUES (?)", [2])
        expect(yield* client.unsafe("SELECT count(*) AS count FROM example")).toEqual([{ count: 2 }])
      }).pipe(Effect.provide(layer({ filename: ":memory:" })), Effect.scoped),
    )
    expect(inspected?.state.closed).toBe(1)
  } finally {
    inspected?.cleanup()
  }
})

test("Bun SQLite releases an on-disk database before removing its directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vector-sqlite-close-"))
  let inspected: ReturnType<typeof inspect> | undefined
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        inspected = inspect((yield* Sqlite.Native) as Database)
        const client = yield* SqlClient
        yield* client.unsafe("CREATE TABLE example (value INTEGER)")
        yield* client.unsafe("INSERT INTO example VALUES (1)")
        for (let i = 0; i < 25; i++) {
          expect(yield* client.unsafe(`SELECT value + ${i} AS value FROM example`)).toEqual([{ value: i + 1 }])
        }
      }).pipe(Effect.provide(layer({ filename: join(directory, "test.db") })), Effect.scoped),
    )
    expect(inspected?.state.closed).toBe(1)
    await rm(directory, { recursive: true })
  } finally {
    inspected?.cleanup()
    await rm(directory, { recursive: true, force: true })
  }
})
