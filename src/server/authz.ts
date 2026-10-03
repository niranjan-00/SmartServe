import { db } from '@/lib/db'
import type { Role } from '@/lib/types'
import { getSessionUser, type SessionUser } from '@/server/auth'
import { ApiError } from '@/server/errors'

/**
 * Server-side authorization layer (spec §9/§11).
 * Every organization-scoped query MUST go through these guards so tenant
 * isolation is enforced in the backend, never in the UI.
 */

export interface AuthContext {
  user: SessionUser
  organizationId: string
  role: Role
  memberId: string
  departmentId: string | null
}

export async function requireAuth(): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) throw ApiError.unauthorized()
  return user
}

/** Authenticated user + their ACTIVE membership in the current organization. */
export async function requireOrganization(context?: { organizationId?: string }): Promise<AuthContext> {
  const user = await requireAuth()

  const membership = await db.organizationMember.findFirst({
    where: {
      userId: user.id,
      status: 'ACTIVE',
      ...(context?.organizationId ? { organizationId: context.organizationId } : {}),
    },
    orderBy: { createdAt: 'asc' },
  })

  if (!membership) {
    throw new ApiError(403, 'NO_ORGANIZATION', 'You are not a member of an organization yet')
  }

  return {
    user,
    organizationId: membership.organizationId,
    role: membership.role as Role,
    memberId: membership.id,
    departmentId: membership.departmentId,
  }
}

export async function requireRole(context: AuthContext, ...roles: Role[]): Promise<AuthContext> {
  if (!roles.includes(context.role) && context.role !== 'SUPER_ADMIN') {
    throw ApiError.forbidden()
  }
  return context
}

export async function requireOrganizationRole(context: { organizationId?: string }, ...roles: Role[]): Promise<AuthContext> {
  const ctx = await requireOrganization(context)
  return requireRole(ctx, ...roles)
}

/** Role capability matrix (spec §9) — enforced server-side for every mutation. */
export const PERMISSIONS = {
  'organization:update': ['ORGANIZATION_ADMIN', 'SUPER_ADMIN'],
  'members:read': ['ORGANIZATION_ADMIN', 'SUPERVISOR', 'SUPER_ADMIN'],
  'members:invite': ['ORGANIZATION_ADMIN', 'SUPER_ADMIN'],
  'members:manage': ['ORGANIZATION_ADMIN', 'SUPER_ADMIN'],
  'departments:manage': ['ORGANIZATION_ADMIN', 'SUPER_ADMIN'],
  'locations:manage': ['ORGANIZATION_ADMIN', 'SUPERVISOR', 'SUPER_ADMIN'],
  'categories:manage': ['ORGANIZATION_ADMIN', 'SUPER_ADMIN'],
  'sla:manage': ['ORGANIZATION_ADMIN', 'SUPER_ADMIN'],
  'whatsapp:manage': ['ORGANIZATION_ADMIN', 'SUPER_ADMIN'],
  'complaints:readAll': ['ORGANIZATION_ADMIN', 'SUPERVISOR', 'VIEWER', 'SUPER_ADMIN'],
  'complaints:create': ['ORGANIZATION_ADMIN', 'SUPERVISOR', 'STAFF', 'SUPER_ADMIN'],
  'complaints:assign': ['ORGANIZATION_ADMIN', 'SUPERVISOR', 'SUPER_ADMIN'],
  'complaints:comment': ['ORGANIZATION_ADMIN', 'SUPERVISOR', 'STAFF', 'SUPER_ADMIN'],
  'complaints:attach': ['ORGANIZATION_ADMIN', 'SUPERVISOR', 'STAFF', 'SUPER_ADMIN'],
  'complaints:link': ['ORGANIZATION_ADMIN', 'SUPERVISOR', 'SUPER_ADMIN'],
  'analytics:read': ['ORGANIZATION_ADMIN', 'SUPERVISOR', 'VIEWER', 'SUPER_ADMIN'],
  'audit:read': ['ORGANIZATION_ADMIN', 'SUPER_ADMIN'],
  'staff:read': ['ORGANIZATION_ADMIN', 'SUPERVISOR', 'VIEWER', 'SUPER_ADMIN'],
} as const

export type Permission = keyof typeof PERMISSIONS

export function hasPermission(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly string[]).includes(role)
}

export async function requirePermission(context: AuthContext, permission: Permission): Promise<AuthContext> {
  if (!hasPermission(context.role, permission)) {
    throw ApiError.forbidden()
  }
  return context
}

/**
 * Complaint access rule (spec §9):
 *  - Admin/Supervisor/Viewer: all organization complaints
 *  - Staff: only complaints assigned to them
 *  Returns the prisma `where` guard to AND into every complaint query.
 */
export function complaintAccessGuard(ctx: AuthContext): Record<string, unknown> {
  if (ctx.role === 'STAFF') {
    return { assignedTo: ctx.user.id }
  }
  return {}
}

export { getSessionUser }
