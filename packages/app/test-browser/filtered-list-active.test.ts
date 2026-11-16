import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { useFilteredList } from "@vectordevai/ui/hooks"

type Row = { id: string }

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }))

/** A list whose leading rows arrive later, as rows from a slower source do while the filter stays the same. */
function setup(keepActive?: boolean) {
  return createRoot((dispose) => {
    const [late, setLate] = createSignal<Row[]>([])
    const list = useFilteredList<Row>({
      items: () => [...late(), ...rows("alpha", "beta", "gamma")],
      key: (row) => row.id,
      filterKeys: ["id"],
      keepActive,
    })
    return { list, setLate, dispose }
  })
}

describe("useFilteredList active row", () => {
  test("rows arriving under the same filter keep the row the user moved to while it is listed", async () => {
    const { list, setLate, dispose } = setup(true)
    await settle()
    expect(list.active()).toBe("alpha")
    list.setActive("gamma")
    setLate(rows("apps"))
    await settle()
    expect(list.flat().map((row) => row.id)).toEqual(["apps", "alpha", "beta", "gamma"])
    expect(list.active()).toBe("gamma")
    dispose()
  })

  test("without a user move, arriving rows select the new first row", async () => {
    const { list, setLate, dispose } = setup(true)
    await settle()
    expect(list.active()).toBe("alpha")
    setLate(rows("apps"))
    await settle()
    expect(list.active()).toBe("apps")
    dispose()
  })

  test("a new filter selects its first row even after the user moved", async () => {
    const { list, setLate, dispose } = setup(true)
    await settle()
    list.setActive("gamma")
    list.onInput("a")
    await settle()
    expect(list.active()).toBe(list.flat()[0].id)
    // The user's row under this filter survives later rows; a row no longer listed selects the first again.
    list.setActive("beta")
    setLate(rows("apps"))
    await settle()
    expect(list.active()).toBe("beta")
    list.onInput("gam")
    await settle()
    expect(list.active()).toBe("gamma")
    dispose()
  })

  test("other lists keep selecting the first row when their rows change", async () => {
    const { list, setLate, dispose } = setup()
    await settle()
    list.setActive("gamma")
    setLate(rows("apps"))
    await settle()
    expect(list.active()).toBe("apps")
    dispose()
  })
})
