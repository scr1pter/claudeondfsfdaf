import { ApiError, createClient } from './sdk.mjs'
import type {
  ClientOptions, LedgerClient, Account, Plan, UsageEvent, Quote, Invoice,
  InvoiceLine, Credit, AccessKey, KeyInput, KeyRole, KeyRevocation,
} from './sdk.mjs'

const options: ClientOptions = { baseUrl: 'http://127.0.0.1:4125', apiKey: 'synthetic' }
const client: LedgerClient = createClient(options)
const plan: Plan = { baseCents: 100, includedUnits: 0, unitCents: 2 }
const accounts: Account[] = await client.listAccounts()
const account: Account = await client.createAccount({ name: 'Synthetic', plan })
const event: UsageEvent = await client.recordUsage(account.id, {
  eventId: 'synthetic', units: 2, occurredAt: '2026-01-01T00:00:00Z',
})
const usage: UsageEvent[] = await client.listUsage(account.id, '2026-01')
await client.listUsage(account.id)
const quote: Quote = await client.quote(account.id, '2026-01')
const issued: Invoice = await client.issueInvoice(account.id, { period: '2026-01', requestId: 'synthetic' })
const invoice: Invoice = await client.getInvoice(issued.id)
const status: 'issued' = invoice.status
const lines: InvoiceLine[] = invoice.lines
const kind: 'base' | 'overage' = lines[0].kind
const cents: number = invoice.balanceCents
const credit: Credit = await client.creditInvoice(invoice.id, { requestId: 'synthetic', amountCents: 1, reason: 'Synthetic' })
const credits: Credit[] = await client.listCredits(invoice.id)
const keyInput: KeyInput = { role: 'billing', accountIds: [account.id] }
const key: AccessKey = await client.createKey(keyInput)
const role: KeyRole = key.role
const rawKey: string = key.apiKey
const scope: string[] | undefined = key.accountIds
const revoked: KeyRevocation = await client.revokeKey(key.id)
const error: ApiError = new ApiError(400, 'synthetic', 'Synthetic')
const errorStatus: number = error.status
const errorCode: string = error.code

// @ts-expect-error Owners cannot be created through the API.
client.createKey({ role: 'owner' })
// @ts-expect-error Units must be a number.
client.recordUsage(account.id, { eventId: 'e', units: '2', occurredAt: '2026-01-01T00:00:00Z' })
// @ts-expect-error requestId is required.
client.issueInvoice(account.id, { period: '2026-01' })
// @ts-expect-error Credits require a reason.
client.creditInvoice(invoice.id, { requestId: 'e', amountCents: 2 })
// @ts-expect-error Account scopes contain string IDs.
client.createKey({ role: 'reader', accountIds: [3] })
// @ts-expect-error A quote is not a string.
const badQuote: string = await client.quote(account.id, '2026-01')
// @ts-expect-error Unknown response fields must be rejected.
invoice.notAField
// @ts-expect-error Status is a precise literal.
const badStatus: 'draft' = invoice.status
// @ts-expect-error IDs must be strings.
client.getInvoice(2)
// @ts-expect-error ApiError status is numeric.
const badErrorStatus: string = error.status

void [accounts, event, usage, quote, status, kind, cents, credit, credits, role, rawKey, scope,
  revoked, errorStatus, errorCode, badQuote, badStatus, badErrorStatus]
