import {
  ApiError, createClient,
  type ClientOptions, type Plan, type NewAccount, type Account, type UsageInput, type UsageEvent,
  type Quote, type InvoiceInput, type InvoiceLine, type Invoice, type CreditInput, type Credit,
  type KeyRole, type KeyInput, type AccessKey, type KeyRevocation, type LedgerClient,
} from "../sdk.mjs"

const options: ClientOptions = { baseUrl: "http://127.0.0.1:4125", apiKey: "synthetic-type-fixture" }
const client: LedgerClient = createClient(options)
const plan: Plan = { baseCents: 1000, includedUnits: 10, unitCents: 25 }
const accountInput: NewAccount = { name: "Synthetic type fixture", plan }
const usageInput: UsageInput = { eventId: "event-1", units: 20, occurredAt: "2026-11-04T10:00:00Z" }
const invoiceInput: InvoiceInput = { period: "2026-11", requestId: "issue-1" }
const creditInput: CreditInput = { requestId: "credit-1", amountCents: 100, reason: "Synthetic adjustment" }
const role: KeyRole = "reader"
const keyInput: KeyInput = { role, accountIds: ["account-1"] }
const accounts: Account[] = await client.listAccounts()
const account: Account = await client.createAccount(accountInput)
const usage: UsageEvent = await client.recordUsage(account.id, usageInput)
const allUsage: UsageEvent[] = await client.listUsage(account.id)
const monthlyUsage: UsageEvent[] = await client.listUsage(account.id, "2026-11")
const quote: Quote = await client.quote(account.id, "2026-11")
const invoice: Invoice = await client.issueInvoice(account.id, invoiceInput)
const fetched: Invoice = await client.getInvoice(invoice.id)
const status: "issued" = invoice.status
const line: InvoiceLine | undefined = invoice.lines[0]
if (line) {
  const kind: "base" | "overage" = line.kind
  const amount: number = line.amountCents
  void [kind, amount]
}
const credit: Credit = await client.creditInvoice(invoice.id, creditInput)
const credits: Credit[] = await client.listCredits(invoice.id)
const key: AccessKey = await client.createKey(keyInput)
const workspaceKey: AccessKey = await client.createKey({ role: "billing" })
const revocation: KeyRevocation = await client.revokeKey(key.id)
const revoked: true = revocation.revoked
const secret: string = key.apiKey
const scope: string[] | undefined = key.accountIds
const error: ApiError = new ApiError(409, "conflict", "Synthetic conflict")
const httpStatus: number = error.status
const code: string = error.code
void [accounts, usage, allUsage, monthlyUsage, quote, fetched, status, credit, credits, workspaceKey, revoked, secret, scope, httpStatus, code]

// @ts-expect-error owners cannot be minted
client.createKey({ role: "owner" })
// @ts-expect-error scope must contain string account identifiers
client.createKey({ role: "reader", accountIds: [123] })
// @ts-expect-error undeclared security fields are not input
client.createKey({ role: "reader", workspaceId: "beta" })
// @ts-expect-error input requires an explicit role
client.createKey({})
// @ts-expect-error requestId is required
client.issueInvoice(account.id, { period: "2026-11" })
// @ts-expect-error status is not a writable input
client.issueInvoice(account.id, { ...invoiceInput, status: "issued" })
// @ts-expect-error account identifier must be a string
client.issueInvoice(123, invoiceInput)
// @ts-expect-error amount is integer currency represented as number, not text
client.creditInvoice(invoice.id, { ...creditInput, amountCents: "100" })
// @ts-expect-error credit reason is required
client.creditInvoice(invoice.id, { requestId: "credit-1", amountCents: 100 })
// @ts-expect-error invoice identifier is required
client.getInvoice()
// @ts-expect-error period is required
client.quote(account.id)
// @ts-expect-error units must be numeric
client.recordUsage(account.id, { ...usageInput, units: "20" })
// @ts-expect-error every plan field is required
client.createAccount({ name: "Synthetic", plan: { baseCents: 100 } })
// @ts-expect-error unknown output fields are not allowed
invoice.notAPublicField
// @ts-expect-error invoices have no secret material
invoice.apiKey
// @ts-expect-error credits do not expose request ids
credit.requestId
// @ts-expect-error access keys are scoped without exposing workspace metadata
key.workspaceId
// @ts-expect-error numeric result is not text
const wrongTotal: string = invoice.totalCents
// @ts-expect-error account plans have numeric fields
const wrongPlan: string = account.plan.baseCents
// @ts-expect-error usage event units are numeric
const wrongUsage: string = usage.units
// @ts-expect-error quotes have numeric totals
const wrongQuote: string = quote.totalCents
// @ts-expect-error credits have numeric amounts
const wrongCredit: string = credit.amountCents
// @ts-expect-error issued keys have string secrets
const wrongSecret: number = key.apiKey
// @ts-expect-error promises return invoices, not accounts
const wrongPromise: Promise<Account> = client.getInvoice(invoice.id)
// @ts-expect-error status is issued, never draft
const wrongStatus: "draft" = invoice.status
// @ts-expect-error line kind is closed
const wrongLine: InvoiceLine = { kind: "discount", quantity: 1, unitCents: 1, amountCents: 1 }
// @ts-expect-error revocation is the literal true
const wrongRevocation: false = revocation.revoked
// @ts-expect-error ApiError status is numeric
const wrongError: string = error.status
// @ts-expect-error base URL is required
createClient({ apiKey: "synthetic" })
void [wrongTotal, wrongPlan, wrongUsage, wrongQuote, wrongCredit, wrongSecret, wrongPromise, wrongStatus, wrongLine, wrongRevocation, wrongError]
