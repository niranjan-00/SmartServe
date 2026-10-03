import { statusChangeSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization } from '@/server/authz'
import { complaintService } from '@/server/services/complaint-service'

interface Ctx { params: { id: string } }

/**
 * POST /api/complaints/[id]/status — validated state transitions (spec §20/§22).
 * Staff can only transition their own complaints (enforced in service).
 */
export const POST = withApi<Ctx>(async (req, { params }) => {
  const ctx = await requireOrganization()
  const body = await readJson(req, statusChangeSchema)
  const complaint = await complaintService.changeStatus(ctx, params.id, body.status, body.reason)
  return jsonOk({ complaint })
})
