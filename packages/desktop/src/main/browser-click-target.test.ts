import { describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { clickTargetLabel } from "./browser-click-target"

// Against happy-dom (the app package's DOM for tests), the way the page runs it: serialized with toString() and rebuilt
// with no access to this module, so a function that read anything from module scope would fail.
const load = createRequire(
  realpathSync(path.join(import.meta.dir, "../../../app/node_modules/@happy-dom/global-registrator/package.json")),
)
const { GlobalRegistrator } = load("@happy-dom/global-registrator") as {
  GlobalRegistrator: { register: (options: { url: string }) => void }
}
GlobalRegistrator.register({ url: "https://dashboard.example/projects" })

const label = new Function(`return (${clickTargetLabel.toString()})`)() as typeof clickTargetLabel

const page = (html: string) => {
  document.body.innerHTML = html
}
const byId = (id: string) => document.getElementById(id)!

describe("clickTargetLabel", () => {
  test("names what a positional selector would press", () => {
    page(`<button id="promote">Promote</button>
      <button id="rollback"><span id="inside"></span>Instant Rollback</button>
      <button id="more"><svg id="icon" aria-label="More"></svg>Instant Rollback</button>`)
    expect(label(byId("promote"))).toBe("Promote")
    expect(label(byId("inside"))).toBe("Instant Rollback")
    expect(label(byId("icon"))).toContain("Instant Rollback")
  })

  test("reads an icon button's accessible name and a submit input's value", () => {
    page(`<button id="delete" aria-label="Delete project"></button><input id="save" type="submit" value="Save">`)
    expect(label(byId("delete"))).toContain("Delete project")
    expect(label(byId("save"))).toBe("Save")
  })

  test("reads a name given by aria-labelledby, in the document or the button's own shadow root", () => {
    page(`<button id="icon" aria-labelledby="tip"><svg></svg></button>
      <span id="tip" role="tooltip">Delete repository</span>
      <div id="host"></div>`)
    expect(label(byId("icon"))).toBe("Delete repository")
    const shadow = byId("host").attachShadow({ mode: "open" })
    shadow.innerHTML = `<button id="inner" aria-labelledby="inner-tip"></button><span id="inner-tip">Remove member</span>`
    expect(label(shadow.getElementById("inner")!)).toBe("Remove member")
  })

  test("reads an image's alt, inside a button or as an image input", () => {
    page(`<button id="remove"><img src="x.png" alt="Remove member"></button>
      <input id="pay" type="image" src="pay.png" alt="Pay now">`)
    expect(label(byId("remove"))).toBe("Remove member")
    expect(label(byId("pay"))).toBe("Pay now")
  })

  test("never puts what a text or password field holds into the label", () => {
    page(`<input id="secret" type="password" value="sk_live_abcdefghijklmnop">
      <input id="search" type="text" value="how to delete my account">
      <label id="wrap">Search <input id="wrapped" value="delete everything"></label>`)
    expect(label(byId("secret"))).toBe("")
    expect(label(byId("search"))).toBe("")
    expect(label(byId("wrapped"))).toBe("Search")
  })
})
