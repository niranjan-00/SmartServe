import { feedbackSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { rateLimit, clientIp } from '@/server/rate-limit'
import { submitFeedback } from '@/server/services/feedback-service'
import { db } from '@/lib/db'

/**
 * POST /api/feedback/submit — customer-facing (via WhatsApp bot flow).
 * Identity = organization + ticket + customer phone number match.
 * Intentionally unauthenticated: the bot submits on behalf of WhatsApp
 * customers who never hold dashboard accounts. Rate limited per IP.
 */
export const POST = withApi(async (req) => {
  rateLimit(`feedback:${clientIp(req)}`, 20, 60_000)
  const body = await readJson(req, feedbackSchema)

  const customer = await db.customer.findFirst({
    where: { phoneNumber: body.phoneNumber },
    select: { organizationId: true, id: true },
  })
  if (!customer) {
    return jsonOk({ ok: false, message: 'We could not find your number. Please reply from your WhatsApp.' })
  }

  const result = await submitFeedback({
    organizationId: customer.organizationId,
    customerId: customer.id,
    ticketNumber: body.ticketNumber,
    rating: body.rating,
    comment: body.comment,
  })
  return jsonOk(result)
})
