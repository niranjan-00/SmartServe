'use client'

import { useEffect, useState } from 'react'
import { Search, Send, MessageCircle, Wifi } from 'lucide-react'
import { api, ApiClientError, type StaffMetricRow } from '@/lib/api'
import { StatusBadge } from './complaints-view'
import { initialsOf, formatDateTime, relativeTime, priorityTone, priorityLabel } from './display'

/**
 * Conversations / Customers / Staff / Analytics views — extend the original
 * UI's visual vocabulary to the remaining nav destinations (spec §42/§43/§46).
 */

// ---------------------------------------------------------------------------
// Conversations (spec §52)
// ---------------------------------------------------------------------------

interface ConversationRow {
  id: string
  status: string
  customer: { id: string; name: string | null; phoneNumber: string }
  lastMessage: string | null
  lastMessageAt: string | null
  messageCount: number
  connection?: { displayPhoneNumber: string | null; status: string } | null
}

interface MessageRow {
  id: string
  direction: string
  senderType: string
  content: string | null
  status: string
  createdAt: string
}

export function ConversationsView({ onRefresh, defaultConversationId }: { onRefresh: () => void; defaultConversationId?: string | null }) {
  const [rows, setRows] = useState<ConversationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [activeId, setActiveId] = useState<string | null>(defaultConversationId ?? null)
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [activeCustomer, setActiveCustomer] = useState<{ name: string | null; phoneNumber: string } | null>(null)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)

  const loadList = async () => {
    try {
      const q = search ? `&search=${encodeURIComponent(search)}` : ''
      const data = await api.get<{ conversations: ConversationRow[] }>(`/api/conversations?pageSize=50${q}`)
      setRows(data.conversations)
      if (!activeId && data.conversations.length > 0) setActiveId(defaultConversationId ?? data.conversations[0].id)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void loadList() }, [search])

  useEffect(() => {
    if (!activeId) return
    api.get<{ conversation: { customer: { name: string | null; phoneNumber: string }; messages: MessageRow[]; whatsapp?: { status: string } | null } }>(`/api/conversations/${activeId}/messages`)
      .then((d) => {
        setMessages(d.conversation.messages)
        setActiveCustomer(d.conversation.customer)
        setConnected(d.conversation.whatsapp?.status === 'CONNECTED')
        setError(null)
      })
      .catch(() => undefined)
  }, [activeId])

  async function send() {
    if (!activeId || !reply.trim()) return
    setSending(true)
    setError(null)
    try {
      await api.post(`/api/conversations/${activeId}/messages`, { content: reply.trim() })
      setReply('')
      onRefresh()
      const d = await api.get<{ conversation: { messages: MessageRow[] } }>(`/api/conversations/${activeId}/messages`)
      setMessages(d.conversation.messages)
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not send — WhatsApp connection required')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Workspace / Conversations</div>
          <h1>Conversations</h1>
          <p>Every WhatsApp thread, with full history.</p>
        </div>
        <StatusBadge kind={connected ? 'resolved' : 'new'}>
          <Wifi size={11} style={{ marginRight: 4 }} />{connected ? 'WhatsApp connected' : 'WhatsApp not connected'}
        </StatusBadge>
      </div>
      <div className="filter-bar">
        <div className="search-field">
          <Search size={16} />
          <input placeholder="Search customers..." value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search conversations" />
        </div>
      </div>
      <div className="detail-grid" style={{ gridTemplateColumns: 'minmax(240px,1fr) minmax(0,2fr)' }}>
        <div className="table-card" style={{ maxHeight: 620, overflowY: 'auto' }}>
          {loading && <div style={{ padding: 18, fontSize: 11, color: '#a2adba' }}>Loading…</div>}
          {!loading && rows.length === 0 && <div style={{ padding: 18, fontSize: 11, color: '#a2adba' }}>No conversations yet. Incoming WhatsApp messages appear here.</div>}
          {rows.map((c) => (
            <button key={c.id} onClick={() => setActiveId(c.id)} style={{ display: 'flex', gap: 9, width: '100%', textAlign: 'left', padding: '12px 14px', background: activeId === c.id ? 'var(--sidebar-accent)' : 'transparent', border: 0, borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
              <span className="assignee-dot" style={{ width: 26, height: 26, fontSize: 10 }}>{initialsOf(c.customer.name ?? c.customer.phoneNumber)}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ display: 'block', fontSize: 11.5, color: 'var(--foreground)' }}>{c.customer.name ?? c.customer.phoneNumber}</strong>
                <span style={{ display: 'block', fontSize: 10, color: 'var(--muted-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.lastMessage ?? 'No messages'}</span>
              </span>
              <span style={{ fontSize: 9, color: '#a2adba', whiteSpace: 'nowrap' }}>{c.lastMessageAt ? relativeTime(c.lastMessageAt) : ''}</span>
            </button>
          ))}
        </div>
        <div className="detail-card conversation-card" style={{ display: 'flex', flexDirection: 'column' }}>
          {activeCustomer ? (
            <>
              <div className="detail-card-title">
                <div><h3>{activeCustomer.name ?? activeCustomer.phoneNumber}</h3><p>{activeCustomer.phoneNumber} · WhatsApp thread</p></div>
                <StatusBadge kind="neutral">{messages.length} messages</StatusBadge>
              </div>
              <div className="messages" style={{ flex: 1, overflowY: 'auto', maxHeight: 440 }}>
                {messages.map((m) => {
                  const outbound = m.direction === 'OUTBOUND'
                  return (
                    <div key={m.id} className={`message ${outbound ? 'agent-message' : 'customer-message'}`}>
                      <span>{m.content}</span>
                      <time>{formatDateTime(m.createdAt)}{outbound ? (m.status === 'FAILED' ? ' · failed' : m.status === 'READ' ? ' · ✓✓' : ' · ✓') : ''}</time>
                    </div>
                  )
                })}
              </div>
              {error && <div className="auth-error" style={{ marginTop: 10 }}>{error}</div>}
              <div className="reply-box">
                <input placeholder={connected ? 'Reply to customer...' : 'Connect WhatsApp Business to reply...'} disabled={!connected} value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} aria-label="Reply" />
                <button aria-label="Send" onClick={send} disabled={!connected || sending || !reply.trim()}><Send size={15} /></button>
              </div>
            </>
          ) : (
            <div style={{ padding: 30, textAlign: 'center', color: '#a2adba', fontSize: 11 }}>
              <MessageCircle size={20} style={{ marginBottom: 8 }} />
              <div>Select a conversation to view the full thread.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Customers (spec §42)
// ---------------------------------------------------------------------------

interface CustomerListRow {
  id: string
  name: string | null
  phoneNumber: string
  totalTickets: number
  openTickets: number
  satisfaction: number | null
  createdAt: string
}

export function CustomersView() {
  const [rows, setRows] = useState<CustomerListRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    const q = search ? `&search=${encodeURIComponent(search)}` : ''
    api.get<{ customers: CustomerListRow[] }>(`/api/customers?pageSize=50${q}`)
      .then((d) => setRows(d.customers))
      .finally(() => setLoading(false))
  }, [search])

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Workspace / Customers</div>
          <h1>Customers</h1>
          <p>People who reached your organization on WhatsApp.</p>
        </div>
      </div>
      <div className="filter-bar">
        <div className="search-field">
          <Search size={16} />
          <input placeholder="Search name or phone..." value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search customers" />
        </div>
      </div>
      <div className="table-card complaints-table">
        <div className="table-scroll">
          <table>
            <thead><tr><th>Customer</th><th>Phone</th><th>Open tickets</th><th>Total tickets</th><th>Satisfaction</th><th>First seen</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={6}><div style={{ padding: 20, color: '#a2adba', fontSize: 11 }}>Loading…</div></td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={6}><div style={{ padding: 20, color: '#a2adba', fontSize: 11 }}>No customers yet — they are created automatically from WhatsApp conversations.</div></td></tr>}
              {rows.map((c) => (
                <tr key={c.id}>
                  <td><div className="customer-cell"><div className="avatar avatar-blue">{initialsOf(c.name ?? c.phoneNumber)}</div><div><strong>{c.name ?? 'Unknown'}</strong><span>WhatsApp customer</span></div></div></td>
                  <td style={{ fontSize: 11 }}>{c.phoneNumber}</td>
                  <td><StatusBadge kind={c.openTickets > 0 ? 'in-progress' : 'resolved'}>{c.openTickets}</StatusBadge></td>
                  <td>{c.totalTickets}</td>
                  <td>{c.satisfaction != null ? `${c.satisfaction.toFixed(1)} / 5` : '—'}</td>
                  <td style={{ fontSize: 10.5, color: 'var(--muted-foreground)' }}>{formatDateTime(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Staff (spec §39/§43)
// ---------------------------------------------------------------------------

export function StaffView() {
  const [rows, setRows] = useState<StaffMetricRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.get<{ staff: StaffMetricRow[] }>('/api/staff')
      .then((d) => setRows(d.staff))
      .catch((err) => setError(err instanceof ApiClientError ? err.message : 'Could not load staff'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Operations / Staff</div>
          <h1>Staff</h1>
          <p>Operational metrics for every team member — no rankings, just real workload.</p>
        </div>
      </div>
      {error && <div className="auth-error">{error}</div>}
      <div className="table-card complaints-table">
        <div className="table-scroll">
          <table>
            <thead><tr><th>Staff</th><th>Role</th><th>Department</th><th>Open</th><th>Assigned</th><th>Resolved</th><th>Avg. resolution</th><th>SLA compliance</th><th>Rating</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={9}><div style={{ padding: 20, color: '#a2adba', fontSize: 11 }}>Loading…</div></td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={9}><div style={{ padding: 20, color: '#a2adba', fontSize: 11 }}>No staff members yet — invite your team from onboarding or Settings.</div></td></tr>}
              {rows.map((s) => (
                <tr key={s.userId}>
                  <td><div className="customer-cell"><div className="avatar avatar-blue">{initialsOf(s.name ?? s.email)}</div><div><strong>{s.name ?? s.email}</strong><span>{s.email}</span></div></div></td>
                  <td style={{ fontSize: 10.5 }}>{s.role.replace('_', ' ').toLowerCase()}</td>
                  <td style={{ fontSize: 10.5 }}>{s.department ?? '—'}</td>
                  <td><StatusBadge kind={s.openTickets > 0 ? 'in-progress' : 'resolved'}>{s.openTickets}</StatusBadge></td>
                  <td>{s.assigned}</td>
                  <td>{s.resolved}</td>
                  <td>{s.averageResolutionHours != null ? (s.averageResolutionHours < 1 ? `${Math.round(s.averageResolutionHours * 60)}m` : `${s.averageResolutionHours.toFixed(1)}h`) : '—'}</td>
                  <td>{s.slaCompliance != null ? `${s.slaCompliance}%` : '—'}</td>
                  <td>{s.customerRating != null ? `${s.customerRating.toFixed(1)} / 5` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Analytics (spec §46)
// ---------------------------------------------------------------------------

interface OverviewLite {
  categoryDistribution: Array<{ name: string; count: number }>
  priorityDistribution: Array<{ name: string; count: number }>
  departmentStatistics: Array<{ name: string; total: number; open: number; resolved: number }>
  trend: Array<{ day: string; received: number; resolved: number }>
  slaCompliance: number | null
  averageResolutionHours: number | null
  customerSatisfaction: number | null
}

export function AnalyticsView({ overview }: { overview: OverviewLite | null }) {
  const maxCat = Math.max(1, ...(overview?.categoryDistribution.map((c) => c.count) ?? [1]))
  const maxPri = Math.max(1, ...(overview?.priorityDistribution.map((c) => c.count) ?? [1]))
  const maxTrend = Math.max(1, ...(overview?.trend.map((d) => Math.max(d.received, d.resolved)) ?? [1]))

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Operations / Analytics</div>
          <h1>Analytics</h1>
          <p>Computed from real complaints, resolutions and feedback — no estimates.</p>
        </div>
      </div>
      <div className="metric-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        <div className="metric-card"><div className="metric-head"><span>SLA compliance</span></div><div className="metric-value">{overview?.slaCompliance != null ? `${Math.round(overview.slaCompliance)}%` : '—'}</div><div className="metric-foot"><span className="delta">resolved within SLA</span></div></div>
        <div className="metric-card"><div className="metric-head"><span>Avg. resolution</span></div><div className="metric-value">{overview?.averageResolutionHours != null ? (overview.averageResolutionHours < 1 ? `${Math.round(overview.averageResolutionHours * 60)}m` : `${overview.averageResolutionHours.toFixed(1)}h`) : '—'}</div><div className="metric-foot"><span className="delta">last 30 days</span></div></div>
        <div className="metric-card"><div className="metric-head"><span>Customer satisfaction</span></div><div className="metric-value">{overview?.customerSatisfaction != null ? `${overview.customerSatisfaction.toFixed(1)} / 5` : '—'}</div><div className="metric-foot"><span className="delta">from customer feedback</span></div></div>
      </div>
      <div className="dashboard-grid" style={{ marginTop: 14 }}>
        <div className="trend-card">
          <div className="card-heading"><div><h3>Weekly volume</h3><p>Received vs. resolved per day</p></div></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 20 }}>
            {(overview?.trend ?? []).map((d) => (
              <div key={d.day} style={{ display: 'grid', gridTemplateColumns: '44px 1fr', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 9.5, color: '#a7b0be' }}>{new Date(d.day).toLocaleDateString('en-IN', { weekday: 'short' })}</span>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <div style={{ width: `${(d.received / maxTrend) * 70}%`, minWidth: d.received ? 8 : 0, height: 7, borderRadius: 4, background: '#3578ee' }} />
                  <div style={{ width: `${(d.resolved / maxTrend) * 70}%`, minWidth: d.resolved ? 8 : 0, height: 7, borderRadius: 4, background: '#a78bfa' }} />
                  <span style={{ fontSize: 9, color: '#9aa5b3', marginLeft: 4 }}>{d.received} / {d.resolved}</span>
                </div>
              </div>
            ))}
            {(!overview || overview.trend.length === 0) && <div style={{ color: '#a2adba', fontSize: 11 }}>Trend data appears as complaints arrive.</div>}
          </div>
        </div>
        <div className="ai-card">
          <div className="ai-card-top"><div className="ai-icon"><MessageCircle size={18} /></div><span>Breakdown</span></div>
          <h3>By category &amp; priority</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 16 }}>
            {(overview?.categoryDistribution ?? []).slice(0, 6).map((c) => (
              <div key={c.name} style={{ display: 'grid', gridTemplateColumns: '1fr 34px', gap: 8, alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, height: 7, background: '#dce5f7', borderRadius: 4 }}><div style={{ width: `${(c.count / maxCat) * 100}%`, height: '100%', borderRadius: 4, background: '#6b8ee7' }} /></div>
                  <span style={{ fontSize: 9.5, color: 'var(--muted-foreground)', minWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                </div>
                <strong style={{ fontSize: 11 }}>{c.count}</strong>
              </div>
            ))}
            {(!overview || overview.categoryDistribution.length === 0) && <div style={{ color: '#a2adba', fontSize: 10.5 }}>Categories appear after complaints are classified.</div>}
          </div>
          <div style={{ display: 'flex', gap: 7, marginTop: 16, flexWrap: 'wrap' }}>
            {(overview?.priorityDistribution ?? []).map((p) => (
              <span key={p.name} className={`status-badge ${priorityTone(p.name)}`} style={{ fontSize: 9.5 }}>{priorityLabel(p.name)}: {p.count}</span>
            ))}
            {(!overview || overview.priorityDistribution.length === 0) && <div style={{ color: '#a2adba', fontSize: 10.5 }}>No complaints yet.</div>}
          </div>
        </div>
      </div>
      <div className="table-card complaints-table" style={{ marginTop: 14 }}>
        <div className="table-head"><div><h3>Department statistics</h3><p>Volume, load and throughput per team</p></div></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Department</th><th>Total</th><th>Open</th><th>Resolved</th><th>Resolution rate</th></tr></thead>
            <tbody>
              {(!overview || overview.departmentStatistics.length === 0) && <tr><td colSpan={5}><div style={{ padding: 20, color: '#a2adba', fontSize: 11 }}>Departments appear as complaints are routed.</div></td></tr>}
              {(overview?.departmentStatistics ?? []).map((d) => (
                <tr key={d.name}>
                  <td><strong style={{ fontSize: 11 }}>{d.name}</strong></td>
                  <td>{d.total}</td>
                  <td><StatusBadge kind={d.open > 0 ? 'in-progress' : 'resolved'}>{d.open}</StatusBadge></td>
                  <td>{d.resolved}</td>
                  <td>{d.total > 0 ? `${Math.round((d.resolved / d.total) * 100)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Departments (spec §44)
// ---------------------------------------------------------------------------

interface DepartmentStatRow {
  id: string
  name: string
  description: string | null
  staffCount: number
  complaintCount: number
  openComplaints: number
  resolvedComplaints: number
}

export function DepartmentsView() {
  const [rows, setRows] = useState<DepartmentStatRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get<{ departments: DepartmentStatRow[] }>('/api/departments')
      .then((d) => setRows(d.departments))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Operations / Departments</div>
          <h1>Departments</h1>
          <p>Teams that own complaints across your organization.</p>
        </div>
      </div>
      <div className="table-card complaints-table">
        <div className="table-scroll">
          <table>
            <thead><tr><th>Department</th><th>Staff</th><th>Total complaints</th><th>Open</th><th>Resolved</th><th>Resolution rate</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={6}><div style={{ padding: 20, color: '#a2adba', fontSize: 11 }}>Loading…</div></td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={6}><div style={{ padding: 20, color: '#a2adba', fontSize: 11 }}>No departments yet — create them in Settings → Departments.</div></td></tr>}
              {rows.map((d) => (
                <tr key={d.id}>
                  <td><div className="customer-cell"><div className="avatar avatar-violet" style={{ background: '#f0ecff', color: '#8067d5' }}>{initialsOf(d.name)}</div><div><strong>{d.name}</strong><span>{d.description ?? 'Team'}</span></div></div></td>
                  <td>{d.staffCount}</td>
                  <td>{d.complaintCount}</td>
                  <td><StatusBadge kind={d.openComplaints > 0 ? 'in-progress' : 'resolved'}>{d.openComplaints}</StatusBadge></td>
                  <td>{d.resolvedComplaints}</td>
                  <td>{d.complaintCount > 0 ? `${Math.round((d.resolvedComplaints / d.complaintCount) * 100)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
