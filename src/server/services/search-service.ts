import { db } from '@/lib/db'
import { OPEN_STATUSES } from '@/lib/types'
import type { AuthContext } from '@/server/authz'

/**
 * Global search (spec §40/§47) — ticket number, customer, phone, complaint
 * title/description, department, staff. Always organization-scoped; staff
 * see only their assigned tickets.
 */

export async function globalSearch(ctx: AuthContext, query: string, limit = 8) {
  const q = query.trim()
  if (q.length < 2) return { complaints: [], customers: [], departments: [], staff: [] }

  const staffOnly = ctx.role === 'STAFF' ? { assignedTo: ctx.user.id } : {}
  const contains = { contains: q }

  const [complaints, customers, departments, staff] = await Promise.all([
    db.complaint.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...staffOnly,
        OR: [
          { ticketNumber: contains },
          { title: contains },
          { description: contains },
          { customer: { is: { OR: [{ name: contains }, { phoneNumber: contains }] } } },
          { department: { is: { name: contains } } },
          { assignee: { is: { name: contains } } },
        ],
      },
      select: {
        id: true,
        ticketNumber: true,
        title: true,
        status: true,
        priority: true,
        createdAt: true,
        customer: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    db.customer.findMany({
      where: {
        organizationId: ctx.organizationId,
        OR: [{ name: contains }, { phoneNumber: contains }],
      },
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        _count: { select: { complaints: { where: { status: { in: OPEN_STATUSES } } } } },
      },
      take: limit,
    }),
    db.department.findMany({
      where: { organizationId: ctx.organizationId, name: contains },
      select: { id: true, name: true, _count: { select: { complaints: true } } },
      take: 5,
    }),
    (async () => {
      if (ctx.role === 'STAFF' || ctx.role === 'VIEWER') return []
      const members = await db.organizationMember.findMany({
        where: {
          organizationId: ctx.organizationId,
          status: 'ACTIVE',
          user: { OR: [{ name: contains }, { email: contains }] },
        },
        select: { user: { select: { id: true, name: true, email: true } }, role: true },
        take: 5,
      })
      return members.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role }))
    })(),
  ])

  return { complaints, customers, departments, staff }
}
