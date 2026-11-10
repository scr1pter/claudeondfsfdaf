import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { Citation, DocumentRow, SearchResult } from "../server/types"
import "./style.css"

class RequestError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options)
  const value = await response.json()
  if (!response.ok) throw new RequestError(value.error.code, value.error.message)
  return value as T
}

const failure = (error: unknown) => error instanceof Error ? error.message : "Request failed. Please try again."
type Version = Pick<DocumentRow, "version" | "title" | "created_at">
type SearchPage = { query: string; revision: number; results: SearchResult[]; nextCursor: string | null }

function App() {
  const [source, setSource] = useState("notes/local.md")
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [batchText, setBatchText] = useState("")
  const [importing, setImporting] = useState(false)
  const [query, setQuery] = useState("")
  const [pageSize, setPageSize] = useState("10")
  const [results, setResults] = useState<SearchResult[]>([])
  const [searchState, setSearchState] = useState<{ query: string; revision: number; cursor: string | null } | null>(null)
  const [searching, setSearching] = useState(false)
  const [stale, setStale] = useState(false)
  const [current, setCurrent] = useState<DocumentRow | null>(null)
  const [versions, setVersions] = useState<Version[]>([])
  const [citation, setCitation] = useState<Citation | null>(null)
  const [message, setMessage] = useState("Ready to import local text.")
  const searchRequest = useRef(0)
  const documentRequest = useRef(0)
  const citationRequest = useRef(0)

  async function search(next = false, requestedQuery = query) {
    const request = ++searchRequest.current
    const searchQuery = next && searchState ? searchState.query : requestedQuery
    const params = new URLSearchParams({ q: searchQuery, limit: pageSize })
    if (next && searchState?.cursor) params.set("cursor", searchState.cursor)
    setSearching(true)
    if (!next) { setResults([]); setSearchState(null); setStale(false) }
    try {
      const value = await api<SearchPage>(`/api/search?${params}`)
      if (request !== searchRequest.current) return
      setResults((previous) => next ? [...previous, ...value.results] : value.results)
      setSearchState({ query: value.query, revision: value.revision, cursor: value.nextCursor })
      setStale(false)
      setMessage(`Loaded ${value.results.length} results at revision ${value.revision}.`)
    } catch (error) {
      if (request !== searchRequest.current) return
      if (error instanceof RequestError && error.code === "stale_cursor") {
        setStale(true)
        setMessage("Collection changed. Restart search to see the current revision.")
      } else setMessage(failure(error))
    } finally { if (request === searchRequest.current) setSearching(false) }
  }

  async function importDocument() {
    setImporting(true)
    try {
      const value = await api<{ documents: DocumentRow[] }>("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, title, body }) })
      setMessage(`Imported document ${value.documents[0].id}, version ${value.documents[0].version}.`)
    } catch (error) { setMessage(failure(error)) }
    finally { setImporting(false) }
  }

  async function importBatch() {
    setImporting(true)
    try {
      const value = await api<{ batchId: string; revision: number; replayed: boolean }>("/api/batches", { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: batchText })
      setMessage(`Batch ${value.batchId} at revision ${value.revision}. ${value.replayed ? "Replayed original receipt; no changes applied." : "Committed; not replayed."}`)
    } catch (error) { setMessage(`Batch failed: ${failure(error)}`) }
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
    } catch (error) { if (request === documentRequest.current) setMessage(failure(error)) }
  }

  async function viewCitation(value: Citation) {
    const request = ++citationRequest.current
    try {
      const params = new URLSearchParams({ documentId: String(value.documentId), version: String(value.version), startByte: String(value.startByte), endByte: String(value.endByte) })
      const resolved = await api<Citation>(`/api/citations?${params}`)
      if (request === citationRequest.current) setCitation(resolved)
    } catch (error) { if (request === citationRequest.current) setMessage(failure(error)) }
  }
  useEffect(() => { document.title = "Evidence Workbench" }, [])

  return <main>
    <header><p className="eyebrow">LOCAL DOCUMENT RESEARCH</p><h1>Evidence Workbench</h1><p>Import text, search your collection, and inspect original documents.</p></header>
    <section aria-labelledby="import-heading"><h2 id="import-heading">Import a document</h2>
      <label>Document source<input aria-label="Document source" value={source} onChange={(event) => setSource(event.target.value)} /></label>
      <label>Document title<input aria-label="Document title" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Document text<textarea aria-label="Document text" rows={7} value={body} onChange={(event) => setBody(event.target.value)} /></label>
      <button disabled={importing} onClick={() => void importDocument()}>Import document</button>
    </section>
    <section aria-labelledby="batch-heading"><h2 id="batch-heading">Import a batch</h2>
      <p>Apply upserts and deletions atomically. Reuse a batch ID to safely retry the same request.</p>
      <label>Batch NDJSON<textarea aria-label="Batch NDJSON" className="batch-input" rows={7} spellCheck={false} value={batchText} onChange={(event) => setBatchText(event.target.value)} placeholder={'{"type":"batch","batchId":"field_01"}\n{"type":"upsert","source":"notes/fern.md","title":"Fern log","body":"Amber fern."}'} /></label>
      <button disabled={importing} onClick={() => void importBatch()}>Import batch</button>
    </section>
    <p role="status">{message}</p>
    <section aria-labelledby="search-heading"><h2 id="search-heading">Search the collection</h2>
      <form onSubmit={(event) => { event.preventDefault(); void search() }}><label>Search documents<input aria-label="Search documents" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button type="submit">Search</button></form>
      <label className="page-size">Results per page<select aria-label="Results per page" value={pageSize} onChange={(event) => {
        ++searchRequest.current
        setPageSize(event.target.value); setSearchState(null); setResults([]); setStale(false); setSearching(false)
      }}><option value="2">2</option><option value="10">10</option><option value="25">25</option></select></label>
      {searchState && <p className="metadata">Collection revision {searchState.revision} | {results.length} results loaded</p>}
      <ul aria-label="Search results" aria-busy={searching}>{results.map((result) => <li key={result.id} data-testid="search-result"><h3>{result.title}</h3><p className="metadata">{result.source} | Version {result.version}</p><pre>{result.snippet}</pre><div className="actions"><button onClick={() => void openDocument(result.id)}>Open document {result.id}</button><button className="secondary" onClick={() => void viewCitation(result.citation)}>View citation {result.id}</button></div></li>)}</ul>
      {stale && <div className="notice"><p>Collection changed. The displayed results belong to an older revision.</p><button onClick={() => { const sameQuery = searchState?.query ?? query; setQuery(sameQuery); void search(false, sameQuery) }}>Restart search</button></div>}
      <button disabled={searching || stale || !searchState?.cursor} onClick={() => void search(true)}>Next results</button>
    </section>
    {citation && <section aria-labelledby="citation-heading"><p className="eyebrow">IMMUTABLE EVIDENCE</p><h2 id="citation-heading">Citation</h2><p>Document {citation.documentId} | Version {citation.version}</p><p>Bytes {citation.startByte} to {citation.endByte} (end exclusive)</p><pre data-testid="citation-quote">{citation.quote}</pre><button onClick={() => void openDocument(citation.documentId, citation.version)}>Open cited document</button></section>}
    {current && <section aria-labelledby="document-heading"><p className="eyebrow">ORIGINAL TEXT</p><h2 id="document-heading">{current.title}</h2><p>{current.source}</p><p className="metadata">Document {current.id} | Version {current.version} | {current.created_at}</p><label className="page-size">Document version<select aria-label="Document version" value={String(current.version)} onChange={(event) => void openDocument(current.id, Number(event.target.value))}>{versions.map((version) => <option key={version.version} value={version.version}>{version.version}</option>)}</select></label><pre data-testid="document-body">{current.body}</pre></section>}
  </main>
}

createRoot(document.getElementById("root")!).render(<App />)
