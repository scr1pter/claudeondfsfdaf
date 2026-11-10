import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { BatchReceipt, Citation, DocumentRow, SearchResult } from "../server/types"
import "./style.css"

type Version = { version: number; title: string; created_at: string }
type SearchPage = { query: string; revision: number; results: SearchResult[]; nextCursor: string | null }
class RequestError extends Error {
  constructor(public code: string, message: string) { super(message) }
}
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options)
  const value = await response.json()
  if (!response.ok) throw new RequestError(value.error?.code ?? "request_failed", value.error?.message ?? "Request failed.")
  return value as T
}
const explanation = (error: unknown) => error instanceof Error ? error.message : "Unable to reach the local server. Try again."

function App() {
  const [source, setSource] = useState("notes/local.md")
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [batch, setBatch] = useState("")
  const [importing, setImporting] = useState(false)
  const [query, setQuery] = useState("")
  const [pageSize, setPageSize] = useState(10)
  const [results, setResults] = useState<SearchResult[]>([])
  const [context, setContext] = useState<{ query: string; limit: number; revision: number } | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [searching, setSearching] = useState(false)
  const [current, setCurrent] = useState<DocumentRow | null>(null)
  const [versions, setVersions] = useState<Version[]>([])
  const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null)
  const [message, setMessage] = useState("Ready to import local text.")
  const searchRequest = useRef(0)
  const documentRequest = useRef(0)

  async function search(searchQuery = query, limit = pageSize, next: string | null = null) {
    const request = ++searchRequest.current
    setSearching(true)
    try {
      const parameters = new URLSearchParams({ q: searchQuery, limit: String(limit) })
      if (next !== null) parameters.set("cursor", next)
      const value = await api<SearchPage>(`/api/search?${parameters}`)
      if (request !== searchRequest.current) return
      setResults((prior) => next === null ? value.results : [...prior, ...value.results])
      setCursor(value.nextCursor)
      setContext({ query: value.query, limit, revision: value.revision })
      setStale(false)
      setMessage(`${value.results.length} ${next === null ? "results loaded" : "more results loaded"} at revision ${value.revision}.`)
    } catch (error) {
      if (request !== searchRequest.current) return
      if (error instanceof RequestError && error.code === "stale_cursor") {
        setStale(true)
        setMessage("Collection changed. Restart search to see results at the current revision.")
      } else {
        if (next === null) { setResults([]); setCursor(null); setContext(null); setStale(false) }
        setMessage(explanation(error))
      }
    } finally { if (request === searchRequest.current) setSearching(false) }
  }

  async function importDocument() {
    setImporting(true)
    try {
      const value = await api<{ documents: DocumentRow[] }>("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, title, body }) })
      const document = value.documents[0]
      setMessage(`Imported document ${document.id}, version ${document.version}.`)
    } catch (error) { setMessage(explanation(error)) }
    finally { setImporting(false) }
  }

  async function importBatch() {
    setImporting(true)
    try {
      const value = await api<BatchReceipt>("/api/batches", { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: batch })
      const changed = value.operations.filter((operation) => operation.changed).length
      setMessage(`Batch ${value.batchId} · revision ${value.revision} · replayed: ${value.replayed ? "true (original receipt)" : "false (first import)"} · receipt: ${changed} changed operations.`)
    } catch (error) { setMessage(`Batch import failed: ${explanation(error)}`) }
    finally { setImporting(false) }
  }

  async function openDocument(id: number, version?: number) {
    const request = ++documentRequest.current
    try {
      const [value, history] = await Promise.all([
        api<{ document: DocumentRow }>(`/api/documents/${id}${version === undefined ? "" : `/versions/${version}`}`),
        api<{ versions: Version[] }>(`/api/documents/${id}/versions`),
      ])
      if (request !== documentRequest.current) return
      setCurrent(value.document)
      setVersions(history.versions)
    } catch (error) { if (request === documentRequest.current) setMessage(explanation(error)) }
  }

  async function viewCitation(bound: Citation) {
    try {
      const parameters = new URLSearchParams({ documentId: String(bound.documentId), version: String(bound.version), startByte: String(bound.startByte), endByte: String(bound.endByte) })
      setSelectedCitation(await api<Citation>(`/api/citations?${parameters}`))
    } catch (error) { setMessage(explanation(error)) }
  }

  return <main>
    <header><p className="eyebrow">LOCAL DOCUMENT RESEARCH</p><h1>Evidence Workbench</h1><p>Import text, search your collection, and follow evidence through every revision.</p></header>
    <section aria-labelledby="import-heading"><h2 id="import-heading">Import a document</h2>
      <form onSubmit={(event) => { event.preventDefault(); void importDocument() }}>
        <label>Document source<input aria-label="Document source" value={source} onChange={(event) => setSource(event.target.value)} /></label>
        <label>Document title<input aria-label="Document title" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Document text<textarea aria-label="Document text" rows={7} value={body} onChange={(event) => setBody(event.target.value)} /></label>
        <button disabled={importing} type="submit">Import document</button>
      </form>
    </section>
    <section aria-labelledby="batch-heading"><h2 id="batch-heading">Import an atomic batch</h2>
      <p id="batch-help">Begin with a batch header, then one upsert or delete per line. Reuse the same batch ID to safely retry an import.</p>
      <pre className="example">{'{"type":"batch","batchId":"field_01"}\n{"type":"upsert","source":"notes/fern.md","title":"Fern log","body":"Amber fern."}'}</pre>
      <label>Batch NDJSON<textarea aria-label="Batch NDJSON" rows={7} spellCheck={false} aria-describedby="batch-help" value={batch} onChange={(event) => setBatch(event.target.value)} /></label>
      <button disabled={importing} onClick={() => void importBatch()}>Import batch</button>
    </section>
    <p role="status" className="status">{message}</p>
    <section aria-labelledby="search-heading"><h2 id="search-heading">Search the collection</h2>
      <form onSubmit={(event) => { event.preventDefault(); void search() }}>
        <label>Search documents<input aria-label="Search documents" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="search-controls">
          <label>Results per page<select aria-label="Results per page" value={pageSize} onChange={(event) => {
            const size = Number(event.target.value)
            setPageSize(size)
            if (context) void search(context.query, size)
          }}><option value="2">2</option><option value="10">10</option><option value="25">25</option></select></label>
          <button type="submit" disabled={searching}>Search</button>
        </div>
      </form>
      {context && <p className="metadata">{results.length} results shown · collection revision {context.revision}</p>}
      {stale && <div className="notice"><p>Collection changed. Restart search to load the current revision.</p><button disabled={searching} onClick={() => void search(context?.query ?? query, pageSize)}>Restart search</button></div>}
      <ul aria-label="Search results">{results.map((result) => <li key={result.id} data-testid="search-result">
        <h3>{result.title}</h3><p className="metadata">{result.source} · version {result.version}</p><pre className="snippet">{result.snippet}</pre>
        <div className="actions"><button onClick={() => void openDocument(result.id)}>Open document {result.id}</button><button className="secondary" onClick={() => void viewCitation(result.citation)}>View citation {result.id}</button></div>
      </li>)}</ul>
      {context && !results.length && <p>No matching documents.</p>}
      <button className="secondary" disabled={!cursor || searching || stale} onClick={() => context && void search(context.query, context.limit, cursor)}>Next results</button>
    </section>
    {selectedCitation && <section aria-labelledby="citation-heading"><h2 id="citation-heading">Citation</h2>
      <p>Document {selectedCitation.documentId} · version {selectedCitation.version}</p>
      <p>Start byte: {selectedCitation.startByte} · End byte: {selectedCitation.endByte} (exclusive)</p>
      <pre data-testid="citation-quote">{selectedCitation.quote}</pre>
      <button onClick={() => void openDocument(selectedCitation.documentId, selectedCitation.version)}>Open cited document</button>
    </section>}
    {current && <section aria-labelledby="document-heading"><h2 id="document-heading">{current.title}</h2>
      <p className="metadata">{current.source} · Document {current.id}</p>
      <label>Document version<select aria-label="Document version" value={current.version} onChange={(event) => void openDocument(current.id, Number(event.target.value))}>{versions.map((version) => <option key={version.version} value={version.version}>{version.version}</option>)}</select></label>
      <p>Version {current.version} · <time dateTime={current.created_at}>{current.created_at}</time></p>
      <pre data-testid="document-body">{current.body}</pre>
    </section>}
  </main>
}

createRoot(document.getElementById("root")!).render(<App />)
