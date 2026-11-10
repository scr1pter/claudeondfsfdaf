export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

export function createClient(options) {
  if (!options || typeof options.baseUrl !== "string" || typeof options.apiKey !== "string") {
    throw new ApiError(400, "invalid_client_options", "baseUrl and apiKey must be strings")
  }
  let url
  try {
    url = new URL(options.baseUrl)
  } catch {
    throw new ApiError(400, "invalid_client_options", "baseUrl must be an HTTP or HTTPS URL")
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ApiError(400, "invalid_client_options", "baseUrl must be an HTTP or HTTPS URL without credentials, query or fragment")
  }
  const base = url.href.replace(/\/+$/, "")
  const apiKey = options.apiKey
  const safeMessage = (value) => apiKey ? value.split(apiKey).join("[redacted]") : value
  async function request(method, path, input) {
    let body
    try {
      if (input !== undefined) body = JSON.stringify(input)
    } catch {
      throw new ApiError(400, "invalid_input", "Request input must be JSON serializable")
    }
    let response
    try {
      response = await fetch(base + path, { method,
        headers: { authorization: "Bearer " + apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body }) })
    } catch {
      throw new ApiError(0, "network_error", "Cannot reach the service")
    }
    let result
    try {
      result = await response.json()
    } catch {
      throw new ApiError(response.status, "invalid_response", "The service returned an invalid JSON response")
    }
    if (!response.ok) {
      const code = typeof result?.error?.code === "string" && result.error.code ? result.error.code : "api_error"
      const message = typeof result?.error?.message === "string" && result.error.message ? result.error.message : "Request failed"
      throw new ApiError(response.status, safeMessage(code), safeMessage(message))
    }
    return result
  }
  const accountPath = (accountId) => "/api/accounts/" + encodeURIComponent(accountId)
  const invoicePath = (invoiceId) => "/api/invoices/" + encodeURIComponent(invoiceId)
  return {
    listAccounts: () => request("GET", "/api/accounts"),
    createAccount: (input) => request("POST", "/api/accounts", input),
    getAccount: (accountId) => request("GET", accountPath(accountId)),
    recordUsage: (accountId, input) => request("POST", accountPath(accountId) + "/usage", input),
    listUsage: (accountId, period) => request("GET", accountPath(accountId) + "/usage"
      + (period === undefined ? "" : "?period=" + encodeURIComponent(period))),
    quote: (accountId, period) => request("GET", accountPath(accountId) + "/quote?period=" + encodeURIComponent(period)),
    issueInvoice: (accountId, input) => request("POST", accountPath(accountId) + "/invoices", input),
    getInvoice: (invoiceId) => request("GET", invoicePath(invoiceId)),
    creditInvoice: (invoiceId, input) => request("POST", invoicePath(invoiceId) + "/credits", input),
    listCredits: (invoiceId) => request("GET", invoicePath(invoiceId) + "/credits"),
    createKey: (input) => request("POST", "/api/access-keys", input),
    revokeKey: (keyId) => request("POST", "/api/access-keys/" + encodeURIComponent(keyId) + "/revoke", {}),
  }
}
