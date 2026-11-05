export const plan = { baseCents: 1000, includedUnits: 10, unitCents: 25 }
export const account = { id: "account-1", workspaceId: "acme", name: "Synthetic client account", plan }
export const usageInput = { eventId: "synthetic-event", units: 25, occurredAt: "2026-11-04T10:00:00Z" }
export const usage = { id: "usage-1", workspaceId: "acme", accountId: account.id, ...usageInput }
export const quote = { accountId: account.id, period: "2026-11", ...plan, totalUnits: 25, overageUnits: 15, totalCents: 1375 }
export const invoice = {
  id: "invoice-1", workspaceId: "acme", ...quote, status: "issued", creditedCents: 0, balanceCents: 1375,
  lines: [
    { kind: "base", quantity: 1, unitCents: 1000, amountCents: 1000 },
    { kind: "overage", quantity: 15, unitCents: 25, amountCents: 375 },
  ],
}
export const credit = { id: "credit-1", workspaceId: "acme", invoiceId: invoice.id, amountCents: 100, reason: "Synthetic service adjustment" }
export const accessKey = { id: "key-1", apiKey: "synthetic-issued-key", role: "reader", accountIds: [account.id] }
