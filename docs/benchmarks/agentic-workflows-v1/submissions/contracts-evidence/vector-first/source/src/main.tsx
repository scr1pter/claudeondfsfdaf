import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { BatchReceipt, Citation, DocumentRow, SearchResult } from "../server/types"
import "./style.css"

class RequestError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options)
  const value = await response.json()
  if (!response.ok) throw new RequestError(value.error.code, value.error.message)
  return value
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The request failed. Please try again."
type Version = Pick<DocumentRow, "version" | "title" | "created_at">
type SearchPage = { query: string; revision: number; results: SearchResult[]; nextCursor: string | null }

function App() {
  const [source, setSource] = useState("notes/local.md")
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [batch, setBatch] = useState("")
  const [importing, setImporting] = useState(false)
  const [query, setQuery] = useState("")
  const [limit, setLimit] = useState(10)
  const [activeQuery, setActiveQuery] = useState<string | null>(null)
  const [results, setResults] = useState<SearchResult[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [searchRevision, setSearchRevision] = useState<number | null>(null)
  const [searching, setSearching] = useState(false)
  const [stale, setStale] = useState(false)
  const [current, setCurrent] = useState<DocumentRow | null>(null)
  const [versions, setVersions] = useState<Version[]>([])
  const [citation, setCitation] = useState<Citation | null>(null)
  const [message, setMessage] = useState("Ready to import local text.")
  const searchRequest = useRef(0)
  const documentRequest = useRef(0)
  const citationRequest = useRef(0)

  async function search(append = false, searchQuery = query, pageSize = limit) {
    const sequence = ++searchRequest.current
    setSearching(true)
    if (!append) {
      setActiveQuery(searchQuery)
      setResults([])
      setNextCursor(null)
      setSearchRevision(null)
      setStale(false)
    }
    try {
      const params = new URLSearchParams({ q: searchQuery, limit: String(pageSize) })
      if (append && nextCursor) params.set("cursor", nextCursor)
      const value = await request<SearchPage>(`/api/search?${params}`)
      if (sequence !== searchRequest.current) return
      setResults((previous) => append ? [...previous, ...value.results] : value.results)
      setNextCursor(value.nextCursor)
      setSearchRevision(value.revision)
      setMessage(`${value.results.length} ${append ? "more " : ""}results loaded at revision ${value.revision}.`)
    } catch (error) {
      if (sequence !== searchRequest.current) return
      if (error instanceof RequestError && error.code === "stale_cursor") setStale(true)
      setMessage(errorMessage(error))
    } finally {
      if (sequence === searchRequest.current) setSearching(false)
    }
  }

  async function importDocument() {
    setImporting(true)
    try {
      const value = await request<{ documents: DocumentRow[] }>("/api/import", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, title, body }),
      })
      setMessage(`Imported document ${value.documents[0].id}, version ${value.documents[0].version}.`)
    } catch (error) { setMessage(errorMessage(error)) }
    finally { setImporting(false) }
  }

  async function importBatch() {
    setImporting(true)
    try {
      const receipt = await request<BatchReceipt>("/api/batches", {
        method: "POST", headers: { "content-type": "application/x-ndjson" }, body: batch,
      })
      setMessage(`Batch ${receipt.batchId}: revision ${receipt.revision}. ${receipt.replayed ? "Replayed original receipt; no changes made." : "Committed; not replayed."}`)
    } catch (error) { setMessage(`Batch import failed: ${errorMessage(error)}`) }
    finally { setImporting(false) }
  }

  async function openDocument(id: number, version?: number) {
    const sequence = ++documentRequest.current
    try {
      const value = await request<{ document: DocumentRow }>(`/api/documents/${id}${version === undefined ? "" : `/versions/${version}`}`)
      const history = await request<{ versions: Version[] }>(`/api/documents/${id}/versions`)
      if (sequence !== documentRequest.current) return
      setCurrent(value.document)
      setVersions(history.versions)
    } catch (error) { if (sequence === documentRequest.current) setMessage(errorMessage(error)) }
  }

  async function viewCitation(value: Citation) {
    const sequence = ++citationRequest.current
    try {
      const params = new URLSearchParams({ documentId: String(value.documentId), version: String(value.version), startByte: String(value.startByte), endByte: String(value.endByte) })
      const resolved = await request<Citation>(`/api/citations?${params}`)
      if (sequence === citationRequest.current) setCitation(resolved)
    } catch (error) { if (sequence === citationRequest.current) setMessage(errorMessage(error)) }
  }

  useEffect(() => { document.title = "Evidence Workbench" }, [])

  return <main>
    <header><p className="eyebrow">LOCAL DOCUMENT RESEARCH</p><h1>Evidence Workbench</h1><p>Import text, search your collection, and inspect original documents.</p></header>
    <section aria-labelledby="import-heading"><h2 id="import-heading">Import a document</h2>
      <label>Document source<input aria-label="Document source" value={source} onChange={(event) => setSource(event.target.value)} /></label>
      <label>Document title<input aria-label="Document title" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Document text<textarea aria-label="Document text" rows={7} value={body} onChange={(event) => setBody(event.target.value)} /></label>
      <button disabled={importing} onClick={importDocument}>Import document</button>
    </section>
    <section aria-labelledby="batch-heading"><h2 id="batch-heading">Import an atomic batch</h2>
      <p>Start with a batch header, then one upsert or delete per line. A batch ID can be safely retried.</p>
      <label>Batch NDJSON<textarea aria-label="Batch NDJSON" className="batch-input" rows={7} spellCheck={false} placeholder={'{"type":"batch","batchId":"field_01"}\n{"type":"upsert","source":"notes/fern.md","title":"Fern log","body":"Amber fern."}'} value={batch} onChange={(event) => setBatch(event.target.value)} /></label>
      <button disabled={importing} onClick={importBatch}>Import batch</button>
    </section>
    <p role="status">{message}</p>
    <section aria-labelledby="search-heading"><h2 id="search-heading">Search the collection</h2>
      <form onSubmit={(event) => { event.preventDefault(); void search() }}>
        <label>Search documents<input aria-label="Search documents" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="search-controls"><label>Results per page<select aria-label="Results per page" value={limit} onChange={(event) => {
          const size = Number(event.target.value)
          setLimit(size)
          if (activeQuery !== null) void search(false, activeQuery, size)
        }}><option value="2">2</option><option value="10">10</option><option value="25">25</option></select></label>
          <button type="submit" disabled={searching}>Search</button></div>
      </form>
      {searchRevision !== null && <p className="metadata">Collection revision {searchRevision} | {results.length} results shown</p>}
      {stale && <div className="notice"><p>Collection changed. Restart search to see a consistent set of results.</p><button onClick={() => search(false, activeQuery ?? query, limit)}>Restart search</button></div>}
      <ul aria-label="Search results">{results.map((result) => <li key={result.id} data-testid="search-result">
        <h3>{result.title}</h3><p className="metadata">{result.source} | Version {result.version}</p><pre className="snippet">{result.snippet}</pre>
        <div className="actions"><button onClick={() => openDocument(result.id)}>Open document {result.id}</button><button className="secondary" onClick={() => viewCitation(result.citation)}>View citation {result.id}</button></div>
      </li>)}</ul>
      <button disabled={!nextCursor || stale || searching} onClick={() => search(true, activeQuery ?? query, limit)}>Next results</button>
    </section>
    {citation && <section aria-labelledby="citation-heading"><h2 id="citation-heading">Citation</h2>
      <p className="metadata">Document {citation.documentId} | Version {citation.version} | Bytes {citation.startByte} to {citation.endByte} (end exclusive)</p>
      <pre data-testid="citation-quote">{citation.quote}</pre>
      <button onClick={() => openDocument(citation.documentId, citation.version)}>Open cited document</button>
    </section>}
    {current && <section aria-labelledby="document-heading"><h2 id="document-heading">{current.title}</h2>
      <p className="metadata">{current.source}</p><p>Version {current.version} | {current.created_at}</p>
      <label>Document version<select aria-label="Document version" value={current.version} onChange={(event) => openDocument(current.id, Number(event.target.value))}>{versions.map((version) => <option key={version.version} value={version.version}>{version.version} - {version.title}</option>)}</select></label>
      <pre data-testid="document-body">{current.body}</pre>
    </section>}
  </main>
}

createRoot(document.getElementById("root")!).render(<App />)
