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
  const apiKey = options.apiKey
  const redact = (value) => apiKey ? value.replaceAll(apiKey, "[redacted]") : value
  async function request(method, path, input) {
    let response
    try {
      response = await fetch(base + path, { method, redirect: "error",
        headers: { authorization: "Bearer " + apiKey, ...(input === undefined ? {} : { "content-type": "application/json" }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
    } catch {
      throw new ApiError(0, "network_error", "Cannot reach the LedgerDesk service")
    }
    let result
    try {
      result = await response.json()
    } catch {
      throw new ApiError(response.status, response.ok ? "invalid_response" : "api_error",
        response.ok ? "Service returned invalid JSON" : "Request failed")
    }
    if (!response.ok) {
      const code = typeof result?.error?.code === "string" && result.error.code.trim() ? result.error.code : "api_error"
      const message = typeof result?.error?.message === "string" && result.error.message.trim() ? result.error.message : "Request failed"
      throw new ApiError(response.status, redact(code), redact(message))
    }
    return result
  }
  return {
    listAccounts: () => request("GET", "/api/accounts"),
    createAccount: (input) => request("POST", "/api/accounts", {
      name: input?.name,
      plan: { baseCents: input?.plan?.baseCents, includedUnits: input?.plan?.includedUnits, unitCents: input?.plan?.unitCents },
    }),
    recordUsage: (accountId, input) => request("POST", "/api/accounts/" + encodeURIComponent(accountId) + "/usage", {
      eventId: input?.eventId, units: input?.units, occurredAt: input?.occurredAt,
    }),
    listUsage: (accountId, period) => request("GET", "/api/accounts/" + encodeURIComponent(accountId) + "/usage"
      + (period === undefined ? "" : "?period=" + encodeURIComponent(period))),
    quote: (accountId, period) => request("GET", "/api/accounts/" + encodeURIComponent(accountId) + "/quote?period=" + encodeURIComponent(period)),
    issueInvoice: (accountId, input) => request("POST", "/api/accounts/" + encodeURIComponent(accountId) + "/invoices", {
      period: input?.period, requestId: input?.requestId,
    }),
    getInvoice: (invoiceId) => request("GET", "/api/invoices/" + encodeURIComponent(invoiceId)),
    creditInvoice: (invoiceId, input) => request("POST", "/api/invoices/" + encodeURIComponent(invoiceId) + "/credits", {
      requestId: input?.requestId, amountCents: input?.amountCents, reason: input?.reason,
    }),
    listCredits: (invoiceId) => request("GET", "/api/invoices/" + encodeURIComponent(invoiceId) + "/credits"),
    createKey: (input) => request("POST", "/api/access-keys", { role: input?.role, accountIds: input?.accountIds }),
    revokeKey: (keyId) => request("POST", "/api/access-keys/" + encodeURIComponent(keyId) + "/revoke", {}),
  }
}
