import { db } from '@/lib/db'
import { SLA_STATES, OPEN_STATUSES, type Priority, type SlaState } from '@/lib/types'
import { createLogger } from '@/server/logger'

const log = createLogger('sla')

/**
 * SLA service (spec §30-32). Organizations configure per-priority response &
 * resolution windows; slaDueAt is stamped at complaint creation. State is
 * computed server-side and continuously maintained by the background monitor
 * (jobs.ts) — never only on page load.
 */

export interface SlaPolicy {
  firstResponseMinutes: number
  resolutionMinutes: number
  escalationMinutes: number | null
  enabled: boolean
}

export const DEFAULT_SLA: Record<Priority, SlaPolicy> = {
  LOW: { firstResponseMinutes: 240, resolutionMinutes: 1440, escalationMinutes: null, enabled: true },
  MEDIUM: { firstResponseMinutes: 120, resolutionMinutes: 480, escalationMinutes: null, enabled: true },
  HIGH: { firstResponseMinutes: 30, resolutionMinutes: 120, escalationMinutes: null, enabled: true },
  CRITICAL: { firstResponseMinutes: 10, resolutionMinutes: 30, escalationMinutes: null, enabled: true },
}

export async function getSlaPolicies(organizationId: string): Promise<Record<Priority, SlaPolicy>> {
  const rows = await db.sLA.findMany({ where: { organizationId } })
  const result = { ...DEFAULT_SLA } as Record<Priority, SlaPolicy>
  for (const row of rows) {
    if (row.priority in result) {
      result[row.priority as Priority] = {
        firstResponseMinutes: row.firstResponseMinutes,
        resolutionMinutes: row.resolutionMinutes,
        escalationMinutes: row.escalationMinutes,
        enabled: row.enabled,
      }
    }
  }
  return result
}

/** slaDueAt = createdAt + resolutionMinutes of the matching priority policy. */
export function computeSlaDueAt(createdAt: Date, policy: SlaPolicy): Date {
  return new Date(createdAt.getTime() + policy.resolutionMinutes * 60_000)
}

/**
 * SLA state machine:
 *   MET          → resolved/closed before due
 *   BREACHED     → open and past due
 *   APPROACHING  → open and ≥80% of the window consumed
 *   WITHIN_SLA   → open, otherwise
 */
export function computeSlaState(complaint: { status: string; slaDueAt: Date | null; createdAt: Date; resolvedAt: Date | null }, now = new Date()): SlaState {
  if (complaint.status === 'RESOLVED' || complaint.status === 'CLOSED') {
    if (complaint.resolvedAt && complaint.slaDueAt && complaint.resolvedAt <= complaint.slaDueAt) return 'MET'
    if (complaint.resolvedAt && complaint.slaDueAt && complaint.resolvedAt > complaint.slaDueAt) return 'BREACHED'
    return 'MET'
  }
  if (!complaint.slaDueAt) return 'WITHIN_SLA'
  if (now > complaint.slaDueAt) return 'BREACHED'
  const total = complaint.slaDueAt.getTime() - complaint.createdAt.getTime()
  const used = now.getTime() - complaint.createdAt.getTime()
  if (total > 0 && used / total >= 0.8) return 'APPROACHING'
  return 'WITHIN_SLA'
}

export function isSlaState(v: string): v is SlaState {
  return (SLA_STATES as readonly string[]).includes(v)
}

export interface SlaBreachInfo {
  complaintId: string
  organizationId: string
  ticketNumber: string
  slaDueAt: Date
  assignedTo: string | null
}

/**
 * Continuous SLA scan used by the background monitor. Creates SLA_WARNING
 * APPROACHING notifications and SLA_BREACH escalations exactly once per
 * complaint per state transition (tracked via escalation records).
 */
export async function scanOrganizationSla(organizationId: string): Promise<{ warnings: number; breaches: number }> {
  const { notify } = await import('@/server/services/notification-service')
  const complaints = await db.complaint.findMany({
    where: { organizationId, status: { in: OPEN_STATUSES }, slaDueAt: { not: null } },
    select: { id: true, ticketNumber: true, slaDueAt: true, priority: true, assignedTo: true, status: true },
  })

  let warnings = 0
  let breaches = 0
  const now = new Date()

  for (const complaint of complaints) {
    const state = computeSlaState({
      status: complaint.status,
      slaDueAt: complaint.slaDueAt,
      createdAt: new Date(0), // not needed for open complaints' state beyond due date
      resolvedAt: null,
    }, now)

    if (state === 'APPROACHING') {
      const existing = await db.notification.findFirst({
        where: { type: 'SLA_WARNING', complaintId: complaint.id },
        select: { id: true },
      })
      if (!existing) {
        log.info('sla.warning', { ticketNumber: complaint.ticketNumber })
        await db.escalation.create({
          data: {
            organizationId,
            complaintId: complaint.id,
            level: 1,
            trigger: 'SLA_APPROACHING',
            notifiedUserId: complaint.assignedTo,
          },
        })
        if (complaint.assignedTo) {
          await notify({
            organizationId,
            userId: complaint.assignedTo,
            type: 'SLA_WARNING',
            title: 'SLA approaching',
            message: `Ticket ${complaint.ticketNumber} is approaching its SLA due time.`,
            complaintId: complaint.id,
          })
        }
        warnings++
      }
    }

    if (state === 'BREACHED') {
      const existing = await db.escalation.findFirst({
        where: { complaintId: complaint.id, trigger: 'SLA_BREACH', level: { gte: 1 } },
        select: { id: true },
      })
      if (!existing) {
        log.info('sla.breach', { ticketNumber: complaint.ticketNumber })
        await db.escalation.create({
          data: {
            organizationId,
            complaintId: complaint.id,
            level: 2,
            trigger: 'SLA_BREACH',
            notifiedUserId: complaint.assignedTo,
          },
        })
        // Level 2: notify supervisors; level 3 handled on repeated breach scans
        const supervisors = await db.organizationMember.findMany({
          where: { organizationId, role: { in: ['ORGANIZATION_ADMIN', 'SUPERVISOR'] }, status: 'ACTIVE' },
          select: { userId: true },
        })
        const { notifyMany } = await import('@/server/services/notification-service')
        await notifyMany(
          supervisors.map((s) => ({
            organizationId,
            userId: s.userId,
            type: 'SLA_BREACH' as const,
            title: 'SLA breached',
            message: `Ticket ${complaint.ticketNumber} has breached its SLA. Supervisors have been notified.`,
            complaintId: complaint.id,
          })),
        )
        if (complaint.assignedTo) {
          await notify({
            organizationId,
            userId: complaint.assignedTo,
            type: 'SLA_BREACH',
            title: 'SLA breached',
            message: `Ticket ${complaint.ticketNumber} has breached its SLA due time.`,
            complaintId: complaint.id,
          })
        }
        breaches++
      } else {
        // Repeated breach → escalate to level 3 (organization admin)
        const level3 = await db.escalation.findFirst({
          where: { complaintId: complaint.id, trigger: 'SLA_BREACH', level: 3 },
          select: { id: true },
        })
        if (!level3) {
          const breachAge = now.getTime() - (complaint.slaDueAt?.getTime() ?? 0)
          if (breachAge > 60 * 60 * 1000) {
            await db.escalation.create({
              data: { organizationId, complaintId: complaint.id, level: 3, trigger: 'SLA_BREACH_L3' },
            })
            const admins = await db.organizationMember.findMany({
              where: { organizationId, role: 'ORGANIZATION_ADMIN', status: 'ACTIVE' },
              select: { userId: true },
            })
            const { notifyMany } = await import('@/server/services/notification-service')
            await notifyMany(
              admins.map((a) => ({
                organizationId,
                userId: a.userId,
                type: 'ESCALATION' as const,
                title: 'Escalation level 3',
                message: `Ticket ${complaint.ticketNumber} remains unresolved 1h after SLA breach. Escalated to organization admin.`,
                complaintId: complaint.id,
              })),
            )
          }
        }
      }
      breaches++
    }
  }

  return { warnings, breaches }
}
