import { expect, test } from "bun:test"
import path from "node:path"
import { release112, release112Copy, release112Version } from "../src/data/vector-releases"

const page = path.join(import.meta.dir, "../src/pages/docs/research.astro")

test("the research docs say asking Vector to keep research asks you every time, under the 1.99.112 label", async () => {
  const text = await Bun.file(page).text()
  expect(text).toContain("{release112.since} asking Vector to save or keep the research does what <strong>Keep in brain</strong> does")
  expect(text).toContain("Vector asks every time, whatever your permission")
  expect(release112Version).toBe("1.99.112")
  expect(release112Copy("1.99.111")).toMatchObject({ since: "Coming in desktop 1.99.112:", shipped: false })
  expect(release112Copy("1.99.112")).toMatchObject({ since: "From desktop 1.99.112:", shipped: true })
  // Desktop 1.99.112 is published and the release workflow refuses a stable downgrade, so the label never goes back.
  expect(release112).toMatchObject({ since: "From desktop 1.99.112:", shipped: true })
})

test("the docs say every memory erase takes the research that goes with it", async () => {
  const research = await Bun.file(page).text()
  expect(research).not.toContain("does not remove research runs yet")
  expect(research).toContain("<code>vector memory erase</code> removes this repository's runs too")
  expect(research).toContain("<code>--everywhere</code> removes every\n            run, and <code>--personal</code> keeps them")
  const brain = await Bun.file(path.join(import.meta.dir, "../src/pages/docs/brain.astro")).text()
  expect(brain).toContain("session, and the Deep research runs it started.")
})
