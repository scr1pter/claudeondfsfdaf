import { expect, test } from "bun:test"
import path from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

// As in sign-in-page.test.ts: this package's tsconfig compiles JSX for Solid, and Astro builds the React islands
// itself, so the account island and the download panel it embeds are compiled here with React's automatic runtime.
const react = new Bun.Transpiler({
  loader: "tsx",
  autoImportJSX: true,
  tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" } },
})
Bun.plugin({
  name: "react islands",
  setup(build) {
    build.onLoad({ filter: /components\/marketing\/(account|download)\/[^/]+\.tsx$/ }, async (args) => ({
      contents: react.transformSync(await Bun.file(args.path).text()),
      loader: "js",
    }))
  },
})
const { AccountPage } = await import("../src/components/marketing/account/AccountPage")

type Account = NonNullable<Parameters<typeof AccountPage>[0]["preview"]>
const page = (account: Account) => renderToStaticMarkup(createElement(AccountPage, { preview: account }))
const DESIGN_TAB = '<a href="/design">Design</a>'

test("the Design tab follows the server's owner answer, whatever the address", () => {
  const user = { id: "usr_preview", email: "owner@example.com", name: "Vector Owner" }
  expect(page({ user, owner: true })).toContain(DESIGN_TAB)
  expect(page({ user, owner: false })).not.toContain(DESIGN_TAB)
  // An answer without the field, as from a server that predates it, shows no owner links.
  expect(page({ user })).not.toContain(DESIGN_TAB)
  expect(page({ user: { ...user, email: "someone@example.com" }, owner: true })).toContain(DESIGN_TAB)
})

// Who the owner is is the server's answer (api/account/status), so the browser code never needs to name anyone.
// Addresses at the reserved example domains are placeholders, and test files may hold any fixture.
test("the site's components and libraries carry no one's email address", async () => {
  const source = path.join(import.meta.dir, "../src")
  const address = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
  const placeholder = /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/
  const found: string[] = []
  let scanned = 0
  for (const directory of ["components", "lib"]) {
    for (const file of new Bun.Glob("**/*.{ts,tsx,js,mjs,astro}").scanSync({ cwd: path.join(source, directory) })) {
      if (/\.test\.[cm]?[jt]sx?$/.test(file)) continue
      scanned++
      const text = await Bun.file(path.join(source, directory, file)).text()
      for (const [match] of text.matchAll(address)) {
        if (!placeholder.test(match.slice(match.indexOf("@") + 1).toLowerCase())) found.push(`${directory}/${file}`)
      }
    }
  }
  expect(scanned).toBeGreaterThan(20)
  expect(found).toEqual([])
})
