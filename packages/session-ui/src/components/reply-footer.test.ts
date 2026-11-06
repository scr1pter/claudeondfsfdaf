import { describe, expect, test } from "bun:test"
import { ReplyFooter, type ReplyFooterComponent } from "./reply-footer"

describe("ReplyFooter", () => {
  test("keeps every registered component, in registration order, so a later chip never replaces an earlier one", () => {
    const learned: ReplyFooterComponent = () => null
    const workflow: ReplyFooterComponent = () => null
    ReplyFooter.register(learned)
    ReplyFooter.register(workflow)
    const list = ReplyFooter.list()
    expect(list).toContain(learned)
    expect(list).toContain(workflow)
    expect(list.indexOf(learned)).toBeLessThan(list.indexOf(workflow))
  })

  test("registering the same component again draws it once", () => {
    const chip: ReplyFooterComponent = () => null
    ReplyFooter.register(chip)
    ReplyFooter.register(chip)
    expect(ReplyFooter.list().filter((footer) => footer === chip)).toHaveLength(1)
  })
})
