import { withApi, jsonOk } from '@/server/api'
import { requireOrganization } from '@/server/authz'
import { complaintService } from '@/server/services/complaint-service'

interface Ctx { params: { id: string } }

/** POST: retry AI analysis after a failure (spec §23: allow retry). */
export const POST = withApi<Ctx>(async (_req, { params }) => {
  const ctx = await requireOrganization()
  const complaint = await complaintService.retryAi(ctx, params.id)
  return jsonOk({ complaint })
})
