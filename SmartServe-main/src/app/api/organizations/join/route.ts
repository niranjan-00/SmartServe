import { joinOrganizationSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireAuth } from '@/server/authz'
import { joinOrganization } from '@/server/services/organization-service'
import { rateLimit } from '@/server/rate-limit'

/** POST: join an organization using an invitation code (spec §8). */
export const POST = withApi(async (req) => {
  const user = await requireAuth()
  rateLimit(`orgjoin:${user.id}`, 10, 60_000)
  const body = await readJson(req, joinOrganizationSchema)
  const organization = await joinOrganization({ user }, body.code)
  return jsonOk({ organization: { id: organization.id, name: organization.name, slug: organization.slug } })
})
