'use client'

import { useEffect, useState } from 'react'
import { Bell, CheckCircle2, Clock3, X, UserRound, Bot, Inbox, AlertCircle, Sparkles, Building2, Wifi, ShieldCheck, Ticket } from 'lucide-react'
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
// WhatsApp view (real connection state, spec §54)
// ---------------------------------------------------------------------------

type SimState = { ok: boolean; message: string } | null

export function WhatsAppView({ org, role, onChanged }: {
  org: OrganizationInfo
  role: string
  onChanged: () => void
}) {
  const isAdmin = role === 'ORGANIZATION_ADMIN' || role === 'SUPER_ADMIN'
  const [connection, setConnection] = useState<{ status: string; mode: string; displayPhoneNumber: string | null; phoneNumberId: string | null; statusMessage: string | null } | null>(null)
  const [form, setForm] = useState({ wabaId: '', phoneNumberId: '', displayPhoneNumber: '', accessToken: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [simFrom, setSimFrom] = useState('')
  const [simText, setSimText] = useState('')
  const [simResult, setSimResult] = useState<SimState>(null)

  const load = () => {
    api.get<{ connection: { status: string; mode: string; displayPhoneNumber: string | null; phoneNumberId: string | null; statusMessage: string | null } }>('/api/whatsapp/connection')
      .then((d) => setConnection(d.connection))
      .catch(() => undefined)
  }
  useEffect(load, [])

  const isConnected = connection?.status === 'CONNECTED'

  async function connect() {
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/whatsapp/connection', form)
      setForm({ wabaId: '', phoneNumberId: '', displayPhoneNumber: '', accessToken: '' })
      load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    await api.delete('/api/whatsapp/connection').catch(() => undefined)
    setBusy(false)
    load()
    onChanged()
  }

  async function simulate() {
    setSimResult(null)
    try {
      await api.post('/api/dev/simulate-message', { from: simFrom, text: simText })
      setSimResult({ ok: true, message: 'Message injected through the webhook pipeline. Check Conversations & Complaints.' })
    } catch (err) {
      setSimResult({ ok: false, message: err instanceof Error ? err.message : 'Simulation failed' })
    }
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Connect / WhatsApp</div>
          <h1>WhatsApp</h1>
          <p>Connect your WhatsApp Business number to receive and resolve complaints automatically.</p>
        </div>
        {isAdmin && isConnected && <Button variant="outline" onClick={disconnect} disabled={busy}>Disconnect</Button>}
      </div>
      <div className="settings-grid" style={{ maxWidth: 980 }}>
        <div className="detail-card settings-card">
          <div className="detail-card-title">
            <div><h3>WhatsApp Business connection</h3><p>Meta WhatsApp Business Cloud API</p></div>
            <div className="ai-icon"><Wifi size={18} /></div>
          </div>
          <div className="settings-rows">
            <div className="settings-row"><span>Connection status</span><strong style={{ color: isConnected ? '#35966c' : connection?.status === 'ERROR' ? '#d64b60' : 'var(--muted-foreground)' }}>
              {connection?.status === 'NOT_CONNECTED' ? 'Not connected' : connection?.status === 'CONNECTED' ? 'Connected' : connection?.status === 'CONNECTING' ? 'Connecting…' : connection?.status === 'ERROR' ? 'Error' : connection?.status ?? 'Not connected'}
            </strong></div>
            <div className="settings-row"><span>Mode</span><strong>{connection?.mode === 'development' ? 'Development adapter' : 'Meta Cloud API'}</strong></div>
            <div className="settings-row"><span>Phone number</span><strong>{connection?.displayPhoneNumber ?? 'Add a business number'}</strong></div>
            <div className="settings-row"><span>Phone number ID</span><strong>{connection?.phoneNumberId ?? '—'}</strong></div>
            {connection?.statusMessage && (
              <div className="settings-row"><span>Status detail</span><strong style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={connection.statusMessage}>{connection.statusMessage}</strong></div>
            )}
          </div>

          {isAdmin && (
            <div style={{ padding: '18px 0 4px' }}>
              {!isConnected ? (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div className="auth-field"><label>WABA ID</label><input value={form.wabaId} onChange={(e) => setForm({ ...form, wabaId: e.target.value })} placeholder="1024578..." /></div>
                    <div className="auth-field"><label>Phone number ID</label><input value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })} placeholder="106540..." /></div>
                    <div className="auth-field"><label>Display phone number</label><input value={form.displayPhoneNumber} onChange={(e) => setForm({ ...form, displayPhoneNumber: e.target.value })} placeholder="+91 98765 43210" /></div>
                    <div className="auth-field"><label>Access token</label><input type="password" value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} placeholder="EAAG..." /></div>
                  </div>
                  {error && <div className="auth-error">{error}</div>}
                  <Button size="sm" onClick={connect} disabled={busy || !form.wabaId || !form.phoneNumberId || !form.displayPhoneNumber || form.accessToken.length < 8}>
                    {busy ? 'Connecting…' : 'Connect WhatsApp Business'}
                  </Button>
                </>
              ) : (
                <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>Connected — incoming messages for this number become conversations and complaints automatically.</span>
              )}
            </div>
          )}
        </div>

        <div className="ai-card settings-help">
          <div className="ai-card-top"><div className="ai-icon"><Bot size={18} /></div><span>Development adapter</span></div>
          <h3>Test the full pipeline locally.</h3>
          <p>Inject a simulated customer message through the real webhook path — customer creation, bot flow, complaint, AI analysis and assignment all run exactly as in production.</p>
          {isAdmin && connection && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
              <input value={simFrom} onChange={(e) => setSimFrom(e.target.value)} placeholder="Customer phone (e.g. 919876543210)" style={{ height: 34, border: '1px solid var(--border)', borderRadius: 8, padding: '0 10px', fontSize: 11.5, background: 'var(--card)', color: 'var(--foreground)' }} />
              <input value={simText} onChange={(e) => setSimText(e.target.value)} placeholder="Message, e.g. The AC in room 204 is not working" style={{ height: 34, border: '1px solid var(--border)', borderRadius: 8, padding: '0 10px', fontSize: 11.5, background: 'var(--card)', color: 'var(--foreground)' }} />
              <Button size="sm" onClick={simulate} disabled={!simFrom || !simText}>Simulate inbound message</Button>
              {simResult && <div className={simResult.ok ? 'auth-info' : 'auth-error'} style={{ marginBottom: 0 }}>{simResult.message}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Profile view (session-backed, spec §43)
// ---------------------------------------------------------------------------

export function ProfileView({ user, members }: { user: { name?: string | null; email?: string | null; image?: string | null }; members: MemberRow[] }) {
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
