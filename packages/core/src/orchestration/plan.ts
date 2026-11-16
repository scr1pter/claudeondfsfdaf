export * as WorkflowPlan from "./plan"

import { createHash } from "node:crypto"
import { Schema } from "effect"
import type { Workflow } from "@vectordevai/schema/workflow"
import type { Connect } from "@vectordevai/schema/connect"
import { WorkflowSpec } from "./spec"
import { WorkflowTemplate } from "./template"
import { WorkflowLimits } from "./limits"

export type Agent = {
  readonly name: string
  readonly allowed: boolean
  readonly primary?: boolean
  readonly hidden?: boolean
  readonly research?: boolean
  readonly writes: boolean
  readonly asks?: readonly string[]
}
export type Options = {
  readonly agents: readonly Agent[]
  readonly inputs?: Readonly<Record<string, unknown>>
  readonly saved?: Readonly<Record<string, unknown>>
  readonly limits?: WorkflowLimits.Configured
  readonly cpus?: number
  readonly source?: "model" | "owner" | "saved"
  readonly modelAllowed?: (model: string, agent: string) => boolean
  /** Engine-owned member manifests only. Workflow JSON cannot supply or override declared effects. */
  readonly connections?: readonly Pick<Connect.Member, "id" | "actions">[]
}
type ExpandedFields = {
  readonly inputs: Readonly<Record<string, unknown>>
  readonly path: string
  readonly dependencies: readonly string[]
  readonly barriers: readonly string[]
  readonly group?: string
}
export type ExpandedAgent = ExpandedFields & { readonly stage: WorkflowSpec.AgentStage }
export type ExpandedConnect = ExpandedFields & { readonly stage: WorkflowSpec.ConnectStage }
export type Expanded = ExpandedFields & { readonly stage: WorkflowSpec.ExecutableStage }

export function isAgent(entry: Expanded): entry is ExpandedAgent {
  return "prompt" in entry.stage
}
export type Built = {
  readonly ok: boolean
  readonly issues: readonly WorkflowSpec.Issue[]
  readonly warnings: readonly WorkflowSpec.Issue[]
  readonly plan?: Workflow.Plan
  readonly stages?: readonly Expanded[]
  readonly limits?: WorkflowLimits.Resolved
  readonly large?: boolean
  readonly groups?: Readonly<Record<string, readonly string[]>>
  readonly groupLimits?: Readonly<Record<string, WorkflowLimits.Resolved>>
  readonly groupResults?: Readonly<Record<string, NonNullable<WorkflowSpec.Spec["result"]>>>
}

export function build(value: unknown, options: Options): Built {
  const parsed = WorkflowSpec.parse(value, { source: options.source })
  if (!parsed.ok) return { ok: false, issues: parsed.issues, warnings: [] }
  const issues: WorkflowSpec.Issue[] = []
  const warnings: WorkflowSpec.Issue[] = []
  const inputs = resolveInputs(parsed.spec, options.inputs ?? {}, issues, "/inputs")
  const stages: {
    stage: WorkflowSpec.ExecutableStage
    inputs: Readonly<Record<string, unknown>>
    path: string
    group?: string
  }[] = []
  const groups = new Map<string, string[]>()
  const groupLimits: Record<string, WorkflowLimits.Resolved> = Object.create(null)
  const groupResults: Record<string, NonNullable<WorkflowSpec.Spec["result"]>> = Object.create(null)
  const configured = options.limits ?? {}
  let large = WorkflowLimits.exceeds(parsed.spec.limits ?? {}, configured)
  const ids = new Set<string>()
  parsed.spec.stages.forEach((stage, i) => {
    const at = `/stages/${i}`
    if (ids.has(stage.id)) issues.push({ path: `${at}/id`, message: `Duplicate stage: ${stage.id}.` })
    ids.add(stage.id)
    if ("prompt" in stage) {
      stages.push({ stage: { ...parsed.spec.defaults, ...stage }, inputs, path: at })
      groups.set(stage.id, [stage.id])
      return
    }
    if ("connect" in stage) {
      stages.push({ stage, inputs, path: at })
      groups.set(stage.id, [stage.id])
      return
    }
    const saved =
      options.saved && Object.hasOwn(options.saved, stage.workflow) ? options.saved[stage.workflow] : undefined
    if (!saved) {
      issues.push({ path: `${at}/workflow`, message: `Saved workflow is unavailable: ${stage.workflow}.` })
      return
    }
    const child = WorkflowSpec.parse(saved, { source: "saved" })
    if (!child.ok) {
      issues.push(...child.issues.map((issue) => ({ path: `${at}/workflow${issue.path}`, message: issue.message })))
      return
    }
    if (child.spec.stages.some((item) => "workflow" in item)) {
      issues.push({ path: `${at}/workflow`, message: "Workflows may nest only one level." })
      return
    }
    const given: Record<string, unknown> = Object.create(null)
    for (const [name, raw] of Object.entries(stage.inputs ?? {})) {
      if (typeof raw === "string" && raw.includes("{{")) {
        if (!/^\{\{inputs\.[a-z][a-z0-9_]{0,31}\}\}$/.test(raw)) {
          issues.push({
            path: `${at}/inputs/${name}`,
            message: "Nested inputs accept a literal JSON value or one inputs.name reference.",
          })
          continue
        }
        const inputName = raw.slice(9, -2)
        if (!Object.hasOwn(parsed.spec.inputs ?? {}, inputName)) {
          issues.push({ path: `${at}/inputs/${name}`, message: `Unknown workflow input reference: ${inputName}.` })
          continue
        }
        given[name] = WorkflowTemplate.lookup(inputs, [inputName])
      } else given[name] = raw
    }
    const childInputs = resolveInputs(child.spec, given, issues, `${at}/inputs`)
    if ((child.spec.limits?.max_agents ?? 0) > (configured.max_agents ?? WorkflowLimits.DEFAULTS.max_agents))
      issues.push({
        path: `${at}/workflow/limits/max_agents`,
        message: "The nested agent count exceeds the configured workflow maximum.",
      })
    // Each nested group has its own ledger; parent limits still apply to every descendant.
    groupLimits[stage.id] = WorkflowLimits.resolve(child.spec.limits, configured, options.cpus ?? 1)
    large ||= WorkflowLimits.exceeds(child.spec.limits ?? {}, configured)
    const children = child.spec.stages.filter((item): item is WorkflowSpec.ExecutableStage => !("workflow" in item))
    groups.set(
      stage.id,
      children.map((item) => `${stage.id}.${item.id}`),
    )
    for (const id of child.spec.result?.stages ?? []) {
      if (!children.some((item) => item.id === id))
        issues.push({ path: `${at}/workflow/result/stages`, message: `Unknown result stage: ${id}.` })
    }
    groupResults[stage.id] = {
      ...child.spec.result,
      stages: child.spec.result?.stages?.map((id) => `${stage.id}.${id}`),
    }
    const prefixed = (text: string) => text.replace(/\{\{\s*stages\.([a-z][a-z0-9_-]*)\./g, `{{stages.${stage.id}.$1.`)
    children.forEach((item, j) => {
      if ("connect" in item) {
        stages.push({
          stage: {
            ...item,
            id: `${stage.id}.${item.id}`,
            title: item.title ? prefixed(item.title) : undefined,
            after: [...(stage.after ?? []), ...(item.after ?? []).map((id) => `${stage.id}.${id}`)],
            if: item.if ? nestedPredicate(item.if, stage.id) : undefined,
          },
          inputs: childInputs,
          group: stage.id,
          path: `${at}/workflow/stages/${j}`,
        })
        return
      }
      const source =
        item.for_each && "from" in item.for_each
          ? {
              ...item.for_each,
              from: (typeof item.for_each.from === "string" ? [item.for_each.from] : item.for_each.from).map(
                (id) => `${stage.id}.${id}`,
              ),
            }
          : item.for_each
      stages.push({
        stage: {
          ...child.spec.defaults,
          ...item,
          id: `${stage.id}.${item.id}`,
          prompt: prefixed(item.prompt),
          title: item.title ? prefixed(item.title) : undefined,
          after: [...(stage.after ?? []), ...(item.after ?? []).map((id) => `${stage.id}.${id}`)],
          for_each: source,
          if: item.if ? nestedPredicate(item.if, stage.id) : undefined,
          owned_paths: item.owned_paths?.map(prefixed),
          success_criteria: item.success_criteria?.map(prefixed),
          verify: item.verify ? { ...item.verify, prompt: prefixed(item.verify.prompt) } : undefined,
        },
        inputs: childInputs,
        group: stage.id,
        path: `${at}/workflow/stages/${j}`,
      })
    })
  })
  const all = stages.map((item) => item.stage.id)
  const available = [...new Set([...all, ...groups.keys()])]
  const expanded = stages.map((entry): Expanded => {
    const stage = entry.stage
    // All edges validate the DAG; only barriers wait for completion. A `from` edge may stream ready items.
    const dependencies = new Set<string>(stage.after ?? [])
    const barriers = new Set<string>(stage.after ?? [])
    if ("prompt" in stage && stage.for_each && "from" in stage.for_each)
      for (const id of typeof stage.for_each.from === "string" ? [stage.for_each.from] : stage.for_each.from)
        dependencies.add(id)
    const fields = [
      ...("prompt" in stage ? [{ text: stage.prompt, path: "prompt", verify: false }] : []),
      ...(stage.title ? [{ text: stage.title, path: "title", verify: false }] : []),
      ...("prompt" in stage
        ? (stage.owned_paths ?? []).map((text, i) => ({ text, path: `owned_paths/${i}`, verify: false }))
        : []),
      ...("prompt" in stage
        ? (stage.success_criteria ?? []).map((text, i) => ({ text, path: `success_criteria/${i}`, verify: false }))
        : []),
      ...("prompt" in stage && stage.verify
        ? [{ text: stage.verify.prompt, path: "verify/prompt", verify: true }]
        : []),
    ]
    for (const field of fields) {
      issues.push(
        ...WorkflowTemplate.validate(
          field.text,
          { inputs: Object.keys(entry.inputs), stages: available, verify: field.verify },
          `${entry.path}/${field.path}`,
        ),
      )
      for (const ref of WorkflowTemplate.references(field.text)) {
        const id = WorkflowTemplate.stageReference(ref, available)
        if (id) {
          dependencies.add(id)
          barriers.add(id)
        }
      }
    }
    if (stage.if)
      for (const path of predicatePaths(stage.if)) {
        const id = available.toSorted((a, b) => b.length - a.length).find((id) => path.startsWith(`stages.${id}.`))
        if (!id || !["done", "failed", "items"].includes(path.slice(`stages.${id}.`.length)))
          issues.push({ path: `${entry.path}/if`, message: `Unknown aggregate path: ${path}.` })
        else {
          dependencies.add(id)
          barriers.add(id)
        }
      }
    const resolved = new Set<string>()
    for (const id of dependencies) {
      if (!available.includes(id)) issues.push({ path: entry.path, message: `Unknown stage dependency: ${id}.` })
      for (const key of groups.get(id) ?? [id]) resolved.add(key)
    }
    return {
      ...entry,
      dependencies: [...resolved],
      barriers: [...new Set([...barriers].flatMap((id) => groups.get(id) ?? [id]))],
    }
  })
  const done = new Set<string>()
  while (true) {
    const ready = expanded.filter((item) => !done.has(item.stage.id) && item.dependencies.every((id) => done.has(id)))
    if (!ready.length) break
    ready.forEach((item) => done.add(item.stage.id))
  }
  if (done.size !== expanded.length)
    issues.push({
      path: "/stages",
      message: "Stages must form a directed acyclic graph; a dependency cycle or unresolved stage remains.",
    })
  for (const id of parsed.spec.result?.stages ?? [])
    if (!available.includes(id)) issues.push({ path: "/result/stages", message: `Unknown result stage: ${id}.` })
  if ((parsed.spec.limits?.max_agents ?? 0) > (configured.max_agents ?? WorkflowLimits.DEFAULTS.max_agents))
    issues.push({
      path: "/limits/max_agents",
      message: "The requested agent count exceeds the configured workflow maximum.",
    })
  const limits = WorkflowLimits.resolve(parsed.spec.limits, configured, options.cpus ?? 1)
  const permitted = options.agents
    .filter((agent) => agent.allowed && !agent.primary && !agent.hidden && !agent.research)
    .map((agent) => agent.name)
  const plans: Workflow.PlanStage[] = expanded.map(({ stage, path }): Workflow.PlanStage => {
    if ("connect" in stage) {
      const members = options.connections?.filter((member) => member.id === stage.connect.to) ?? []
      const actions =
        members.length === 1 ? (members[0].actions?.filter((action) => action.id === stage.connect.action) ?? []) : []
      const action = actions.length === 1 ? actions[0] : undefined
      if (!action)
        issues.push({
          path: `${path}/connect`,
          message: "The connected action has no trusted member manifest in this workflow build.",
        })
      else if (!action.effects.length || action.effects.some((effect) => effect !== "read"))
        issues.push({
          path: `${path}/connect/action`,
          message: "Workflow connected actions must declare only read effects.",
        })
      warnings.push({
        path: `${path}/connect`,
        message:
          "Connected workflow execution is unavailable until reviewer helpers preserve the workflow and ancestor budget scopes.",
      })
      return {
        id: stage.id,
        title: stage.title ?? stage.id,
        phase: "",
        kind: "connect",
        connect: { to: stage.connect.to, action: stage.connect.action },
        items: 1,
        serial: false,
        writes: "read only; execution unavailable",
        asks: ["connect", "connect_model when required"],
      }
    }
    const name = stage.agent ?? "general"
    const agent = options.agents.find((item) => item.name === name)
    if (!agent || !permitted.includes(name))
      issues.push({
        path: `${path}/agent`,
        message: `Agent "${name}" is unavailable. Permitted agents: ${permitted.join(", ") || "none"}.`,
      })
    if (stage.model && (!options.modelAllowed || !options.modelAllowed(stage.model, name)))
      issues.push({ path: `${path}/model`, message: `Model is not allowed for ${name}: ${stage.model}.` })
    if (stage.verify) {
      const verifier = stage.verify.agent ?? name
      if (!permitted.includes(verifier))
        issues.push({ path: `${path}/verify/agent`, message: `Verifier is unavailable: ${verifier}.` })
      const verifierModel = stage.verify.model ?? stage.model
      if (verifierModel && (!options.modelAllowed || !options.modelAllowed(verifierModel, verifier)))
        issues.push({ path: `${path}/verify/model`, message: `Verifier model is not allowed: ${verifierModel}.` })
    }
    const writes = agent?.writes ?? true
    const isolated = stage.isolation === "worktree"
    const owned = !!stage.owned_paths?.length
    const verifier = stage.verify
      ? options.agents.find((item) => item.name === (stage.verify?.agent ?? name))
      : undefined
    const verifierWrites = !!stage.verify && (verifier?.writes ?? true)
    const verifierIsolated = (stage.verify?.isolation ?? stage.isolation) === "worktree"
    const serial = (writes && !isolated && !owned) || (verifierWrites && !verifierIsolated && !owned)
    const placement = (writer: boolean, isolation: boolean) =>
      !writer
        ? "read only"
        : isolation
          ? "each in its own worktree"
          : owned
            ? "each owns its paths"
            : "in this checkout, one at a time"
    if (serial)
      warnings.push({
        path,
        message: "This writer has no owned paths or worktree and runs one at a time in this checkout.",
      })
    if (stage.for_each && "files" in stage.for_each && !stage.for_each.files.hidden)
      warnings.push({ path: `${path}/for_each/files`, message: "Hidden files are excluded." })
    if (stage.for_each && "changed_files" in stage.for_each && !stage.for_each.changed_files.include_deleted)
      warnings.push({ path: `${path}/for_each/changed_files`, message: "Deleted files are excluded." })
    return {
      id: stage.id,
      title: stage.title ?? stage.id,
      phase: stage.phase ?? "",
      agent: name,
      model: stage.model,
      effort: stage.effort,
      isolation: stage.isolation,
      items: !stage.for_each ? 1 : "items" in stage.for_each ? stage.for_each.items.length : "dynamic",
      serial,
      writes: `${placement(writes, isolated)}${stage.verify ? `; verifier: ${placement(verifierWrites, verifierIsolated)}` : ""}`,
      asks: [...new Set([...(agent?.asks ?? []), ...(verifier?.asks ?? [])])],
      verify: stage.verify ? { agent: stage.verify.agent ?? name, maxRounds: stage.verify.max_rounds ?? 2 } : undefined,
    }
  })
  const plan: Workflow.Plan = {
    title: parsed.spec.title,
    stages: plans,
    maxAgents: limits.maxAgents,
    concurrency: limits.concurrency,
    usd: limits.usd,
    tokens: limits.tokens,
    steps: limits.steps,
    perAgentSteps: limits.perAgentSteps,
    minutes: limits.minutes,
  }
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    plan: issues.length ? undefined : plan,
    stages: issues.length ? undefined : expanded,
    limits,
    large,
    groups: Object.fromEntries(groups),
    groupLimits,
    groupResults,
  }
}

function resolveInputs(
  spec: WorkflowSpec.Spec,
  given: Readonly<Record<string, unknown>>,
  issues: WorkflowSpec.Issue[],
  at: string,
) {
  const values: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(given))
    if (!Object.hasOwn(spec.inputs ?? {}, key))
      issues.push({ path: `${at}/${key}`, message: "Unknown workflow input." })
  for (const [key, definition] of Object.entries(spec.inputs ?? {})) {
    const value = Object.hasOwn(given, key) ? given[key] : definition.default
    if (value === undefined && definition.required)
      issues.push({ path: `${at}/${key}`, message: "Required workflow input is missing." })
    if (value !== undefined) {
      let encoded: string | undefined
      try {
        encoded = JSON.stringify(value)
      } catch {
        /* The input is not serializable JSON. */
      }
      if (
        encoded === undefined ||
        new TextEncoder().encode(encoded).byteLength > 8192 ||
        !Schema.is(Schema.Json)(value)
      ) {
        issues.push({ path: `${at}/${key}`, message: "Workflow inputs must be JSON values of at most 8 KiB each." })
        continue
      }
    }
    values[key] = value
  }
  return values
}
function nestedPredicate(predicate: WorkflowSpec.Predicate, parent: string): WorkflowSpec.Predicate {
  const comparison = (item: WorkflowSpec.Comparison): WorkflowSpec.Comparison => ({
    ...item,
    path: item.path?.startsWith("stages.") ? `stages.${parent}.${item.path.slice(7)}` : item.path,
  })
  if ("all" in predicate) return { all: predicate.all.map(comparison) }
  if ("any" in predicate) return { any: predicate.any.map(comparison) }
  if ("not" in predicate) return { not: comparison(predicate.not) }
  return comparison(predicate)
}

function predicatePaths(predicate: WorkflowSpec.Predicate): string[] {
  if ("all" in predicate) return predicate.all.flatMap((item) => (item.path ? [item.path] : []))
  if ("any" in predicate) return predicate.any.flatMap((item) => (item.path ? [item.path] : []))
  if ("not" in predicate) return predicate.not.path ? [predicate.not.path] : []
  return predicate.path ? [predicate.path] : []
}

/** Content keys include every execution-affecting input; object property order is immaterial. */
export function key(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex")
}
export function canonical(value: unknown): string {
  if (value === undefined) return "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .toSorted()
      .filter((name) => (value as Record<string, unknown>)[name] !== undefined)
      .map((name) => `${JSON.stringify(name)}:${canonical((value as Record<string, unknown>)[name])}`)
      .join(",")}}`
  return JSON.stringify(value)
}
