
import { db } from '@/lib/db'
import { ApiError } from '@/server/errors'
import { recordAudit } from '@/server/audit'
import { randomToken } from '@/server/crypto'
import { DEFAULT_SLA } from './sla-service'
import type { AuthContext } from '@/server/authz'

/**
 * OrganizationService
 *
 * Handles:
 * - Organization creation and updates
 * - Organization membership
 * - Staff invitations
 * - Invitation acceptance
 * - Member and invitation listing
 */

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48)
}

const INVITATION_EXPIRY_DAYS = 7

const ALLOWED_INVITATION_ROLES = [
  'ORGANIZATION_ADMIN',
  'SUPERVISOR',
  'STAFF',
  'VIEWER',
] as const

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// ============================================================
// CREATE ORGANIZATION
// ============================================================

export async function createOrganization(
  ctx: { user: { id: string; name?: string | null } },
  input: {
    name: string
    industry?: string
    ipAddress?: string
    userAgent?: string
  }
) {
  let slug = slugify(input.name) || 'org'
  let suffix = 0

  // Generate a unique organization slug.
  for (;;) {
    const candidate = suffix === 0 ? slug : `${slug}-${suffix}`

    const taken = await db.organization.findUnique({
      where: { slug: candidate },
      select: { id: true },
    })

    if (!taken) {
      slug = candidate
      break
    }

    suffix++

    if (suffix > 50) {
      throw ApiError.conflict(
        'Could not generate a unique organization slug'
      )
    }
  }

  const organization = await db.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: input.name,
        slug,
        industry: input.industry,
        onboardingStep: 1,
      },
    })

    await tx.organizationMember.create({
      data: {
        organizationId: org.id,
        userId: ctx.user.id,
        role: 'ORGANIZATION_ADMIN',
        status: 'ACTIVE',
      },
    })

    // Provision default SLA policies.
    await tx.sLA.createMany({
      data: (
        Object.keys(DEFAULT_SLA) as Array<keyof typeof DEFAULT_SLA>
      ).map((priority) => ({
        organizationId: org.id,
        priority,
        firstResponseMinutes:
          DEFAULT_SLA[priority].firstResponseMinutes,
        resolutionMinutes:
          DEFAULT_SLA[priority].resolutionMinutes,
        escalationMinutes:
          DEFAULT_SLA[priority].escalationMinutes,
        enabled: true,
      })),
    })

    return org
  })

  await recordAudit({
    organizationId: organization.id,
    userId: ctx.user.id,
    action: 'organization.created',
    entityType: 'Organization',
    entityId: organization.id,
    newValue: {
      name: organization.name,
      slug,
    },
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  })

  return organization
}

// ============================================================
// UPDATE ORGANIZATION
// ============================================================

export async function updateOrganization(
  ctx: AuthContext,
  input: Record<string, unknown>
) {
  const org = await db.organization.update({
    where: { id: ctx.organizationId },
    data: input as never,
  })

  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'organization.updated',
    entityType: 'Organization',
    entityId: ctx.organizationId,
    newValue: input,
  })

  return org
}

// ============================================================
// ACCEPT ORGANIZATION INVITATION
// ============================================================

/**
 * Join an organization using an invitation token.
 *
 * Security:
 * - Requires an authenticated user.
 * - Checks the actual database email.
 * - Checks invitation status and expiration.
 * - Prevents duplicate acceptance.
 * - Performs membership creation and invitation
 *   consumption in one transaction.
 */

export async function joinOrganization(
  ctx: {
    user: {
      id: string
      email?: string | null
    }
  },
  code: string
) {
  const token = code.trim()

  if (!token) {
    throw ApiError.badRequest('Invitation token is required')
  }

  // Verify the authenticated user against the database.
  const user = await db.user.findUnique({
    where: { id: ctx.user.id },
    select: {
      id: true,
      email: true,
    },
  })

  if (!user?.email) {
    throw ApiError.forbidden(
      'Your account must have a valid email address'
    )
  }

  const userEmail = normalizeEmail(user.email)

  const invitation = await db.invitation.findUnique({
    where: { token },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  })

  if (!invitation) {
    throw ApiError.badRequest(
      'This invitation is invalid'
    )
  }

  if (invitation.status !== 'PENDING') {
    throw ApiError.badRequest(
      'This invitation has already been used or revoked'
    )
  }

  if (
    invitation.expiresAt &&
    invitation.expiresAt.getTime() <= Date.now()
  ) {
    throw ApiError.badRequest(
      'This invitation has expired. Ask your administrator for a new invitation.'
    )
  }

  // Only the invited email address can accept.
  if (userEmail !== normalizeEmail(invitation.email)) {
    throw ApiError.forbidden(
      'This invitation was issued for a different email address. Sign in using the invited email.'
    )
  }

  if (!ALLOWED_INVITATION_ROLES.includes(
    invitation.role as (typeof ALLOWED_INVITATION_ROLES)[number]
  )) {
    throw ApiError.badRequest(
      'This invitation contains an invalid role'
    )
  }

  // Ensure the assigned department still exists in this organization.
  if (invitation.departmentId) {
    const department = await db.department.findFirst({
      where: {
        id: invitation.departmentId,
        organizationId: invitation.organizationId,
      },
      select: { id: true },
    })

    if (!department) {
      throw ApiError.badRequest(
        'The department assigned to this invitation no longer exists'
      )
    }
  }

  // Atomic acceptance: only one request can consume the invitation.
  await db.$transaction(async (tx) => {
    const currentInvitation = await tx.invitation.findUnique({
      where: { id: invitation.id },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        token: true,
      },
    })

    if (
      !currentInvitation ||
      currentInvitation.status !== 'PENDING' ||
      currentInvitation.token !== token
    ) {
      throw ApiError.conflict(
        'This invitation has already been accepted or revoked'
      )
    }

    if (
      currentInvitation.expiresAt &&
      currentInvitation.expiresAt.getTime() <= Date.now()
    ) {
      throw ApiError.badRequest(
        'This invitation has expired'
      )
    }

    // Consume the invitation conditionally.
    // This protects against concurrent acceptance requests.
    const consumed = await tx.invitation.updateMany({
      where: {
        id: invitation.id,
        token,
        status: 'PENDING',
      },
      data: {
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      },
    })

    if (consumed.count !== 1) {
      throw ApiError.conflict(
        'This invitation has already been accepted'
      )
    }

    const existingMembership =
      await tx.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: invitation.organizationId,
            userId: user.id,
          },
        },
      })

    if (existingMembership?.status === 'ACTIVE') {
      throw ApiError.conflict(
        'You are already a member of this organization'
      )
    }

    // Create or reactivate membership.
    await tx.organizationMember.upsert({
      where: {
        organizationId_userId: {
          organizationId: invitation.organizationId,
          userId: user.id,
        },
      },
      create: {
        organizationId: invitation.organizationId,
        userId: user.id,
        role: invitation.role,
        status: 'ACTIVE',
        departmentId: invitation.departmentId,
      },
      update: {
        role: invitation.role,
        status: 'ACTIVE',
        departmentId: invitation.departmentId,
      },
    })
  })

  await recordAudit({
    organizationId: invitation.organizationId,
    userId: user.id,
    action: 'organization.joined',
    entityType: 'Organization',
    entityId: invitation.organizationId,
    newValue: {
      role: invitation.role,
      departmentId: invitation.departmentId,
    },
  })

  return invitation.organization
}

// ============================================================
// INVITE STAFF / MEMBER
// ============================================================

/**
 * Create or renew an organization invitation.
 *
 * Existing pending invitations are renewed with a new token.
 */

export async function inviteMember(
  ctx: AuthContext,
  email: string,
  role: string,
  departmentId?: string
) {
  const normalizedEmail = normalizeEmail(email)

  if (!normalizedEmail) {
    throw ApiError.badRequest('Email address is required')
  }

  if (
    !ALLOWED_INVITATION_ROLES.includes(
      role as (typeof ALLOWED_INVITATION_ROLES)[number]
    )
  ) {
    throw ApiError.badRequest('Invalid invitation role')
  }

  // Verify department ownership.
  if (departmentId) {
    const department = await db.department.findFirst({
      where: {
        id: departmentId,
        organizationId: ctx.organizationId,
      },
      select: { id: true },
    })

    if (!department) {
      throw ApiError.badRequest(
        'The selected department does not belong to this organization'
      )
    }
  }

  // Prevent inviting an existing active member.
  const existingUser = await db.user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      memberships: {
        where: {
          organizationId: ctx.organizationId,
          status: 'ACTIVE',
        },
        select: { id: true },
      },
    },
  })

  if (existingUser?.memberships.length) {
    throw ApiError.conflict(
      'This user is already an active member of your organization'
    )
  }

  const token = randomToken(32)

  const expiresAt = new Date(
    Date.now() +
      INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000
  )

  const invitation = await db.invitation.upsert({
    where: {
      organizationId_email: {
        organizationId: ctx.organizationId,
        email: normalizedEmail,
      },
    },
    create: {
      organizationId: ctx.organizationId,
      email: normalizedEmail,
      role,
      departmentId: departmentId ?? null,
      token,
      status: 'PENDING',
      invitedBy: ctx.user.id,
      expiresAt,
      acceptedAt: null,
    },
    update: {
      role,
      departmentId: departmentId ?? null,
      token,
      status: 'PENDING',
      invitedBy: ctx.user.id,
      expiresAt,
      acceptedAt: null,
    },
  })

  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'member.invited',
    entityType: 'Invitation',
    entityId: invitation.id,
    newValue: {
      email: normalizedEmail,
      role,
      departmentId: departmentId ?? null,
      expiresAt,
    },
  })

  return invitation
}

// ============================================================
// LIST ORGANIZATION MEMBERS
// ============================================================

export async function listMembers(ctx: AuthContext) {
  return db.organizationMember.findMany({
    where: {
      organizationId: ctx.organizationId,
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
    orderBy: {
      createdAt: 'asc',
    },
  })
}

// ============================================================
// LIST PENDING INVITATIONS
// ============================================================

export async function listPendingInvitations(ctx: AuthContext) {
  const invitations = await db.invitation.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: 'PENDING',
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  // Reflect expired invitations in their actual status.
  const now = new Date()

  const expiredIds = invitations
    .filter(
      (invitation) =>
        invitation.expiresAt &&
        invitation.expiresAt.getTime() <= now.getTime()
    )
    .map((invitation) => invitation.id)

  if (expiredIds.length > 0) {
    await db.invitation.updateMany({
      where: {
        id: { in: expiredIds },
        status: 'PENDING',
      },
      data: {
        status: 'EXPIRED',
      },
    })
  }

  return invitations.filter(
    (invitation) =>
      !invitation.expiresAt ||
      invitation.expiresAt.getTime() > now.getTime()
  )
}
