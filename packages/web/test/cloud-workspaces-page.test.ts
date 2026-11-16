import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

// As in account-page.test.ts: this package's tsconfig compiles JSX for Solid, and Astro builds the React islands itself,
// so the workspace island is compiled here with React's automatic runtime.
const react = new Bun.Transpiler({
  loader: "tsx",
  autoImportJSX: true,
  tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" } },
})
Bun.plugin({
  name: "react workspace island",
  setup(build) {
    build.onLoad({ filter: /components\/workspaces\/[^/]+\.tsx$/ }, async (args) => ({
      contents: react.transformSync(await Bun.file(args.path).text()),
      loader: "js",
    }))
  },
})
const { CloudWorkspaces } = await import("../src/components/workspaces/CloudWorkspaces")

// The production site build keeps /workspaces (script/prune-vector-site.mjs), so anyone can open it while the pilot is
// off by default; before sign-in it must not read as a launched product.
test("the public workspaces page says the pilot is closed before anyone signs in", () => {
  const html = renderToStaticMarkup(createElement(CloudWorkspaces))
  expect(html).toContain("<h1>Cloud workspaces are a private pilot.</h1>")
  expect(html).toContain("The pilot is not open to everyone yet.")
  expect(html).not.toContain("wherever you are")
  expect(html).not.toMatch(/credit|\$\d|per token/i)
})
