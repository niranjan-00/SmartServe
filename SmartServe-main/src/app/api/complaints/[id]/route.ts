import { z } from 'zod'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { complaintService } from '@/server/services/complaint-service'
import { ApiError } from '@/server/errors'

interface Ctx { params: { id: string } }

/** GET /api/complaints/[id] — full detail bundle (spec §41). */
export const GET = withApi<Ctx>(async (_req, { params }) => {
  const ctx = await requireOrganization()
  const complaint = await complaintService.getComplaintDetail(ctx, params.id)
  return jsonOk({ complaint })
})

/** PATCH /api/complaints/[id] — change priority (admin/supervisor). */
export const PATCH = withApi<Ctx>(async (req, { params }) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'complaints:assign')
  const schema = z.object({ priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), reason: z.string().trim().max(300).optional() })
  const body = await readJson(req, schema)
  const complaint = await complaintService.changePriority(ctx, params.id, body.priority, body.reason)
  return jsonOk({ complaint })
})
