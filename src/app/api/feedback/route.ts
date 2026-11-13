import { paginationSchema } from '@/lib/types'
import { withApi, readQuery, jsonOk } from '@/server/api'
import { requireOrganization } from '@/server/authz'
import { listFeedback, organizationFeedbackStats } from '@/server/services/feedback-service'

/** Feedback list for the organization (spec §37/§38). */
export const GET = withApi(async (req) => {
  const ctx = await requireOrganization()
  const { page, pageSize } = readQuery(req, paginationSchema)
  const [result, stats] = await Promise.all([listFeedback(ctx, page, pageSize), organizationFeedbackStats(ctx.organizationId)])
  return jsonOk({ ...result, stats })
})
