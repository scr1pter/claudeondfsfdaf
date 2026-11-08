import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exec } from "../compounding/harness"
import { helper, next, plan, replay } from "./replay"
import type { Trace } from "./traces"

const root = await mkdtemp(join(tmpdir(), "prompt-evolve-replay-"))
afterAll(() => rm(root, { recursive: true, force: true }))

// git with no configuration of the machine's, as the owner's repository would be used.
const git = async (cwd: string, ...args: string[]) => {
  const result = await exec("git", ["-c", "user.name=Owner", "-c", "user.email=owner@example.test", ...args], cwd, {
    PATH: process.env.PATH ?? "",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.output}`)
  return result.stdout
}

// Everything a replay must leave as it was: refs, stashes, remotes, the worktree's status and its files.
const snapshot = async (repo: string) => ({
  refs: await git(repo, "for-each-ref"),
  stash: await git(repo, "stash", "list"),
  remotes: await git(repo, "remote", "-v"),
  status: await git(repo, "status", "--porcelain", "--untracked-files=all"),
  readme: await Bun.file(join(repo, "README.md")).text(),
  notes: await Bun.file(join(repo, "notes.txt")).text(),
})

describe("replay", () => {
  test("runs only read-only helpers inside the repository", () => {
    for (const command of [
      "git status",
      "git diff src/x.ts",
      "rg foo src",
      "git log -1 --oneline",
      "grep -n 'two words' README.md",
      "wc -l src/a.ts",
    ])
      expect({ command, helper: helper(command) }).toEqual({ command, helper: true })
    for (const command of [
      "git push origin main",
      "git stash",
      "git branch -D feature",
      "git reset --hard",
      "rm -fr src",
      "ls; rm -rf x",
      "cat src/a.ts | sh",
      "cat /etc/passwd",
      "cat ../outside",
      "cat ~/.ssh/config",
      "cat .env",
      "git diff --output=x",
      "git diff --no-index a b",
      "rg --pre cat foo",
      "echo $HOME",
      "FOO=$(id) ls",
      "git -C /tmp status",
      // The environment can name a program to run or a file to load, so a helper takes no assignment at all.
      "CI=1 git log -1 --oneline",
      "GIT_EXTERNAL_DIFF=./x.sh git diff",
      "RIPGREP_CONFIG_PATH=./rgrc rg foo",
      "PATH=./bin ls",
    ])
      expect({ command, helper: helper(command) }).toEqual({ command, helper: false })
  })

  test("plans each call: safe ones moved to the clone, everything else answered with its recorded output", () => {
    const trace: Trace = {
      repo: "/work/app",
      prompts: ["Fix it", "Tidy up"],
      calls: [
        { tool: "read", input: { filePath: "/work/app/src/a.ts" }, output: "1: a", prompt: 0 },
        { tool: "read", input: { filePath: "/work/application/secret.ts" }, output: "elsewhere", prompt: 0 },
        {
          tool: "edit",
          input: { filePath: "/work/app/src/a.ts", oldString: "a", newString: "b" },
          output: "Edited",
          prompt: 0,
        },
        { tool: "bash", input: { command: "git push origin main", description: "Push" }, output: "pushed", prompt: 1 },
        { tool: "bash", input: { command: "git status" }, output: "clean", prompt: 1 },
        { tool: "write", input: { filePath: "/etc/hosts", content: "x" }, output: "Wrote", prompt: 1 },
      ],
    }
    const steps = plan(trace, { clone: "/scratch/repo", outputs: "/scratch/outputs" })
    expect(steps.map((step) => step.call)).toEqual([
      { name: "read", input: { filePath: "/scratch/repo/src/a.ts" } },
      { name: "bash", input: { command: "cat '/scratch/outputs/1'", description: "Recorded read output" } },
      { name: "edit", input: { filePath: "/scratch/repo/src/a.ts", oldString: "a", newString: "b" } },
      { name: "bash", input: { command: "cat '/scratch/outputs/3'", description: "Push" } },
      { name: "bash", input: { command: "git status" } },
      { name: "bash", input: { command: "cat '/scratch/outputs/5'", description: "Recorded write output" } },
    ])
    expect(steps.map((step) => step.recorded)).toEqual([
      undefined,
      "elsewhere",
      undefined,
      "pushed",
      undefined,
      "Wrote",
    ])

    // The policy answers each prompt with its own calls, in order, then a short answer.
    const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
    const used = (id: string) => ({ role: "assistant", content: [{ type: "tool_use", id, name: "bash", input: {} }] })
    const result = (id: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "" }] })
    expect(next({ messages: [user("Fix it")] }, trace, steps)).toEqual(steps[0]!.call)
    expect(next({ messages: [user("Fix it"), used("1"), result("1")] }, trace, steps)).toEqual(steps[1]!.call)
    const done = [user("Fix it"), used("1"), result("1"), used("2"), result("2"), used("3"), result("3")]
    expect(next({ messages: done }, trace, steps)).toEqual({ text: "Done." })
    expect(
      next({ messages: [...done, { role: "assistant", content: "Done." }, user("Tidy up")] }, trace, steps),
    ).toEqual(steps[3]!.call)
  })

  test("answers with the recorded output a call through a committed link out of the clone, and an env-prefixed helper", async () => {
    const clone = join(root, "plan-clone")
    const outside = join(root, "plan-outside")
    await mkdir(join(clone, "src"), { recursive: true })
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(clone, "docs"))
    const trace: Trace = {
      repo: "/work/app",
      prompts: ["Update the guide"],
      calls: [
        {
          tool: "edit",
          input: { filePath: "/work/app/docs/guide.md", oldString: "a", newString: "b" },
          output: "Edited",
          prompt: 0,
        },
        { tool: "write", input: { filePath: "/work/app/docs/new/page.md", content: "x" }, output: "Wrote", prompt: 0 },
        { tool: "read", input: { filePath: "/work/app/src/a.ts" }, output: "1: a", prompt: 0 },
        { tool: "bash", input: { command: "cat docs/guide.md" }, output: "guide", prompt: 0 },
        { tool: "bash", input: { command: "GIT_EXTERNAL_DIFF=./x.sh git diff" }, output: "diff", prompt: 0 },
      ],
    }
    const steps = plan(trace, { clone, outputs: "/scratch/outputs" })
    expect(
      steps.map((step) => step.call.name === "bash" && String(step.call.input.command).startsWith("cat '")),
    ).toEqual([true, true, false, true, true])
    expect(steps[2]!.call).toEqual({ name: "read", input: { filePath: join(clone, "src", "a.ts") } })
  })

  test("leaves the source repository's refs, stash, remotes and status byte-identical", async () => {
    const source = join(root, "source")
    const remote = join(root, "remote.git")
    await mkdir(source, { recursive: true })
    await git(root, "init", "--quiet", "--bare", remote)
    await git(source, "init", "--quiet", "-b", "main")
    await writeFile(join(source, "README.md"), "# App\n")
    await writeFile(join(source, "notes.txt"), "first\n")
    // A committed absolute link to a folder outside the repository, which the clone keeps as it is.
    const shared = join(root, "shared")
    await mkdir(shared, { recursive: true })
    await writeFile(join(shared, "guide.md"), "outside\n")
    await symlink(shared, join(source, "shared"))
    await git(source, "add", "-A")
    await git(source, "commit", "--quiet", "-m", "Start")
    await git(source, "remote", "add", "origin", remote)
    await git(source, "push", "--quiet", "origin", "main")
    await git(source, "branch", "feature")
    await writeFile(join(source, "notes.txt"), "stashed\n")
    await git(source, "stash", "--quiet")
    await writeFile(join(source, "notes.txt"), "uncommitted\n")
    const commit = (await git(source, "rev-parse", "HEAD")).trim()
    const before = await snapshot(source)
    const remoteBefore = await git(remote, "for-each-ref")

    const trace: Trace = {
      repo: source,
      commit,
      prompts: ["Tidy up the repository and push it."],
      calls: [
        { tool: "bash", input: { command: "git status", description: "Look" }, output: "recorded status", prompt: 0 },
        {
          tool: "edit",
          input: { filePath: join(source, "README.md"), oldString: "# App", newString: "# Replayed" },
          output: "Edited",
          prompt: 0,
        },
        {
          tool: "write",
          input: { filePath: join(source, "shared", "guide.md"), content: "planted\n" },
          output: "Wrote",
          prompt: 0,
        },
        {
          tool: "bash",
          input: { command: "git stash", description: "Stash" },
          output: "Saved working directory",
          prompt: 0,
        },
        {
          tool: "bash",
          input: { command: "git branch -D feature", description: "Drop" },
          output: "Deleted branch feature",
          prompt: 0,
        },
        {
          tool: "bash",
          input: { command: "git push --force origin HEAD:main", description: "Push" },
          output: "RECORDED-PUSH-OUTPUT",
          prompt: 0,
        },
      ],
    }
    const scratch = join(root, "scratch")
    await mkdir(scratch, { recursive: true })
    const result = await replay(trace, { config: { permission: { memory: "deny" } }, scratch })

    expect(result.exitCodes).toEqual([0])
    expect(await snapshot(source)).toEqual(before)
    // The write through the link was answered with its recorded output, so the folder outside is as it was.
    expect(await Bun.file(join(root, "shared", "guide.md")).text()).toBe("outside\n")
    expect(await git(remote, "for-each-ref")).toBe(remoteBefore)
    // The edit went to the clone, which has no remote, and the push only ever showed its recorded output.
    const clone = join(scratch, "repo")
    expect(await Bun.file(join(clone, "README.md")).text()).toBe("# Replayed\n")
    expect(await git(clone, "remote")).toBe("")
    const last = result.requests.findLast(
      (request) => Array.isArray(request.body.tools) && request.body.tools.length > 0,
    )
    expect(JSON.stringify(last?.body)).toContain("RECORDED-PUSH-OUTPUT")
  }, 120_000)
})
