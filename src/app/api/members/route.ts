
import { z } from 'zod'
import { db } from '@/lib/db'
import { inviteMemberSchema, updateMemberSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { ApiError } from '@/server/errors'
import {
  inviteMember,
  listMembers,
  listPendingInvitations,
} from '@/server/services/organization-service'
import { recordAudit } from '@/server/audit'
import { emitToOrganization } from '@/server/realtime'
import type { Role } from '@/lib/types'

/**
 * GET: List organization members and pending invitations.
 */
export const GET = withApi(async () => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'members:read')

  const [members, invitations] = await Promise.all([
    listMembers(ctx),
    listPendingInvitations(ctx),
  ])

  return jsonOk({
    members,
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      createdAt: invitation.createdAt,
    })),
  })
})

/**
 * POST: Invite a new member.
 * Returns a shareable invitation code.
 */
export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'members:invite')

  const body = await readJson(req, inviteMemberSchema)

  // Validate department ownership before creating the invitation.
  if (body.departmentId) {
    const department = await db.department.findFirst({
      where: {
        id: body.departmentId,
        organizationId: ctx.organizationId,
      },
      select: { id: true },
    })

    if (!department) {
      throw ApiError.badRequest(
        'Selected department does not belong to this organization',
      )
    }
  }

  const invitation = await inviteMember(
    ctx,
    body.email,
    body.role,
    body.departmentId,
  )

  await emitToOrganization(ctx.organizationId, 'member.updated', {
    invitationId: invitation.id,
  })

  return jsonOk({
    invitation: {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      code: invitation.token,
      expiresAt: invitation.expiresAt,
    },
  })
})

/**
 * PATCH: Update member role, status, or department.
 */
export const PATCH = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'members:manage')

  const schema = updateMemberSchema.extend({
    memberId: z.string().min(1),
  })

  const body = await readJson(req, schema)

  if (
    body.role === undefined &&
    body.status === undefined &&
    body.departmentId === undefined
  ) {
    throw ApiError.badRequest('At least one field must be provided')
  }

  const member = await db.organizationMember.findFirst({
    where: {
      id: body.memberId,
      organizationId: ctx.organizationId,
    },
  })

  if (!member) {
    throw ApiError.notFound('Member not found')
  }

  // Organization admins cannot manage Super Admin accounts.
  if (
    member.role === 'SUPER_ADMIN' &&
    ctx.role !== 'SUPER_ADMIN'
  ) {
    throw ApiError.forbidden()
  }

  // Only Super Admins can assign the Super Admin role.
  if (
    body.role === 'SUPER_ADMIN' &&
    ctx.role !== 'SUPER_ADMIN'
  ) {
    throw ApiError.forbidden()
  }

  // Prevent changing your own role or suspending your own account.
  if (
    member.userId === ctx.user.id &&
    (
      body.role !== undefined ||
      body.status === 'SUSPENDED'
    )
  ) {
    throw ApiError.badRequest(
      'You cannot change your own role or suspend your own account',
    )
  }

  // Validate department ownership.
  if (body.departmentId) {
    const department = await db.department.findFirst({
      where: {
        id: body.departmentId,
        organizationId: ctx.organizationId,
      },
      select: { id: true },
    })

    if (!department) {
      throw ApiError.badRequest(
        'Selected department does not belong to this organization',
      )
    }
  }

  // Protect the last active organization admin.
  const losingAdminAccess =
    member.role === 'ORGANIZATION_ADMIN' &&
    member.status === 'ACTIVE' &&
    (
      (
        body.role !== undefined &&
        body.role !== 'ORGANIZATION_ADMIN'
      ) ||
      body.status === 'SUSPENDED'
    )

  if (losingAdminAccess) {
    const activeAdmins = await db.organizationMember.count({
      where: {
        organizationId: ctx.organizationId,
        role: 'ORGANIZATION_ADMIN',
        status: 'ACTIVE',
      },
    })

    if (activeAdmins <= 1) {
      throw ApiError.badRequest(
        'Organization must retain at least one active admin',
      )
    }
  }

  const updated = await db.organizationMember.update({
    where: {
      id: member.id,
    },
    data: {
      role: body.role,
      status: body.status,
      departmentId:
        body.departmentId === undefined
          ? undefined
          : body.departmentId,
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
      department: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  })

  // Record role changes in the audit log.
  if (
    body.role !== undefined &&
    body.role !== member.role
  ) {
    await recordAudit({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      action: 'member.role_changed',
      entityType: 'OrganizationMember',
      entityId: member.id,
      oldValue: {
        role: member.role,
      },
      newValue: {
        role: body.role,
      },
    })
  }

  await emitToOrganization(ctx.organizationId, 'member.updated', {
    memberId: member.id,
  })

  return jsonOk({
    member: updated,
  })
})

/**
 * DELETE: Remove a member using ?memberId=...
 */
export const DELETE = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'members:manage')

  const url = new URL(req.url)
  const memberId = url.searchParams.get('memberId')

  if (!memberId) {
    throw ApiError.badRequest('memberId is required')
  }

  const member = await db.organizationMember.findFirst({
    where: {
      id: memberId,
      organizationId: ctx.organizationId,
    },
  })

  if (!member) {
    throw ApiError.notFound('Member not found')
  }

  // Prevent removing your own account.
  if (member.userId === ctx.user.id) {
    throw ApiError.badRequest('You cannot remove yourself')
  }

  // Organization admins cannot remove Super Admin accounts.
  if (
    member.role === 'SUPER_ADMIN' &&
    ctx.role !== 'SUPER_ADMIN'
  ) {
    throw ApiError.forbidden()
  }

  // Protect the last active organization admin.
  if (
    member.role === 'ORGANIZATION_ADMIN' &&
    member.status === 'ACTIVE'
  ) {
    const activeAdmins = await db.organizationMember.count({
      where: {
        organizationId: ctx.organizationId,
        role: 'ORGANIZATION_ADMIN',
        status: 'ACTIVE',
      },
    })

    if (activeAdmins <= 1) {
      throw ApiError.badRequest(
        'Organization must retain at least one active admin',
      )
    }
  }

  await db.organizationMember.delete({
    where: {
      id: member.id,
    },
  })

  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'member.removed',
    entityType: 'OrganizationMember',
    entityId: member.id,
    oldValue: {
      role: member.role as Role,
    },
  })

  await emitToOrganization(ctx.organizationId, 'member.updated', {
    memberId: member.id,
    removed: true,
  })

  return jsonOk({
    removed: true,
  })
})
