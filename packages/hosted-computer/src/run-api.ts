import { createHmac, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { request as httpsRequest } from "node:https"
import { Hosted } from "@vectordevai/schema/hosted"

/*
 * hostd's calls to Vector (contract WP A54): the session's heartbeat through the run-API host, and the PUT of packed
 * files to the signed link a heartbeat answer carries. hostd holds no credential from Vector: the provider's egress
 * proxy adds the session's run token to requests for the run-API host, and to nothing else (WP A52). A request carries
 * only the headers listed here, so never `Origin`, `Sec-Fetch-*` or a cookie, which the run-API host refuses (S7); that
 * is why this uses node:https directly and not fetch, which adds `sec-fetch-mode` on its own.
 *
 * The proxy adds the run token for any process on the computer, the agent's too, so hostd signs its heartbeats (P8
 * review): it makes a key of its own when it starts, before the agent exists, keeps it in its memory only (hostd runs
 * as root; the agent cannot read it), sends it with its beats until one is answered (the server registers the first),
 * and signs every beat with it (`Hosted.hostdMacInput`). The server takes no report it did not sign.
 */

export type Transport = (request: {
  method: "POST" | "PUT"
  host: string
  path: string
  headers: Record<string, string>
  body: Buffer | { file: string; bytes: number }
  timeoutMs: number
}) => Promise<{ status: number; body: Buffer }>

const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const FORBIDDEN = /^(?:origin|cookie|authorization|sec-fetch-.*|proxy-authorization)$/i

/** The real transport: HTTPS only, no redirects followed, no headers but the ones given, answers capped. */
export const httpsTransport: Transport = (input) =>
  new Promise((resolve, reject) => {
    for (const name of Object.keys(input.headers)) if (FORBIDDEN.test(name)) return reject(new Error(`header ${name} is not sent`))
    const req = httpsRequest(
      { method: input.method, host: input.host, port: 443, path: input.path, headers: input.headers, timeout: input.timeoutMs },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > 1024 * 1024) req.destroy(new Error("answer too large"))
          else chunks.push(chunk)
        })
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }))
        response.on("error", reject)
      },
    )
    req.on("timeout", () => req.destroy(new Error("timed out")))
    req.on("error", reject)
    if (Buffer.isBuffer(input.body)) req.end(input.body)
    else createReadStream(input.body.file).on("error", reject).pipe(req)
  })

/** What hostd reports beyond WP A53's fields (the server keeps what it knows and drops the rest). */
export type Report = Hosted.Heartbeat

export class RunApi {
  /** hostd's own key for this session's heartbeats (memory only). */
  private readonly key: Buffer
  /** Whether a heartbeat was answered, so the server has the key. */
  private registered = false

  constructor(
    private readonly runHost: string,
    private readonly session: string,
    private readonly transport: Transport = httpsTransport,
    private readonly userAgent = "vector-hostd",
    key: Buffer = randomBytes(32),
  ) {
    if (!HOST.test(runHost)) throw new Error("The run-API host is not a host name.")
    if (key.length !== 32) throw new Error("hostd's key is 32 bytes.")
    this.key = key
  }

  /** The report as signed: the key while it is not registered yet, and `mac` over the rest. */
  private sign(report: Report): Report {
    const { hostdKey: _key, mac: _mac, ...fields } = report
    const signed: Report = { ...fields, ...(this.registered ? {} : { hostdKey: this.key.toString("base64url") }) }
    const mac = createHmac("sha256", this.key)
      .update(Hosted.hostdMacInput(this.session, signed as Record<string, unknown>))
      .digest("base64url")
    return { ...signed, mac }
  }

  /** One heartbeat: the report out, the session's answer back. Throws on anything but 200 with a JSON object. */
  async heartbeat(report: Report): Promise<Hosted.HeartbeatAnswer> {
    const body = Buffer.from(JSON.stringify(this.sign(report)))
    const answer = await this.transport({
      method: "POST",
      host: this.runHost,
      path: `/api/hosted/sessions/${this.session}/heartbeat`,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "content-length": String(body.length),
        "user-agent": this.userAgent,
      },
      body,
      timeoutMs: 15_000,
    })
    if (answer.status !== 200) throw new HeartbeatError(answer.status, answer.body)
    this.registered = true
    const value = JSON.parse(answer.body.toString("utf8")) as Hosted.HeartbeatAnswer
    if (!value || typeof value !== "object" || typeof value.state !== "string") throw new Error("malformed answer")
    return value
  }

  /** PUTs the packed files to the signed link, with exactly the headers it names. */
  async upload(link: NonNullable<Hosted.HeartbeatAnswer["upload"]>, file: string) {
    const url = new URL(link.url)
    if (url.protocol !== "https:" || !HOST.test(url.hostname) || url.port) throw new Error("The upload link is not usable.")
    const bytes = (await stat(file)).size
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(link.headers)) if (!FORBIDDEN.test(name)) headers[name.toLowerCase()] = value
    headers["content-length"] = String(bytes)
    const answer = await this.transport({
      method: "PUT",
      host: url.hostname,
      path: url.pathname + url.search,
      headers,
      body: { file, bytes },
      timeoutMs: 30 * 60_000,
    })
    if (answer.status < 200 || answer.status > 299) throw new Error(`upload refused (${answer.status})`)
  }
}

export class HeartbeatError extends Error {
  readonly code: string

  constructor(
    readonly status: number,
    body: Buffer,
  ) {
    let code = ""
    try {
      code = (JSON.parse(body.toString("utf8")) as { error?: { code?: string } }).error?.code ?? ""
    } catch {}
    super(`heartbeat refused (${status}${code ? ` ${code}` : ""})`)
    this.code = code
  }
}
