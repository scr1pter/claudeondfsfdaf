import type { BunPlugin } from "bun"

const ALIASED = "_require('esprima')"

// js-yaml 3 hides its optional esprima require behind an alias, so the bundler keeps a bare runtime require. Plain Bun
// auto-installs such a specifier when no node_modules is near the bundle, which strict egress refuses. Fail the same
// require inside js-yaml's own catch instead, exactly as an absent esprima does under Node.
export const sandboxBunEsprima: BunPlugin = {
  name: "absent-optional-esprima",
  setup(build) {
    build.onLoad({ filter: /[\\/]js-yaml[\\/]lib[\\/]js-yaml[\\/]type[\\/]js[\\/]function\.js$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      if (!source.includes(ALIASED)) throw new Error(`${args.path} no longer requires esprima through an alias`)
      return {
        contents: source.replace(ALIASED, '(() => { throw new Error("esprima is not part of the sandbox probe") })()'),
        loader: "js",
      }
    })
  },
}
