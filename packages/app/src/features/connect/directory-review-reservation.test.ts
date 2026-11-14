import { expect, test } from "bun:test"
import { createDirectoryReviewController } from "./directory-review-controller"
import { createDirectoryReviewReservation } from "./directory-review-reservation"

const key = "opaque-workspace-scope"
const body = { target: { kind: "branch" as const, base: "a".repeat(40) }, background: true }
const first = "0196aa50-50d0-4f17-9c1d-85eff018e829"
const second = "0196aa50-50d0-4f17-9c1d-85eff018e830"

function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => void values.set(name, value),
    removeItem: (name: string) => void values.delete(name),
  }
  let minted = 0
  const make = () =>
    createDirectoryReviewReservation({ storage, key, body, requestKey: () => (++minted === 1 ? first : second) })
  return { storage, make, minted: () => minted }
}

for (const mutation of ["remove", "replace"] as const)
  test(`an uncertain actual controller refuses retry when its saved request is ${mutation}d`, async () => {
    const f = fixture()
    const reservation = f.make()
    const posts: unknown[] = []
    const controller = createDirectoryReviewController({
      target: { workspaceID: "workspace", directory: "/workspace/fixture", base: body.target.base },
      enabled: true,
      current: () => true,
      admission: reservation,
      changed() {},
      subscribe: () => () => {},
      transport: {
        runs: async () => [],
        get: async () => {
          throw new Error("No confirmed review exists")
        },
        start: async () => {
          const request = reservation.request()
          expect(JSON.parse(f.storage.getItem(key)!)).toEqual(request)
          posts.push(request)
          throw new TypeError("The successful POST response was lost")
        },
        pending: async () => [],
        reply: async () => {},
        cancel: async () => {},
      },
    })
    try {
      await controller.refresh()
      await controller.start()
      expect(posts).toEqual([{ requestKey: first, ...body }])
      expect(controller.state.admissionUncertain).toBe(true)
      if (mutation === "remove") f.storage.removeItem(key)
      else f.storage.setItem(key, JSON.stringify({ requestKey: second, ...body }))
      await controller.start(true)
      expect(posts).toHaveLength(1)
      expect(f.minted()).toBe(1)
      expect(controller.state.admissionUncertain).toBe(true)
      expect(controller.state.error).toContain("cannot be tracked safely")
    } finally {
      controller.dispose()
    }
  })

test("same-body retries and remounts retain the captured key until that exact request is confirmed", () => {
  const f = fixture()
  const original = f.make()
  original.hold(false)
  const request = original.request()
  original.hold(true)
  expect(original.request()).toEqual(request)
  const remounted = f.make()
  expect(remounted.pending()).toBe(true)
  remounted.hold(true)
  expect(remounted.request()).toEqual(request)
  expect(f.minted()).toBe(1)
  remounted.confirm()
  expect(() => original.hold(true)).toThrow("original review request")
  expect(original.pending()).toBe(true)
  expect(f.minted()).toBe(1)
  expect(remounted.pending()).toBe(false)
  remounted.hold(false)
  expect(remounted.request()).toEqual({ requestKey: second, ...body })
  expect(f.minted()).toBe(2)
})

test("unconfirmed markers cannot be replaced or retargeted, including after remount", () => {
  const f = fixture()
  const original = f.make()
  original.hold(false)
  f.storage.setItem(key, JSON.stringify({ requestKey: second, ...body }))
  expect(() => original.hold(true)).toThrow("original review request")
  expect(() => original.confirm()).toThrow("changed")
  expect(f.storage.getItem(key)).toBe(JSON.stringify({ requestKey: second, ...body }))
  f.storage.setItem(key, JSON.stringify({ requestKey: first, target: { kind: "staged" }, background: true }))
  expect(() => f.make()).toThrow("does not match this workspace")
  expect(f.minted()).toBe(1)
})
