import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import ts from "typescript"
import { Option, Schema } from "effect"
import { ConfigComputerV1 } from "@vectordevai/core/v1/config/computer"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import baseline from "../../test/fixtures/config-top-level-keys-1.99.99.json" with { type: "json" }
import { createComputerPolicy } from "./computer-policy"

const ROOT = path.resolve(import.meta.dir, "../../../..")

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return sources(file)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : []
  })
}

function parse(file: string) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
}

function keys(object: ts.ObjectLiteralExpression) {
  return object.properties.flatMap((property): string[] => {
    if (ts.isSpreadAssignment(property)) {
      const value = ts.isParenthesizedExpression(property.expression)
        ? property.expression.expression
        : property.expression
      if (
        ts.isConditionalExpression(value) &&
        ts.isObjectLiteralExpression(value.whenTrue) &&
        ts.isObjectLiteralExpression(value.whenFalse)
      )
        return [...keys(value.whenTrue), ...keys(value.whenFalse)]
      throw new Error("A config spread needs a compatibility check of its actual patch producer.")
    }
    if (!property.name || ts.isComputedPropertyName(property.name))
      throw new Error("A config write must expose its top-level keys for the older-engine compatibility check.")
    return [property.name.text]
  })
}

function producerKeys(file: string, name: string) {
  const source = parse(path.join(ROOT, file))
  const declaration = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  )
  if (!declaration?.body) throw new Error(`The config producer ${name} needs a compatibility check.`)
  const returned = declaration.body.statements.filter(ts.isReturnStatement)
  if (returned.length !== 1 || !returned[0]!.expression || !ts.isObjectLiteralExpression(returned[0]!.expression))
    throw new Error(`The config producer ${name} must expose every returned top-level key.`)
  return keys(returned[0]!.expression)
}

function payloadKeys(expression: ts.Expression, source: ts.SourceFile): string[] {
  if (ts.isParenthesizedExpression(expression)) return payloadKeys(expression.expression, source)
  if (ts.isObjectLiteralExpression(expression)) return keys(expression)
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "rolesPatch"
  ) {
    // Both the Local role picker and setup wizard use this imported producer. Check its actual returned object,
    // including each conditional spread, rather than approving the call merely because its name is familiar.
    const imported = source.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        (statement.moduleSpecifier.text.startsWith("@/")
          ? path.join(ROOT, "packages/app/src", statement.moduleSpecifier.text.slice(2))
          : path.resolve(path.dirname(source.fileName), statement.moduleSpecifier.text)) ===
          path.join(ROOT, "packages/app/src/features/local/local-model") &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.elements.some(
          (element) => element.name.text === "rolesPatch" && !element.propertyName,
        ),
    )
    if (!imported) throw new Error("The role config producer import changed; review its compatibility.")
    return producerKeys("packages/app/src/features/local/local-model.ts", "rolesPatch")
  }
  if (ts.isIdentifier(expression)) {
    const initializers: ts.Expression[] = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === expression.text &&
        node.initializer
      )
        initializers.push(node.initializer)
      ts.forEachChild(node, walk)
    }
    walk(source)
    if (initializers.length === 1) return payloadKeys(initializers[0]!, source)
  }
  throw new Error("An opaque config write needs a compatibility check of its actual patch producer.")
}

test("app and desktop user/global config writes use only the 1.99.99 top-level keys", () => {
  const allowed = new Set(baseline.keys)
  const found: { file: string; keys: string[] }[] = []
  const delegated = new Set<string>()
  const forwarding = new Set([
    "packages/app/src/components/dialog-custom-provider.tsx",
    "packages/app/src/components/settings-v2/subagents.tsx",
  ])
  const inspect = (file: string) => {
    const source = parse(file)
    const relative = path.relative(ROOT, file).split(path.sep).join("/")
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const call = node.expression
        if (call.name.text === "updateConfig") {
          const patch = node.arguments[0]
          if (patch && ts.isObjectLiteralExpression(patch)) found.push({ file: relative, keys: keys(patch) })
          else {
            // The two existing forwarding functions delegate to producers checked below. Any new opaque writer
            // needs an explicit producer check, rather than silently accepting new engine-only settings.
            expect(forwarding.has(relative)).toBe(true)
            delegated.add(relative)
          }
        }
        if (
          call.name.text === "update" &&
          ts.isPropertyAccessExpression(call.expression) &&
          call.expression.name.text === "config"
        ) {
          if (relative === "packages/app/src/context/server-sync.tsx")
            expect(node.arguments[0]?.getText(source)).toBe("{ config }")
          else {
            const input = node.arguments[0]
            if (!input || !ts.isObjectLiteralExpression(input))
              throw new Error("A direct config update must expose its config payload.")
            const config = input.properties.find((property) => property.name?.getText(source) === "config")
            if (!config || !ts.isPropertyAssignment(config))
              throw new Error("A direct config update needs a config payload compatibility check.")
            found.push({ file: relative, keys: payloadKeys(config.initializer, source) })
          }
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
  }
  sources(path.join(ROOT, "packages/app/src")).forEach(inspect)
  sources(path.join(ROOT, "packages/desktop/src")).forEach(inspect)
  // The subagent switch's actual patch producer is the only nonliteral updateConfig payload besides the
  // provider dialog's forwarding callback, whose save helper exposes its literal provider payload above.
  const subagents = parse(path.join(ROOT, "packages/app/src/components/settings-v2/subagent-switches.ts"))
  const declaration = subagents.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((declaration) => declaration.name.getText(subagents) === "agentSwitchPatch")
  const initializer = declaration?.initializer
  expect(initializer && ts.isArrowFunction(initializer)).toBe(true)
  if (!initializer || !ts.isArrowFunction(initializer)) throw new Error("The subagent config producer is missing.")
  const body = ts.isParenthesizedExpression(initializer.body) ? initializer.body.expression : initializer.body
  if (!ts.isObjectLiteralExpression(body)) throw new Error("The subagent config producer needs a compatibility check.")
  found.push({ file: "subagent-switches.ts", keys: keys(body) })
  expect(delegated).toEqual(forwarding)
  expect(found.length).toBeGreaterThan(0)
  for (const write of found)
    for (const key of write.keys) {
      expect({ file: write.file, key, compatible: allowed.has(key) }).toMatchObject({ compatible: true })
      expect(key).not.toBe("computer")
    }
})

test("the historical key fixture excludes computer while managed configuration decodes it", () => {
  expect(baseline.ref).toBe("v1.99.99")
  expect(baseline.commit).toBe("0575c41f370cbc828940e27d6857bf2c27f0e33f")
  expect(baseline.keys).toHaveLength(35)
  expect(baseline.keys).not.toContain("computer")
  const computer = {
    enabled: false,
    allow_always: false,
    apps: { macos: { "com.example.editor@TEAM123456": "deny" } },
  }
  expect(Option.isSome(Schema.decodeUnknownOption(ConfigComputerV1.Info)(computer))).toBe(true)
  expect(Option.isSome(Schema.decodeUnknownOption(ConfigV1.Info)({ computer }))).toBe(true)
  const policy = createComputerPolicy({
    read: () => ({ files: ["managed.jsonc"], policies: [], ignored: [] }),
    readFile: () => `// Company config only\n${JSON.stringify({ computer })}`,
  }).get()
  expect(policy).toMatchObject({ managed: true, enabled: false, allowAlways: false })
})
