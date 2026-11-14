import { describe, expect, test } from "bun:test"
import { selectedShellOption, shellSelectOptions, type ShellOption } from "./shell-model"

const labels = { auto: "Auto (Default)", terminalOnly: "terminal only" }
const zsh: ShellOption = { path: "/bin/zsh", name: "zsh", acceptable: true }
const bash: ShellOption = { path: "/bin/bash", name: "bash", acceptable: true }
const brewBash: ShellOption = { path: "/opt/homebrew/bin/bash", name: "bash", acceptable: true }
const fish: ShellOption = { path: "/opt/homebrew/bin/fish", name: "fish", acceptable: false }

describe("Terminal shell options", () => {
  test("puts Auto first, saved as no shell at all", () => {
    expect(shellSelectOptions({ shells: [], current: undefined, ...labels })).toEqual([
      { id: "auto", value: "", label: "Auto (Default)" },
    ])
  })

  test("a server answer that is not a list leaves Auto and the saved shell, and never throws", () => {
    // An older or mock server can answer the shell list with an object; Settings must still open (main CI, 27 Oct).
    const odd = { shells: {} as unknown as readonly ShellOption[], current: "zsh", ...labels }
    expect(() => shellSelectOptions(odd)).not.toThrow()
    expect(shellSelectOptions(odd).map((option) => option.value)).toEqual(["", "zsh"])
    const broken = [zsh, { name: "nu" } as unknown as ShellOption, null as unknown as ShellOption]
    expect(shellSelectOptions({ shells: broken, current: "", ...labels }).map((option) => option.id)).toEqual([
      "auto",
      "/bin/zsh",
    ])
  })

  test("names each shell, keyed by its path", () => {
    expect(shellSelectOptions({ shells: [zsh, bash], current: "", ...labels }).slice(1)).toEqual([
      { id: "/bin/zsh", value: "zsh", label: "zsh" },
      { id: "/bin/bash", value: "bash", label: "bash" },
    ])
  })

  test("uses the path for shells that share a name, so the two can be told apart", () => {
    expect(shellSelectOptions({ shells: [zsh, bash, brewBash], current: "", ...labels }).slice(1)).toEqual([
      { id: "/bin/zsh", value: "zsh", label: "zsh" },
      { id: "/bin/bash", value: "/bin/bash", label: "/bin/bash" },
      { id: "/opt/homebrew/bin/bash", value: "/opt/homebrew/bin/bash", label: "/opt/homebrew/bin/bash" },
    ])
  })

  test("marks a shell agent tool calls will not use as terminal only", () => {
    expect(shellSelectOptions({ shells: [fish], current: "", ...labels })[1]).toEqual({
      id: "/opt/homebrew/bin/fish",
      value: "fish",
      label: "fish (terminal only)",
    })
  })

  test("keeps a saved shell the list does not have, so the picker shows it rather than another", () => {
    const options = shellSelectOptions({ shells: [zsh], current: "/usr/local/bin/nu", ...labels })
    expect(options.at(-1)).toEqual({ id: "/usr/local/bin/nu", value: "/usr/local/bin/nu", label: "/usr/local/bin/nu" })
    expect(selectedShellOption(options, "/usr/local/bin/nu").id).toBe("/usr/local/bin/nu")
  })

  test("adds nothing for a saved shell the list already has", () => {
    expect(shellSelectOptions({ shells: [zsh, bash], current: "bash", ...labels })).toHaveLength(3)
  })

  test("treats a listed shell saved by its path as that shell, without a second option for it", () => {
    const options = shellSelectOptions({ shells: [zsh, bash], current: "/bin/zsh", ...labels })
    expect(options).toHaveLength(3)
    expect(new Set(options.map((option) => option.id)).size).toBe(options.length)
    expect(selectedShellOption(options, "/bin/zsh")).toEqual({ id: "/bin/zsh", value: "zsh", label: "zsh" })
  })

  test("selects the saved shell, and Auto when none is saved", () => {
    const options = shellSelectOptions({ shells: [zsh, bash], current: "zsh", ...labels })
    expect(selectedShellOption(options, "zsh").id).toBe("/bin/zsh")
    expect(selectedShellOption(options, "").id).toBe("auto")
  })
})
