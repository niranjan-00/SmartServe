import { db } from '@/lib/db'
import { recordAudit } from '@/server/audit'
import { emitToOrganization } from '@/server/realtime'
import { ApiError } from '@/server/errors'
import type { AuthContext } from '@/server/authz'

/**
 * FeedbackService (spec §37/§38). Ratings come only from real customers
 * via the WhatsApp bot flow — never fabricated. Staff dashboards read
 * aggregated satisfaction from these rows.
 */

export async function submitFeedback(params: {
  organizationId: string
  customerId: string
  ticketNumber: string
  rating: number
  comment?: string
}): Promise<{ ok: boolean; message: string }> {
  const complaint = await db.complaint.findFirst({
    where: {
      ticketNumber: params.ticketNumber,
      organizationId: params.organizationId,
      customerId: params.customerId, // identity check: only own tickets
    },
  })

  if (!complaint) {
    return { ok: false, message: `Ticket ${params.ticketNumber} was not found for your WhatsApp number.` }
  }
  if (complaint.status !== 'RESOLVED' && complaint.status !== 'CLOSED') {
    return { ok: false, message: `Ticket ${params.ticketNumber} is not resolved yet, so it can't be rated.` }
  }

  const existing = await db.feedback.findUnique({
    where: { complaintId_customerId: { complaintId: complaint.id, customerId: params.customerId } },
  })
  if (existing) {
    return { ok: false, message: `You already rated ticket ${params.ticketNumber}. Thank you!` }
  }

  await db.feedback.create({
    data: {
      organizationId: params.organizationId,
      complaintId: complaint.id,
      customerId: params.customerId,
      staffId: complaint.assignedTo,
      rating: params.rating,
      comment: params.comment ?? null,
    },
  })

  await recordAudit({
    organizationId: params.organizationId,
    action: 'feedback.received',
    entityType: 'Feedback',
    entityId: complaint.id,
    newValue: { ticketNumber: params.ticketNumber, rating: params.rating },
  })

  await emitToOrganization(params.organizationId, 'dashboard.refresh', { reason: 'feedback' })

  return { ok: true, message: 'Thank you for your feedback!' }
}

export async function listFeedback(ctx: AuthContext, page: number, pageSize: number) {
  const where = { organizationId: ctx.organizationId }
  const [total, items] = await Promise.all([
    db.feedback.count({ where }),
    db.feedback.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        complaint: { select: { ticketNumber: true, title: true } },
        customer: { select: { name: true, phoneNumber: true } },
      },
    }),
  ])
  return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) }
}

export async function organizationFeedbackStats(organizationId: string) {
  const rows = await db.feedback.groupBy({
    by: ['rating'],
    where: { organizationId },
    _count: { _all: true },
  })
  const total = rows.reduce((acc, r) => acc + r._count._all, 0)
  const average = total > 0 ? rows.reduce((acc, r) => acc + r.rating * r._count._all, 0) / total : null
  void ApiError
  return { total, average, distribution: rows.map((r) => ({ rating: r.rating, count: r._count._all })) }
}
