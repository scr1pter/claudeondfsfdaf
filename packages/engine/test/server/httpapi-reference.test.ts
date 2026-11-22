import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Global } from "@vectordevai/core/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { Effect } from "effect"
import { pollWithTimeout } from "../lib/effect"

afterEach(async () => {
  // The git reference starts a clone of github.com/Effect-TS/effect in the background of the location's services, which
  // disposeAllInstances leaves running (they idle for an hour). Ending them here interrupts that clone, so its git never
  // starts after this file, under the next file's network guard.
  expect((await Server.Default().app.request("/global/dispose", { method: "POST" })).status).toBe(200)
  await disposeAllInstances()
  await resetDatabase()
})

describe("reference HttpApi", () => {
  test("lists usable references resolved in the server workspace", async () => {
    await using tmp = await tmpdir({
      trusted: true,
      config: {
        formatter: false,
        lsp: false,
        references: {
          docs: "./docs",
          effect: { repository: "Effect-TS/effect", branch: "main" },
          bad: "not-a-repo",
        },
      },
    })

    const body = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const response = await Server.Default().app.request("/api/reference", {
            headers: { "x-vector-directory": tmp.path },
          })
          expect(response.status).toBe(200)
          const body = await response.json()
          return body.data.length === 0 ? undefined : body
        }),
        "references were not loaded",
      ),
    )
    expect(body).toMatchObject({ location: { directory: tmp.path } })
    expect(body.data).toEqual([
      {
        name: "docs",
        path: path.join(tmp.path, "docs"),
        source: {
          type: "local",
          path: path.join(tmp.path, "docs"),
        },
      },
      {
        name: "effect",
        path: path.join(Global.Path.repos, "github.com", "Effect-TS", "effect"),
        source: {
          type: "git",
          repository: "Effect-TS/effect",
          branch: "main",
        },
      },
    ])
  })
})
