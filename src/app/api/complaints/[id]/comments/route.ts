import { commentSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { complaintService } from '@/server/services/complaint-service'

interface Ctx { params: { id: string } }

/** Comments (spec §35/§37): internal staff notes, clearly separate from the customer WhatsApp thread. */
export const GET = withApi<Ctx>(async (_req, { params }) => {
  const ctx = await requireOrganization()
  const complaint = await complaintService.getComplaintDetail(ctx, params.id)
  return jsonOk({ comments: complaint.comments })
})

export const POST = withApi<Ctx>(async (req, { params }) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'complaints:comment')
  const body = await readJson(req, commentSchema)
  const comment = await complaintService.addComment(ctx, params.id, body.content, body.visibility)
  return jsonOk({ comment }, { status: 201 })
})
