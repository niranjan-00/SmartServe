import { z } from 'zod'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { complaintService } from '@/server/services/complaint-service'

interface Ctx { params: { id: string } }

/** GET: potential related incidents (duplicate detection, spec §26/§28). */
export const GET = withApi<Ctx>(async (_req, { params }) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'complaints:readAll')
  await complaintService.detectDuplicates(params.id, ctx.organizationId)
  const complaint = await complaintService.getComplaintDetail(ctx, params.id)
  return jsonOk({ related: complaint.relatedComplaints })
})

/** POST: link or dismiss a potential duplicate — never auto-merged. */
export const POST = withApi<Ctx>(async (req, { params }) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'complaints:link')
  const schema = z.object({ matchId: z.string().min(1), action: z.enum(['LINK', 'DISMISS']) })
  const body = await readJson(req, schema)
  const match = await complaintService.setDuplicateMatchStatus(ctx, body.matchId, body.action)
  return jsonOk({ match })
})
