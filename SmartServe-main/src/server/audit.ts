import { db } from '@/lib/db'
import { createLogger } from '@/server/logger'

const log = createLogger('audit')

/**
 * Immutable audit trail (spec §41/§48). Append-only: the application exposes
 * no code path that updates or deletes AuditLog rows.
 */

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.register'
  | 'auth.password_reset_requested'
  | 'auth.password_reset'
  | 'organization.created'
  | 'organization.updated'
  | 'organization.joined'
  | 'member.invited'
  | 'member.role_changed'
  | 'member.removed'
  | 'department.created'
  | 'department.updated'
  | 'department.deleted'
  | 'location.created'
  | 'location.updated'
  | 'location.deleted'
  | 'category.created'
  | 'category.updated'
  | 'category.deleted'
  | 'sla.updated'
  | 'whatsapp.connected'
  | 'whatsapp.disconnected'
  | 'complaint.created'
  | 'complaint.assigned'
  | 'complaint.status_changed'
  | 'complaint.priority_changed'
  | 'complaint.resolved'
  | 'complaint.reopened'
  | 'comment.created'
  | 'attachment.uploaded'
  | 'feedback.received'
  | 'ai.retry'

export async function recordAudit(entry: {
  organizationId?: string | null
  userId?: string | null
  action: AuditAction
  entityType: string
  entityId?: string | null
  oldValue?: unknown
  newValue?: unknown
  ipAddress?: string
  userAgent?: string
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        organizationId: entry.organizationId ?? null,
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        oldValue: entry.oldValue === undefined ? null : JSON.stringify(entry.oldValue),
        newValue: entry.newValue === undefined ? null : JSON.stringify(entry.newValue),
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      },
    })
  } catch (error) {
    // Audit must never break the business flow, but failures are loud.
    log.error('audit.write_failed', {
      action: entry.action,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
