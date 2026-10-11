import { db } from '@/lib/db'
import { createLogger } from '@/server/logger'
import { scanOrganizationSla } from './services/sla-service'
import { autoAssign } from './services/assignment-service'

const log = createLogger('jobs')

/**
 * Background job architecture (spec §54/§56).
 * In-process queue + scheduler — compatible with single-node deployments
 * (Render/VPS/Docker). The webhook path never waits on AI: complaints are
 * persisted first and AI runs here asynchronously.
 *
 * Jobs:
 *   - AI classification (+ auto-assignment + duplicate detection) — queued
 *   - SLA monitoring / escalation — every 60s across all organizations
 */

// ---------------------------------------------------------------------------
// AI queue
// ---------------------------------------------------------------------------

interface AiJob {
  complaintId: string
  organizationId: string
  text: string
  categories: string[]
  departments: string[]
  locations: string[]
  attempts: number
}

const aiQueue: AiJob[] = []
let aiQueueRunning = false

export function enqueueAiAnalysis(job: Omit<AiJob, 'attempts'>): void {
  aiQueue.push({ ...job, attempts: 0 })
  log.debug('ai.enqueued', { complaintId: job.complaintId, queueSize: aiQueue.length })
  void processAiQueue()
}

async function processAiQueue(): Promise<void> {
  if (aiQueueRunning) return
  aiQueueRunning = true
  try {
    while (aiQueue.length > 0) {
      const job = aiQueue.shift()!
      await runAiJob(job)
    }
  } finally {
    aiQueueRunning = false
  }
}

async function runAiJob(job: AiJob): Promise<void> {
  const { complaintId, organizationId, text } = job
  try {
    await db.complaint.update({ where: { id: complaintId }, data: { aiStatus: 'PROCESSING' } }).catch(() => undefined)

    const { classifyComplaint } = await import('./services/ai')
    const result = await classifyComplaint({
      text,
      categories: job.categories,
      departments: job.departments,
      locations: job.locations,
    })

    // Resolve taxonomy entities by name (AI output validated before saving)
    const existing = await db.complaint.findUnique({ where: { id: complaintId }, select: { priority: true } })
    const [category, department] = await Promise.all([
      result.category
        ? db.category.findFirst({ where: { organizationId, name: { equals: result.category } } })
        : null,
      result.department
        ? db.department.findFirst({ where: { organizationId, name: { equals: result.department } } })
        : null,
    ])

    // AI may strengthen priority (escalate) but never silently downgrade staff-set priorities
    const strengthenedPriority =
      rankOf(result.priority) > rankOf(existing?.priority ?? 'MEDIUM') ? result.priority : undefined

    await db.$transaction(async (tx) => {
      await tx.aIAnalysis.create({
        data: {
          complaintId,
          organizationId,
          status: 'COMPLETED',
          title: result.title,
          category: result.category,
          department: result.department,
          location: result.location,
          priority: result.priority,
          sentiment: result.sentiment,
          intent: result.intent,
          confidence: result.confidence,
          provider: result.provider,
          raw: JSON.stringify(result),
        },
      })
      await tx.complaint.update({
        where: { id: complaintId },
        data: {
          aiStatus: 'COMPLETED',
          aiError: null,
          priority: strengthenedPriority,
          categoryId: category?.id ?? undefined,
          departmentId: department?.id ?? undefined,
        },
      })
    })

    // Duplicate detection (bounded, after classification)
    const { complaintService } = await import('./services/complaint-service')
    await complaintService.detectDuplicates(complaintId, organizationId)

    // Auto-assignment after AI classification
    await autoAssign(complaintId)

    const { emitToOrganization } = await import('@/server/realtime')
    await emitToOrganization(organizationId, 'complaint.updated', { complaintId, aiStatus: 'COMPLETED' })
    log.info('ai.completed', { complaintId, provider: result.provider })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('ai.job_failed', { complaintId, message })
    const attempts = job.attempts + 1
    if (attempts < 2) {
      aiQueue.push({ ...job, attempts })
      return
    }
    // Permanent failure — complaint remains valid, AI marked FAILED (spec §23)
    await db.complaint.update({
      where: { id: complaintId },
      data: { aiStatus: 'FAILED', aiError: message.slice(0, 300) },
    }).catch(() => undefined)
    await db.aIAnalysis.create({
      data: { complaintId, organizationId, status: 'FAILED', error: message.slice(0, 500) },
    }).catch(() => undefined)
  }
}

function rankOf(priority: string): number {
  return { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }[priority] ?? 2
}

// ---------------------------------------------------------------------------
// SLA monitor — continuous, not page-load driven (spec §31)
// ---------------------------------------------------------------------------

async function runSlaMonitor(): Promise<void> {
  try {
    const organizations = await db.organization.findMany({ select: { id: true } })
    for (const org of organizations) {
      const result = await scanOrganizationSla(org.id)
      if (result.warnings > 0 || result.breaches > 0) {
        log.info('sla.scan', { organizationId: org.id, ...result })
        const { emitToOrganization } = await import('@/server/realtime')
        if (result.warnings > 0) await emitToOrganization(org.id, 'sla.warning', result)
        if (result.breaches > 0) await emitToOrganization(org.id, 'sla.breached', result)
      }
    }
  } catch (error) {
    log.error('sla.monitor_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

// ---------------------------------------------------------------------------
// Scheduler bootstrap
// ---------------------------------------------------------------------------

const globalForJobs = globalThis as unknown as {
  __smartserveJobsStarted?: boolean
}

export function ensureBackgroundJobs(): void {
  if (globalForJobs.__smartserveJobsStarted) return
  globalForJobs.__smartserveJobsStarted = true
  log.info('jobs.scheduler_started')
  setInterval(() => void runSlaMonitor(), 60_000).unref?.()
  // First pass shortly after boot
  setTimeout(() => void runSlaMonitor(), 5_000).unref?.()
}
