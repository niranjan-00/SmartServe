import { db } from '@/lib/db'
import { updateOrganizationSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { updateOrganization } from '@/server/services/organization-service'
import { emitToOrganization } from '@/server/realtime'

/** GET current organization + viewer's role. */
export const GET = withApi(async () => {
  const ctx = await requireOrganization()
  const organization = await db.organization.findUnique({
    where: { id: ctx.organizationId },
    select: {
      id: true, name: true, slug: true, logoUrl: true, email: true, phone: true,
      website: true, address: true, industry: true, onboardingStep: true, autoAssignment: true, createdAt: true,
    },
  })
  const memberCount = await db.organizationMember.count({ where: { organizationId: ctx.organizationId, status: 'ACTIVE' } })
  return jsonOk({ organization, role: ctx.role, memberCount })
})

/** PATCH organization details — admin only. */
export const PATCH = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'organization:update')
  const body = await readJson(req, updateOrganizationSchema)
  const organization = await updateOrganization(ctx, body)
  await emitToOrganization(ctx.organizationId, 'organization.updated', { name: organization.name })
  return jsonOk({ organization })
})
