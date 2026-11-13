'use client'

import { useEffect, useRef, useState } from 'react'
import { Bell, CheckCircle2, Clock3, X, UserRound, Bot, Inbox, AlertCircle, Sparkles, Building2, ShieldCheck, Ticket, QrCode, Plus, Smartphone, RefreshCw, Trash2, MessageCircle, CircleCheck, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api, type OrganizationInfo, type NotificationRow, type MemberRow } from '@/lib/api'
import { initialsOf, relativeTime, formatDate } from './display'

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
              return (
                <button
                  key={n.id}
                  className="activity-item"
                  style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 0, padding: '13px 0', borderBottom: '1px solid var(--border)', cursor: n.complaintId ? 'pointer' : 'default', opacity: n.readAt ? 0.62 : 1 }}
                  onClick={() => {
                    void notifications.markRead(n.id)
                    if (n.complaintId) onOpenComplaint(n.complaintId)
                  }}
                >
                  <div className={`activity-icon ${meta.cls}`}><Icon size={14} /></div>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 11.5, margin: 0 }}><strong>{n.title}</strong> — {n.message}</p>
                    <span style={{ fontSize: 9.5, color: '#a2adba' }}>{relativeTime(n.createdAt)}{n.complaint?.ticketNumber ? ` · ${n.complaint.ticketNumber}` : ''}</span>
                  </div>
                  {!n.readAt && <i style={{ width: 7, height: 7, borderRadius: '50%', background: '#3578ee', marginTop: 8 }} />}
                </button>
              )
            })}
          </div>
        </div>
        <div className="ai-card settings-help">
          <div className="ai-card-top"><div className="ai-icon"><Sparkles size={18} /></div><span>SmartServe guidance</span></div>
          <h3>Never miss what matters.</h3>
          <p>Complaint events, SLA warnings and escalations land here in real time while your dashboard is open.</p>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Settings view (real org config + SLA + taxonomy, spec §44/§45/§32)
// ---------------------------------------------------------------------------

interface SlaPolicy { priority: string; firstResponseMinutes: number; resolutionMinutes: number; escalationMinutes: number | null; enabled: boolean }
interface CategoryRowLite { id: string; name: string; status: string; defaultPriority: string; department?: { name: string } | null }
interface DepartmentLite { id: string; name: string; staffCount: number; openComplaints: number }

export function SettingsView({ org, role, onChanged }: {
  org: OrganizationInfo
  role: string
  onChanged: () => void
}) {
  const isAdmin = role === 'ORGANIZATION_ADMIN' || role === 'SUPER_ADMIN'
  const [tab, setTab] = useState<'organization' | 'sla' | 'categories' | 'departments'>('organization')

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Management / Settings</div>
          <h1>Settings</h1>
          <p>Configure SmartServe for your team and workspace.</p>
        </div>
      </div>
      <div className="filter-bar" role="tablist">
        {([['organization', 'Organization'], ['sla', 'SLA'], ['categories', 'Categories'], ['departments', 'Departments']] as const).map(([key, label]) => (
          <Button key={key} variant={tab === key ? 'default' : 'outline'} size="sm" onClick={() => setTab(key)}>{label}</Button>
        ))}
      </div>
      {tab === 'organization' && <OrganizationSettings org={org} isAdmin={isAdmin} onChanged={onChanged} />}
      {tab === 'sla' && <SlaSettings isAdmin={isAdmin} onChanged={onChanged} />}
      {tab === 'categories' && <CategorySettings isAdmin={isAdmin} onChanged={onChanged} />}
      {tab === 'departments' && <DepartmentSettings isAdmin={isAdmin} onChanged={onChanged} />}
    </div>
  )
}

function OrganizationSettings({ org, isAdmin, onChanged }: { org: OrganizationInfo; isAdmin: boolean; onChanged: () => void }) {
  const [name, setName] = useState(org.name)
  const [email, setEmail] = useState(org.email ?? '')
  const [phone, setPhone] = useState(org.phone ?? '')
  const [website, setWebsite] = useState(org.website ?? '')
  const [address, setAddress] = useState(org.address ?? '')
  const [autoAssignment, setAutoAssignment] = useState(org.autoAssignment)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      await api.patch('/api/organizations/current', { name, email, phone, website, address, autoAssignment })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-grid" style={{ maxWidth: 900 }}>
      <div className="detail-card settings-card">
        <div className="detail-card-title">
          <div><h3>Workspace settings</h3><p>Shown to your team across SmartServe.</p></div>
          <div className="ai-icon"><Building2 size={18} /></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: '18px 0' }}>
          <div className="auth-field"><label>Organization name</label><input value={name} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} style={{ height: 36, border: '1px solid var(--input)', borderRadius: 8, padding: '0 10px', fontSize: 12, background: 'var(--background)', color: 'var(--foreground)' }} /></div>
          <div className="auth-field"><label>Contact email</label><input value={email} disabled={!isAdmin} onChange={(e) => setEmail(e.target.value)} style={{ height: 36, border: '1px solid var(--input)', borderRadius: 8, padding: '0 10px', fontSize: 12, background: 'var(--background)', color: 'var(--foreground)' }} /></div>
          <div className="auth-field"><label>Phone</label><input value={phone} disabled={!isAdmin} onChange={(e) => setPhone(e.target.value)} style={{ height: 36, border: '1px solid var(--input)', borderRadius: 8, padding: '0 10px', fontSize: 12, background: 'var(--background)', color: 'var(--foreground)' }} /></div>
          <div className="auth-field"><label>Website</label><input value={website} disabled={!isAdmin} onChange={(e) => setWebsite(e.target.value)} style={{ height: 36, border: '1px solid var(--input)', borderRadius: 8, padding: '0 10px', fontSize: 12, background: 'var(--background)', color: 'var(--foreground)' }} /></div>
          <div className="auth-field" style={{ gridColumn: '1 / -1' }}><label>Address</label><input value={address} disabled={!isAdmin} onChange={(e) => setAddress(e.target.value)} style={{ height: 36, border: '1px solid var(--input)', borderRadius: 8, padding: '0 10px', fontSize: 12, background: 'var(--background)', color: 'var(--foreground)' }} /></div>
          {isAdmin && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--foreground)' }}>
              <input type="checkbox" checked={autoAssignment} onChange={(e) => setAutoAssignment(e.target.checked)} />
              AI &amp; rules-based auto-assignment for new complaints
            </label>
          )}
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Button size="sm" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
            {saved && <span style={{ fontSize: 10.5, color: '#35966c' }}>Saved</span>}
          </div>
        )}
      </div>
      <div className="ai-card settings-help">
        <div className="ai-card-top"><div className="ai-icon"><Sparkles size={18} /></div><span>SmartServe guidance</span></div>
        <h3>Make your workspace work for you.</h3>
        <p>Auto-assignment routes each complaint to the best available staff member using department, skills and workload.</p>
      </div>
    </div>
  )
}

function SlaSettings({ isAdmin, onChanged }: { isAdmin: boolean; onChanged: () => void }) {
  const [policies, setPolicies] = useState<SlaPolicy[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.get<{ policies: Record<string, Omit<SlaPolicy, 'priority'>> }>('/api/sla').then(({ policies: p }) => {
      setPolicies(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((priority) => ({
        priority,
        firstResponseMinutes: p[priority]?.firstResponseMinutes ?? 60,
        resolutionMinutes: p[priority]?.resolutionMinutes ?? 480,
        escalationMinutes: p[priority]?.escalationMinutes ?? null,
        enabled: p[priority]?.enabled ?? true,
      })))
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [])

  async function save() {
    await api.put('/api/sla', { policies }).catch(() => undefined)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    onChanged()
  }

  return (
    <div className="detail-card settings-card" style={{ maxWidth: 900 }}>
      <div className="detail-card-title">
        <div><h3>SLA policies</h3><p>Resolution targets per priority. Breaches escalate automatically.</p></div>
        <div className="ai-icon"><ShieldCheck size={18} /></div>
      </div>
      {!loaded ? (
        <div className="settings-rows"><div className="settings-row"><span>Loading…</span></div></div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: '16px 0' }}>
            {policies.map((p) => (
              <div key={p.priority} style={{ display: 'grid', gridTemplateColumns: '86px 1fr 1fr', gap: 9, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 9, padding: '10px 12px' }}>
                <strong style={{ fontSize: 11, color: p.priority === 'CRITICAL' ? '#d64b60' : p.priority === 'HIGH' ? '#d6683f' : 'var(--foreground)' }}>{p.priority}</strong>
                <label style={{ fontSize: 10, color: 'var(--muted-foreground)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  Resolution (minutes)
                  <input type="number" min={1} value={p.resolutionMinutes} disabled={!isAdmin} onChange={(e) => setPolicies((prev) => prev.map((x) => x.priority === p.priority ? { ...x, resolutionMinutes: Number(e.target.value) || 1 } : x))} style={{ height: 32, border: '1px solid var(--input)', borderRadius: 7, padding: '0 8px', fontSize: 12, background: 'var(--background)', color: 'var(--foreground)' }} />
                </label>
                <label style={{ fontSize: 10, color: 'var(--muted-foreground)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  First response (minutes)
                  <input type="number" min={1} value={p.firstResponseMinutes} disabled={!isAdmin} onChange={(e) => setPolicies((prev) => prev.map((x) => x.priority === p.priority ? { ...x, firstResponseMinutes: Number(e.target.value) || 1 } : x))} style={{ height: 32, border: '1px solid var(--input)', borderRadius: 7, padding: '0 8px', fontSize: 12, background: 'var(--background)', color: 'var(--foreground)' }} />
                </label>
              </div>
            ))}
          </div>
          {isAdmin && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <Button size="sm" onClick={save}>Save SLA</Button>
              {saved && <span style={{ fontSize: 10.5, color: '#35966c' }}>Saved</span>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function CategorySettings({ isAdmin, onChanged }: { isAdmin: boolean; onChanged: () => void }) {
  const [categories, setCategories] = useState<CategoryRowLite[]>([])
  const [departments, setDepartments] = useState<DepartmentLite[]>([])
  const [name, setName] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [priority, setPriority] = useState('MEDIUM')

  const load = () => {
    api.get<{ categories: CategoryRowLite[] }>('/api/categories').then((d) => setCategories(d.categories)).catch(() => undefined)
    api.get<{ departments: DepartmentLite[] }>('/api/departments').then((d) => setDepartments(d.departments)).catch(() => undefined)
  }
  useEffect(load, [])

  async function add() {
    if (!name.trim()) return
    await api.post('/api/categories', { name: name.trim(), departmentId: departmentId || undefined, defaultPriority: priority }).catch(() => undefined)
    setName('')
    load()
    onChanged()
  }

  return (
    <div className="detail-card settings-card" style={{ maxWidth: 900 }}>
      <div className="detail-card-title">
        <div><h3>Complaint categories</h3><p>Used for classification and routing defaults.</p></div>
        <div className="ai-icon"><Ticket size={18} /></div>
      </div>
      {isAdmin && (
        <div style={{ display: 'flex', gap: 8, padding: '14px 0', flexWrap: 'wrap' }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Category name" style={{ height: 34, border: '1px solid var(--input)', borderRadius: 8, padding: '0 10px', fontSize: 12, background: 'var(--background)', color: 'var(--foreground)', flex: 1, minWidth: 140 }} />
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} style={{ height: 34, border: '1px solid var(--input)', borderRadius: 8, fontSize: 12, background: 'var(--background)', color: 'var(--foreground)', padding: '0 8px' }}>
            <option value="">No department</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ height: 34, border: '1px solid var(--input)', borderRadius: 8, fontSize: 12, background: 'var(--background)', color: 'var(--foreground)', padding: '0 8px' }}>
            {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <Button size="sm" onClick={add} disabled={!name.trim()}>Add</Button>
        </div>
      )}
      <div className="settings-rows">
        {categories.length === 0 && <div className="settings-row"><span>No categories yet. Add your first category above.</span></div>}
        {categories.map((c) => (
          <div className="settings-row" key={c.id}>
            <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>{c.name}</span>
            <strong style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {c.department?.name && <span className="category-chip">{c.department.name}</span>}
              <span className={`status-badge ${c.defaultPriority.toLowerCase()}`}>{c.defaultPriority}</span>
              {c.status === 'INACTIVE' && <span className="status-badge new">inactive</span>}
            </strong>
          </div>
        ))}
      </div>
    </div>
  )
}

function DepartmentSettings({ isAdmin, onChanged }: { isAdmin: boolean; onChanged: () => void }) {
  const [departments, setDepartments] = useState<DepartmentLite[]>([])
  const [name, setName] = useState('')

  const load = () => {
    api.get<{ departments: DepartmentLite[] }>('/api/departments').then((d) => setDepartments(d.departments)).catch(() => undefined)
  }
  useEffect(load, [])

  async function add() {
    if (!name.trim()) return
    await api.post('/api/departments', { name: name.trim() }).catch(() => undefined)
    setName('')
    load()
    onChanged()
  }

  return (
    <div className="detail-card settings-card" style={{ maxWidth: 900 }}>
      <div className="detail-card-title">
        <div><h3>Departments</h3><p>Complaints are routed to teams by department.</p></div>
        <div className="ai-icon"><Building2 size={18} /></div>
      </div>
      {isAdmin && (
        <div style={{ display: 'flex', gap: 8, padding: '14px 0' }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Department name" style={{ height: 34, border: '1px solid var(--input)', borderRadius: 8, padding: '0 10px', fontSize: 12, background: 'var(--background)', color: 'var(--foreground)', flex: 1 }} />
          <Button size="sm" onClick={add} disabled={!name.trim()}>Add</Button>
        </div>
      )}
      <div className="settings-rows">
        {departments.length === 0 && <div className="settings-row"><span>No departments yet. Add your first team above.</span></div>}
        {departments.map((d) => (
          <div className="settings-row" key={d.id}>
            <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>{d.name}</span>
            <strong style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 10.5 }}>
              <span style={{ color: 'var(--muted-foreground)', fontWeight: 400 }}>{d.staffCount} staff</span>
              <span style={{ color: 'var(--muted-foreground)', fontWeight: 400 }}>{d.openComplaints} open</span>
            </strong>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// WhatsApp view — Baileys QR onboarding with multiple numbers per organization
// ---------------------------------------------------------------------------

type WhatsAppAccountRow = {
  id: string
  label: string
  phoneNumber: string | null
  status: string
  lastConnectedAt: string | null
  lastError: string | null
  createdAt: string
  qr?: string | null
  qrExpiresAt?: number | null
}

export function WhatsAppView({ org, role, onChanged }: {
  org: OrganizationInfo
  role: string
  onChanged: () => void
}) {
  const isAdmin = role === 'ORGANIZATION_ADMIN' || role === 'SUPER_ADMIN'
  const [accounts, setAccounts] = useState<WhatsAppAccountRow[]>([])
  const [qrById, setQrById] = useState<Record<string, string | null>>({})
  const [label, setLabel] = useState('Customer Support')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const notifiedConnected = useRef(false)

  async function loadAccounts() {
    try {
      const result = await api.get<{ accounts: WhatsAppAccountRow[] }>('/api/whatsapp/accounts')
      setAccounts(result.accounts)
      const hasConnected = result.accounts.some((account) => account.status === 'CONNECTED')
      if (hasConnected && !notifiedConnected.current) {
        notifiedConnected.current = true
        onChanged()
      } else if (!hasConnected) {
        notifiedConnected.current = false
      }
      for (const account of result.accounts) {
        if (account.status === 'QR_PENDING' || account.status === 'CONNECTING') {
          try {
            const qr = await api.get<{ qr: string | null }>(`/api/whatsapp/accounts/${account.id}/qr`)
            setQrById((current) => ({ ...current, [account.id]: qr.qr }))
          } catch { /* the QR may not have been generated yet */ }
        } else if (account.status === 'CONNECTED') {
          setQrById((current) => ({ ...current, [account.id]: null }))
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load WhatsApp accounts')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAccounts()
    const timer = setInterval(() => void loadAccounts(), 3500)
    return () => clearInterval(timer)
  }, [])

  async function addAccount() {
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/whatsapp/accounts', { label: label.trim() || 'WhatsApp' })
      setLabel('')
      await loadAccounts()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start WhatsApp connection')
    } finally {
      setBusy(false)
    }
  }

  async function removeAccount(id: string) {
    if (!window.confirm('Remove this WhatsApp number and its saved linked-device session?')) return
    setBusy(true)
    setError(null)
    try {
      await api.delete(`/api/whatsapp/accounts/${id}`)
      setQrById((current) => { const next = { ...current }; delete next[id]; return next })
      await loadAccounts()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove WhatsApp account')
    } finally {
      setBusy(false)
    }
  }

  async function reconnect(id: string) {
    setBusy(true)
    setError(null)
    try {
      await api.post(`/api/whatsapp/accounts/${id}/connect`, {})
      await loadAccounts()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reconnect WhatsApp')
    } finally {
      setBusy(false)
    }
  }

  const connected = accounts.filter((account) => account.status === 'CONNECTED').length
  const pending = accounts.filter((account) => ['CONNECTING', 'QR_PENDING'].includes(account.status)).length

  function statusLabel(status: string) {
    if (status === 'CONNECTED') return 'Connected'
    if (status === 'QR_PENDING') return 'Scan QR code'
    if (status === 'CONNECTING') return 'Connecting'
    if (status === 'LOGGED_OUT') return 'Logged out'
    if (status === 'ERROR') return 'Error'
    return 'Disconnected'
  }

  function statusColor(status: string) {
    if (status === 'CONNECTED') return '#269b70'
    if (status === 'ERROR' || status === 'LOGGED_OUT') return '#d64b60'
    if (status === 'QR_PENDING' || status === 'CONNECTING') return '#c58a24'
    return 'var(--muted-foreground)'
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Connect / WhatsApp</div>
          <h1>WhatsApp connections</h1>
          <p>Connect multiple WhatsApp numbers to {org.name}. Each number has its own session and conversations.</p>
        </div>
      </div>

      <div className="settings-grid" style={{ maxWidth: 1050 }}>
        <div className="detail-card settings-card">
          <div className="detail-card-title">
            <div><h3>Your WhatsApp numbers</h3><p>Link a phone using WhatsApp → Linked Devices → Link a Device.</p></div>
            <div className="ai-icon"><MessageCircle size={18} /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, padding: '10px 0 18px' }}>
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}><div style={{ fontSize: 22, fontWeight: 700 }}>{accounts.length}</div><div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>Total numbers</div></div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}><div style={{ fontSize: 22, fontWeight: 700, color: '#269b70' }}>{connected}</div><div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>Connected</div></div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}><div style={{ fontSize: 22, fontWeight: 700, color: '#c58a24' }}>{pending}</div><div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>Awaiting scan</div></div>
          </div>

          {loading && <div className="settings-row"><span>Loading WhatsApp accounts…</span></div>}
          {!loading && accounts.length === 0 && (
            <div style={{ border: '1px dashed var(--border)', borderRadius: 12, padding: '28px 16px', textAlign: 'center', marginBottom: 14 }}>
              <div className="ai-icon" style={{ margin: '0 auto 10px' }}><QrCode size={22} /></div>
              <strong style={{ display: 'block', marginBottom: 5 }}>No WhatsApp numbers connected</strong>
              <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>Add your first number below. You will scan a QR code using the WhatsApp mobile app.</span>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {accounts.map((account) => (
              <div key={account.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div className="ai-icon"><Smartphone size={17} /></div>
                    <div>
                      <strong style={{ display: 'block', fontSize: 13 }}>{account.label}</strong>
                      <span style={{ color: 'var(--muted-foreground)', fontSize: 11 }}>{account.phoneNumber ? `+${account.phoneNumber}` : 'Phone number appears after QR login'}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 11, fontWeight: 650, color: statusColor(account.status) }}>{statusLabel(account.status)}</span>
                    {isAdmin && <button title="Remove number" onClick={() => void removeAccount(account.id)} disabled={busy} style={{ border: 0, background: 'transparent', color: 'var(--muted-foreground)', cursor: 'pointer', padding: 5 }}><Trash2 size={15} /></button>}
                  </div>
                </div>
                {qrById[account.id] && account.status !== 'CONNECTED' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', marginTop: 14, padding: 12, borderRadius: 10, background: 'var(--muted)' }}>
                    <img src={qrById[account.id] || ''} alt={`WhatsApp QR for ${account.label}`} width={190} height={190} style={{ background: '#fff', borderRadius: 8, padding: 8 }} />
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <strong style={{ display: 'block', marginBottom: 7, fontSize: 13 }}>Scan to connect</strong>
                      <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.8, color: 'var(--muted-foreground)' }}>
                        <li>Open WhatsApp on your phone.</li>
                        <li>Go to Linked Devices.</li>
                        <li>Tap Link a Device and scan this QR.</li>
                      </ol>
                      <span style={{ display: 'block', fontSize: 10, color: 'var(--muted-foreground)', marginTop: 8 }}>QR codes expire. The screen refreshes automatically while waiting.</span>
                    </div>
                  </div>
                )}
                {['CONNECTING', 'QR_PENDING'].includes(account.status) && !qrById[account.id] && <div style={{ marginTop: 12, fontSize: 11, color: 'var(--muted-foreground)', display: 'flex', alignItems: 'center', gap: 7 }}><Loader2 size={14} /> Preparing secure WhatsApp session…</div>}
                {account.status === 'CONNECTED' && <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, color: '#269b70', fontSize: 11 }}><CircleCheck size={14} /> This number is ready to receive customer messages.</div>}
                {account.lastError && <div className="auth-error" style={{ marginTop: 10 }}>{account.lastError}</div>}
                {isAdmin && ['DISCONNECTED', 'LOGGED_OUT', 'ERROR'].includes(account.status) && <Button size="sm" variant="outline" onClick={() => void reconnect(account.id)} disabled={busy} style={{ marginTop: 10 }}><RefreshCw size={13} /> Reconnect</Button>}
              </div>
            ))}
          </div>

          {isAdmin && (
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 18, paddingTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'end', gap: 10, flexWrap: 'wrap' }}>
                <div className="auth-field" style={{ flex: 1, minWidth: 200 }}><label>New number label</label><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sales, Support, Billing" /></div>
                <Button size="sm" onClick={() => void addAccount()} disabled={busy || label.trim().length < 2}><Plus size={14} /> {busy ? 'Starting…' : 'Add WhatsApp number'}</Button>
              </div>
            </div>
          )}
          {error && <div className="auth-error" style={{ marginTop: 12 }}>{error}</div>}
        </div>

        <div className="ai-card settings-help">
          <div className="ai-card-top"><div className="ai-icon"><ShieldCheck size={18} /></div><span>Private linked-device sessions</span></div>
          <h3>Connect without Meta API credentials.</h3>
          <p>SmartServe uses Baileys to link each WhatsApp account as a companion device. No Meta developer credentials or separate provider dashboard is required.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11 }}><CheckCircle2 size={15} color="#269b70" /> Separate session for every number</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11 }}><CheckCircle2 size={15} color="#269b70" /> QR status updates automatically</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11 }}><CheckCircle2 size={15} color="#269b70" /> Sessions restored from Turso-backed credentials</div>
          </div>
          <p style={{ marginTop: 14, fontSize: 10 }}>Baileys is an unofficial WhatsApp Web integration. Use responsibly and avoid unsolicited or bulk messaging.</p>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Profile view (session-backed, spec §43)
// ---------------------------------------------------------------------------

export function ProfileView({ user, members }: { user: { id?: string; name?: string | null; email?: string | null; image?: string | null }; members: MemberRow[] }) {
  const me = members.find((m) => m.user.id === user.id)
  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Account / Profile</div>
          <h1>Your profile</h1>
          <p>Manage your personal details and workspace presence.</p>
        </div>
      </div>
      <div className="settings-grid" style={{ maxWidth: 980 }}>
        <div className="detail-card settings-card">
          <div className="detail-card-title">
            <div><h3>Account details</h3><p>Synced from your SmartServe account.</p></div>
            <div className="ai-icon"><UserRound size={18} /></div>
          </div>
          <div className="settings-rows">
            <div className="settings-row"><span>Full name</span><strong>{user.name ?? '—'}</strong></div>
            <div className="settings-row"><span>Work email</span><strong>{user.email ?? '—'}</strong></div>
            <div className="settings-row"><span>Role</span><strong>{me?.role ? me.role.replace('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : 'Member'}</strong></div>
            <div className="settings-row"><span>Department</span><strong>{me?.department?.name ?? '—'}</strong></div>
            <div className="settings-row"><span>Member since</span><strong>{formatDate(me?.createdAt)}</strong></div>
          </div>
        </div>
        <div className="ai-card settings-help">
          <div className="ai-card-top"><div className="ai-icon"><Sparkles size={18} /></div><span>SmartServe guidance</span></div>
          <h3>One account, one team.</h3>
          <p>Need different permissions? Organization admins can change roles from Management → Settings → Organization.</p>
        </div>
      </div>
    </div>
  )
}
