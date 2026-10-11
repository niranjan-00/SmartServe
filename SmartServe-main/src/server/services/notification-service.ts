import { db } from '@/lib/db'
import type { Notification } from '@prisma/client'
import { emitToOrganization } from '@/server/realtime'
import { createLogger } from '@/server/logger'

const log = createLogger('notification')

/**
 * NotificationService (spec §33/§35). Dashboard notification center reads
 * from these rows — no fake in-memory notifications.
 */

export interface CreateNotificationInput {
  organizationId: string
  userId: string
  type: string
  title: string
  message: string
  complaintId?: string | null
}

export async function notify(input: CreateNotificationInput): Promise<Notification | null> {
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
      include: { complaint: { select: { ticketNumber: true, title: true } } },
    })
    await emitToOrganization(input.organizationId, 'notification.created', {
      userId: input.userId,
      notification,
    })
    return notification
  } catch (error) {
    log.error('notification.create_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

export async function notifyMany(inputs: CreateNotificationInput[]): Promise<void> {
  await Promise.all(inputs.map(notify))
}
