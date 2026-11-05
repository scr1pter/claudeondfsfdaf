export interface ClientOptions {
  baseUrl: string
  apiKey: string
}
export interface Plan {
  baseCents: number
  includedUnits: number
  unitCents: number
}
export interface NewAccount {
  name: string
  plan: Plan
}
export interface Account extends NewAccount {
  id: string
  workspaceId: string
}
export interface UsageInput {
  eventId: string
  units: number
  occurredAt: string
}
export interface UsageEvent extends UsageInput {
  id: string
  workspaceId: string
  accountId: string
}
export interface Quote extends Plan {
  accountId: string
  period: string
  totalUnits: number
  overageUnits: number
  totalCents: number
}
export interface InvoiceInput {
  period: string
  requestId: string
}
export interface InvoiceLine {
  kind: "base" | "overage"
  quantity: number
  unitCents: number
  amountCents: number
}
export interface Invoice extends Quote {
  id: string
  workspaceId: string
  status: "issued"
  creditedCents: number
  balanceCents: number
  lines: InvoiceLine[]
}
export interface CreditInput {
  requestId: string
  amountCents: number
  reason: string
}
export interface Credit {
  id: string
  workspaceId: string
  invoiceId: string
  amountCents: number
  reason: string
}
export type KeyRole = "billing" | "reader"
export interface KeyInput {
  role: KeyRole
  accountIds?: string[]
}
export interface AccessKey extends KeyInput {
  id: string
  apiKey: string
}
export interface KeyRevocation {
  revoked: true
}
export interface LedgerClient {
  listAccounts(): Promise<Account[]>
  createAccount(input: NewAccount): Promise<Account>
  recordUsage(accountId: string, input: UsageInput): Promise<UsageEvent>
  listUsage(accountId: string, period?: string): Promise<UsageEvent[]>
  quote(accountId: string, period: string): Promise<Quote>
  issueInvoice(accountId: string, input: InvoiceInput): Promise<Invoice>
  getInvoice(invoiceId: string): Promise<Invoice>
  creditInvoice(invoiceId: string, input: CreditInput): Promise<Credit>
  listCredits(invoiceId: string): Promise<Credit[]>
  createKey(input: KeyInput): Promise<AccessKey>
  revokeKey(keyId: string): Promise<KeyRevocation>
}
export class ApiError extends Error {
  constructor(status: number, code: string, message: string)
  readonly status: number
  readonly code: string
}
export function createClient(options: ClientOptions): LedgerClient
