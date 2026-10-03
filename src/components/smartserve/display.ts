import type { ComplaintStatus } from '@/lib/types'

/** Presentation helpers shared by SmartServe views. */

export function initialsOf(name?: string | null): string {
  if (!name) return '?'
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?'
}

const PRIORITY_TONE: Record<string, string> = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
}

const STATUS_KIND: Record<string, string> = {
  NEW: 'new',
  ACKNOWLEDGED: 'acknowledged',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in-progress',
  RESOLVED: 'resolved',
  CLOSED: 'new',
  REOPENED: 'critical',
}

export function priorityTone(priority: string): string {
  return PRIORITY_TONE[priority] ?? 'medium'
}

export function statusKind(status: string): string {
  return STATUS_KIND[status] ?? 'new'
}

export function statusLabel(status: string): string {
  return status.charAt(0) + status.replace('_', ' ').slice(1).toLowerCase()
}

export function priorityLabel(priority: string): string {
  return priority.charAt(0) + priority.slice(1).toLowerCase()
}

const IST_OPTIONS: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Kolkata' }

export function formatTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—'
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return d.toLocaleTimeString('en-IN', { ...IST_OPTIONS, hour: 'numeric', minute: '2-digit' })
}

export function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return '—'
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return d.toLocaleDateString('en-IN', { ...IST_OPTIONS, day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—'
  return `${formatDate(iso)}, ${formatTime(iso)}`
}

export function relativeTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—'
  const d = typeof iso === 'string' ? new Date(iso) : iso
  const diff = Date.now() - d.getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  return formatDate(d)
}

/** SLA countdown label, e.g. "1h 24m" / "18m" / "Breached 2h ago". */
export function slaLabel(slaState: string, slaDueAt: string | null): string {
  if (slaState === 'MET') return 'Closed'
  if (!slaDueAt) return '—'
  const due = new Date(slaDueAt).getTime()
  const diff = due - Date.now()
  const abs = Math.abs(diff)
  const h = Math.floor(abs / 3_600_000)
  const m = Math.floor((abs % 3_600_000) / 60_000)
  const span = h > 0 ? `${h}h ${m}m` : `${m}m`
  if (slaState === 'BREACHED') return `Overdue ${span}`
  return span
}

export function slaIsCritical(slaState: string): boolean {
  return slaState === 'BREACHED' || slaState === 'APPROACHING'
}

export function greetingForHour(hour = new Date().getHours()): string {
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

export function isOpenStatus(status: string): boolean {
  return ['NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'].includes(status)
}

export type { ComplaintStatus }
