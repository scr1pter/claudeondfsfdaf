// @ts-check
import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import solidJs from "@astrojs/solid-js"
import react from "@astrojs/react"
import cloudflare from "@astrojs/cloudflare"
import tailwindcss from "@tailwindcss/vite"
import theme from "./src/theme/index.ts"
import config from "./config.mjs"
import { rehypeHeadingIds } from "@astrojs/markdown-remark"
import rehypeAutolinkHeadings from "rehype-autolink-headings"
import { spawnSync } from "child_process"

// https://astro.build/config
export default defineConfig({
  site: config.url,
  base: "/",
  output: "server",
  adapter: cloudflare({
    imageService: "passthrough",
  }),
  devToolbar: {
    enabled: false,
  },
  server: {
    host: "0.0.0.0",
  },
  markdown: {
    rehypePlugins: [rehypeHeadingIds, [rehypeAutolinkHeadings, { behavior: "wrap" }]],
  },
  build: {},
  vite: {
    define: {
      // Only this public boolean crosses into page metadata; server secrets remain private.
      "import.meta.env.PUBLIC_VECTOR_OG_ENABLED": JSON.stringify(
        process.env.VECTOR_OG_ENABLED === "true" ? "true" : "false",
      ),
    },
    // Astro 5 carries Vite 6 while the workspace-wide Tailwind peer resolves
    // against Vite 7. The plugin API is compatible, but the duplicated Vite
    // type identities are not.
    plugins: [/** @type {never} */ (tailwindcss())],
  },
  integrations: [
    configSchema(),
    react({ include: ["**/components/marketing/**/*.tsx", "**/components/workspaces/**/*.tsx"] }),
    solidJs({ exclude: ["**/components/marketing/**/*.tsx", "**/components/workspaces/**/*.tsx"] }),
    starlight({
      title: "Vector",
      defaultLocale: "root",
      locales: {
        root: {
          label: "English",
          lang: "en",
          dir: "ltr",
        },
      },
      favicon: "/favicon.ico",
      head: [
        {
          tag: "link",
          attrs: {
            rel: "icon",
            href: "/favicon.ico",
            sizes: "any",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/png",
            href: "/favicon-32x32-desktop-v4.png",
            sizes: "32x32",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/png",
            href: "/favicon-96x96-desktop-v4.png",
            sizes: "96x96",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            href: "/apple-touch-icon-desktop-v4.png",
            sizes: "180x180",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "manifest",
            href: "/site.webmanifest",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "theme-color",
            content: "#1d1d1f",
          },
        },
      ],
      lastUpdated: true,
      expressiveCode: { themes: ["github-light", "github-dark"] },
      social: [],
      markdown: {
        headingLinks: false,
      },
      customCss: ["./src/styles/custom.css"],
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        replacesTitle: true,
      },
      sidebar: [],
      components: {
        Hero: "./src/components/Hero.astro",
        Head: "./src/components/Head.astro",
        Header: "./src/components/Header.astro",
        Footer: "./src/components/Footer.astro",
        LanguageSelect: "./src/components/LanguageSelect.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      plugins: [theme()],
    }),
  ],
})

function configSchema() {
  return {
    name: "configSchema",
    hooks: {
      "astro:build:done": async () => {
        console.log("generating config schema")
        spawnSync("../engine/script/schema.ts", ["./dist/config.json", "./dist/tui.json"])
      },
    },
  }
}
