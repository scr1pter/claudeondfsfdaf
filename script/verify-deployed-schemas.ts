export const SCHEMA_PATHS = [
  "/config.json",
  "/tui.json",
  "/theme.json",
  "/desktop-theme.json",
  "/workflow.json",
] as const

export async function verifyDeployedSchemas(origin: string, request: typeof fetch = fetch) {
  return Promise.all(
    SCHEMA_PATHS.map(async (path) => {
      const response = await request(new URL(path, origin), { signal: AbortSignal.timeout(30_000), redirect: "error" })
      if (response.status !== 200) throw new Error(`${path}: expected HTTP 200, received ${response.status}`)
      const mime = response.headers.get("content-type")?.split(";")[0]?.trim()
      if (mime !== "application/json")
        throw new Error(`${path}: expected application/json, received ${mime ?? "no content type"}`)
      const schema: unknown = await response.json()
      if (!schema || typeof schema !== "object" || Array.isArray(schema) || !("$schema" in schema))
        throw new Error(`${path}: expected a JSON Schema document`)
      return { path, status: response.status, contentType: mime }
    }),
  )
}

if (import.meta.main) {
  const origin = process.argv[2] ?? "https://vectordev.ai"
  console.log(JSON.stringify(await verifyDeployedSchemas(origin), null, 2))
}
