import { z } from 'zod'
import { db } from '@/lib/db'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization } from '@/server/authz'
import { ApiError } from '@/server/errors'

const onboardingSchema = z.object({
  step: z.number().int().min(0).max(7),
})

/**
 * Persistent onboarding state (spec §66). Steps:
 * 1 create org → 2 details → 3 departments → 4 invite staff →
 * 5 connect WhatsApp → 6 configure SLA → 7 complete.
 * Users can leave and continue later — state lives in the database.
 */
export const GET = withApi(async () => {
  const ctx = await requireOrganization()
  const organization = await db.organization.findUnique({
    where: { id: ctx.organizationId },
    select: { onboardingStep: true, name: true, slug: true },
  })
  const [departments, members, whatsapp, slas, categories] = await Promise.all([
    db.department.count({ where: { organizationId: ctx.organizationId } }),
    db.organizationMember.count({ where: { organizationId: ctx.organizationId, status: 'ACTIVE' } }),
    db.whatsAppConnection.findUnique({ where: { organizationId: ctx.organizationId }, select: { status: true } }),
    db.sLA.count({ where: { organizationId: ctx.organizationId } }),
    db.category.count({ where: { organizationId: ctx.organizationId } }),
  ])
  return jsonOk({
    step: organization?.onboardingStep ?? 0,
    progress: {
      departments: departments > 0,
      members: members > 1,
      whatsapp: whatsapp?.status === 'CONNECTED',
      sla: slas > 0,
      categories: categories > 0,
    },
  })
})

export const PATCH = withApi(async (req) => {
  const ctx = await requireOrganization()
  const body = await readJson(req, onboardingSchema)
  if (ctx.role !== 'ORGANIZATION_ADMIN' && ctx.role !== 'SUPER_ADMIN') {
    throw ApiError.forbidden('Only organization admins can update onboarding')
  }
  const organization = await db.organization.update({
    where: { id: ctx.organizationId },
    data: { onboardingStep: body.step },
  })
  return jsonOk({ step: organization.onboardingStep })
})
