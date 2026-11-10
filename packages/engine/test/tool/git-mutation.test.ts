import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { GitMutation } from "@/tool/shell/git-mutation"

// No git execution is needed to classify effects; real alias lookup is covered by the shell integration test.
const root = path.resolve(os.tmpdir(), "vector-git-classifier", "repository")
const other = path.resolve(root, "..", "other")
const classify = (args: string[], options: Partial<GitMutation.Options> = {}) =>
  GitMutation.classify(["git", ...args], { cwd: root, trees: [root, other], ...options })!

const cases: Array<{ title: string; args: string[]; effects: GitMutation.Kind[] }> = [
  { title: "status", args: ["status"], effects: [] },
  { title: "diff", args: ["diff", "--stat"], effects: [] },
  { title: "log", args: ["log", "-1"], effects: [] },
  { title: "show", args: ["show", "HEAD"], effects: [] },
  { title: "blame", args: ["blame", "file.ts"], effects: [] },
  { title: "grep", args: ["grep", "term"], effects: [] },
  { title: "ls-files", args: ["ls-files"], effects: [] },
  { title: "rev-parse", args: ["rev-parse", "HEAD"], effects: [] },
  { title: "fetch", args: ["fetch", "origin"], effects: [] },
  { title: "push", args: ["push", "origin", "HEAD"], effects: [] },
  { title: "branch listing", args: ["branch", "--list", "vector/*"], effects: [] },
  { title: "branch default listing", args: ["branch"], effects: [] },
  { title: "tag listing", args: ["tag", "--list", "v*"], effects: [] },
  { title: "tag default listing", args: ["tag"], effects: [] },
  { title: "stash list", args: ["stash", "list"], effects: [] },
  { title: "stash show", args: ["stash", "show", "stash@{0}"], effects: [] },
  { title: "checkout paths", args: ["checkout", "HEAD", "--", "src/file.ts"], effects: ["paths"] },
  { title: "restore paths", args: ["restore", "--worktree", "src/file.ts"], effects: ["paths"] },
  { title: "restore dot", args: ["restore", "."], effects: ["tree"] },
  { title: "restore missing paths", args: ["restore"], effects: ["tree"] },
  { title: "rm paths", args: ["rm", "src/file.ts"], effects: ["paths"] },
  { title: "mv paths", args: ["mv", "old.ts", "new.ts"], effects: ["paths"] },
  { title: "clean named paths", args: ["clean", "-f", "src"], effects: ["paths"] },
  { title: "add", args: ["add", "file.ts"], effects: ["index"] },
  { title: "reset paths", args: ["reset", "--", "src/file.ts"], effects: ["index"] },
  { title: "reset mixed without commit", args: ["reset", "--mixed"], effects: ["index"] },
  { title: "reset soft without commit", args: ["reset", "--soft"], effects: ["index"] },
  { title: "restore staged", args: ["restore", "--staged", "file.ts"], effects: ["index"] },
  { title: "rm cached", args: ["rm", "--cached", "file.ts"], effects: ["index"] },
  { title: "apply cached", args: ["apply", "--cached", "change.patch"], effects: ["index"] },
  { title: "commit", args: ["commit", "-m", "Change"], effects: ["head", "index"] },
  { title: "reset soft commit", args: ["reset", "--soft", "HEAD~1"], effects: ["head", "index"] },
  { title: "reset default commit", args: ["reset", "HEAD~1"], effects: ["head", "index"] },
  { title: "reset mixed commit", args: ["reset", "--mixed", "HEAD~1"], effects: ["head", "index"] },
  { title: "reset hard", args: ["reset", "--hard", "HEAD~1"], effects: ["tree", "head"] },
  { title: "reset merge", args: ["reset", "--merge", "HEAD~1"], effects: ["tree", "head"] },
  { title: "reset keep", args: ["reset", "--keep", "HEAD~1"], effects: ["tree", "head"] },
  { title: "merge", args: ["merge", "feature"], effects: ["tree", "head"] },
  { title: "rebase", args: ["rebase", "main"], effects: ["tree", "head"] },
  { title: "pull", args: ["pull", "origin", "main"], effects: ["tree", "head"] },
  { title: "cherry-pick", args: ["cherry-pick", "abc123"], effects: ["tree", "head"] },
  { title: "revert", args: ["revert", "abc123"], effects: ["tree", "head"] },
  { title: "am", args: ["am", "change.patch"], effects: ["tree", "head"] },
  { title: "stash pop", args: ["stash", "pop"], effects: ["tree", "head"] },
  { title: "stash apply", args: ["stash", "apply"], effects: ["tree", "head"] },
  { title: "clean tree", args: ["clean", "-fd"], effects: ["tree"] },
  { title: "apply tree", args: ["apply", "change.patch"], effects: ["tree"] },
  { title: "submodule update", args: ["submodule", "update", "--init"], effects: ["tree"] },
  { title: "submodule init", args: ["submodule", "init"], effects: ["tree"] },
  { title: "checkout branch", args: ["checkout", "main"], effects: ["branch"] },
  { title: "checkout detach", args: ["checkout", "--detach", "HEAD"], effects: ["branch"] },
  { title: "switch branch", args: ["switch", "main"], effects: ["branch"] },
  { title: "checkout new branch at ref", args: ["checkout", "-b", "new", "main"], effects: ["branch"] },
  { title: "switch new branch at ref", args: ["switch", "-c", "new", "main"], effects: ["branch"] },
  { title: "checkout new branch at current head", args: ["checkout", "-b", "new"], effects: ["head"] },
  { title: "switch new branch at current head", args: ["switch", "-c", "new"], effects: ["head"] },
  { title: "stash default", args: ["stash"], effects: ["stash"] },
  { title: "stash push", args: ["stash", "push"], effects: ["stash"] },
  { title: "stash save", args: ["stash", "save", "Work"], effects: ["stash"] },
  { title: "stash include untracked", args: ["stash", "-u"], effects: ["stash"] },
  { title: "stash keep index", args: ["stash", "-k"], effects: ["stash"] },
  { title: "branch delete", args: ["branch", "-d", "feature"], effects: ["refs"] },
  { title: "branch force delete", args: ["branch", "-D", "feature"], effects: ["refs"] },
  { title: "branch move", args: ["branch", "-m", "old", "new"], effects: ["refs"] },
  { title: "branch force move", args: ["branch", "-M", "old", "new"], effects: ["refs"] },
  { title: "branch copy", args: ["branch", "-c", "old", "new"], effects: ["refs"] },
  { title: "branch force copy", args: ["branch", "-C", "old", "new"], effects: ["refs"] },
  { title: "branch force create", args: ["branch", "-f", "new", "main"], effects: ["refs"] },
  { title: "tag create", args: ["tag", "v1"], effects: ["refs"] },
  { title: "tag delete", args: ["tag", "-d", "v1"], effects: ["refs"] },
  { title: "update-ref", args: ["update-ref", "refs/heads/new", "HEAD"], effects: ["refs"] },
  { title: "symbolic-ref write", args: ["symbolic-ref", "HEAD", "refs/heads/new"], effects: ["refs"] },
  { title: "symbolic-ref read", args: ["symbolic-ref", "HEAD"], effects: [] },
  { title: "worktree add", args: ["worktree", "add", "../task", "main"], effects: ["refs"] },
  { title: "worktree remove", args: ["worktree", "remove", "../task"], effects: ["refs"] },
  { title: "worktree move", args: ["worktree", "move", "../old", "../new"], effects: ["refs"] },
  { title: "worktree prune", args: ["worktree", "prune"], effects: ["refs"] },
  { title: "worktree lock", args: ["worktree", "lock", "../task"], effects: ["refs"] },
  { title: "worktree list", args: ["worktree", "list"], effects: [] },
  { title: "stash drop", args: ["stash", "drop"], effects: ["refs"] },
  { title: "stash clear", args: ["stash", "clear"], effects: ["refs"] },
  { title: "reflog expire", args: ["reflog", "expire", "--all"], effects: ["refs"] },
  { title: "reflog delete", args: ["reflog", "delete", "main@{0}"], effects: ["refs"] },
  { title: "gc", args: ["gc"], effects: ["refs"] },
  { title: "prune", args: ["prune"], effects: ["refs"] },
  { title: "replace", args: ["replace", "abc", "def"], effects: ["refs"] },
  { title: "notes add", args: ["notes", "add", "-m", "Note"], effects: ["refs"] },
]

describe("GitMutation effects", () => {
  for (const item of cases)
    test(item.title, () => {
      expect(classify(item.args).effects.toSorted()).toEqual(item.effects.toSorted())
    })

  test("stash branch includes ref changes and its working-tree/head effects", () => {
    expect(classify(["stash", "branch", "new"]).effects).toEqual(["tree", "head", "refs"])
  })

  test("every mutating stash operation retains its semantic marker, including aliases", () => {
    for (const args of [
      ["stash"],
      ["stash", "push"],
      ["stash", "pop"],
      ["stash", "apply"],
      ["stash", "drop"],
      ["stash", "clear"],
      ["stash", "branch", "new"],
    ])
      expect(classify(args).stash).toBe(true)
    expect(classify(["pop"], { aliases: { pop: "stash pop" } }).stash).toBe(true)
    expect(classify(["stash", "list"]).stash).toBeUndefined()
    expect(classify(["stash", "show"]).stash).toBeUndefined()
  })

  test("nonmutating checks and previews have no effect", () => {
    for (const args of [
      ["clean", "-nd"],
      ["add", "--dry-run", "."],
      ["commit", "--dry-run"],
      ["apply", "--check", "patch"],
      ["apply", "--stat", "patch"],
      ["apply", "--numstat", "patch"],
    ])
      expect(classify(args).effects).toEqual([])
  })

  test("--apply reenables writes after report-only and check modes", () => {
    for (const mode of ["--stat", "--numstat", "--summary", "--check"]) {
      expect(classify(["apply", mode, "--apply", "patch"]).effects).toEqual(["tree"])
      expect(classify(["apply", "--cached", mode, "--apply", "patch"]).effects).toEqual(["index"])
    }
  })

  test("valid negated flags follow their final value", () => {
    expect(classify(["rm", "--cached", "--no-cached", "p"]).effects).toEqual(["paths"])
    expect(classify(["rm", "--no-cached", "--cached", "p"]).effects).toEqual(["index"])
    expect(classify(["clean", "--dry-run", "--no-dry-run", "-f"]).effects).toEqual(["tree"])
    expect(classify(["clean", "--no-dry-run", "--dry-run", "-f"]).effects).toEqual([])
    expect(classify(["apply", "--stat", "--no-stat", "patch"]).effects).toEqual(["tree"])
    expect(classify(["restore", "--staged", "--no-staged", "owned.ts"]).effects).toEqual(["paths"])
    expect(classify(["restore", "--no-staged", "--staged", "owned.ts"]).effects).toEqual(["index"])
    expect(classify(["restore", "-SW", "--no-worktree", "owned.ts"]).effects).toEqual(["index"])
    expect(classify(["restore", "-SW", "--no-staged", "owned.ts"]).effects).toEqual(["paths"])
    expect(classify(["restore", "--no-staged", "-SW", "owned.ts"]).effects.toSorted()).toEqual(["index", "paths"])
    expect(classify(["apply", "--cached", "--no-cached", "patch"]).effects).toEqual(["tree"])
    expect(classify(["apply", "--no-cached", "--cached", "patch"]).effects).toEqual(["index"])
    expect(classify(["apply", "--index", "--no-index", "patch"]).effects).toEqual(["tree"])
    expect(classify(["apply", "--no-index", "--index", "patch"]).effects).toEqual(["tree", "index"])
  })

  test("option values and literal filenames cannot masquerade as readonly modes", () => {
    expect(classify(["commit", "-m", "--dry-run"]).effects).toEqual(["head", "index"])
    expect(classify(["commit", "--author", "--dry-run"]).effects).toEqual(["head", "index"])
    expect(classify(["apply", "--", "--stat"]).effects).toEqual(["tree"])
    expect(classify(["apply", "--directory", "--stat", "patch"]).effects).toEqual(["tree"])
    expect(classify(["add", "--", "--dry-run"]).effects).toEqual(["index"])
    expect(classify(["stash", "-m", "show"]).stash).toBe(true)
    expect(classify(["stash", "--", "show"]).stash).toBe(true)
    expect(classify(["clean", "-e", "-n", "-f"]).effects).toEqual(["tree"])
    expect(classify(["restore", "-sS", "owned.ts"]).effects).toEqual(["paths"])
    expect(classify(["clean", "-en", "-f"]).effects).toEqual(["tree"])
  })

  test("combined restore staged/worktree options include both mutations", () => {
    expect(classify(["restore", "-SW", "file.ts"]).effects.toSorted()).toEqual(["index", "paths"])
  })
})

describe("GitMutation paths and placement", () => {
  test("checkout paths include only the pathspec after --", () => {
    expect(classify(["checkout", "main", "--", "src/file.ts"]).paths).toEqual([path.join(root, "src/file.ts")])
    expect(classify(["mv", "old.ts", "new.ts"]).paths).toEqual([path.join(root, "old.ts"), path.join(root, "new.ts")])
  })

  test("-C is relative to the previous effective directory and retained for alias lookup", () => {
    const result = classify(["-C", "../other", "-C", "nested", "checkout", "--", "file.ts"])
    expect(result).toMatchObject({
      tree: other,
      directory: path.join(other, "nested"),
      gitArgs: ["-C", "../other", "-C", "nested"],
      paths: [path.join(other, "nested/file.ts")],
    })
  })

  test("-c, pager options and separate global values are skipped without losing the command", () => {
    const gitArgs = ["-p", "--no-pager", "-c", "core.fsmonitor=false", "--namespace", "test"]
    expect(classify([...gitArgs, "reset", "--hard"]).gitArgs).toEqual(gitArgs)
    expect(classify([...gitArgs, "reset", "--hard"]).effects).toEqual(["tree", "head"])
  })

  test("--git-dir and --work-tree redirect to their known tree", () => {
    expect(classify(["--git-dir", path.join(other, ".git"), "reset", "--hard"]).tree).toBe(other)
    expect(classify([`--git-dir=${path.join(other, ".git")}`, "reset", "--hard"]).tree).toBe(other)
    const result = classify(["--work-tree", other, "checkout", "--", "file.ts"])
    expect(result.tree).toBe(other)
    expect(result.directory).toBe(other)
    expect(result.paths).toEqual([path.join(other, "file.ts")])
  })

  test("leading Git environment assignments participate in placement", () => {
    for (const variable of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
      const value =
        variable === "GIT_WORK_TREE" ? other : path.join(other, ".git", variable === "GIT_DIR" ? "" : "index")
      const result = GitMutation.classify([`${variable}=${value}`, "git", "add", "file.ts"], {
        cwd: root,
        trees: [root, other],
      })!
      expect(result.tree).toBe(other)
      expect(result.gitArgs).toEqual([])
    }
  })

  test("inherited Git overrides and CLI overrides are applied in git precedence order", () => {
    expect(classify(["add", "file.ts"], { env: { GIT_WORK_TREE: other } }).tree).toBe(other)
    expect(classify(["--work-tree", root, "add", "file.ts"], { env: { GIT_WORK_TREE: other } }).tree).toBe(root)
  })

  test("a temporary index cannot hide a mutation of the actual checkout", () => {
    // GIT_INDEX_FILE changes index placement, not HEAD or the files reset/checkout/merge overwrite.
    const env = { GIT_INDEX_FILE: path.resolve(other, "..", "outside-index") }
    expect(classify(["reset", "--hard"], { env }).tree).toBe(root)
    expect(classify(["checkout", "main"], { env }).tree).toBe(root)
    expect(classify(["commit", "-m", "Change"], { env }).tree).toBe(root)
    expect(GitMutation.classify(["git", "add", "file.ts"], { cwd: root, trees: [root, other], env })).toBeUndefined()
  })

  test("an external gitdir cannot hide writes to a known actual checkout", () => {
    const gitDirectory = path.resolve(root, "..", "unregistered", ".git")
    for (const args of [
      ["reset", "--hard"],
      ["checkout", "main"],
      ["checkout", "--", "owned.ts"],
    ]) {
      const result = classify(["--git-dir", gitDirectory, ...args])
      expect(result).toMatchObject({ tree: root, workingTree: root, directory: root, gitDirectory })
    }
    expect(classify(["--git-dir", gitDirectory, "checkout", "--", "owned.ts"]).paths).toEqual([
      path.join(root, "owned.ts"),
    ])
    expect(
      GitMutation.classify(["git", "--git-dir", gitDirectory, "add", "owned.ts"], { cwd: root, trees: [root, other] }),
    ).toBeUndefined()
  })

  test("explicit work-tree controls actual paths while git-dir retains its metadata identity", () => {
    const gitDirectory = path.join(root, ".git")
    const result = classify(["--git-dir", gitDirectory, "--work-tree", other, "checkout", "--", "owned.ts"])
    expect(result).toMatchObject({ tree: root, workingTree: other, directory: other, gitDirectory })
    expect(result.paths).toEqual([path.join(other, "owned.ts")])
  })

  test("mutations outside every known tree are dropped", () => {
    expect(
      GitMutation.classify(["git", "-C", path.resolve(root, "..", "unknown"), "reset", "--hard"], {
        cwd: root,
        trees: [root, other],
      }),
    ).toBeUndefined()
  })

  test("the longest matching known tree wins and registered linked git directories are recognized", () => {
    const nested = path.join(root, "nested")
    expect(classify(["-C", nested, "reset", "--hard"], { trees: [root, nested] }).tree).toBe(nested)
    const gitDir = path.resolve(root, "..", "common", "worktrees", "task")
    expect(classify(["--git-dir", gitDir, "reset", "--hard"], { gitDirectories: { [gitDir]: other } }).tree).toBe(other)
    const linked = classify(["--git-dir", gitDir, "checkout", "--", "owned.ts"], {
      gitDirectories: { [gitDir]: other },
    })
    expect(linked).toMatchObject({ tree: other, workingTree: root, directory: root, gitDirectory: gitDir })
    expect(linked.paths).toEqual([path.join(root, "owned.ts")])
  })

  test("caller canonicalization matches differently cased or aliased tree spellings", () => {
    const canonicalize = (file: string) => path.resolve(file).toLowerCase()
    expect(classify(["-C", root.toUpperCase(), "status"], { canonicalize }).tree).toBe(root.toLowerCase())
  })

  test("dynamic targets are left out and globs guard their known literal parent", () => {
    expect(classify(["checkout", "--", "$OUT", "`target`", "%OUT%"]).paths).toEqual([])
    expect(classify(["checkout", "--", "src/*.ts"]).paths).toEqual([path.join(root, "src")])
    expect(classify(["checkout", "--", "*.ts"]).paths).toEqual([root])
  })

  test("pathspec magic and hidden pathspec files cannot become invented literal paths", () => {
    for (const magic of [":(top)src/x", ":/src/x", ":(glob)src/*.ts", ":!src/x", ":^src/x"])
      expect(classify(["checkout", "--", magic]).effects).toContain("tree")
    for (const args of [
      ["checkout", "--pathspec-from-file=list", "--", "p"],
      ["restore", "--pathspec-from-file", "list", "p"],
      ["rm", "--pathspec-from-file=list", "p"],
    ])
      expect(classify(args).effects).toContain("tree")
  })

  test("uncertain directory flags retain a conservative current-tree effect", () => {
    expect(classify(["-C", "$OUT", "reset", "--hard"]).effects).toContain("tree")
    expect(classify(["--work-tree=$OUT", "checkout", "--", "file.ts"]).tree).toBe(root)
  })
})

describe("GitMutation aliases and shared references", () => {
  test("an unknown alias requests one read-only lookup and stays conservative until resolved", () => {
    expect(classify(["co", "main"])).toMatchObject({ effects: ["tree"], alias: "co" })
    expect(classify(["co", "main"], { aliases: { co: "checkout" } })).toMatchObject({
      effects: ["branch"],
      refs: ["main"],
    })
    expect(classify(["co", "main"], { aliases: { co: "checkout" } }).alias).toBeUndefined()
  })

  test("aliases preserve quoted arguments and resolve only once", () => {
    expect(classify(["co"], { aliases: { co: 'checkout "feature with spaces"' } }).refs).toEqual([
      "feature with spaces",
    ])
    expect(classify(["co"], { aliases: { co: "other", other: "status" } })).toMatchObject({ effects: ["tree"] })
    expect(classify(["co"], { aliases: { co: "other", other: "status" } }).alias).toBeUndefined()
  })

  test("shell aliases and malformed aliases are never interpreted", () => {
    for (const value of ["!git reset --hard", "!echo hi", "checkout 'unterminated"]) {
      expect(classify(["co"], { aliases: { co: value } }).effects).toEqual(["tree"])
      expect(classify(["co"], { aliases: { co: value } }).alias).toBeUndefined()
    }
  })

  test("-c aliases override configured aliases, including shell aliases", () => {
    expect(classify(["-c", "alias.co=checkout", "co", "main"], { aliases: { co: "status" } }).effects).toEqual([
      "branch",
    ])
    expect(classify(["-c", "alias.co=!git reset --hard", "co"]).effects).toEqual(["tree"])
  })

  test("branch-creation and direct reference mutations retain reserved-name operands", () => {
    expect(classify(["checkout", "-b", "vector/subagent/test"]).refs).toContain("vector/subagent/test")
    expect(classify(["checkout", "-bvector/subagent/test"]).refs).toContain("vector/subagent/test")
    expect(classify(["switch", "-cvector/subagent/test"]).refs).toContain("vector/subagent/test")
    expect(classify(["checkout", "--orphan=vector/subagent/test"]).refs).toContain("vector/subagent/test")
    expect(classify(["switch", "--orphan=vector/subagent/test"]).refs).toContain("vector/subagent/test")
    expect(classify(["worktree", "add", "-bvector/subagent/test", "../task"]).refs).toContain("vector/subagent/test")
    expect(classify(["branch", "-D", "vector/subagent/test"]).refs).toContain("vector/subagent/test")
    expect(classify(["tag", "vector/subagent/test"]).refs).toContain("vector/subagent/test")
    expect(classify(["update-ref", "refs/heads/vector/subagent/test", "HEAD"]).refs).toContain(
      "refs/heads/vector/subagent/test",
    )
    expect(classify(["update-ref", "--stdin"]).refs).toEqual(["*"])
  })

  test("unknown mutation ref operands remain explicit broad targets", () => {
    for (const args of [
      ["branch", "-D", "$TARGET"],
      ["update-ref", "$REF", "HEAD"],
      ["tag", "$TAG"],
      ["worktree", "remove", "$WORKTREE"],
      ["gc"],
      ["prune"],
    ])
      expect(classify(args).refs).toContain("*")
    expect(classify(["checkout", "--", "$OUT"]).paths).toEqual([])
  })

  test("negated listing modes do not erase a later ref mutation", () => {
    expect(classify(["branch", "--list", "--no-list", "new"]).effects).toEqual(["refs"])
    expect(classify(["tag", "--list", "--no-list", "new"]).effects).toEqual(["refs"])
    expect(classify(["branch", "--show-current", "--no-show-current", "new"]).effects).toEqual(["refs"])
  })

  test("worktree mutation operands include their absolute directory", () => {
    expect(classify(["worktree", "remove", "../task"]).refs).toContain(path.resolve(root, "../task"))
    expect(classify(["worktree", "prune"]).refs).toContain("*")
    expect(classify(["wt", "../task"], { aliases: { wt: "worktree remove" } }).refs).toContain(
      path.resolve(root, "../task"),
    )
  })

  test("non-git commands and incomplete global flags produce no git result", () => {
    expect(GitMutation.classify(["echo", "git", "reset"], { cwd: root })).toBeUndefined()
    expect(GitMutation.classify(["git", "-C"], { cwd: root })).toBeUndefined()
    expect(GitMutation.classify(["git", "-c"], { cwd: root })).toBeUndefined()
  })
})
