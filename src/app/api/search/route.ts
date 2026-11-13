import { z } from 'zod'
import { withApi, jsonOk } from '@/server/api'
import { requireOrganization } from '@/server/authz'
import { globalSearch } from '@/server/services/search-service'
import { rateLimit } from '@/server/rate-limit'

/** Global search — org-scoped + role-aware (spec §40/§47). */
export const GET = withApi(async (req) => {
  const ctx = await requireOrganization()
  rateLimit(`search:${ctx.user.id}`, 60, 60_000)
  const q = z.string().trim().max(120).safeParse(new URL(req.url).searchParams.get('q') ?? '')
  if (!q.success) return jsonOk({ complaints: [], customers: [], departments: [], staff: [] })
  const results = await globalSearch(ctx, q.data)
  return jsonOk(results)
})
