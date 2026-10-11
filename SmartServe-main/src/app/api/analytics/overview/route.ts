import { withApi, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { getDashboardOverview } from '@/server/services/analytics-service'
import { ensureBackgroundJobs } from '@/server/jobs'

/** Dashboard bundle — every metric computed from the database (spec §39). */
export const GET = withApi(async () => {
  ensureBackgroundJobs()
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'analytics:read')
  const overview = await getDashboardOverview(ctx.organizationId)
  return jsonOk(overview)
})
