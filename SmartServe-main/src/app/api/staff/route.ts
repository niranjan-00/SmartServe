import { withApi, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { getStaffMetrics } from '@/server/services/analytics-service'

/** Staff operational metrics (spec §39/§43) — assigned/resolved/avg/SLA/rating. */
export const GET = withApi(async () => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'staff:read')
  const staff = await getStaffMetrics(ctx.organizationId)
  return jsonOk({ staff })
})
