import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "./style.css"

type Document = { id: number; source: string; title: string; body: string; snippet?: string }

function App() {
  const [source, setSource] = useState("notes/local.md")
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<Document[]>([])
  const [current, setCurrent] = useState<Document | null>(null)
  const [message, setMessage] = useState("Ready to import local text.")

  async function search() {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
    const value = await response.json()
    setResults(value.results ?? [])
    setMessage(`Found ${value.results?.length ?? 0} documents.`)
  }
  async function importDocument() {
    const response = await fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, title, body }) })
    const value = await response.json()
    setMessage(response.ok ? `Imported ${value.documents.length} document.` : value.error.message)
  }
  async function openDocument(id: number) {
    const response = await fetch(`/api/documents/${id}`)
    const value = await response.json()
    if (response.ok) setCurrent(value.document)
    if (!response.ok) setMessage(value.error.message)
  }
  useEffect(() => { document.title = "Evidence Workbench" }, [])

  return <main>
    <header><p className="eyebrow">LOCAL DOCUMENT RESEARCH</p><h1>Evidence Workbench</h1><p>Import text, search your collection, and inspect original documents.</p></header>
    <section aria-labelledby="import-heading"><h2 id="import-heading">Import a document</h2>
      <label>Document source<input value={source} onChange={(event) => setSource(event.target.value)} /></label>
      <label>Document title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Document text<textarea rows={7} value={body} onChange={(event) => setBody(event.target.value)} /></label>
      <button onClick={importDocument}>Import document</button>
    </section>
    <p role="status">{message}</p>
    <section aria-labelledby="search-heading"><h2 id="search-heading">Search the collection</h2>
      <form onSubmit={(event) => { event.preventDefault(); void search() }}><label>Search documents<input value={query} onChange={(event) => setQuery(event.target.value)} /></label><button type="submit">Search</button></form>
      <ul aria-label="Search results">{results.map((result) => <li key={result.id} data-testid="search-result"><h3>{result.title}</h3><p>{result.source}</p><p>{result.snippet}</p><button onClick={() => openDocument(result.id)}>Open document {result.id}</button></li>)}</ul>
    </section>
    {current && <section aria-labelledby="document-heading"><h2 id="document-heading">{current.title}</h2><p>{current.source}</p><pre data-testid="document-body">{current.body}</pre></section>}
  </main>
}

createRoot(document.getElementById("root")!).render(<App />)
