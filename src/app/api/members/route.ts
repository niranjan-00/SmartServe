import { z } from 'zod'
import { db } from '@/lib/db'
import { inviteMemberSchema, updateMemberSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { ApiError } from '@/server/errors'
import { inviteMember, listMembers, listPendingInvitations } from '@/server/services/organization-service'
import { recordAudit } from '@/server/audit'
import { emitToOrganization } from '@/server/realtime'
import type { Role } from '@/lib/types'

/** GET: members + pending invitations. */
export const GET = withApi(async () => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'members:read')
  const [members, invitations] = await Promise.all([listMembers(ctx), listPendingInvitations(ctx)])
  return jsonOk({ members, invitations: invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, status: i.status, createdAt: i.createdAt })) })
})

/** POST: invite a member by email (returns the join code — email delivery pluggable). */
export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'members:invite')
  const body = await readJson(req, inviteMemberSchema)
  const invitation = await inviteMember(ctx, body.email, body.role, body.departmentId)
  return jsonOk({
    invitation: {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      code: invitation.token, // shareable join code
      expiresAt: invitation.expiresAt,
    },
  })
})

/** PATCH: change member role/status/department. */
export const PATCH = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'members:manage')
  const schema = updateMemberSchema.extend({ memberId: z.string().min(1) })
  const body = await readJson(req, schema)

  const member = await db.organizationMember.findFirst({
    where: { id: body.memberId, organizationId: ctx.organizationId },
  })
  if (!member) throw ApiError.notFound('Member not found')
  if (body.role && !hasPermission(ctx.role, 'members:manage')) throw ApiError.forbidden()

  // Cannot demote the final organization admin
  if (member.role === 'ORGANIZATION_ADMIN' && body.role && body.role !== 'ORGANIZATION_ADMIN') {
    const admins = await db.organizationMember.count({
      where: { organizationId: ctx.organizationId, role: 'ORGANIZATION_ADMIN', status: 'ACTIVE' },
    })
    if (admins <= 1) throw ApiError.badRequest('Organization must retain at least one admin')
  }

  const updated = await db.organizationMember.update({
    where: { id: member.id },
    data: {
      role: body.role,
      status: body.status,
      departmentId: body.departmentId === undefined ? undefined : body.departmentId,
    },
    include: { user: { select: { id: true, name: true, email: true } } },
  })

  if (body.role && body.role !== member.role) {
    await recordAudit({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      action: 'member.role_changed',
      entityType: 'OrganizationMember',
      entityId: member.id,
      oldValue: { role: member.role },
      newValue: { role: body.role },
    })
  }

  await emitToOrganization(ctx.organizationId, 'member.updated', { memberId: member.id })
  return jsonOk({ member: updated })
})

/** DELETE: remove a member (by ?memberId=). */
export const DELETE = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'members:manage')
  const url = new URL(req.url)
  const memberId = url.searchParams.get('memberId')
  if (!memberId) throw ApiError.badRequest('memberId is required')

  const member = await db.organizationMember.findFirst({
    where: { id: memberId, organizationId: ctx.organizationId },
  })
  if (!member) throw ApiError.notFound('Member not found')
  if (member.role === 'ORGANIZATION_ADMIN') {
    const admins = await db.organizationMember.count({
      where: { organizationId: ctx.organizationId, role: 'ORGANIZATION_ADMIN', status: 'ACTIVE' },
    })
    if (admins <= 1) throw ApiError.badRequest('Organization must retain at least one admin')
  }
  if (member.userId === ctx.user.id) throw ApiError.badRequest('You cannot remove yourself')

  await db.organizationMember.delete({ where: { id: member.id } })
  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'member.removed',
    entityType: 'OrganizationMember',
    entityId: member.id,
    oldValue: { role: member.role as Role },
  })
  return jsonOk({ removed: true })
})
