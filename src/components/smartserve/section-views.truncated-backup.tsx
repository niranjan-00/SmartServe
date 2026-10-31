'use client'

import { useEffect, useState } from 'react'
import { Bell, CheckCircle2, UserRound, Bot, Inbox, AlertCircle, Sparkles, Building2, Wifi, ShieldCheck, Ticket, Play, RefreshCw, QrCode } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api, type OrganizationInfo, type NotificationRow, type MemberRow } from '@/lib/api'
import { relativeTime, formatDate } from './display'

/**
 * Detail/settings side views — same visual system as the original UI,
 * wired to real backend data (spec §48/§53/§54/§65/§48).
 */

export function useNotifications(orgId: string | null) {
  const [items, setItems] = useState<NotificationRow[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      const data = await api.get<{ items: NotificationRow[]; unread: number }>('/api/notifications?pageSize=50')
      setItems(data.items)
      setUnread(data.unread)
    } catch {
      // silent — notification badge is non-critical
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (orgId) void load()
    const t = setInterval(() => orgId && void load(), 30_000)
    return () => clearInterval(t)
  }, [orgId])

  const markAllRead = async () => {
    await api.patch('/api/notifications').catch(() => undefined)
    void load()
  }
  const markRead = async (id: string) => {
    await api.put(`/api/notifications?notificationId=${id}`).catch(() => undefined)
    void load()
  }

  return { items, unread, loading, reload: load, markAllRead, markRead }
}

// ---------------------------------------------------------------------------
// Notifications view (real DB rows, spec §53)
// ---------------------------------------------------------------------------

const NOTIFICATION_ICON: Record<string, { icon: typeof Inbox; cls: string }> = {
  NEW_COMPLAINT: { icon: Inbox, cls: 'blue' },
  ASSIGNMENT: { icon: UserRound, cls: 'violet' },
  STATUS_CHANGE: { icon: CheckCircle2, cls: 'green' },
  SLA_WARNING: { icon: AlertCircle, cls: 'amber' },
  SLA_BREACH: { icon: AlertCircle, cls: 'amber' },
  ESCALATION: { icon: AlertCircle, cls: 'amber' },
  COMMENT: { icon: Bot, cls: 'violet' },
  RESOLUTION: { icon: CheckCircle2, cls: 'green' },
}

export function NotificationsView({ notifications, onOpenComplaint }: {
  notifications: ReturnType<typeof useNotifications>
  onOpenComplaint: (id: string) => void
}) {
  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Management / Notifications</div>
          <h1>Notifications</h1>
          <p>Review the updates that need your attention across the workspace.</p>
        </div>
        <div className="header-actions">
          <Button variant="outline" onClick={notifications.markAllRead}>Mark all read</Button>
        </div>
      </div>
      <div className="settings-grid" style={{ maxWidth: 760 }}>
        <div className="detail-card settings-card">
          <div className="detail-card-title">
            <div>
              <h3>Your latest updates</h3>
              <p>{notifications.unread > 0 ? `${notifications.unread} unread notification${notifications.unread === 1 ? '' : 's'}` : 'You are all caught up'}</p>
            </div>
            <div className="ai-icon"><Bell size={18} /></div>
          </div>
          <div className="settings-rows">
            {notifications.loading && <div className="settings-row"><span>Loading notifications…</span></div>}
            {!notifications.loading && notifications.items.length === 0 && (
              <div className="settings-row"><span>No notifications yet. New complaints, assignments and SLA alerts will appear here.</span></div>
            )}
            {notifications.items.map((n) => {
              const meta = NOTIFICATION_ICON[n.type] ?? { icon: Bell, cls: 'blue' }
              const Icon = meta.icon