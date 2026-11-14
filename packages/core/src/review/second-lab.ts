// Second-lab reviews and the review panel (WP A35). Which models a review runs on when a second lab should check it,
// and how many labs did. On Vector Codium the plan's review pair (the catalog's `review`) runs the first pass on one
// lab and checks each finding on another; a pair whose models come from the same lab warns and runs one pass. The
// optional panel (`panel` in .vector/review.json) adds a judge from a third lab, which makes the final call on each
// finding. The panel and the "Checked by a second lab" line work with your own keys too. Pure and browser-safe: the
// engine's runner and the desktop's review share it.

import { labName, labOf, type Lab } from "../model-lab"

export type LabModel = {
  providerID: string
  modelID: string
  /** The lab a catalog states for the model (Vector Codium's listing); otherwise it is read from the vendor. */
  lab?: string
}

/** The plan's review pair, from Vector Codium's listing: the first pass, the check, and the panel's judge. */
export type CodiumPair<M extends LabModel> = { triage?: M; confirm?: M; panelJudge?: M }

export type ReviewModels<M extends LabModel> = {
  /** The review model: it checks each finding of a first pass, or runs the only pass. */
  model: M
  /** The first pass, when it differs from the review model. */
  triage?: M
  /** The panel's judge, from a third lab. */
  judge?: M
  /** What the review says about the choice: a same-lab pair, or a panel that could not be formed. */
  notes: string[]
}

export function labOfModel(model: LabModel | undefined): Lab | undefined {
  return model ? labOf(`${model.providerID}/${model.modelID}`, model.lab) : undefined
}

const same = (a: LabModel | undefined, b: LabModel | undefined) =>
  !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID

/**
 * The models a review runs on.
 *
 * - `model` is the review model the settings chose; `triage` and `judge` are review.json's `triageModel` and
 *   `judgeModel`, already resolved.
 * - `codium` is the plan's review pair, given only when the review model is a Vector Codium model. Without a
 *   `triageModel` the review runs the pair: the first pass on its triage model and the check on the review model,
 *   which is the pair's confirm model when the settings named Codium Auto or the triage model itself. A pair whose two
 *   models come from the same lab warns and runs one pass on the review model. A `triageModel` the user set is their
 *   own cheaper first pass and runs as it always has.
 * - With `panel`, the judge is `judge`, or on Codium the pair's panel judge; it joins only when the first pass, the
 *   check and the judge come from three different labs Vector can name.
 */
export function reviewModels<M extends LabModel>(input: {
  model: M
  triage?: M
  judge?: M
  panel: boolean
  codium?: CodiumPair<M>
  auto?: boolean
}): ReviewModels<M> {
  const notes: string[] = []
  let model = input.model
  let triage = input.triage && !same(input.triage, input.model) ? input.triage : undefined
  const pair = input.codium
  if (!triage && pair?.triage) {
    const check = input.auto || same(model, pair.triage) ? pair.confirm : model
    const first = labOfModel(pair.triage)
    const second = labOfModel(check)
    if (check && first && second && first !== second) {
      triage = pair.triage
      model = check
    } else if (check && first && first === second) notes.push(noteSameLabPair(first, nameOf(input.model)))
  }
  let judge: M | undefined
  if (input.panel) {
    const candidate = input.judge ?? pair?.panelJudge
    const labs = [labOfModel(triage), labOfModel(model), labOfModel(candidate)]
    if (triage && candidate && labs.every(Boolean) && new Set(labs).size === 3) judge = candidate
    else notes.push(notePanelUnavailable())
  }
  return { model, ...(triage ? { triage } : {}), ...(judge ? { judge } : {}), notes }
}

/**
 * How many labs checked the findings a review reports: 2 when a first pass on one lab was checked by the review model
 * from another, 3 when the panel's judge from a third lab also finished. Undefined when no check from another lab
 * finished, or a lab cannot be named.
 */
export function checkedLabs(input: {
  model: LabModel
  triage?: LabModel
  judge?: LabModel
  /** The check on the review model finished. */
  verified: boolean
  /** The panel's judge finished. */
  judged?: boolean
}): 2 | 3 | undefined {
  if (!input.triage || !input.verified) return undefined
  const first = labOfModel(input.triage)
  const second = labOfModel(input.model)
  if (!first || !second || first === second) return undefined
  const third = input.judged ? labOfModel(input.judge) : undefined
  return third && third !== first && third !== second ? 3 : 2
}

/** The footer line for a review checked across labs. */
export function checkedLine(labs: 2 | 3 | undefined): string | undefined {
  if (labs === 2) return "Checked by a second lab"
  if (labs === 3) return "Checked by three labs"
  return undefined
}

export function noteSameLabPair(lab: Lab, model: string): string {
  return `The first pass and the check would both run on ${labName(lab)} models, so this review ran one pass on ${model} and no second lab checked its findings.`
}

export function notePanelUnavailable(): string {
  return "The review panel needs a first pass, a check and a judge from three different labs, and this review's models do not make one, so it ran without the judge. Set triageModel, model and judgeModel in .vector/review.json to models from three labs."
}

export function noteJudgeUnfinished(model: string): string {
  return `The panel's judge on ${model} did not finish, so the check on the review model decided which findings to report.`
}

function nameOf(model: LabModel) {
  return `${model.providerID}/${model.modelID}`
}
