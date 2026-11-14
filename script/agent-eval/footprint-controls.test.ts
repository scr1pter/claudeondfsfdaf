import { expect, test } from "bun:test"
import { footprintControlArgs, footprintControls } from "./footprint-controls"

test("omitted controls add no CLI overrides", () => {
  const controls = footprintControls(["--runtime", "vector,vector-openai", "--sessions", "2"])
  expect(controls).toEqual({ taskSize: undefined, judge: undefined })
  expect(footprintControlArgs(controls)).toEqual([])
})

test("task size and judge controls pass through to Vector's existing CLI options", () => {
  expect(footprintControlArgs(footprintControls(["--task-size", "standard", "--judge", "off"]))).toEqual([
    "--size",
    "standard",
    "--judge",
    "off",
  ])
  expect(footprintControlArgs(footprintControls(["--task-size", "thorough"]))).toEqual(["--size", "thorough"])
  for (const size of ["auto", "chat", "light", "standard", "thorough"]) {
    expect(footprintControls(["--task-size", size]).taskSize).toBe(size)
  }
  for (const judge of ["off", "thorough", "changes"]) {
    expect(footprintControls(["--judge", judge]).judge).toBe(judge)
  }
})

test("invalid, missing, and ambiguous controls fail before the harness starts", () => {
  for (const argv of [
    ["--task-size", "heavy"],
    ["--task-size"],
    ["--task-size", "--judge", "off"],
    ["--task-size", "standard", "--task-size", "thorough"],
    ["--judge", "on"],
    ["--judge"],
    ["--judge", "off", "--judge", "changes"],
  ]) {
    expect(() => footprintControls(argv)).toThrow()
  }
})
