import { describe, expect, test } from "bun:test"
import path from "path"
import { Shell } from "@vectordevai/core/shell"
import { FSUtil } from "@vectordevai/core/fs-util"
import { which } from "@vectordevai/core/util/which"

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

describe("shell", () => {
  test("normalizes shell names", () => {
    expect(Shell.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(Shell.name("C:/tools/NU.EXE")).toBe("nu")
      expect(Shell.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("detects login shells", () => {
    expect(Shell.login("/bin/bash")).toBe(true)
    expect(Shell.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("detects posix shells", () => {
    expect(Shell.posix("/bin/bash")).toBe(true)
    expect(Shell.posix("/bin/fish")).toBe(false)
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const preferred = Shell.preferred()
      const acceptable = Shell.acceptable()
      expect(Shell.preferred("vector-missing-shell")).toBe(preferred)
      expect(Shell.acceptable("vector-missing-shell")).toBe(acceptable)
    })
  })

  test("falls back for terminal-only acceptable shells", () => {
    expect(Shell.name(Shell.acceptable("fish"))).not.toBe("fish")
    expect(Shell.name(Shell.acceptable("nu"))).not.toBe("nu")
  })

  test("builds command args per shell family", () => {
    expect(Shell.args("/bin/sh", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    expect(Shell.args("/usr/bin/fish", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    const zsh = Shell.args("/bin/zsh", "echo hi", "/tmp")
    expect(zsh[0]).toBe("-l")
    expect(zsh[1]).toBe("-c")
    // The directory and the command line are positional parameters, never part of the script.
    expect(zsh.slice(-2)).toEqual(["/tmp", "echo hi"])
    expect(zsh[2]).not.toContain("echo hi")
  })

  // The wrapper runs a command line exactly once, as written: nothing in it is expanded before eval reads it, so what
  // the permission scan read (single quotes literal, a line break a line break) is what runs.
  for (const shell of ["bash", "zsh"]) {
    const file = which(shell)
    test.skipIf(!file || process.platform === "win32")(`${shell} wrapper runs a command line as written`, async () => {
      const run = async (line: string) => {
        const proc = Bun.spawn([file!, ...Shell.args(file!, line, process.cwd())], {
          env: { ...process.env, HOME: process.cwd(), ZDOTDIR: process.cwd() },
          stdout: "pipe",
          stderr: "pipe",
        })
        const out = await new Response(proc.stdout).text()
        await proc.exited
        return out
      }
      expect(await run("echo 'literal $HOME'")).toBe("literal $HOME\n")
      expect(await run("echo 'x $(echo SUBST-RAN) `echo TICK-RAN`'")).toBe("x $(echo SUBST-RAN) `echo TICK-RAN`\n")
      expect(await run("printf 'a b\\n' | awk '{print $2}'")).toBe("b\n")
      expect(await run("echo first\necho second")).toBe("first\nsecond\n")
      expect(await run("set -- one two; echo \"$1\"")).toBe("one\n")
    })
  }

  test("shows the command line a shell runs, not the bash or zsh wrapper around it", () => {
    const line = 'sleep 30 && npm run dev -- --host "0.0.0.0"\necho done'
    for (const shell of ["/bin/zsh", "/bin/bash"])
      expect(Shell.commandLine(shell, Shell.args(shell, line, "/tmp"))).toBe(line)
    // Other shells take the line as their last argument, and a program its own arguments.
    expect(Shell.commandLine("/bin/sh", Shell.args("/bin/sh", "echo hi", "/tmp"))).toBe("/bin/sh -c echo hi")
    expect(Shell.commandLine("/usr/bin/node", ["server.js", "--port", "3000"])).toBe(
      "/usr/bin/node server.js --port 3000",
    )
    // A wrapper-shaped argv whose script is not the wrapper's own is shown as it is.
    const odd = ["-l", "-c", 'cd -- "$1"\neval "$2"\n', "vector", "/tmp", "rm -rf ~"]
    expect(Shell.commandLine("/bin/bash", odd)).toBe(["/bin/bash", ...odd].join(" "))
  })

  test("tells an interactive shell from a program reading the terminal", () => {
    expect(Shell.interactive("/bin/zsh", ["-l"])).toBe(true)
    expect(Shell.interactive("/bin/bash", [])).toBe(true)
    expect(Shell.interactive("/bin/bash", ["--login", "-i"])).toBe(true)
    expect(Shell.interactive("/bin/bash", Shell.args("/bin/bash", "npm run dev", "/tmp"))).toBe(false)
    expect(Shell.interactive("/bin/sh", ["-c", "vite"])).toBe(false)
    expect(Shell.interactive("/bin/bash", ["script.sh"])).toBe(false)
    expect(Shell.interactive("/usr/bin/python3", [])).toBe(false)
    expect(Shell.interactive("/usr/bin/ssh", ["host"])).toBe(false)
    expect(Shell.interactive("/usr/bin/fish", [])).toBe(false)
    expect(Shell.interactive("/usr/local/bin/pwsh", ["-NoLogo"])).toBe(true)
    expect(Shell.interactive("/usr/local/bin/pwsh", ["-NoProfile", "-Command", "dir"])).toBe(false)
  })

  if (process.platform === "win32") {
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(Shell.name(Shell.acceptable())).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      const shell = "/cygdrive/c/Program Files/Git/bin/bash.exe"
      await withShell(shell, async () => {
        expect(Shell.preferred()).toBe(FSUtil.windowsPath(shell))
      })
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      await withShell("/usr/bin/bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      expect(Shell.acceptable("bash")).toBe(bash)
      expect(Shell.preferred("bash")).toBe(bash)
      await withShell("bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(Shell.preferred()).toBe(shell)
      })
    })
  }
})
