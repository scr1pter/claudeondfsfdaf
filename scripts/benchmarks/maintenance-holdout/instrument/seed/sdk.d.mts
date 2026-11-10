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
export interface LedgerClient {
  listAccounts(): Promise<Account[]>
  createAccount(input: NewAccount): Promise<Account>
  recordUsage(accountId: string, input: UsageInput): Promise<UsageEvent>
  listUsage(accountId: string, period?: string): Promise<UsageEvent[]>
  quote(accountId: string, period: string): Promise<Quote>
}
export class ApiError extends Error {
  constructor(status: number, code: string, message: string)
  readonly status: number
  readonly code: string
}
export function createClient(options: ClientOptions): LedgerClient
