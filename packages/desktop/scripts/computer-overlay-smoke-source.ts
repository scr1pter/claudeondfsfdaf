import { createHash } from "node:crypto"
import { isBuiltin } from "node:module"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

export const COMPUTER_OVERLAY_ENTRYPOINTS = [
  {
    input: "scripts/computer-overlay-smoke-electron.ts",
    output: "computer-overlay-smoke-electron.mjs",
    format: "esm" as const,
  },
  { input: "src/preload/computer-overlay.ts", output: "computer-overlay-smoke-preload.cjs", format: "cjs" as const },
  { input: "test/computer/fake-helper.ts", output: "computer-fake-helper.mjs", format: "esm" as const },
] as const
export type OverlaySourceEntry = { path: string; bytes: Uint8Array }
export type OverlaySourceGraph = {
  repository: string
  entries: OverlaySourceEntry[]
  bunVersion: string
  resolverVersion: string
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const relativeName = (value: string) =>
  value.length > 0 &&
  !value.includes("\\") &&
  !value.includes(":") &&
  !value.startsWith("/") &&
  !/[\u0000-\u001f\u007f]/.test(value) &&
  value.split("/").every((part) => part && part !== "." && part !== "..")

/** Inspect real syntax and lexical bindings; a local assertion named require is an ordinary function. */
export function computerOverlayModuleReferences(file: string, source: string): string[] {
  const filename = file.replaceAll("\\", "/")
  const syntax = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    types: [],
    allowJs: true,
    target: ts.ScriptTarget.Latest,
  }
  const host = ts.createCompilerHost(options)
  const key = (name: string) =>
    ts.sys.useCaseSensitiveFileNames ? name.replaceAll("\\", "/") : name.replaceAll("\\", "/").toLowerCase()
  host.getSourceFile = (name) => (key(name) === key(filename) ? syntax : undefined)
  host.writeFile = () => {
    throw new Error("Overlay source admission cannot emit compiler output.")
  }
  // Binding this one admitted source supplies lexical symbols without resolving or typechecking
  // dependencies. The independent graph resolver below owns every actual module edge.
  const checker = ts.createProgram([filename], options, host).getTypeChecker()
  const modules = new Set<string>()
  function moduleName(value: ts.Node | undefined) {
    if (!value || !ts.isStringLiteralLike(value))
      throw new Error("The overlay source graph contains an unbounded runtime import.")
    modules.add(value.text)
  }
  function nodeRequireFactory(node: ts.Expression): boolean {
    if (!ts.isIdentifier(node)) return false
    const declarations = checker.getSymbolAtLocation(node)?.declarations ?? []
    return declarations.some((declaration) => {
      if (!ts.isImportSpecifier(declaration) || (declaration.propertyName ?? declaration.name).text !== "createRequire")
        return false
      const imported = declaration.parent.parent.parent
      return (
        ts.isImportDeclaration(imported) &&
        ts.isStringLiteralLike(imported.moduleSpecifier) &&
        ["node:module", "module"].includes(imported.moduleSpecifier.text)
      )
    })
  }
  function nodeRequireBinding(node: ts.Identifier): boolean {
    const declarations = checker.getSymbolAtLocation(node)?.declarations ?? []
    if (!declarations.length) return node.text === "require"
    if (
      declarations.every(
        (declaration) =>
          (ts.isFunctionDeclaration(declaration) && declaration.body !== undefined) ||
          (ts.isVariableDeclaration(declaration) &&
            declaration.initializer !== undefined &&
            (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))),
      )
    )
      return false
    if (
      declarations.some(
        (declaration) =>
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          ts.isCallExpression(declaration.initializer) &&
          nodeRequireFactory(declaration.initializer.expression),
      )
    )
      return true
    if (node.text === "require")
      throw new Error("The overlay source graph cannot prove a runtime module loader binding.")
    return false
  }
  function inspect(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) moduleName(node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      moduleName(node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node)) {
      if (!ts.isLiteralTypeNode(node.argument))
        throw new Error("The overlay source graph contains an unbounded type import.")
      moduleName(node.argument.literal)
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression
      let loader = expression.kind === ts.SyntaxKind.ImportKeyword
      if (ts.isIdentifier(expression)) loader ||= nodeRequireBinding(expression)
      else if (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "resolve" &&
        ts.isIdentifier(expression.expression)
      )
        loader ||= nodeRequireBinding(expression.expression)
      else if (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "require" &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "module"
      ) {
        if (checker.getSymbolAtLocation(expression.expression))
          throw new Error("The overlay source graph cannot prove a runtime module object binding.")
        loader = true
      }
      if (loader) {
        if (node.arguments.length !== 1)
          throw new Error("The overlay source graph contains an unbounded runtime import.")
        moduleName(node.arguments[0])
      }
    }
    ts.forEachChild(node, inspect)
  }
  inspect(syntax)
  return [...modules]
}

/** A Node-readable independent graph; runtime manifests cannot nominate or omit trusted source inputs. */
export async function computerOverlaySourceGraph(directory: string): Promise<OverlaySourceGraph> {
  const desktop = await realpath(directory),
    repository = await realpath(path.join(desktop, "../.."))
  if (!desktop.startsWith(repository + path.sep)) throw new Error("The overlay source root escaped its repository.")
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    resolveJsonModule: true,
    resolvePackageJsonExports: true,
    resolvePackageJsonImports: true,
    customConditions: ["node"],
  }
  const entries = new Map<string, OverlaySourceEntry>(),
    pending = COMPUTER_OVERLAY_ENTRYPOINTS.map((entry) => path.join(desktop, entry.input))
  async function add(file: string) {
    const canonical = await realpath(file),
      status = await lstat(canonical)
    if (
      !canonical.startsWith(repository + path.sep) ||
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.size > 16 * 1024 * 1024
    )
      throw new Error("An overlay source input is invalid.")
    const relative = path.relative(repository, canonical).split(path.sep).join("/")
    if (!relativeName(relative) || relative.startsWith("node_modules/"))
      throw new Error("An overlay source input is outside the workspace graph.")
    if (!entries.has(relative)) entries.set(relative, { path: relative, bytes: await readFile(canonical) })
    if (entries.size > 4096) throw new Error("The overlay source graph exceeded its bound.")
    return { canonical, entry: entries.get(relative)! }
  }
  for (const file of ["package.json", "bun.lock", "packages/desktop/package.json", "packages/desktop/tsconfig.json"])
    await add(path.join(repository, file))
  const packageValue: unknown = JSON.parse(Buffer.from(entries.get("package.json")!.bytes).toString("utf8"))
  if (
    !record(packageValue) ||
    typeof packageValue.packageManager !== "string" ||
    !/^bun@\d+\.\d+\.\d+$/.test(packageValue.packageManager)
  )
    throw new Error("The overlay compiler is not exactly pinned.")
  const visited = new Set<string>()
  while (pending.length) {
    const file = pending.pop()!,
      { canonical, entry } = await add(file)
    if (visited.has(canonical)) continue
    visited.add(canonical)
    // A nearest workspace package manifest owns export/import resolution, including Node conditions.
    let parent = path.dirname(canonical)
    while (parent.startsWith(repository + path.sep)) {
      const manifest = path.join(parent, "package.json")
      if (ts.sys.fileExists(manifest)) {
        await add(manifest)
        break
      }
      parent = path.dirname(parent)
    }
    if (canonical.endsWith(".json")) continue
    const source = Buffer.from(entry.bytes).toString("utf8")
    for (const specifier of computerOverlayModuleReferences(canonical, source)) {
      if (isBuiltin(specifier) || specifier === "electron" || specifier === "original-fs") continue
      const resolved = ts.resolveModuleName(specifier, canonical, options, ts.sys).resolvedModule
      if (!resolved)
        throw new Error(
          `The overlay source graph has an unresolved import from ${entry.path}: ${JSON.stringify(specifier.slice(0, 256))}.`,
        )
      const target = await realpath(resolved.resolvedFileName)
      if (
        target.startsWith(repository + path.sep) &&
        !path.relative(repository, target).split(path.sep).includes("node_modules")
      )
        pending.push(target)
      else if (!target.startsWith(path.join(repository, "node_modules") + path.sep))
        throw new Error("An overlay dependency escaped the frozen installation.")
    }
  }
  return {
    repository,
    entries: [...entries.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
    bunVersion: packageValue.packageManager.slice(4),
    resolverVersion: ts.version,
  }
}

/** The dedicated driver binds both C2 native inputs and every independently resolved workspace input. */
export function computerOverlaySourceDigest(
  nativeDigest: string,
  graph: Pick<OverlaySourceGraph, "entries" | "bunVersion" | "resolverVersion">,
) {
  if (
    !/^[a-f0-9]{64}$/.test(nativeDigest) ||
    !/^\d+\.\d+\.\d+$/.test(graph.bunVersion) ||
    !graph.resolverVersion.trim() ||
    !graph.entries.length ||
    graph.entries.length > 4096
  )
    throw new Error("The overlay source digest inputs are invalid.")
  const digest = createHash("sha256")
    .update("vector-computer-overlay-source-v1\0")
    .update(nativeDigest)
    .update("\0")
    .update(graph.bunVersion)
    .update("\0")
    .update(graph.resolverVersion)
    .update("\0")
  const names = new Set<string>()
  for (const entry of [...graph.entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    if (!relativeName(entry.path) || names.has(entry.path))
      throw new Error("An overlay source digest input is ambiguous.")
    names.add(entry.path)
    digest
      .update(entry.path)
      .update("\0")
      .update(String(entry.bytes.byteLength))
      .update("\0")
      .update(entry.bytes)
      .update("\0")
  }
  return digest.digest("hex")
}

/** Compare the actual compiler's observed workspace inputs with the independent current-source graph. */
export async function verifyComputerOverlayBundleGraph(
  value: unknown,
  directory: string,
  graph: OverlaySourceGraph,
  entrypoint?: string,
) {
  if (
    !record(value) ||
    !record(value.inputs) ||
    !Object.keys(value.inputs).length ||
    Object.keys(value.inputs).length > 32_768
  )
    throw new Error("The overlay compiler did not return its bounded input graph.")
  const expected = new Map(graph.entries.map((entry) => [entry.path, entry]))
  let entrypointObserved = entrypoint === undefined
  for (const [name, metadata] of Object.entries(value.inputs)) {
    if (
      !record(metadata) ||
      !Number.isSafeInteger(metadata.bytes) ||
      Number(metadata.bytes) < 0 ||
      !Array.isArray(metadata.imports)
    )
      throw new Error("The overlay compiler input metadata is invalid.")
    const file = await realpath(path.isAbsolute(name) ? name : path.resolve(directory, name))
    const relative = path.relative(graph.repository, file).split(path.sep).join("/")
    if (entrypoint && file === (await realpath(path.join(directory, entrypoint)))) entrypointObserved = true
    if (relative.startsWith("node_modules/")) continue // Frozen dependency install and lock are admitted separately.
    const admitted = expected.get(relative)
    if (
      !admitted ||
      metadata.bytes !== admitted.bytes.byteLength ||
      hash(await readFile(file)) !== hash(admitted.bytes)
    )
      throw new Error("The overlay bundle consumed source outside its admitted graph.")
  }
  if (!entrypointObserved) throw new Error("The overlay compiler did not observe its fixed entrypoint.")
}
