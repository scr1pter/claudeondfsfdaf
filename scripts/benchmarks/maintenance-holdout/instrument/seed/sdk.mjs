export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

export function createClient(options) {
  const base = options.baseUrl.replace(/\/+$/, "")
  async function request(method, path, input) {
    const response = await fetch(base + path, { method,
      headers: { authorization: "Bearer " + options.apiKey, ...(input === undefined ? {} : { "content-type": "application/json" }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
    const result = await response.json()
    if (!response.ok) throw new ApiError(response.status, result.error?.code || "api_error", result.error?.message || "Request failed")
    return result
  }
  return {
    listAccounts: () => request("GET", "/api/accounts"),
    createAccount: (input) => request("POST", "/api/accounts", input),
    recordUsage: (accountId, input) => request("POST", "/api/accounts/" + encodeURIComponent(accountId) + "/usage", input),
    listUsage: (accountId, period) => request("GET", "/api/accounts/" + encodeURIComponent(accountId) + "/usage"
      + (period === undefined ? "" : "?period=" + encodeURIComponent(period))),
    quote: (accountId, period) => request("GET", "/api/accounts/" + encodeURIComponent(accountId) + "/quote?period=" + encodeURIComponent(period)),
  }
}
