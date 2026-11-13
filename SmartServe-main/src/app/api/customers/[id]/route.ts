import { db } from '@/lib/db'
import { withApi, jsonOk } from '@/server/api'
import { requireOrganization } from '@/server/authz'
import { ApiError } from '@/server/errors'

interface Ctx { params: { id: string } }

/** Customer detail: profile + complaint history + conversations (spec §42). */
export const GET = withApi<Ctx>(async (_req, { params }) => {
  const ctx = await requireOrganization()
  const customer = await db.customer.findFirst({
    where: { id: params.id, organizationId: ctx.organizationId },
    include: {
      complaints: {
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: {
          id: true, ticketNumber: true, title: true, status: true, priority: true, createdAt: true, resolvedAt: true,
        },
      },
      conversations: {
        orderBy: { lastMessageAt: 'desc' },
        take: 10,
        select: { id: true, status: true, lastMessageAt: true, _count: { select: { messages: true } } },
      },
      feedbacks: { select: { rating: true, comment: true, createdAt: true, complaint: { select: { ticketNumber: true } } } },
    },
  })
  if (!customer) throw ApiError.notFound('Customer not found')

  const avgRating = customer.feedbacks.length > 0
    ? customer.feedbacks.reduce((a, b) => a + b.rating, 0) / customer.feedbacks.length
    : null

  return jsonOk({ customer: { ...customer, satisfaction: avgRating } })
})
