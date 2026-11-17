
import { db } from '@/lib/db'
import type { Notification } from '@prisma/client'
import { emitToOrganization } from '@/server/realtime'
import { createLogger } from '@/server/logger'

const log = createLogger('notification')

/**
 * NotificationService (spec §33/§35).
 *
 * Dashboard notification center reads persisted notification rows.
 * Notifications are never stored only in memory.
 */

export interface CreateNotificationInput {
  organizationId: string
  userId: string
  type: string
  title: string
  message: string
  complaintId?: string | null
}

/**
 * Create and deliver a notification to one user.
 */
export async function notify(
  input: CreateNotificationInput,
): Promise<Notification | null> {
  try {
    const notification = await db.notification.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        type: input.type,
        title: input.title,
        message: input.message,
        complaintId: input.complaintId ?? null,
      },
      include: {
        complaint: {
          select: {
            ticketNumber: true,
            title: true,
          },
        },
      },
    })

    await emitToOrganization(
      input.organizationId,
      'notification.created',
      {
        userId: input.userId,
        notification,
      },
    )

    return notification
  } catch (error) {
    log.error('notification.create_failed', {
      organizationId: input.organizationId,
      userId: input.userId,
      complaintId: input.complaintId ?? null,
      message:
        error instanceof Error
          ? error.message
          : String(error),
    })

    return null
  }
}

/**
 * Send notifications to multiple users.
 *
 * Each notification is persisted separately so that the
 * existing per-user notification center continues to work.
 */
export async function notifyMany(
  inputs: CreateNotificationInput[],
): Promise<void> {
  if (inputs.length === 0) return

  await Promise.all(inputs.map((input) => notify(input)))
}

/**
 * Notify all active STAFF and SUPERVISOR members of a department.
 *
 * Only members belonging to the specified organization and
 * department receive notifications.
 */
export async function notifyDepartmentMembers(input: {
  organizationId: string
  departmentId: string
  title: string
  message: string
  complaintId?: string | null
}): Promise<void> {
  try {
    // Verify that the department belongs to this organization.
    const department = await db.department.findFirst({
      where: {
        id: input.departmentId,
        organizationId: input.organizationId,
      },
      select: {
        id: true,
        name: true,
      },
    })

    if (!department) {
      log.warn('department_notification.invalid_department', {
        organizationId: input.organizationId,
        departmentId: input.departmentId,
      })

      return
    }

    // Find active staff and supervisors in this department.
    const members = await db.organizationMember.findMany({
      where: {
        organizationId: input.organizationId,
        departmentId: department.id,
        status: 'ACTIVE',
        role: {
          in: ['STAFF', 'SUPERVISOR'],
        },
      },
      select: {
        userId: true,
      },
    })

    if (members.length === 0) {
      log.info('department_notification.no_recipients', {
        organizationId: input.organizationId,
        departmentId: department.id,
      })

      return
    }

    // Remove duplicate user IDs defensively.
    const uniqueUserIds = [...new Set(
      members.map((member) => member.userId),
    )]

    await notifyMany(
      uniqueUserIds.map((userId) => ({
        organizationId: input.organizationId,
        userId,
        type: 'NEW_COMPLAINT',
        title: input.title,
        message: input.message,
        complaintId: input.complaintId ?? null,
      })),
    )

    log.info('department_notification.sent', {
      organizationId: input.organizationId,
      departmentId: department.id,
      departmentName: department.name,
      recipientCount: uniqueUserIds.length,
      complaintId: input.complaintId ?? null,
    })
  } catch (error) {
    log.error('department_notification.failed', {
      organizationId: input.organizationId,
      departmentId: input.departmentId,
      complaintId: input.complaintId ?? null,
      message:
        error instanceof Error
          ? error.message
          : String(error),
    })
  }
}
