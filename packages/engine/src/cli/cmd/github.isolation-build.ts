// Builds replace this exact module with immutable literals. Source execution is always inactive.
export const enabled: boolean = false
export const asset: { readonly v: 1; readonly entry: string; readonly sha256: string } | undefined = undefined

export * as GithubIsolationBuild from "./github.isolation-build"
