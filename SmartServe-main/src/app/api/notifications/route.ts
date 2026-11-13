import { z } from 'zod'
import { db } from '@/lib/db'
import { paginationSchema } from '@/lib/types'
import { withApi, readQuery, jsonOk } from '@/server/api'
import { requireOrganization } from '@/server/authz'
import { emitToOrganization } from '@/server/realtime'
import { ApiError } from '@/server/errors'

/** Notification center (spec §33/§35) — real database rows only. */
export const GET = withApi(async (req) => {
  const ctx = await requireOrganization()
  const { page, pageSize } = readQuery(req, paginationSchema)
  const [items, total, unread] = await Promise.all([
    db.notification.findMany({
      where: { userId: ctx.user.id, organizationId: ctx.organizationId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { complaint: { select: { ticketNumber: true } } },
    }),
    db.notification.count({ where: { userId: ctx.user.id, organizationId: ctx.organizationId } }),
    db.notification.count({ where: { userId: ctx.user.id, organizationId: ctx.organizationId, readAt: null } }),
  ])
  return jsonOk({ items, total, unread, page, pageSize })
})

/** PATCH: mark all as read. */
export const PATCH = withApi(async () => {
  const ctx = await requireOrganization()
  await db.notification.updateMany({
    where: { userId: ctx.user.id, organizationId: ctx.organizationId, readAt: null },
    data: { readAt: new Date() },
  })
  await emitToOrganization(ctx.organizationId, 'dashboard.refresh', { reason: 'notifications' })
  return jsonOk({ ok: true })
})

/** PUT: mark a single notification as read (?notificationId=). */
export const PUT = withApi(async (req) => {
  const ctx = await requireOrganization()
  const url = new URL(req.url)
  const notificationId = z.string().min(1).safeParse(url.searchParams.get('notificationId'))
  if (!notificationId.success) throw ApiError.badRequest('notificationId is required')

  await db.notification.updateMany({
    where: {
      id: notificationId.data,
      userId: ctx.user.id,
      organizationId: ctx.organizationId,
      readAt: null,
    },
    data: { readAt: new Date() },
  })
  return jsonOk({ ok: true })
})
