
import { db } from '@/lib/db'
import { OPEN_STATUSES, type ComplaintStatus } from '@/lib/types'
import { createLogger } from '@/server/logger'
import {
  notify,
  notifyDepartmentMembers,
} from './notification-service'
import { emitToOrganization } from '@/server/realtime'

const log = createLogger('assignment')

/**
 * AssignmentService
 *
 * Assignment priority:
 * 1. Preserve an explicitly selected complaint department.
 * 2. Use the department mapped to the complaint category.
 * 3. Use the AI-suggested department as a fallback.
 *
 * Staff selection:
 * 1. Only active STAFF and SUPERVISOR members.
 * 2. Only staff belonging to the selected department, when one exists.
 * 3. Prefer matching skills.
 * 4. Prefer staff with lower open workloads.
 *
 * Organizations can disable automatic assignment through
 * Organization.autoAssignment.
 */

export interface AssignableStaff {
  userId: string
  name: string | null
  departmentId: string | null
  skills: string[]
  openCount: number
}

/**
 * Returns eligible staff members.
 *
 * When departmentId is provided, staff from other departments
 * are excluded completely.
 *
 * When departmentId is not provided, all eligible staff members
 * in the organization can be considered.
 */
export async function getAssignableStaff(
  organizationId: string,
  departmentId?: string | null,
): Promise<AssignableStaff[]> {
  const members = await db.organizationMember.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      role: {
        in: ['STAFF', 'SUPERVISOR'],
      },
      ...(departmentId ? { departmentId } : {}),
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  })

  if (members.length === 0) {
    return []
  }

  const userIds = members.map((member) => member.userId)

  const [staffSkills, workloads] = await Promise.all([
    db.staffSkill.findMany({
      where: {
        organizationId,
        userId: {
          in: userIds,
        },
      },
    }),

    db.complaint.groupBy({
      by: ['assignedTo'],
      where: {
        organizationId,
        assignedTo: {
          in: userIds,
        },
        status: {
          in: OPEN_STATUSES,
        },
      },
      _count: {
        _all: true,
      },
    }),
  ])

  const workloadMap = new Map(
    workloads.map((workload) => [
      workload.assignedTo,
      workload._count._all,
    ]),
  )

  const skillsMap = new Map<string, string[]>()

  for (const skill of staffSkills) {
    const existing = skillsMap.get(skill.userId) ?? []

    existing.push(skill.skill.toLowerCase().trim())

    skillsMap.set(skill.userId, existing)
  }

  return members.map((member) => ({
    userId: member.userId,
    name: member.user.name,
    departmentId: member.departmentId,
    skills: skillsMap.get(member.userId) ?? [],
    openCount: workloadMap.get(member.userId) ?? 0,
  }))
}

/**
 * Calculates the assignment score.
 * Higher score means a better candidate.
 */
export function scoreStaff(
  staff: AssignableStaff,
  opts: {
    departmentId?: string | null
    skillHint?: string | null
  },
): number {
  let score = 100

  if (
    opts.departmentId &&
    staff.departmentId === opts.departmentId
  ) {
    score += 50
  }

  if (opts.skillHint?.trim()) {
    const hint = opts.skillHint.toLowerCase().trim()

    const hasMatchingSkill = staff.skills.some((skill) => {
      return (
        skill.length > 0 &&
        (skill.includes(hint) || hint.includes(skill))
      )
    })

    if (hasMatchingSkill) {
      score += 30
    }
  }

  // Workload penalty.
  score -= staff.openCount * 2

  return score
}

/**
 * Selects the best eligible staff member.
 */
export function pickBestStaff(
  staff: AssignableStaff[],
  opts: {
    departmentId?: string | null
    skillHint?: string | null
  },
): AssignableStaff | null {
  if (staff.length === 0) {
    return null
  }

  const sorted = [...staff].sort((a, b) => {
    const scoreDifference =
      scoreStaff(b, opts) - scoreStaff(a, opts)

    if (scoreDifference !== 0) {
      return scoreDifference
    }

    if (a.openCount !== b.openCount) {
      return a.openCount - b.openCount
    }

    return a.userId.localeCompare(b.userId)
  })

  return sorted[0]
}

/**
 * Resolves the department for a complaint.
 *
 * Priority:
 * 1. Existing complaint department.
 * 2. Department configured on its category.
 * 3. AI-suggested department.
 *
 * Every lookup is scoped to the organization.
 */
async function resolveComplaintDepartment(
  complaint: {
    organizationId: string
    departmentId: string | null
    categoryId: string | null
  },
  aiDepartmentName?: string | null,
): Promise<string | null> {
  // Preserve an existing manually selected department.
  if (complaint.departmentId) {
    const existingDepartment = await db.department.findFirst({
      where: {
        id: complaint.departmentId,
        organizationId: complaint.organizationId,
      },
      select: {
        id: true,
      },
    })

    if (existingDepartment) {
      return existingDepartment.id
    }
  }

  // Category-to-department mapping takes priority over AI.
  if (complaint.categoryId) {
    const category = await db.category.findFirst({
      where: {
        id: complaint.categoryId,
        organizationId: complaint.organizationId,
        status: 'ACTIVE',
      },
      select: {
        departmentId: true,
      },
    })

    if (category?.departmentId) {
      const categoryDepartment = await db.department.findFirst({
        where: {
          id: category.departmentId,
          organizationId: complaint.organizationId,
        },
        select: {
          id: true,
        },
      })

      if (categoryDepartment) {
        return categoryDepartment.id
      }
    }
  }

  // AI department is only a fallback.
  if (aiDepartmentName?.trim()) {
    const aiDepartment = await db.department.findFirst({
      where: {
        organizationId: complaint.organizationId,
        name: {
          equals: aiDepartmentName.trim(),
        },
      },
      select: {
        id: true,
      },
    })

    if (aiDepartment) {
      return aiDepartment.id
    }
  }

  return null
}

/**
 * Automatically assigns a complaint to an eligible staff member.
 *
 * If no staff member is available:
 * - The department is preserved/resolved.
 * - Department members are notified.
 * - The complaint remains unassigned to an individual.
 *
 * Assignment failures never block complaint creation.
 */
export async function autoAssign(
  complaintId: string,
): Promise<string | null> {
  try {
    const complaint = await db.complaint.findUnique({
      where: {
        id: complaintId,
      },
      include: {
        organization: {
          select: {
            id: true,
            autoAssignment: true,
          },
        },
      },
    })

    if (!complaint) {
      log.warn('autoAssign.complaintNotFound', {
        complaintId,
      })

      return null
    }

    if (!complaint.organization.autoAssignment) {
      log.info('autoAssign.disabled', {
        complaintId,
        organizationId: complaint.organizationId,
      })

      return null
    }

    // Never overwrite an existing assignment.
    if (complaint.assignedTo) {
      return null
    }

    // Get the latest completed AI analysis.
    const analysis = await db.aIAnalysis.findFirst({
      where: {
        complaintId,
        organizationId: complaint.organizationId,
        status: 'COMPLETED',
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        department: true,
        category: true,
      },
    })

    // Resolve department using manual/category/AI priority.
    const departmentId = await resolveComplaintDepartment(
      {
        organizationId: complaint.organizationId,
        departmentId: complaint.departmentId,
        categoryId: complaint.categoryId,
      },
      analysis?.department,
    )

    // Save the resolved department without overwriting
    // a department selected by another process.
    if (departmentId && !complaint.departmentId) {
      await db.complaint.updateMany({
        where: {
          id: complaintId,
          organizationId: complaint.organizationId,
          assignedTo: null,
          departmentId: null,
        },
        data: {
          departmentId,
        },
      })
    }

    // Get staff belonging to the selected department.
    const staff = await getAssignableStaff(
      complaint.organizationId,
      departmentId,
    )

    const best = pickBestStaff(staff, {
      departmentId,
      skillHint: analysis?.category ?? null,
    })

    // No eligible staff: notify the department.
    if (!best) {
      if (departmentId) {
        await notifyDepartmentMembers({
          organizationId: complaint.organizationId,
          departmentId,
          title: 'New complaint needs attention',
          message: `${complaint.ticketNumber} — ${complaint.title} is awaiting staff assignment in your department.`,
          complaintId,
        })
      }

      log.info('autoAssign.noEligibleStaff', {
        complaintId,
        organizationId: complaint.organizationId,
        departmentId,
      })

      return null
    }

    const now = new Date()

    const nextStatus: ComplaintStatus =
      complaint.status === 'NEW'
        ? 'ASSIGNED'
        : (complaint.status as ComplaintStatus)

    /**
     * Assign atomically.
     *
     * The conditional update prevents concurrent workers
     * from assigning the same complaint.
     *
     * Checking departmentId also protects a department
     * selected manually while this process was running.
     */
    const assigned = await db.$transaction(async (tx) => {
      const updateResult = await tx.complaint.updateMany({
        where: {
          id: complaintId,
          organizationId: complaint.organizationId,
          assignedTo: null,
          status: complaint.status,
          departmentId: complaint.departmentId,
        },
        data: {
          assignedTo: best.userId,
          assignedAt: now,
          departmentId: departmentId ?? complaint.departmentId,
          status: nextStatus,
        },
      })

      if (updateResult.count === 0) {
        return false
      }

      await tx.complaintAssignment.create({
        data: {
          complaintId,
          organizationId: complaint.organizationId,
          assignedTo: best.userId,
          reason: 'AUTO_RULE',
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
            reason: 'Automatic staff assignment',
          },
        })
      }

      return true
    })

    if (!assigned) {
      log.info('autoAssign.alreadyAssignedOrUpdated', {
        complaintId,
      })

      return null
    }

    // Notify the assigned staff member.
    await notify({
      organizationId: complaint.organizationId,
      userId: best.userId,
      type: 'ASSIGNMENT',
      title: 'New complaint auto-assigned',
      message: `${complaint.ticketNumber} — ${complaint.title}`,
      complaintId,
    })

    // Emit realtime assignment event.
    await emitToOrganization(
      complaint.organizationId,
      'complaint.assigned',
      {
        complaintId,
        assignedTo: best.userId,
        departmentId,
      },
    )

    log.info('autoAssign.success', {
      complaintId,
      organizationId: complaint.organizationId,
      assignedTo: best.userId,
      departmentId,
      openCount: best.openCount,
    })

    return best.userId
  } catch (error) {
    log.error('autoAssign.failed', {
      complaintId,
      message:
        error instanceof Error
          ? error.message
          : String(error),
    })

    return null
  }
}
