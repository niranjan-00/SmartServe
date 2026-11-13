import { withApi, jsonOk } from '@/server/api'
import { requireOrganization } from '@/server/authz'
import { complaintService } from '@/server/services/complaint-service'

interface Ctx { params: { id: string } }

/**
 * GET /api/complaints/[id]/suggestion — AI suggested resolution, generated
 * when staff opens the complaint (spec §25/§27). Clearly labelled as
 * AI-generated on the UI; staff can ignore it.
 */
export const GET = withApi<Ctx>(async (_req, { params }) => {
  const ctx = await requireOrganization()
  const suggestion = await complaintService.getOrCreateSuggestion(ctx, params.id)
  return jsonOk({ suggestion, aiGenerated: true })
})
