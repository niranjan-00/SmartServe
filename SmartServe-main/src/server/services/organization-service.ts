import { db } from '@/lib/db'
import { ApiError } from '@/server/errors'
import { recordAudit } from '@/server/audit'
import { randomToken } from '@/server/crypto'
import { DEFAULT_SLA } from './sla-service'
import type { AuthContext } from '@/server/authz'

/**
 * OrganizationService (spec §7/§13/§55/§66). Creating an organization
 * provisions default SLA policies and seeds the starter taxonomy templates
 * (departments/categories stay empty until the admin configures them — no
 * demo data is ever inserted, per product decision).
 */

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48)
}

export async function createOrganization(ctx: { user: { id: string; name?: string | null } }, input: {
  name: string
  industry?: string
  ipAddress?: string
  userAgent?: string
}) {
  // Users without an organization create one; users already owning one cannot
  const existingMembership = await db.organizationMember.findFirst({
    where: { userId: ctx.user.id, role: 'ORGANIZATION_ADMIN', status: 'ACTIVE' },
  })

  let slug = slugify(input.name) || 'org'
  let suffix = 0
  // Ensure unique slug
  for (;;) {
    const taken = await db.organization.findUnique({ where: { slug: suffix === 0 ? slug : `${slug}-${suffix}` } })
    if (!taken) break
    suffix++
    if (suffix > 50) throw ApiError.conflict('Could not generate a unique organization slug')
  }
  if (suffix > 0) slug = `${slug}-${suffix}`

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
    // Default SLA policies per priority (spec §30)
    await tx.sLA.createMany({
      data: (Object.keys(DEFAULT_SLA) as Array<keyof typeof DEFAULT_SLA>).map((priority) => ({
        organizationId: org.id,
        priority,
        firstResponseMinutes: DEFAULT_SLA[priority].firstResponseMinutes,
        resolutionMinutes: DEFAULT_SLA[priority].resolutionMinutes,
        escalationMinutes: DEFAULT_SLA[priority].escalationMinutes,
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
    newValue: { name: organization.name, slug },
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  })

  void existingMembership
  return organization
}

export async function updateOrganization(ctx: AuthContext, input: Record<string, unknown>) {
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

/** Join via invitation code (spec §8: create OR join). */
export async function joinOrganization(ctx: { user: { id: string; email?: string | null } }, code: string) {
  const invitation = await db.invitation.findUnique({
    where: { token: code },
    include: { organization: { select: { id: true, name: true } } },
  })
  if (!invitation || invitation.status !== 'PENDING') {
    throw ApiError.badRequest('This invitation code is invalid or has been used')
  }
  if (invitation.expiresAt && invitation.expiresAt < new Date()) {
    throw ApiError.badRequest('This invitation has expired')
  }
  // Only the invited email may accept
  if (ctx.user.email?.toLowerCase() !== invitation.email.toLowerCase()) {
    throw ApiError.forbidden('This invitation was issued for a different email address')
  }

  const existing = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: invitation.organizationId, userId: ctx.user.id } },
  })
  if (existing) {
    if (existing.status === 'ACTIVE') throw ApiError.conflict('You are already a member of this organization')
  }

  await db.$transaction(async (tx) => {
    await tx.organizationMember.upsert({
      where: { organizationId_userId: { organizationId: invitation.organizationId, userId: ctx.user.id } },
      create: {
        organizationId: invitation.organizationId,
        userId: ctx.user.id,
        role: invitation.role,
        status: 'ACTIVE',
        departmentId: invitation.departmentId,
      },
      update: { status: 'ACTIVE', role: invitation.role },
    })
    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    })
  })

  await recordAudit({
    organizationId: invitation.organizationId,
    userId: ctx.user.id,
    action: 'organization.joined',
    entityType: 'Organization',
    entityId: invitation.organizationId,
    newValue: { role: invitation.role },
  })

  return invitation.organization
}

export async function inviteMember(ctx: AuthContext, email: string, role: string, departmentId?: string) {
  const token = randomToken(18)
  const invitation = await db.invitation.upsert({
    where: { organizationId_email: { organizationId: ctx.organizationId, email } },
    create: {
      organizationId: ctx.organizationId,
      email,
      role,
      departmentId,
      token,
      invitedBy: ctx.user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    },
    update: {
      role,
      departmentId,
      token,
      status: 'PENDING',
      invitedBy: ctx.user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    },
  })

  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'member.invited',
    entityType: 'Invitation',
    entityId: invitation.id,
    newValue: { email, role },
  })

  // Email provider is pluggable (spec: Resend/SMTP) — the invitation code is
  // returned so admins can share it manually when no email provider is configured.
  return invitation
}

export async function listMembers(ctx: AuthContext) {
  return db.organizationMember.findMany({
    where: { organizationId: ctx.organizationId },
    include: {
      user: { select: { id: true, name: true, email: true, image: true } },
      department: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
}

export async function listPendingInvitations(ctx: AuthContext) {
  return db.invitation.findMany({
    where: { organizationId: ctx.organizationId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  })
}
