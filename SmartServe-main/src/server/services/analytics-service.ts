import { db } from '@/lib/db'
import { OPEN_STATUSES } from '@/lib/types'
import { computeSlaState } from './sla-service'

/**
 * AnalyticsService (spec §38/§46). Every number is computed from real
 * database records — no hardcoded metrics anywhere.
 */

export interface DashboardOverview {
  complaintsToday: number
  openComplaints: number
  resolvedComplaints: number
  averageResolutionHours: number | null
  slaCompliance: number | null
  customerSatisfaction: number | null
  trend: Array<{ day: string; received: number; resolved: number }>
  categoryDistribution: Array<{ name: string; count: number }>
  priorityDistribution: Array<{ name: string; count: number }>
  departmentStatistics: Array<{ name: string; total: number; open: number; resolved: number }>
  staffWorkload: Array<{ userId: string; name: string; open: number; resolved: number }>
  recentComplaints: Array<Record<string, unknown>>
  liveActivity: Array<Record<string, unknown>>
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function getDashboardOverview(organizationId: string): Promise<DashboardOverview> {
  const now = new Date()
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const weekAgo = new Date(now.getTime() - 6 * 24 * 3600 * 1000)
  weekAgo.setHours(0, 0, 0, 0)

  const [
    complaintsToday,
    openComplaints,
    resolvedComplaints,
    resolvedWithTimes,
    slaCandidates,
    feedbacks,
    weekComplaints,
    categories,
    priorities,
    departments,
    staffWorkload,
    recentComplaints,
    recentAudit,
  ] = await Promise.all([
    db.complaint.count({ where: { organizationId, createdAt: { gte: startOfToday } } }),
    db.complaint.count({ where: { organizationId, status: { in: OPEN_STATUSES } } }),
    db.complaint.count({ where: { organizationId, status: { in: ['RESOLVED', 'CLOSED'] } } }),
    db.complaint.findMany({
      where: { organizationId, status: { in: ['RESOLVED', 'CLOSED'] }, resolvedAt: { not: null }, createdAt: { gte: new Date(now.getTime() - 30 * 24 * 3600 * 1000) } },
      select: { createdAt: true, resolvedAt: true },
      take: 500,
      orderBy: { resolvedAt: 'desc' },
    }),
    db.complaint.findMany({
      where: { organizationId, status: { in: ['RESOLVED', 'CLOSED'] }, resolvedAt: { not: null }, slaDueAt: { not: null } },
      select: { resolvedAt: true, slaDueAt: true },
      take: 500,
      orderBy: { resolvedAt: 'desc' },
    }),
    db.feedback.findMany({ where: { organizationId }, select: { rating: true } }),
    db.complaint.findMany({
      where: { organizationId, createdAt: { gte: weekAgo } },
      select: { createdAt: true, status: true, resolvedAt: true },
    }),
    db.complaint.groupBy({
      by: ['categoryId'],
      where: { organizationId, categoryId: { not: null } },
      _count: { _all: true },
    }),
    db.complaint.groupBy({
      by: ['priority'],
      where: { organizationId },
      _count: { _all: true },
    }),
    db.department.findMany({
      where: { organizationId },
      include: { complaints: { select: { status: true } } },
    }),
    db.complaint.groupBy({
      by: ['assignedTo'],
      where: { organizationId, assignedTo: { not: null } },
      _count: { _all: true },
    }),
    db.complaint.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: {
        customer: { select: { name: true, phoneNumber: true } },
        category: { select: { name: true } },
        department: { select: { name: true } },
        assignee: { select: { name: true } },
      },
    }),
    db.auditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 6,
      include: { user: { select: { name: true } } },
    }),
  ])

  // Average resolution time (hours) over resolved complaints
  const durations = resolvedWithTimes
    .map((c) => (c.resolvedAt ? (c.resolvedAt.getTime() - c.createdAt.getTime()) / 3_600_000 : null))
    .filter((v): v is number => v !== null)
  const averageResolutionHours = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null

  // SLA compliance: resolved within due date / resolved
  const met = slaCandidates.filter((c) => c.resolvedAt && c.slaDueAt && c.resolvedAt <= c.slaDueAt).length
  const slaCompliance = slaCandidates.length > 0 ? (met / slaCandidates.length) * 100 : null

  // Customer satisfaction from real Feedback rows (1-5)
  const customerSatisfaction = feedbacks.length > 0 ? feedbacks.reduce((a, b) => a + b.rating, 0) / feedbacks.length : null

  // 7-day trend
  const trend: Array<{ day: string; received: number; resolved: number }> = []
  for (let i = 6; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 24 * 3600 * 1000)
    const key = dayKey(day)
    const received = weekComplaints.filter((c) => dayKey(c.createdAt) === key).length
    const resolved = weekComplaints.filter((c) => c.resolvedAt && dayKey(c.resolvedAt) === key).length
    trend.push({ day: key, received, resolved })
  }

  // Category distribution with names
  const categoryRows = await db.category.findMany({
    where: { id: { in: categories.map((c) => c.categoryId!).filter(Boolean) } },
    select: { id: true, name: true },
  })
  const categoryDistribution = categories
    .map((c) => ({
      name: categoryRows.find((r) => r.id === c.categoryId)?.name ?? 'Uncategorized',
      count: c._count._all,
    }))
    .sort((a, b) => b.count - a.count)

  const priorityDistribution = priorities.map((p) => ({ name: p.priority, count: p._count._all })).sort((a, b) => b.count - a.count)

  const departmentStatistics = departments
    .map((d) => ({
      name: d.name,
      total: d.complaints.length,
      open: d.complaints.filter((c) => OPEN_STATUSES.includes(c.status as never)).length,
      resolved: d.complaints.filter((c) => c.status === 'RESOLVED' || c.status === 'CLOSED').length,
    }))
    .sort((a, b) => b.total - a.total)

  // Staff workload (operational metrics, not ranking — spec §39)
  const staffUsers = await db.user.findMany({
    where: { id: { in: staffWorkload.map((s) => s.assignedTo!).filter(Boolean) } },
    select: { id: true, name: true },
  })
  const resolvedByStaff = await db.complaint.groupBy({
    by: ['assignedTo'],
    where: { organizationId, assignedTo: { not: null }, status: { in: ['RESOLVED', 'CLOSED'] } },
    _count: { _all: true },
  })
  const staffOpen = await db.complaint.groupBy({
    by: ['assignedTo'],
    where: { organizationId, assignedTo: { not: null }, status: { in: OPEN_STATUSES } },
    _count: { _all: true },
  })
  const staffWorkloadOut = staffUsers.map((u) => ({
    userId: u.id,
    name: u.name,
    open: staffOpen.find((s) => s.assignedTo === u.id)?._count._all ?? 0,
    resolved: resolvedByStaff.find((s) => s.assignedTo === u.id)?._count._all ?? 0,
  }))
  void staffWorkload

  // Activity feed from the real audit log
  const liveActivity = recentAudit.map((a) => ({
    id: a.id,
    action: a.action,
    description: formatActivity(a.action, a.newValue, a.user?.name),
    actor: a.user?.name ?? 'System',
    createdAt: a.createdAt.toISOString(),
  }))

  return {
    complaintsToday,
    openComplaints,
    resolvedComplaints,
    averageResolutionHours,
    slaCompliance,
    customerSatisfaction,
    trend,
    categoryDistribution,
    priorityDistribution,
    departmentStatistics,
    staffWorkload: staffWorkloadOut,
    recentComplaints: recentComplaints.map((c) => ({
      id: c.id,
      ticketNumber: c.ticketNumber,
      title: c.title,
      status: c.status,
      priority: c.priority,
      createdAt: c.createdAt.toISOString(),
      customer: c.customer,
      category: c.category?.name ?? null,
      department: c.department?.name ?? null,
      assignee: c.assignee?.name ?? null,
      slaState: computeSlaState(c),
    })),
    liveActivity,
  }
}

function formatActivity(action: string, newValue: unknown, actor?: string | null): string {
  const nv = (newValue ?? {}) as Record<string, unknown>
  const ticket = typeof nv.ticketNumber === 'string' ? nv.ticketNumber : ''
  switch (action) {
    case 'complaint.created':
      return `New complaint ${ticket || ''} received`.trim()
    case 'complaint.assigned':
      return `Complaint ${ticket || ''} assigned${actor ? ` by ${actor}` : ''}`
    case 'complaint.resolved':
      return `Complaint ${ticket || ''} resolved`
    case 'complaint.status_changed':
      return `Status changed to ${String(nv.status ?? '').replace('_', ' ').toLowerCase()}`
    case 'comment.created':
      return `${actor ?? 'Someone'} added an internal comment`
    case 'sla.updated':
      return 'SLA policy updated'
    case 'whatsapp.connected':
      return 'WhatsApp Business connected'
    case 'ai.retry':
      return 'AI analysis retry queued'
    default:
      return action.replace(/[._]/g, ' ')
  }
}

/** Staff operational metrics (spec §39) — no "best employee" ranking. */
export async function getStaffMetrics(organizationId: string) {
  const members = await db.organizationMember.findMany({
    where: { organizationId, status: 'ACTIVE', role: { in: ['STAFF', 'SUPERVISOR', 'ORGANIZATION_ADMIN'] } },
    include: {
      user: { select: { id: true, name: true, email: true, image: true } },
      department: { select: { name: true } },
    },
  })

  const out = []
  for (const member of members) {
    const [assignedTotal, resolvedTotal, openCount, resolvedRecent, feedbackRows, breachedCount] = await Promise.all([
      db.complaint.count({ where: { organizationId, assignedTo: member.userId } }),
      db.complaint.count({ where: { organizationId, assignedTo: member.userId, status: { in: ['RESOLVED', 'CLOSED'] } } }),
      db.complaint.count({ where: { organizationId, assignedTo: member.userId, status: { in: OPEN_STATUSES } } }),
      db.complaint.findMany({
        where: { organizationId, assignedTo: member.userId, status: { in: ['RESOLVED', 'CLOSED'] }, resolvedAt: { not: null } },
        select: { createdAt: true, resolvedAt: true, slaDueAt: true },
        take: 100,
        orderBy: { resolvedAt: 'desc' },
      }),
      db.feedback.findMany({ where: { organizationId, staffId: member.userId }, select: { rating: true } }),
      db.complaint.count({
        where: { organizationId, assignedTo: member.userId, slaDueAt: { not: null }, resolvedAt: { not: null } },
      }),
    ])

    const durations = resolvedRecent
      .map((c) => (c.resolvedAt ? (c.resolvedAt.getTime() - c.createdAt.getTime()) / 3_600_000 : null))
      .filter((v): v is number => v !== null)
    const withinSla = resolvedRecent.filter((c) => c.resolvedAt && c.slaDueAt && c.resolvedAt <= c.slaDueAt).length

    out.push({
      userId: member.userId,
      name: member.user.name,
      email: member.user.email,
      image: member.user.image,
      role: member.role,
      department: member.department?.name ?? null,
      assigned: assignedTotal,
      resolved: resolvedTotal,
      openTickets: openCount,
      averageResolutionHours: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      slaCompliance: resolvedRecent.length > 0 ? Math.round((withinSla / resolvedRecent.length) * 100) : null,
      customerRating: feedbackRows.length > 0 ? feedbackRows.reduce((a, b) => a + b.rating, 0) / feedbackRows.length : null,
    })
    void breachedCount
  }

  return out
}
