import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { descriptorReceipt, inspectOwnDescriptorMetadata } from "../fixture/sandbox-fd-observation"

const dummy = { dev: 17n, ino: 29n }
const ordinary = { dev: 17n, ino: 30n }

function inspect(
  descriptors: Readonly<Record<number, typeof dummy>>,
  listed = Object.keys(descriptors),
  missing = "EBADF",
) {
  return runInNewContext(inspectOwnDescriptorMetadata, {
    require(name: string) {
      expect(name).toBe("node:fs")
      return {
        readdirSync(file: string) {
          expect(file).toBe("/proc/self/fd")
          return listed
        },
        fstatSync(fd: number, options: unknown) {
          expect(options).toEqual({ bigint: true })
          if (!descriptors[fd]) throw Object.assign(new Error("Synthetic descriptor"), { code: missing })
          return descriptors[fd]
        },
      }
    },
  }) as (expected: string, fixedDescriptors?: string[]) => unknown
}

test("matches only the dummy descriptor identity, regardless of its slot", () => {
  const expected = "17:29"
  expect(descriptorReceipt(inspect({ 1: ordinary, 3: ordinary, 11: dummy })(expected), true)).toBe(true)
  expect(descriptorReceipt(inspect({ 1: ordinary, 3: ordinary })(expected), false)).toBe(true)
  expect(descriptorReceipt(inspect({ 1: ordinary, 3: dummy })(expected, ["1", "3"]), true)).toBe(true)
})

test("exclusion requires live stdout and a complete descriptor observation", () => {
  expect(descriptorReceipt(inspect({ 1: ordinary }, ["1", "3"])("17:29"), false)).toBe(true)
  expect(descriptorReceipt(inspect({ 3: ordinary })("17:29"), false)).toBe(false)
  expect(descriptorReceipt({ stdout: true }, false)).toBe(false)
  expect(() => inspect({ 1: ordinary }, ["1", "3"], "EACCES")("17:29")).toThrow("Synthetic descriptor")
  expect(() =>
    inspect(
      {},
      Array.from({ length: 1025 }, (_, fd) => String(fd)),
    )("17:29"),
  ).toThrow("Too many descriptors")
})
