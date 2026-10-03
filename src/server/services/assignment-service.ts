import { db } from '@/lib/db'
import { OPEN_STATUSES, type ComplaintStatus } from '@/lib/types'
import { createLogger } from '@/server/logger'

const log = createLogger('assignment')

/**
 * AssignmentService (spec §24/§26). Deterministic scoring:
 *   department match > skill match > lowest open workload.
 * Organizations can disable auto-assignment (Organization.autoAssignment).
 * AI output is only a hint — the final decision is always rule-based.
 */

export interface AssignableStaff {
  userId: string
  name: string | null
  departmentId: string | null
  skills: string[]
  openCount: number
}

export async function getAssignableStaff(organizationId: string, departmentId?: string | null): Promise<AssignableStaff[]> {
  const members = await db.organizationMember.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      role: { in: ['STAFF', 'SUPERVISOR'] },
    },
    include: {
      user: { select: { id: true, name: true } },
      department: { select: { id: true } },
    },
  })

  const staffSkills = await db.staffSkill.findMany({
    where: { organizationId, userId: { in: members.map((m) => m.userId) } },
  })

  const workloads = await db.complaint.groupBy({
    by: ['assignedTo'],
    where: { organizationId, assignedTo: { not: null }, status: { in: OPEN_STATUSES } },
    _count: { _all: true },
  })
  const workloadMap = new Map(workloads.map((w) => [w.assignedTo, w._count._all]))

  return members.map((m) => ({
    userId: m.userId,
    name: m.user.name,
    departmentId: m.departmentId,
    skills: staffSkills.filter((s) => s.userId === m.userId).map((s) => s.skill.toLowerCase()),
    openCount: workloadMap.get(m.userId) ?? 0,
  }))
}

export function scoreStaff(staff: AssignableStaff[], opts: { departmentId?: string | null; skillHint?: string | null }): number {
  let score = 100
  if (opts.departmentId && staff.departmentId === opts.departmentId) score += 50
  if (opts.skillHint) {
    const hint = opts.skillHint.toLowerCase()
    if (staff.skills.some((s) => s.includes(hint) || hint.includes(s))) score += 30
  }
  score -= staff.openCount * 2 // workload penalty
  return score
}

/** Picks the best staff member; returns null when nobody qualifies. */
export function pickBestStaff(
  staff: AssignableStaff[],
  opts: { departmentId?: string | null; skillHint?: string | null },
): AssignableStaff | null {
  if (staff.length === 0) return null
  const sorted = [...staff].sort((a, b) => scoreStaff(b, opts) - scoreStaff(a, opts))
  return sorted[0]
}

/**
 * Auto-assign a complaint right after creation. Uses the AI-selected
 * department (if it maps to a real department) + workload rules.
 * Failures never block the complaint (spec §24).
 */
export async function autoAssign(complaintId: string): Promise<string | null> {
  try {
    const complaint = await db.complaint.findUnique({
      where: { id: complaintId },
      include: { department: { select: { id: true } }, organization: { select: { autoAssignment: true } } },
    })
    if (!complaint || !complaint.organization.autoAssignment) return null
    if (complaint.assignedTo) return null

    // Latest AI analysis supplies the department hint
    const analysis = await db.aIAnalysis.findFirst({
      where: { complaintId, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
    })
    let departmentId = complaint.departmentId
    if (!departmentId && analysis?.department) {
      const dept = await db.department.findFirst({
        where: { organizationId: complaint.organizationId, name: { equals: analysis.department } },
      })
      departmentId = dept?.id ?? null
    }

    const staff = await getAssignableStaff(complaint.organizationId, departmentId)
    const best = pickBestStaff(staff, {
      departmentId,
      skillHint: analysis?.category ?? null,
    })
    if (!best) return null

    const now = new Date()
    await db.$transaction(async (tx) => {
      await tx.complaintAssignment.create({
        data: {
          complaintId,
          organizationId: complaint.organizationId,
          assignedTo: best.userId,
          reason: 'AUTO_RULE',
        },
      })
      await tx.complaint.update({
        where: { id: complaintId },
        data: {
          assignedTo: best.userId,
          assignedAt: now,
          departmentId: departmentId ?? complaint.departmentId,
          status: complaint.status === 'NEW' ? 'ASSIGNED' : (complaint.status as ComplaintStatus),
        },
      })
      if (complaint.status === 'NEW') {
        await tx.complaintStatusHistory.create({
          data: {
            organizationId: complaint.organizationId,
            complaintId,
            fromStatus: 'NEW',
            toStatus: 'ASSIGNED',
            changedBy: null,
            reason: 'Auto-assignment',
          },
        })
      }
    })

    const { notify } = await import('./notification-service')
    await notify({
      organizationId: complaint.organizationId,
      userId: best.userId,
      type: 'ASSIGNMENT',
      title: 'New complaint auto-assigned',
      message: `${complaint.ticketNumber} — ${complaint.title}`,
      complaintId,
    })

    const { emitToOrganization } = await import('@/server/realtime')
    await emitToOrganization(complaint.organizationId, 'complaint.assigned', { complaintId, assignedTo: best.userId })
    log.info('autoAssigned', { complaintId, assignedTo: best.userId })
    return best.userId
  } catch (error) {
    log.error('autoAssign.failed', {
      complaintId,
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
