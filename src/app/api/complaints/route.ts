import { complaintListQuerySchema, createComplaintSchema } from '@/lib/types'
import { withApi, readJson, readQuery, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { complaintService } from '@/server/services/complaint-service'
import { clientIp } from '@/server/rate-limit'
import { ensureBackgroundJobs } from '@/server/jobs'

/**
 * GET /api/complaints — server-side search/filter/sort/pagination (spec §40).
 * Never fetch-everything-then-filter-in-browser.
 */
export const GET = withApi(async (req) => {
  ensureBackgroundJobs()
  const ctx = await requireOrganization()
  const filters = readQuery(req, complaintListQuerySchema)
  const result = await complaintService.listComplaints(ctx, filters)
  return jsonOk(result)
})

/** POST /api/complaints — manual creation from the dashboard. */
export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'complaints:create')
  const body = await readJson(req, createComplaintSchema)
  const complaint = await complaintService.createComplaintFromDashboard(ctx, {
    ...body,
    ipAddress: clientIp(req),
    userAgent: req.headers.get('user-agent') || undefined,
  })
  return jsonOk({ complaint }, { status: 201 })
})
