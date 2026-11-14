import { describe, expect, test } from "bun:test"
import { codiumAccountAuthority } from "../../../api/_lib/everywhere/adapters/account"
import { accountGuards, authorizedCommands, checkAccount } from "../../../api/_lib/everywhere/authority"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { tombstoneKey } from "../../../api/_lib/codium-tombstone"
import type { Store } from "../../../api/_lib/everywhere/store"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeStore } from "./lib/everywhere-store"

installFetchGuard()
const account = "abcd1234-abcd-4abc-8abc-abcdef123456"
const fixture = () => {
  const fake = new FakeStore()
  const store: Store = async (command) => fake.send(command)
  return { fake, context: { store, accountAuthority: codiumAccountAuthority } }
}

describe("Everywhere trusted account deletion adapter", () => {
  test("uses the actual deletion module's mode-separated key and refuses non-account input", async () => {
    expect(await codiumAccountAuthority(account)).toEqual({ tombstoneKey: tombstoneKey(account) })
    expect(await codiumAccountAuthority(account.toUpperCase())).toEqual({ tombstoneKey: tombstoneKey(account) })
    for (const value of ["", "owner", `${account}:other`, ` ${account}`, `${account}\n`])
      expect(await codiumAccountAuthority(value)).toBeUndefined()
  })

  test("any upstream tombstone bytes close admission without writing either account namespace", async () => {
    const f = fixture()
    await checkAccount(f.context, account)
    for (const value of ["deleting", "{}", "null", ""]) {
      f.fake.send(["SET", tombstoneKey(account), value])
      const before = f.fake.commands.length
      await expect(checkAccount(f.context, account)).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
      expect(f.fake.commands.slice(before).every((command) => command[0] === "GET")).toBe(true)
    }
  })

  test("a deletion between admission and commit fences the write using the real sibling key", async () => {
    const f = fixture()
    const guards = await accountGuards(f.context, account)
    const key = everywhereKeys.seen(account)
    f.fake.send(["SET", tombstoneKey(account), "deleted after admission"])
    await expect(authorizedCommands(f.context.store, guards, [["SET", key, "1"]])).rejects.toMatchObject({
      code: "EVERYWHERE_AUTHORITY_CHANGED",
    })
    expect(f.fake.send(["GET", key])).toBeNull()
    expect(f.fake.send(["GET", tombstoneKey(account)])).toBe("deleted after admission")
  })

  test("the permanent Everywhere close marker and store outages still fail closed", async () => {
    const f = fixture()
    f.fake.send(["SET", everywhereKeys.accountClosed(account), "closed"])
    await expect(checkAccount(f.context, account)).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
    f.fake.down = true
    await expect(checkAccount(f.context, account)).rejects.toBeDefined()
  })
})
