/** @jsxImportSource react */
import React from "react"
import "./founders.css"

/** One listed founder as the founders API answers it: the number and the display name they chose, if any. */
export type FounderRow = { number: number; name?: string }
type Page = { public: boolean; founders: FounderRow[] }

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} .'_-]{0,39}$/u

/** The founders API's answer, or undefined when it is not one. Names are kept only in the shape the server allows. */
export function readFoundersPage(value: unknown): Page | undefined {
  if (!value || typeof value !== "object") return undefined
  const page = value as Record<string, unknown>
  if (typeof page.public !== "boolean" || !Array.isArray(page.founders)) return undefined
  const founders = page.founders.flatMap((item): FounderRow[] => {
    if (!item || typeof item !== "object") return []
    const row = item as Record<string, unknown>
    if (typeof row.number !== "number" || !Number.isSafeInteger(row.number) || row.number < 1) return []
    return [{ number: row.number, ...(typeof row.name === "string" && NAME.test(row.name) ? { name: row.name } : {}) }]
  })
  return { public: page.public, founders }
}

/**
 * The opt-in founders page (WP A31). Its random slug travels in the address's fragment, which browsers never send to a
 * server, and goes to the API in a header; once 30 founders are listed the page answers without it.
 */
export function FoundersPage() {
  const [state, setState] = React.useState<{ kind: "loading" } | { kind: "hidden" } | { kind: "page"; page: Page }>({
    kind: "loading",
  })

  React.useEffect(() => {
    const slug = location.hash.slice(1)
    const controller = new AbortController()
    void fetch("/api/founders", {
      headers: {
        accept: "application/json",
        ...(/^[A-Za-z0-9_-]{22}$/.test(slug) ? { "x-vector-founders": slug } : {}),
      },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => (response.ok ? readFoundersPage(await response.json()) : undefined))
      .then((page) => {
        if (!controller.signal.aborted) setState(page ? { kind: "page", page } : { kind: "hidden" })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: "hidden" })
      })
    return () => controller.abort()
  }, [])

  return (
    <section className="founders">
      <h1>Vector Codium founding members</h1>
      <p>The first subscribers to Vector Codium. Each founder chose to be listed here.</p>
      {state.kind === "loading" && <p role="status">Loading…</p>}
      {state.kind === "hidden" && <p>This page is not public yet.</p>}
      {state.kind === "page" && state.page.founders.length === 0 && <p>No founders are listed yet.</p>}
      {state.kind === "page" && state.page.founders.length > 0 && (
        <ol className="founders-list">
          {state.page.founders.map((founder) => (
            <li key={founder.number}>
              <span className="founders-number">#{founder.number}</span>
              <span>{founder.name ?? "Founding member"}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
