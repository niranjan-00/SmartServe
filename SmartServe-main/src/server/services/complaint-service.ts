import { db } from '@/lib/db'
import {
  STATUS_TRANSITIONS,
  OPEN_STATUSES,
  isComplaintStatus,
  isPriority,
  PRIORITY_RANK,
  type ComplaintStatus,
  type Priority,
} from '@/lib/types'
import { ApiError } from '@/server/errors'
import { recordAudit } from '@/server/audit'
import { emitToOrganization } from '@/server/realtime'
import { createLogger } from '@/server/logger'
import { computeSlaDueAt, getSlaPolicies, computeSlaState } from './sla-service'
import { classifyComplaint, suggestResolution } from './ai'
import type { AuthContext } from '@/server/authz'

const log = createLogger('complaint')

/**
 * ComplaintService (spec §19-23, §40-41, §55, §57-58).
 * All state transitions are validated server-side; every mutation writes
 * history rows and audit logs; ticket numbers are generated inside the
 * creation transaction (concurrency-safe).
 */

// ---------------------------------------------------------------------------
// Ticket numbers — SS-10001, SS-10002 ... (global monotonic counter)
// ---------------------------------------------------------------------------

export async function nextTicketNumber(tx: {
  $transaction: unknown
  ticketCounter: {
    update: (args: { where: { id: string }; data: { value: { increment: number } } }) => Promise<{ value: number }>
    upsert: (args: Record<string, unknown>) => Promise<{ value: number }>
  }
}): Promise<string> {
  // Atomic increment (SQLite serializes writes; Postgres row-locks the row)
  const counter = await tx.ticketCounter.upsert({
    where: { id: 'GLOBAL' },
    update: { value: { increment: 1 } },
    create: { id: 'GLOBAL', value: 10001 },
  })
  return `SS-${counter.value}`
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

interface CreateComplaintCore {
  organizationId: string
  customerId: string
  conversationId?: string | null
  title?: string
  description?: string
  categoryId?: string | null
  departmentId?: string | null
  locationId?: string | null
  priority?: Priority
  source?: 'WHATSAPP' | 'DASHBOARD'
  actorUserId?: string | null
  ipAddress?: string
  userAgent?: string
}

async function createComplaintInternal(core: CreateComplaintCore) {
  // SLA policy for the effective priority
  const priority = core.priority ?? 'MEDIUM'
  const policies = await getSlaPolicies(core.organizationId)
  const policy = policies[priority]
  const createdAt = new Date()
  const slaDueAt = computeSlaDueAt(createdAt, policy)

  // Resolve taxonomy names for AI context
  const [orgCategories, orgDepartments, orgLocations] = await Promise.all([
    db.category.findMany({ where: { organizationId: core.organizationId, status: 'ACTIVE' }, select: { name: true } }),
    db.department.findMany({ where: { organizationId: core.organizationId }, select: { name: true } }),
    db.location.findMany({ where: { organizationId: core.organizationId }, select: { name: true } }),
  ])

  const complaint = await db.$transaction(async (tx) => {
    const ticketNumber = await nextTicketNumber(tx as never)
    return tx.complaint.create({
      data: {
        ticketNumber,
        organizationId: core.organizationId,
        customerId: core.customerId,
        conversationId: core.conversationId ?? null,
        title: core.title ?? 'Untitled complaint',
        description: core.description ?? null,
        categoryId: core.categoryId ?? null,
        departmentId: core.departmentId ?? null,
        locationId: core.locationId ?? null,
        priority,
        status: 'NEW',
        source: core.source ?? 'WHATSAPP',
        aiStatus: 'PENDING',
        slaDueAt,
      },
    })
  })

  // Audit AFTER the transaction (audit writes must not roll back the ticket)
  await recordAudit({
    organizationId: core.organizationId,
    userId: core.actorUserId ?? null,
    action: 'complaint.created',
    entityType: 'Complaint',
    entityId: complaint.id,
    newValue: { ticketNumber: complaint.ticketNumber, title: complaint.title, priority },
    ipAddress: core.ipAddress,
    userAgent: core.userAgent,
  })

  await emitToOrganization(core.organizationId, 'complaint.created', { complaintId: complaint.id, ticketNumber: complaint.ticketNumber })
  log.info('complaint.created', { ticketNumber: complaint.ticketNumber, organizationId: core.organizationId })

  // Async AI — complaint already persisted; AI can never block creation (spec §22/§56)
  const { enqueueAiAnalysis } = await import('@/server/jobs')
  enqueueAiAnalysis({
    complaintId: complaint.id,
    organizationId: core.organizationId,
    text: `${complaint.title}\n${complaint.description ?? ''}`,
    categories: orgCategories.map((c) => c.name),
    departments: orgDepartments.map((d) => d.name),
    locations: orgLocations.map((l) => l.name),
  })

  return complaint
}

export const complaintService = {
  /** Bot path: complaint from a WhatsApp conversation (title derived from text). */
  async createComplaintFromBot(params: {
    organizationId: string
    conversationId: string
    customerId: string
    description: string
    locationName: string
  }) {
    const firstLine = params.description.split('\n')[0]?.slice(0, 120) || 'New complaint'
    const complaint = await createComplaintInternal({
      organizationId: params.organizationId,
      customerId: params.customerId,
      conversationId: params.conversationId,
      title: firstLine,
      description: params.description,
      source: 'WHATSAPP',
      priority: 'MEDIUM',
    })

    // Best-effort location lookup by name
    const location = await db.location.findFirst({
      where: {
        organizationId: params.organizationId,
        name: { equals: params.locationName, },
      },
    })
    if (!location) {
      await db.location.create({
        data: { organizationId: params.organizationId, name: params.locationName.slice(0, 100) },
      }).then((loc) => db.complaint.update({ where: { id: complaint.id }, data: { locationId: loc.id } })).catch(() => undefined)
    }

    // The bot flow reply (handleCustomerMessage) already confirms the ticket
    // to the customer — no duplicate outbound message here.
    return complaint
  },

  /** Dashboard path: staff creates a complaint manually. */
  async createComplaintFromDashboard(ctx: AuthContext, input: {
    title: string
    description?: string
    customerId?: string
    customerName?: string
    customerPhone?: string
    categoryId?: string
    departmentId?: string
    locationId?: string
    locationName?: string
    priority: Priority
    ipAddress?: string
    userAgent?: string
  }) {
    // Resolve or create the customer
    let customerId = input.customerId
    if (!customerId) {
      if (!input.customerPhone) throw ApiError.badRequest('Either customerId or customerPhone is required')
      const customer = await db.customer.upsert({
        where: { organizationId_phoneNumber: { organizationId: ctx.organizationId, phoneNumber: input.customerPhone } },
        create: { organizationId: ctx.organizationId, phoneNumber: input.customerPhone, name: input.customerName },
        update: input.customerName ? { name: input.customerName } : {},
      })
      customerId = customer.id
    } else {
      const existing = await db.customer.findFirst({ where: { id: customerId, organizationId: ctx.organizationId } })
      if (!existing) throw ApiError.notFound('Customer not found in this organization')
    }

    // Validate taxonomy references belong to this organization (tenant safety)
    const [category, department, location] = await Promise.all([
      input.categoryId ? db.category.findFirst({ where: { id: input.categoryId, organizationId: ctx.organizationId } }) : null,
      input.departmentId ? db.department.findFirst({ where: { id: input.departmentId, organizationId: ctx.organizationId } }) : null,
      input.locationId ? db.location.findFirst({ where: { id: input.locationId, organizationId: ctx.organizationId } }) : null,
    ])

    // Free-text location: find-or-create by name (org-scoped)
    let resolvedLocation = location
    if (!resolvedLocation && input.locationName) {
      resolvedLocation = await db.location.upsert({
        where: { organizationId_name: { organizationId: ctx.organizationId, name: input.locationName.trim().slice(0, 100) } },
        create: { organizationId: ctx.organizationId, name: input.locationName.trim().slice(0, 100) },
        update: {},
      }).catch(() => null)
    }

    const complaint = await createComplaintInternal({
      organizationId: ctx.organizationId,
      customerId,
      title: input.title,
      description: input.description,
      categoryId: category?.id ?? null,
      departmentId: department?.id ?? null,
      locationId: resolvedLocation?.id ?? null,
      priority: input.priority,
      source: 'DASHBOARD',
      actorUserId: ctx.user.id,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    })

    return complaint
  },

  // -------------------------------------------------------------------------
  // Queries (all organization-scoped — spec §11)
  // -------------------------------------------------------------------------

  async listComplaints(ctx: AuthContext, filters: {
    search?: string
    status?: string
    priority?: string
    categoryId?: string
    departmentId?: string
    assignedTo?: string
    customerId?: string
    from?: string
    to?: string
    slaState?: string
    sort: string
    order: 'asc' | 'desc'
    page: number
    pageSize: number
  }) {
    const { complaintAccessGuard } = await import('@/server/authz')
    const where: Record<string, unknown> = {
      organizationId: ctx.organizationId,
      ...complaintAccessGuard(ctx),
    }

    if (filters.search) {
      const q = filters.search
      where.OR = [
        { ticketNumber: { contains: q } },
        { title: { contains: q } },
        { description: { contains: q } },
        { customer: { is: { OR: [{ name: { contains: q } }, { phoneNumber: { contains: q } }] } } },
        { department: { is: { name: { contains: q } } } },
        { assignee: { is: { name: { contains: q } } } },
      ]
    }
    if (filters.status) {
      const statuses = filters.status.split(',').map((s) => s.trim().toUpperCase()).filter(isComplaintStatus)
      if (statuses.length > 0) where.status = { in: statuses }
    }
    if (filters.priority) {
      const priorities = filters.priority.split(',').map((s) => s.trim().toUpperCase()).filter(isPriority)
      if (priorities.length > 0) where.priority = { in: priorities }
    }
    if (filters.categoryId) where.categoryId = filters.categoryId
    if (filters.departmentId) where.departmentId = filters.departmentId
    if (filters.assignedTo) where.assignedTo = filters.assignedTo === 'unassigned' ? null : filters.assignedTo
    if (filters.customerId) where.customerId = filters.customerId
    if (filters.from || filters.to) {
      where.createdAt = {
        ...(filters.from ? { gte: new Date(filters.from) } : {}),
        ...(filters.to ? { lte: new Date(`${filters.to}T23:59:59.999Z`) } : {}),
      }
    }

    // SLA state filter — computed on candidate rows (bounded page query below)
    const sortByPriority = filters.sort === 'priority'
    const orderBy = sortByPriority
      ? [{ priority: filters.order }]
      : [{ [filters.sort]: filters.order }, { createdAt: 'desc' as const }]

    const [total, rows] = await Promise.all([
      db.complaint.count({ where }),
      db.complaint.findMany({
        where,
        orderBy,
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
        include: {
          customer: { select: { id: true, name: true, phoneNumber: true } },
          category: { select: { id: true, name: true } },
          department: { select: { id: true, name: true } },
          location: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true, image: true } },
        },
      }),
    ])

    let items = rows.map((c) => ({
      ...c,
      slaState: computeSlaState(c),
    }))

    if (filters.slaState) {
      items = items.filter((c) => c.slaState === filters.slaState)
    }
    if (sortByPriority) {
      items.sort((a, b) =>
        filters.order === 'desc'
          ? PRIORITY_RANK[b.priority as Priority] - PRIORITY_RANK[a.priority as Priority]
          : PRIORITY_RANK[a.priority as Priority] - PRIORITY_RANK[b.priority as Priority],
      )
    }

    return { items, total, page: filters.page, pageSize: filters.pageSize, pages: Math.max(1, Math.ceil(total / filters.pageSize)) }
  },

  async getComplaintDetail(ctx: AuthContext, complaintId: string) {
    const { complaintAccessGuard } = await import('@/server/authz')
    const base = await db.complaint.findFirst({
      where: { id: complaintId, organizationId: ctx.organizationId, ...complaintAccessGuard(ctx) },
      include: {
        customer: true,
        conversation: { select: { id: true, status: true } },
        category: true,
        department: true,
        location: true,
        assignee: { select: { id: true, name: true, email: true, image: true } },
        attachments: { orderBy: { createdAt: 'asc' } },
        comments: { orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, name: true, image: true } } } },
        statusHistory: { orderBy: { createdAt: 'asc' } },
        assignments: { orderBy: { assignedAt: 'desc' }, include: { actor: { select: { id: true, name: true } } } },
        aiAnalyses: { orderBy: { createdAt: 'desc' }, take: 1 },
        aiSuggestions: { orderBy: { createdAt: 'desc' }, take: 1 },
        feedbacks: true,
        escalations: { orderBy: { createdAt: 'desc' } },
      },
    })

    if (!base) throw ApiError.notFound('Complaint not found')

    // Related (duplicate) complaints — pending matches surface as
    // "Potential Related Incident" (spec §26/§28)
    const related = await db.duplicateMatch.findMany({
      where: {
        organizationId: ctx.organizationId,
        OR: [
          { complaintId: base.id, status: { not: 'DISMISSED' } },
          { relatedComplaintId: base.id, status: { not: 'DISMISSED' } },
        ],
      },
      include: {
        complaint: { select: { id: true, ticketNumber: true, title: true, status: true, createdAt: true } },
        relatedComplaint: { select: { id: true, ticketNumber: true, title: true, status: true, createdAt: true } },
      },
      orderBy: { similarity: 'desc' },
      take: 5,
    })

    // Conversation messages (WhatsApp thread)
    const messages = base.conversationId
      ? await db.message.findMany({
          where: { conversationId: base.conversationId, organizationId: ctx.organizationId },
          orderBy: { createdAt: 'asc' },
          take: 200,
        })
      : []

    return {
      ...base,
      slaState: computeSlaState(base),
      relatedComplaints: related,
      messages,
    }
  },

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  async assignComplaint(ctx: AuthContext, complaintId: string, assignedTo: string, reason?: string) {
    const complaint = await db.complaint.findFirst({
      where: { id: complaintId, organizationId: ctx.organizationId },
    })
    if (!complaint) throw ApiError.notFound('Complaint not found')

    // Assignee must be an ACTIVE member of the same organization (tenant safety)
    const assignee = await db.organizationMember.findFirst({
      where: {
        userId: assignedTo,
        organizationId: ctx.organizationId,
        status: 'ACTIVE',
        role: { in: ['STAFF', 'SUPERVISOR', 'ORGANIZATION_ADMIN'] },
      },
      include: { user: { select: { id: true, name: true } } },
    })
    if (!assignee) throw ApiError.badRequest('Assignee must be an active staff member of your organization')

    const wasOpen = OPEN_STATUSES.includes(complaint.status as ComplaintStatus)
    const now = new Date()

    await db.$transaction(async (tx) => {
      // Close previous assignment history rows (history preserved, not overwritten)
      await tx.complaintAssignment.updateMany({
        where: { complaintId, unassignedAt: null },
        data: { unassignedAt: now },
      })
      await tx.complaintAssignment.create({
        data: {
          complaintId,
          organizationId: ctx.organizationId,
          assignedTo,
          assignedBy: ctx.user.id,
          reason: reason || (complaint.assignedTo ? 'REASSIGN' : 'MANUAL'),
        },
      })
      await tx.complaint.update({
        where: { id: complaintId },
        data: {
          assignedTo,
          assignedAt: now,
          status: complaint.status === 'NEW' ? 'ASSIGNED' : complaint.status,
        },
      })
      if (complaint.status === 'NEW') {
        await tx.complaintStatusHistory.create({
          data: {
            organizationId: ctx.organizationId,
            complaintId,
            fromStatus: 'NEW',
            toStatus: 'ASSIGNED',
            changedBy: ctx.user.id,
            reason: reason || 'Assigned',
          },
        })
      }
    })

    await recordAudit({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      action: 'complaint.assigned',
      entityType: 'Complaint',
      entityId: complaintId,
      oldValue: { assignedTo: complaint.assignedTo },
      newValue: { assignedTo, reason },
    })

    const { notify } = await import('./notification-service')
    await notify({
      organizationId: ctx.organizationId,
      userId: assignedTo,
      type: 'ASSIGNMENT',
      title: 'New complaint assigned',
      message: `${complaint.ticketNumber} — ${complaint.title} has been assigned to you.`,
      complaintId,
    })

    await emitToOrganization(ctx.organizationId, 'complaint.assigned', { complaintId, assignedTo })
    void wasOpen
    return db.complaint.findUnique({ where: { id: complaintId } })
  },

  async changeStatus(ctx: AuthContext, complaintId: string, toStatus: ComplaintStatus, reason?: string) {
    const complaint = await db.complaint.findFirst({
      where: { id: complaintId, organizationId: ctx.organizationId },
    })
    if (!complaint) throw ApiError.notFound('Complaint not found')

    // Staff may only transition their own complaints
    if (ctx.role === 'STAFF' && complaint.assignedTo !== ctx.user.id) {
      throw ApiError.forbidden('Staff can only update complaints assigned to them')
    }

    const fromStatus = complaint.status as ComplaintStatus
    const allowed = STATUS_TRANSITIONS[fromStatus] ?? []
    if (!allowed.includes(toStatus)) {
      throw ApiError.badRequest(`Invalid status transition: ${fromStatus} → ${toStatus}`)
    }
    if (toStatus === 'IN_PROGRESS' && !complaint.assignedTo) {
      throw ApiError.badRequest('Complaint must be assigned before work can start')
    }

    const now = new Date()
    await db.$transaction(async (tx) => {
      await tx.complaint.update({
        where: { id: complaintId },
        data: {
          status: toStatus,
          acknowledgedAt: toStatus === 'ACKNOWLEDGED' && !complaint.acknowledgedAt ? now : complaint.acknowledgedAt,
          firstResponseAt: !complaint.firstResponseAt && toStatus !== 'NEW' ? now : complaint.firstResponseAt,
          resolvedAt: toStatus === 'RESOLVED' ? now : complaint.resolvedAt,
          closedAt: toStatus === 'CLOSED' ? now : complaint.closedAt,
        },
      })
      await tx.complaintStatusHistory.create({
        data: {
          organizationId: ctx.organizationId,
          complaintId,
          fromStatus,
          toStatus,
          changedBy: ctx.user.id,
          reason,
        },
      })
      // Resolve pending escalations
      if (toStatus === 'RESOLVED' || toStatus === 'CLOSED') {
        await tx.escalation.updateMany({
          where: { complaintId, resolvedAt: null },
          data: { resolvedAt: now },
        })
      }
    })

    const auditAction = toStatus === 'RESOLVED' ? 'complaint.resolved' : toStatus === 'REOPENED' ? 'complaint.reopened' : 'complaint.status_changed'
    await recordAudit({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      action: auditAction,
      entityType: 'Complaint',
      entityId: complaintId,
      oldValue: { status: fromStatus },
      newValue: { status: toStatus, reason },
    })

    await emitToOrganization(ctx.organizationId, 'complaint.status_changed', { complaintId, fromStatus, toStatus })

    // Notifications (assigned staff / admins) + WhatsApp update to customer
    if (toStatus === 'RESOLVED' || toStatus === 'CLOSED') {
      const watchers = await db.organizationMember.findMany({
        where: { organizationId: ctx.organizationId, role: { in: ['ORGANIZATION_ADMIN', 'SUPERVISOR'] }, status: 'ACTIVE' },
        select: { userId: true },
      })
      const { notifyMany } = await import('./notification-service')
      await notifyMany(
        watchers.map((w) => ({
          organizationId: ctx.organizationId,
          userId: w.userId,
          type: toStatus === 'RESOLVED' ? 'RESOLUTION' : 'STATUS_CHANGE',
          title: toStatus === 'RESOLVED' ? 'Complaint resolved' : 'Complaint closed',
          message: `${complaint.ticketNumber} — ${complaint.title}`,
          complaintId,
        })),
      )
      if (toStatus === 'RESOLVED') {
        await notifyCustomer(complaintId, `Update on ticket ${complaint.ticketNumber}: your issue has been marked RESOLVED. If anything is still wrong, reply to reopen it.`)
      }
    }

    return db.complaint.findUnique({ where: { id: complaintId } })
  },

  async changePriority(ctx: AuthContext, complaintId: string, priority: Priority, reason?: string) {
    const complaint = await db.complaint.findFirst({
      where: { id: complaintId, organizationId: ctx.organizationId },
    })
    if (!complaint) throw ApiError.notFound('Complaint not found')
    if (complaint.status === 'CLOSED') throw ApiError.badRequest('Closed complaints cannot be modified')

    const policies = await getSlaPolicies(ctx.organizationId)
    const slaDueAt = computeSlaDueAt(complaint.createdAt, policies[priority])

    const updated = await db.complaint.update({
      where: { id: complaintId },
      data: { priority, slaDueAt },
    })

    await recordAudit({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      action: 'complaint.priority_changed',
      entityType: 'Complaint',
      entityId: complaintId,
      oldValue: { priority: complaint.priority, slaDueAt: complaint.slaDueAt?.toISOString() },
      newValue: { priority, slaDueAt: slaDueAt.toISOString(), reason },
    })

    await emitToOrganization(ctx.organizationId, 'complaint.updated', { complaintId, priority })
    return updated
  },

  async addComment(ctx: AuthContext, complaintId: string, content: string, visibility: 'INTERNAL' | 'PUBLIC') {
    const complaint = await db.complaint.findFirst({
      where: { id: complaintId, organizationId: ctx.organizationId },
    })
    if (!complaint) throw ApiError.notFound('Complaint not found')
    if (ctx.role === 'VIEWER') throw ApiError.forbidden('Viewers cannot comment')

    const comment = await db.complaintComment.create({
      data: {
        organizationId: ctx.organizationId,
        complaintId,
        authorId: ctx.user.id,
        content,
        visibility,
      },
      include: { author: { select: { id: true, name: true, image: true } } },
    })

    await recordAudit({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      action: 'comment.created',
      entityType: 'ComplaintComment',
      entityId: comment.id,
      newValue: { complaintId, visibility },
    })

    await emitToOrganization(ctx.organizationId, 'comment.created', { complaintId, commentId: comment.id })

    if (complaint.assignedTo && complaint.assignedTo !== ctx.user.id) {
      const { notify } = await import('./notification-service')
      await notify({
        organizationId: ctx.organizationId,
        userId: complaint.assignedTo,
        type: 'COMMENT',
        title: 'New internal comment',
        message: `${ctx.user.name ?? 'A colleague'} commented on ${complaint.ticketNumber}.`,
        complaintId,
      })
    }

    return comment
  },

  // -------------------------------------------------------------------------
  // AI suggested resolution — generated when staff opens a complaint (§25/§27)
  // -------------------------------------------------------------------------

  async getOrCreateSuggestion(ctx: AuthContext, complaintId: string) {
    const complaint = await db.complaint.findFirst({
      where: { id: complaintId, organizationId: ctx.organizationId },
      include: { aiSuggestions: { orderBy: { createdAt: 'desc' }, take: 1 } },
    })
    if (!complaint) throw ApiError.notFound('Complaint not found')

    const recent = complaint.aiSuggestions[0]
    if (recent) return recent

    const result = await suggestResolution({
      text: `${complaint.title}\n${complaint.description ?? ''}`,
      category: null,
      department: null,
    })
    return db.aISuggestion.create({
      data: {
        organizationId: ctx.organizationId,
        complaintId,
        suggestion: result.suggestion,
        confidence: result.confidence,
        estimatedResolutionTime: result.estimatedResolutionTime,
      },
    })
  },

  // -------------------------------------------------------------------------
  // Duplicate detection (spec §26/§28) — detect only, never auto-merge
  // -------------------------------------------------------------------------

  async detectDuplicates(complaintId: string, organizationId: string) {
    const complaint = await db.complaint.findFirst({
      where: { id: complaintId, organizationId },
      include: { customer: { select: { phoneNumber: true } } },
    })
    if (!complaint) return

    const candidates = await db.complaint.findMany({
      where: {
        organizationId,
        id: { not: complaintId },
        status: { in: [...OPEN_STATUSES] },
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      },
      select: { id: true, title: true, description: true, customerId: true, ticketNumber: true },
      take: 100,
      orderBy: { createdAt: 'desc' },
    })

    const titleTokens = new Set(
      complaint.title.toLowerCase().split(/\W+/).filter((t) => t.length > 3),
    )

    for (const candidate of candidates) {
      const candTokens = new Set(
        `${candidate.title} ${candidate.description ?? ''}`.toLowerCase().split(/\W+/).filter((t) => t.length > 3),
      )
      let overlap = 0
      for (const token of titleTokens) if (candTokens.has(token)) overlap++
      const titleSim = titleTokens.size > 0 ? overlap / Math.max(titleTokens.size, 1) : 0
      const sameCustomer = candidate.customerId === complaint.customerId ? 0.2 : 0
      const similarity = Math.min(0.99, titleSim * 0.8 + sameCustomer)

      if (similarity >= 0.5) {
        await db.duplicateMatch.upsert({
          where: { complaintId_relatedComplaintId: { complaintId, relatedComplaintId: candidate.id } },
          create: {
            organizationId,
            complaintId,
            relatedComplaintId: candidate.id,
            similarity: Number(similarity.toFixed(2)),
            reason: `${Math.round(similarity * 100)}% content similarity${candidate.customerId === complaint.customerId ? ' + same customer' : ''}`,
          },
          update: { similarity: Number(similarity.toFixed(2)) },
        })
      }
    }
  },

  async setDuplicateMatchStatus(ctx: AuthContext, matchId: string, action: 'LINK' | 'DISMISS') {
    const match = await db.duplicateMatch.findFirst({
      where: { id: matchId, organizationId: ctx.organizationId },
    })
    if (!match) throw ApiError.notFound('Match not found')
    return db.duplicateMatch.update({
      where: { id: matchId },
      data: { status: action === 'LINK' ? 'LINKED' : 'DISMISSED' },
    })
  },

  // -------------------------------------------------------------------------
  // AI retry (spec §23: allow retry after failure)
  // -------------------------------------------------------------------------

  async retryAi(ctx: AuthContext, complaintId: string) {
    const complaint = await db.complaint.findFirst({
      where: { id: complaintId, organizationId: ctx.organizationId },
    })
    if (!complaint) throw ApiError.notFound('Complaint not found')
    if (complaint.aiStatus === 'PENDING' || complaint.aiStatus === 'PROCESSING') {
      return complaint
    }
    await db.complaint.update({ where: { id: complaintId }, data: { aiStatus: 'PENDING', aiError: null } })
    const { enqueueAiAnalysis } = await import('@/server/jobs')
    enqueueAiAnalysis({
      complaintId,
      organizationId: ctx.organizationId,
      text: `${complaint.title}\n${complaint.description ?? ''}`,
      categories: (await db.category.findMany({ where: { organizationId: ctx.organizationId }, select: { name: true } })).map((c) => c.name),
      departments: (await db.department.findMany({ where: { organizationId: ctx.organizationId }, select: { name: true } })).map((d) => d.name),
      locations: (await db.location.findMany({ where: { organizationId: ctx.organizationId }, select: { name: true } })).map((l) => l.name),
    })
    await recordAudit({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      action: 'ai.retry',
      entityType: 'Complaint',
      entityId: complaintId,
    })
    return db.complaint.findUnique({ where: { id: complaintId } })
  },
}

// ---------------------------------------------------------------------------
// Customer WhatsApp notification helper (spec §29/§68 — never blocks flow)
// ---------------------------------------------------------------------------

export async function notifyCustomer(complaintId: string, text: string): Promise<void> {
  try {
    const complaint = await db.complaint.findUnique({
      where: { id: complaintId },
      include: { customer: { select: { phoneNumber: true } }, conversation: { select: { id: true } } },
    })
    if (!complaint?.conversation) return
    const { sendOutbound } = await import('@/server/services/whatsapp')
    await sendOutbound({
      organizationId: complaint.organizationId,
      conversationId: complaint.conversation.id,
      to: complaint.customer.phoneNumber,
      text,
      senderType: 'BOT',
    })
  } catch (error) {
    log.warn('notifyCustomer.failed', {
      complaintId,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
