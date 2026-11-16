import { expect, test } from "bun:test"
import ts from "typescript"

test("web shell declares a restrictive CSP and no-referrer policy", async () => {
  const html = await Bun.file(new URL("../index.html", import.meta.url)).text()
  expect(html).toContain('name="referrer" content="no-referrer"')
  expect(html).toContain("default-src 'self'")
  expect(html).toContain("object-src 'none'")
  expect(html).toContain("frame-src 'none'")
  expect(html).not.toContain("frame-ancestors")
  expect(html).toContain("'wasm-unsafe-eval'")
  expect(html).toContain("img-src 'self' data: blob:")
  expect(html).toContain("media-src 'self' data: blob:")
  expect(html).not.toContain("img-src https:")
})

test("the computer test harness is confined to a statically removable development branch", async () => {
  const source = await Bun.file(new URL("./entry.tsx", import.meta.url)).text()
  // Inspect runtime code after type erasure, so Window declarations and type-only fake imports remain harmless.
  const runtime = ts.transpileModule(source, {
    fileName: "entry.tsx",
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      verbatimModuleSyntax: true,
    },
  }).outputText
  const file = ts.createSourceFile("entry.jsx", runtime, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX)
  const guards: ts.IfStatement[] = []
  const imports: ts.StringLiteralLike[] = []
  const references: ts.Node[] = []
  const renders: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isIfStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      node.expression.left.getText(file) === "import.meta.env.DEV" &&
      node.expression.right.getText(file) === "window.__vectorE2E?.computer"
    )
      guards.push(node)
    if (ts.isStringLiteralLike(node) && /\/computer\/fake-platform(?:\.[jt]sx?)?$/.test(node.text)) imports.push(node)
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === "__vectorE2E") references.push(node)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "render")
      renders.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(guards).toHaveLength(1)
  const guard = guards[0]!
  expect(ts.isBlock(guard.thenStatement)).toBe(true)

  const within = (node: ts.Node, ancestor: ts.Node) => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (current === ancestor) return true
    }
    return false
  }

  // Every module reference must be a dynamic import inside the branch; a static import cannot be tree-shaken by it.
  expect(imports).toHaveLength(1)
  for (const module of imports) {
    expect(ts.isCallExpression(module.parent) && module.parent.expression.kind === ts.SyntaxKind.ImportKeyword).toBe(
      true,
    )
    expect(ts.isAwaitExpression(module.parent.parent)).toBe(true)
    expect(within(module, guard.thenStatement)).toBe(true)
  }
  expect(references.length).toBeGreaterThan(1)
  expect(references.filter((node) => !within(node, guard.expression) && !within(node, guard.thenStatement))).toEqual([])
  expect(renders).toHaveLength(1)
  expect(imports[0]!.getStart(file)).toBeLessThan(renders[0]!.getStart(file))
})
