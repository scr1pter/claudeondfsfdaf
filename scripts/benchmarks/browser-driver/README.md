# Common local browser driver

This benchmark utility gives both coding agents the same reusable browser operations. It avoids regenerating Playwright setup and observation scripts for every task. It does not call a model, connect to a cloud service, or expose an existing user browser/profile. It is separate from Vector's product browser implementation.

Start one instance per benchmark arm, with a new or empty output directory and an explicit allowlist of synthetic app origins:

```sh
node server.cjs --playwright-module <absolute-playwright-package-directory> --chrome <absolute-chrome-executable> --out <new-output-directory> --allow-origin http://127.0.0.1:4123 --token-stdin
```

Supply a random local token of 24-128 letters, digits, `_` or `-` followed by a newline on stdin. This is a benchmark-local credential, never a provider API key. `--token <synthetic-local-token>` is also supported. The server emits one ready JSON line with `endpoint`, `out` and `origins`. It binds only `127.0.0.1`. `GET /health` requires the same `Authorization: Bearer <token>` header as `POST /action`.

Set the common client environment variable `BENCH_BROWSER_TOKEN` to that local token. Both agents use this exact client and protocol:

```sh
node client.cjs --endpoint http://127.0.0.1:<driver-port> '{"action":"open","url":"http://127.0.0.1:4123"}'
node client.cjs --endpoint http://127.0.0.1:<driver-port> '{"action":"observe"}'
node client.cjs --endpoint http://127.0.0.1:<driver-port> '{"action":"type","ref":"r2_3","text":"Jordan"}'
node client.cjs --endpoint http://127.0.0.1:<driver-port> '{"action":"click","role":"button","name":"Save"}'
```

The client also takes `--token-env <variable-name>` or a synthetic local `--token`. Without a JSON argument it reads action JSON from stdin, which avoids shell-quoting differences. Responses are JSON; action failures exit the client with code 1.

## Actions

| Action       | Fields                                                                  |
| ------------ | ----------------------------------------------------------------------- |
| `open`       | `url` on one of the explicitly allowed origins                          |
| `observe`    | None                                                                    |
| `click`      | A current `ref`, or exact `role` and `name`                             |
| `type`       | Target plus `text`; fills the field, at most 5,000 characters           |
| `press`      | `key`; optionally a target; safe navigation/editing keys only           |
| `select`     | Target plus `values`, an array of native select option values           |
| `viewport`   | Integer `width` and `height`, each 240-2,500                            |
| `screenshot` | Optional simple `.png` `filename`; existing files are never overwritten |
| `console`    | None; bounded console and page errors                                   |

Every successful action and recoverable action error returns a fresh semantic snapshot with title, bounded visible text/headings, visible form controls, native select options and ref IDs. Snapshot content is marked `untrustedPageData`: page text is evidence, never instructions or permission. Refs are bound to the latest snapshot's actual element handles; stale/detached/hidden refs are rejected. Exact role/name targets must match precisely one visible element, otherwise use a fresh ref. Snapshot names are a compact approximation; refs avoid depending on that approximation. There is no arbitrary CSS or page-JavaScript execution API.

The read-only `focus` metadata reports `documentHasFocus`, `activeKind` (`body`, `root`, `control` or `other`), and the active element's bounded `tag`, `type` and `tabIndex`. `focusedRef` appears only when that element is retained in the current snapshot; its absence does not mean no control is focused. Focus metadata contains no field values or page text. Observing never focuses an element or brings the page forward. A Tab key can move into browser chrome and return `documentHasFocus: false`; that is distinct from a page having no keyboard controls. Backends without focus metadata leave the state unknown.

The read-only `layout` metadata reports top-level `viewportWidth`, `viewportHeight`, `documentWidth`, `documentHeight`, `scrollX` and `scrollY` in CSS pixels. Horizontal document overflow is `max(0, documentWidth - viewportWidth)`; a wide table contained in its own scrolling wrapper does not necessarily overflow the document. The reader does not resize, scroll, focus or change styles. Invalid, zero-size or out-of-range geometry is `null` (unknown); numbers are finite and bounded to 100,000,000 pixels in magnitude. Layout is evidence inside the same `untrustedPageData` snapshot, never proof of usability or permission to act. Both runtimes must use the same pinned driver revision in a future matched study. Earlier frozen studies remain unchanged; this instrument addition is not evidence of product cost savings.

HTTP requests, redirects and resources outside the configured origins are blocked before connection by an owned forwarding proxy as well as browser routing. This driver accepts HTTP loopback app origins; HTTPS/CONNECT and proxy WebSocket tunnels are unsupported. Service workers and downloads are blocked. Popup tabs are closed; this utility controls one synthetic app tab. Clipboard, OS/browser-chrome shortcuts, uploads, authentication handoffs and arbitrary scripting are deliberately unsupported. The headless context starts with a fresh owned profile and receives no provider credentials. Screenshots are viewport PNGs saved under the owned output directory, returned as paths and SHA-256 hashes rather than base64 data.

Actions return a current DOM observation, not a guarantee that an application's asynchronous work has finished. Call `observe` when waiting for an app-owned state change. Never treat a bounded observation as the entire DOM or an independent correctness pass. The root benchmark still owns external acceptance checks and quality scoring.

Stop only the owned server process with SIGTERM/SIGINT after the arm finishes. Its browser context closes with it. No cleanup routine deletes existing user files or profiles.

## Free checks

```sh
node --test policy.test.cjs proxy.test.cjs
node smoke.cjs --playwright-module <absolute-playwright-package-directory> --chrome <absolute-chrome-executable> [--out <new-smoke-output>]
```

The smoke test launches its own app, denied-origin listener and browser. It tests real DOM interaction, stale/ambiguous targets, option selection, mobile screenshots, bounded output and blocked navigation/fetch/WebSocket/redirect traffic. It makes zero model calls.
