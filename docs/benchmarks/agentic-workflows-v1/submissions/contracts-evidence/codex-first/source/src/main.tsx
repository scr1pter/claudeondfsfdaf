import { useState } from "react"
import { createRoot } from "react-dom/client"
import type { Citation, DocumentRow } from "../server/types"
import "./style.css"

type Result = Pick<DocumentRow, "id" | "source" | "title" | "version"> & { snippet: string; citation: Citation }
type Version = Pick<DocumentRow, "version" | "title" | "created_at">
class RequestError extends Error {
  constructor(public code: string, message: string) { super(message) }
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const value = await response.json()
  if (!response.ok) throw new RequestError(value.error?.code ?? "request_failed", value.error?.message ?? "Request failed.")
  return value as T
}

function App() {
  const [source, setSource] = useState("notes/local.md")
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [batch, setBatch] = useState("")
  const [query, setQuery] = useState("")
  const [activeQuery, setActiveQuery] = useState("")
  const [limit, setLimit] = useState("10")
  const [results, setResults] = useState<Result[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [searchRevision, setSearchRevision] = useState<number | null>(null)
  const [stale, setStale] = useState(false)
  const [current, setCurrent] = useState<DocumentRow | null>(null)
  const [versions, setVersions] = useState<Version[]>([])
  const [citation, setCitation] = useState<Citation | null>(null)
  const [message, setMessage] = useState("Ready to import local text.")
  const [busy, setBusy] = useState(false)

  async function perform(action: () => Promise<void>) {
    setBusy(true)
    try { await action() }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not reach the local server.") }
    finally { setBusy(false) }
  }
  async function search(searchQuery: string, continuation = false) {
    const parameters = new URLSearchParams({ q: searchQuery, limit })
    if (continuation && cursor) parameters.set("cursor", cursor)
    try {
      const value = await api<{ results: Result[]; nextCursor: string | null; revision: number }>(`/api/search?${parameters}`)
      setResults(previous => continuation ? [...previous, ...value.results] : value.results)
      setCursor(value.nextCursor)
      setSearchRevision(value.revision)
      setActiveQuery(searchQuery)
      setStale(false)
      setMessage(`${value.results.length} results on this page. Collection revision ${value.revision}.`)
    } catch (error) {
      if (error instanceof RequestError && error.code === "stale_cursor") {
        setStale(true)
        setMessage("Collection changed. Restart search to see the current revision.")
      } else throw error
    }
  }
  async function importDocument() {
    const value = await api<{ documents: DocumentRow[] }>("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, title, body }) })
    setMessage(`Imported document ${value.documents[0].id}, version ${value.documents[0].version}.`)
  }
  async function importBatch() {
    const value = await api<{ batchId: string; revision: number; replayed: boolean }>("/api/batches", { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: batch })
    setMessage(`Batch ${value.batchId} · revision ${value.revision} · replayed: ${value.replayed ? "true (original receipt)" : "false (new receipt)"}.`)
  }
  async function openDocument(id: number, version?: number) {
    const path = `/api/documents/${id}`
    const [value, history] = await Promise.all([
      api<{ document: DocumentRow }>(version === undefined ? path : `${path}/versions/${version}`),
      api<{ versions: Version[] }>(`${path}/versions`),
    ])
    setCurrent(value.document)
    setVersions(history.versions)
    setMessage(`Opened document ${id}, version ${value.document.version}.`)
  }
  async function viewCitation(value: Citation) {
    const parameters = new URLSearchParams({ documentId: String(value.documentId), version: String(value.version), startByte: String(value.startByte), endByte: String(value.endByte) })
    setCitation(await api<Citation>(`/api/citations?${parameters}`))
    setMessage(`Citation for document ${value.documentId}, version ${value.version}.`)
  }

  return <main>
    <header><p className="eyebrow">LOCAL DOCUMENT RESEARCH</p><h1>Evidence Workbench</h1><p>Import text, search your collection, and inspect original documents and their revisions.</p></header>
    <section aria-labelledby="import-heading"><h2 id="import-heading">Import a document</h2>
      <form onSubmit={event => { event.preventDefault(); void perform(importDocument) }}>
        <label>Document source<input value={source} onChange={event => setSource(event.target.value)} /></label>
        <label>Document title<input value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label>Document text<textarea aria-label="Document text" rows={7} value={body} onChange={event => setBody(event.target.value)} /></label>
        <button disabled={busy}>Import document</button>
      </form>
    </section>
    <section aria-labelledby="batch-heading"><h2 id="batch-heading">Import an atomic batch</h2>
      <p>Enter a batch header, then one upsert or delete per line. Use a new batch ID for each request; retry the same ID to retrieve its receipt.</p>
      <form onSubmit={event => { event.preventDefault(); void perform(importBatch) }}>
        <label>Batch NDJSON<textarea aria-label="Batch NDJSON" rows={7} spellCheck={false} value={batch} onChange={event => setBatch(event.target.value)} placeholder={'{"type":"batch","batchId":"sample_01"}\n{"type":"upsert","source":"notes/fern.md","title":"Fern log","body":"Amber fern."}'} /></label>
        <button disabled={busy}>Import batch</button>
      </form>
    </section>
    <p role="status" aria-live="polite">{message}</p>
    <section aria-labelledby="search-heading"><h2 id="search-heading">Search the collection</h2>
      <form onSubmit={event => { event.preventDefault(); void perform(() => search(query)) }}>
        <label>Search documents<input value={query} onChange={event => setQuery(event.target.value)} /></label>
        <label>Results per page<select aria-label="Results per page" disabled={busy} value={limit} onChange={event => { setLimit(event.target.value); setCursor(null); setResults([]); setSearchRevision(null); setStale(false) }}><option value="2">2</option><option value="10">10</option><option value="25">25</option></select></label>
        <button disabled={busy} type="submit">Search</button>
      </form>
      {searchRevision !== null && <p>Showing {results.length} results · collection revision {searchRevision}</p>}
      <ul aria-label="Search results">{results.map(result => <li key={result.id} data-testid="search-result">
        <h3>{result.title}</h3><p>{result.source} · Version {result.version}</p><pre className="snippet">{result.snippet}</pre>
        <div className="actions"><button disabled={busy} onClick={() => void perform(() => openDocument(result.id))}>Open document {result.id}</button><button disabled={busy} onClick={() => void perform(() => viewCitation(result.citation))}>View citation {result.id}</button></div>
      </li>)}</ul>
      {stale && <p>Collection changed. Restart search to load the current collection.</p>}
      <div className="actions"><button disabled={busy || !cursor || stale} onClick={() => void perform(() => search(activeQuery, true))}>Next results</button>
        {stale && <button disabled={busy} onClick={() => void perform(() => search(activeQuery))}>Restart search</button>}</div>
    </section>
    {citation && <section aria-labelledby="citation-heading"><h2 id="citation-heading">Citation</h2>
      <p>Document {citation.documentId} · Version {citation.version} · startByte: {citation.startByte} · endByte: {citation.endByte}</p>
      <pre data-testid="citation-quote">{citation.quote}</pre>
      <button disabled={busy} onClick={() => void perform(() => openDocument(citation.documentId, citation.version))}>Open cited document</button>
    </section>}
    {current && <section aria-labelledby="document-heading"><h2 id="document-heading">{current.title}</h2><p>{current.source} · Document {current.id} · Version {current.version}</p>
      <label>Document version<select aria-label="Document version" disabled={busy} value={current.version} onChange={event => void perform(() => openDocument(current.id, Number(event.target.value)))}>{versions.map(version => <option key={version.version} value={version.version}>{version.version}</option>)}</select></label>
      <pre data-testid="document-body">{current.body}</pre>
    </section>}
  </main>
}

createRoot(document.getElementById("root")!).render(<App />)
