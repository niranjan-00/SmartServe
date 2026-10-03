import { db } from '@/lib/db'
import { createOrganizationSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireAuth, requireOrganization } from '@/server/authz'
import { createOrganization } from '@/server/services/organization-service'
import { rateLimit, clientIp } from '@/server/rate-limit'

/** GET: organizations the current user belongs to. */
export const GET = withApi(async () => {
  const user = await requireAuth()
  const memberships = await db.organizationMember.findMany({
    where: { userId: user.id, status: 'ACTIVE' },
    include: { organization: { select: { id: true, name: true, slug: true, logoUrl: true, industry: true, onboardingStep: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return jsonOk({ organizations: memberships.map((m) => m.organization), role: memberships[0]?.role ?? null })
})

/** POST: create a new organization (creator becomes ORGANIZATION_ADMIN). */
export const POST = withApi(async (req) => {
  const user = await requireAuth()
  rateLimit(`orgcreate:${user.id}`, 5, 60_000)
  const body = await readJson(req, createOrganizationSchema)
  const organization = await createOrganization({ user }, {
    name: body.name,
    industry: body.industry,
    ipAddress: clientIp(req),
    userAgent: req.headers.get('user-agent') || undefined,
  })
  return jsonOk({ organization })
})

/** Convenience for layout: current active organization context. */
export const PUT = withApi(async () => {
  const ctx = await requireOrganization()
  const organization = await db.organization.findUnique({
    where: { id: ctx.organizationId },
    select: {
      id: true, name: true, slug: true, logoUrl: true, email: true, phone: true,
      website: true, address: true, industry: true, onboardingStep: true, autoAssignment: true, createdAt: true,
    },
  })
  return jsonOk({ organization, role: ctx.role, member: { id: ctx.memberId, departmentId: ctx.departmentId } })
})
