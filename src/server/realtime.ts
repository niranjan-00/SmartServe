import { createLogger } from '@/server/logger'

const log = createLogger('realtime')

/**
 * RealtimeService (server → socket.io mini-service).
 * Keeps realtime implementation independent from database logic (spec §65):
 * services call emitToOrganization(); the transport (socket.io mini service
 * on :3030) fans out to dashboards. If the service is down, events are
 * dropped silently — the dashboard periodically reconciles via API queries
 * and refetches on reconnect, so the database remains the source of truth.
 */

const REALTIME_URL = process.env.REALTIME_SERVICE_URL || 'http://localhost:3030'
const REALTIME_SECRET = process.env.REALTIME_SECRET || process.env.AUTH_SECRET || 'smartserve-development-secret-change-me'

export type RealtimeEvent =
  | 'complaint.created'
  | 'complaint.updated'
  | 'complaint.assigned'
  | 'complaint.status_changed'
  | 'complaint.deleted'
  | 'message.created'
  | 'comment.created'
  | 'notification.created'
  | 'sla.warning'
  | 'sla.breached'
  | 'whatsapp.status_changed'
  | 'organization.updated'
  | 'member.updated'
  | 'dashboard.refresh'

let disabled = false

/** Fire-and-forget event emission — never blocks or fails the caller. */
export async function emitToOrganization(organizationId: string, event: RealtimeEvent, data: unknown): Promise<void> {
  if (disabled) return
  try {
    const res = await fetch(`${REALTIME_URL}/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-realtime-secret': REALTIME_SECRET },
      body: JSON.stringify({ organizationId, event, data }),
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok && res.status === 404) {
      // endpoint unknown → wrong service; disable to avoid log spam
      disabled = true
      log.warn('realtime.service.unreachable', { status: res.status })
    }
  } catch {
    // Realtime is best-effort; database + refetch reconciliation covers gaps.
    log.debug('realtime.emit.skipped', { organizationId, event })
  }
}
