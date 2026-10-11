import { assignComplaintSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { complaintService } from '@/server/services/complaint-service'

interface Ctx { params: { id: string } }

/** POST /api/complaints/[id]/assign — assign/reassign (spec §21/§23). */
export const POST = withApi<Ctx>(async (req, { params }) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'complaints:assign')
  const body = await readJson(req, assignComplaintSchema)
  const complaint = await complaintService.assignComplaint(ctx, params.id, body.assignedTo, body.reason)
  return jsonOk({ complaint })
})
