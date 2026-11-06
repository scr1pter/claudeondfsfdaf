export type Role = 'owner' | 'manager' | 'member' | 'read_only';
export interface User { id: string; name: string; email: string }
export interface Workspace { id: string; name: string; role: Role }
export interface Session { user: User; activeWorkspaceId: string | null; workspaces: Workspace[] }
export interface Customer { id: string; name: string; email: string; company: string; notes: string; createdAt: string; updatedAt: string }
export interface Product { id: string; sku: string; name: string; description: string; priceCents: number; stock: number; createdAt: string; updatedAt: string }
export interface Movement { id: string; productId: string; delta: number; reason: string; kind: string; orderId: string | null; createdBy: string; createdAt: string }
export interface Line { productId: string; sku: string; name: string; unitPriceCents: number; quantity: number; lineTotalCents: number }
export interface Order { id: string; number: string; customerId: string; status: 'draft' | 'fulfilled' | 'cancelled'; items: Line[]; totalCents: number; createdAt: string; updatedAt: string; fulfilledAt: string | null }
export interface Invoice { id: string; number: string; orderId: string; customerId: string; billTo: {name: string; email: string; company: string}; status: 'draft' | 'sent' | 'paid' | 'void'; currency: string; items: Line[]; subtotalCents: number; totalCents: number; createdAt: string; paidAt: string | null }
export interface Project { id: string; name: string; description: string; createdAt: string; updatedAt: string }
export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type Priority = 'low' | 'medium' | 'high';
export interface Task { id: string; projectId: string; title: string; description: string; status: TaskStatus; priority: Priority; assigneeId: string | null; dueDate: string | null; createdAt: string; updatedAt: string }
export interface Member { userId: string; name: string; email: string; role: Role }
export interface Comment { id: string; taskId: string; body: string; author: {id: string; name: string}; createdAt: string }
export interface Attachment { id: string; entityType: string; entityId: string; fileName: string; size: number; mimeType: string; createdBy: string; createdAt: string }
export interface Activity { id: string; action: string; entityType: string; entityId: string; actorId: string; actorName: string; createdAt: string }
export interface Summary { customers: number; products: number; lowStockProducts: number; openOrders: number; fulfilledOrders: number; revenueCents: number; unpaidCents: number; openTasks: number; completedTasks: number }
export interface Invite { id: string; email: string; role: Role; token?: string; expiresAt: string }
