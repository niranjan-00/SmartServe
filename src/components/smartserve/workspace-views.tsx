
'use client'

import { useEffect, useState } from 'react'
import {
  Search,
  Send,
  MessageCircle,
  Wifi,
  RefreshCw,
  UserPlus,
  X,
  Save,
  Trash2,
} from 'lucide-react'
import { api, ApiClientError, type StaffMetricRow } from '@/lib/api'
import { StatusBadge } from './complaints-view'
import {
  initialsOf,
  formatDateTime,
  relativeTime,
  priorityTone,
  priorityLabel,
} from './display'

/**
 * Conversations / Customers / Staff / Analytics views.
 */

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

interface ConversationRow {
  id: string
  status: string
  customer: { id: string; name: string | null; phoneNumber: string }
  lastMessage: string | null
  lastMessageAt: string | null
  messageCount: number
  connection?: {
    displayPhoneNumber?: string | null
    phoneNumber?: string | null
    label?: string
    status: string
  } | null
  whatsappAccount?: {
    id: string
    label: string
    phoneNumber: string | null
    status: string
  } | null
}

interface MessageRow {
  id: string
  direction: string
  senderType: string
  content: string | null
  status: string
  createdAt: string
}

export function ConversationsView({
  onRefresh,
  defaultConversationId,
}: {
  onRefresh: () => void
  defaultConversationId?: string | null
}) {
  const [rows, setRows] = useState<ConversationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [activeId, setActiveId] = useState<string | null>(
    defaultConversationId ?? null
  )
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [activeCustomer, setActiveCustomer] = useState<{
    name: string | null
    phoneNumber: string
  } | null>(null)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Overall organization WhatsApp connection status.
  const [whatsappConnected, setWhatsappConnected] = useState(false)

  // Connection status for the selected conversation.
  const [conversationConnected, setConversationConnected] = useState(false)

  const loadWhatsAppStatus = async () => {
    try {
      const data = await api.get<{
        accounts: Array<{ status: string }>
      }>('/api/whatsapp/accounts')

      setWhatsappConnected(
        (data.accounts ?? []).some(
          (account) => account.status?.toUpperCase() === 'CONNECTED'
        )
      )
    } catch (err) {
      console.error('Could not load WhatsApp account status:', err)
      setWhatsappConnected(false)
    }
  }

  const loadList = async () => {
    try {
      const q = search ? `&search=${encodeURIComponent(search)}` : ''

      const data = await api.get<{
        conversations: ConversationRow[]
      }>(`/api/conversations?pageSize=50${q}`)

      setRows(data.conversations ?? [])

      if (!activeId && data.conversations?.length > 0) {
        setActiveId(
          defaultConversationId ?? data.conversations[0].id
        )
      }
    } catch (err) {
      console.error('Could not load conversations:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadList()
  }, [search])

  // This is independent of the selected conversation.
  useEffect(() => {
    void loadWhatsAppStatus()
  }, [])

  // Load the selected conversation and its messages.
  useEffect(() => {
    if (!activeId) {
      setMessages([])
      setActiveCustomer(null)
      setConversationConnected(false)
      return
    }

    let cancelled = false

    api.get<{
      conversation: {
        customer: {
          name: string | null
          phoneNumber: string
        }
        messages: MessageRow[]
        whatsapp?: { status: string } | null
        whatsappAccount?: {
          label: string
          phoneNumber: string | null
          status: string
        } | null
      }
    }>(`/api/conversations/${activeId}/messages`)
      .then((d) => {
        if (cancelled) return

        setMessages(d.conversation.messages ?? [])
        setActiveCustomer(d.conversation.customer)

        const status =
          d.conversation.whatsappAccount?.status ??
          d.conversation.whatsapp?.status

        setConversationConnected(
          status?.toUpperCase() === 'CONNECTED'
        )

        setError(null)
      })
      .catch((err) => {
        if (!cancelled) {
          console.error(
            'Could not load conversation messages:',
            err
          )
        }
      })

    return () => {
      cancelled = true
    }
  }, [activeId])

  async function send() {
    if (!activeId || !reply.trim() || !conversationConnected) return

    setSending(true)
    setError(null)

    try {
      await api.post(
        `/api/conversations/${activeId}/messages`,
        { content: reply.trim() }
      )

      setReply('')
      onRefresh()

      const d = await api.get<{
        conversation: { messages: MessageRow[] }
      }>(`/api/conversations/${activeId}/messages`)

      setMessages(d.conversation.messages ?? [])
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Could not send — check the WhatsApp connection for this conversation'
      )
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

        <StatusBadge kind={whatsappConnected ? 'resolved' : 'new'}>
          <Wifi size={11} style={{ marginRight: 4 }} />
          {whatsappConnected
            ? 'WhatsApp connected'
            : 'WhatsApp not connected'}
        </StatusBadge>
      </div>

      <div className="filter-bar">
        <div className="search-field">
          <Search size={16} />
          <input
            placeholder="Search customers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search conversations"
          />
        </div>
      </div>

      <div
        className="detail-grid"
        style={{
          gridTemplateColumns: 'minmax(240px,1fr) minmax(0,2fr)',
        }}
      >
        {/* Conversation list */}
        <div
          className="table-card"
          style={{ maxHeight: 620, overflowY: 'auto' }}
        >
          {loading && (
            <div
              style={{
                padding: 18,
                fontSize: 11,
                color: '#a2adba',
              }}
            >
              Loading…
            </div>
          )}

          {!loading && rows.length === 0 && (
            <div
              style={{
                padding: 18,
                fontSize: 11,
                color: '#a2adba',
              }}
            >
              No conversations yet. Incoming WhatsApp messages appear here.
            </div>
          )}

          {rows.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveId(c.id)}
              style={{
                display: 'flex',
                gap: 9,
                width: '100%',
                textAlign: 'left',
                padding: '12px 14px',
                background:
                  activeId === c.id
                    ? 'var(--sidebar-accent)'
                    : 'transparent',
                border: 0,
                borderBottom: '1px solid var(--border)',
                cursor: 'pointer',
              }}
            >
              <span
                className="assignee-dot"
                style={{
                  width: 26,
                  height: 26,
                  fontSize: 10,
                }}
              >
                {initialsOf(c.customer.name ?? c.customer.phoneNumber)}
              </span>

              <span style={{ flex: 1, minWidth: 0 }}>
                <strong
                  style={{
                    display: 'block',
                    fontSize: 11.5,
                    color: 'var(--foreground)',
                  }}
                >
                  {c.customer.name ?? c.customer.phoneNumber}
                </strong>

                <span
                  style={{
                    display: 'block',
                    fontSize: 10,
                    color: 'var(--muted-foreground)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {c.whatsappAccount?.label
                    ? `${c.whatsappAccount.label} · `
                    : ''}
                  {c.lastMessage ?? 'No messages'}
                </span>
              </span>

              <span
                style={{
                  fontSize: 9,
                  color: '#a2adba',
                  whiteSpace: 'nowrap',
                }}
              >
                {c.lastMessageAt
                  ? relativeTime(c.lastMessageAt)
                  : ''}
              </span>
            </button>
          ))}
        </div>

        {/* Conversation details */}
        <div
          className="detail-card conversation-card"
          style={{
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {activeCustomer ? (
            <>
              <div className="detail-card-title">
                <div>
                  <h3>
                    {activeCustomer.name ?? activeCustomer.phoneNumber}
                  </h3>
                  <p>
                    {activeCustomer.phoneNumber} ·{' '}
                    {rows.find((row) => row.id === activeId)
                      ?.whatsappAccount?.label ?? 'WhatsApp thread'}
                  </p>
                </div>

                <StatusBadge kind="neutral">
                  {messages.length} messages
                </StatusBadge>
              </div>

              <div
                className="messages"
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  maxHeight: 440,
                }}
              >
                {messages.map((m) => {
                  const outbound = m.direction === 'OUTBOUND'

                  return (
                    <div
                      key={m.id}
                      className={`message ${
                        outbound
                          ? 'agent-message'
                          : 'customer-message'
                      }`}
                    >
                      <span>{m.content}</span>
                      <time>
                        {formatDateTime(m.createdAt)}
                        {outbound
                          ? m.status === 'FAILED'
                            ? ' · failed'
                            : m.status === 'READ'
                              ? ' · ✓✓'
                              : ' · ✓'
                          : ''}
                      </time>
                    </div>
                  )
                })}
              </div>

              {error && (
                <div
                  className="auth-error"
                  style={{ marginTop: 10 }}
                >
                  {error}
                </div>
              )}

              <div className="reply-box">
                <input
                  placeholder={
                    conversationConnected
                      ? 'Reply to customer...'
                      : 'WhatsApp account for this conversation is not connected...'
                  }
                  disabled={!conversationConnected}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void send()
                  }}
                  aria-label="Reply"
                />

                <button
                  aria-label="Send"
                  onClick={() => void send()}
                  disabled={
                    !conversationConnected ||
                    sending ||
                    !reply.trim()
                  }
                >
                  <Send size={15} />
                </button>
              </div>
            </>
          ) : (
            <div
              style={{
                padding: 30,
                textAlign: 'center',
                color: '#a2adba',
                fontSize: 11,
              }}
            >
              <MessageCircle
                size={20}
                style={{ marginBottom: 8 }}
              />

              <div>
                {whatsappConnected
                  ? 'WhatsApp is connected. Incoming customer conversations will appear here.'
                  : 'Connect a WhatsApp number to start receiving conversations.'}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Customers
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

    api.get<{ customers: CustomerListRow[] }>(
      `/api/customers?pageSize=50${q}`
    )
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
          <input
            placeholder="Search name or phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search customers"
          />
        </div>
      </div>

      <div className="table-card complaints-table">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Phone</th>
                <th>Open tickets</th>
                <th>Total tickets</th>
                <th>Satisfaction</th>
                <th>First seen</th>
              </tr>
            </thead>

            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6}>
                    <div
                      style={{
                        padding: 20,
                        color: '#a2adba',
                        fontSize: 11,
                      }}
                    >
                      Loading…
                    </div>
                  </td>
                </tr>
              )}

              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div
                      style={{
                        padding: 20,
                        color: '#a2adba',
                        fontSize: 11,
                      }}
                    >
                      No customers yet — they are created automatically from WhatsApp conversations.
                    </div>
                  </td>
                </tr>
              )}

              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="customer-cell">
                      <div className="avatar avatar-blue">
                        {initialsOf(c.name ?? c.phoneNumber)}
                      </div>
                      <div>
                        <strong>{c.name ?? 'Unknown'}</strong>
                        <span>WhatsApp customer</span>
                      </div>
                    </div>
                  </td>

                  <td style={{ fontSize: 11 }}>{c.phoneNumber}</td>

                  <td>
                    <StatusBadge
                      kind={
                        c.openTickets > 0
                          ? 'in-progress'
                          : 'resolved'
                      }
                    >
                      {c.openTickets}
                    </StatusBadge>
                  </td>

                  <td>{c.totalTickets}</td>

                  <td>
                    {c.satisfaction != null
                      ? `${c.satisfaction.toFixed(1)} / 5`
                      : '—'}
                  </td>

                  <td
                    style={{
                      fontSize: 10.5,
                      color: 'var(--muted-foreground)',
                    }}
                  >
                    {formatDateTime(c.createdAt)}
                  </td>
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
// Staff
// ---------------------------------------------------------------------------

export function StaffView() {
  const [rows, setRows] = useState<StaffMetricRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.get<{ staff: StaffMetricRow[] }>('/api/staff')
      .then((d) => setRows(d.staff))
      .catch((err) =>
        setError(
          err instanceof ApiClientError
            ? err.message
            : 'Could not load staff'
        )
      )
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Operations / Staff</div>
          <h1>Staff</h1>
          <p>
            Operational metrics for every team member — no rankings, just real workload.
          </p>
        </div>
      </div>

      {error && <div className="auth-error">{error}</div>}

      <div className="table-card complaints-table">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Staff</th>
                <th>Role</th>
                <th>Department</th>
                <th>Open</th>
                <th>Assigned</th>
                <th>Resolved</th>
                <th>Avg. resolution</th>
                <th>SLA compliance</th>
                <th>Rating</th>
              </tr>
            </thead>

            <tbody>
              {loading && (
                <tr>
                  <td colSpan={9}>
                    <div
                      style={{
                        padding: 20,
                        color: '#a2adba',
                        fontSize: 11,
                      }}
                    >
                      Loading…
                    </div>
                  </td>
                </tr>
              )}

              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <div
                      style={{
                        padding: 20,
                        color: '#a2adba',
                        fontSize: 11,
                      }}
                    >
                      No staff members yet — invite your team from onboarding or Settings.
                    </div>
                  </td>
                </tr>
              )}

              {rows.map((s) => (
                <tr key={s.userId}>
                  <td>
                    <div className="customer-cell">
                      <div className="avatar avatar-blue">
                        {initialsOf(s.name ?? s.email)}
                      </div>
                      <div>
                        <strong>{s.name ?? s.email}</strong>
                        <span>{s.email}</span>
                      </div>
                    </div>
                  </td>

                  <td style={{ fontSize: 10.5 }}>
                    {s.role.replace('_', ' ').toLowerCase()}
                  </td>

                  <td style={{ fontSize: 10.5 }}>
                    {s.department ?? '—'}
                  </td>

                  <td>
                    <StatusBadge
                      kind={
                        s.openTickets > 0
                          ? 'in-progress'
                          : 'resolved'
                      }
                    >
                      {s.openTickets}
                    </StatusBadge>
                  </td>

                  <td>{s.assigned}</td>
                  <td>{s.resolved}</td>

                  <td>
                    {s.averageResolutionHours != null
                      ? s.averageResolutionHours < 1
                        ? `${Math.round(s.averageResolutionHours * 60)}m`
                        : `${s.averageResolutionHours.toFixed(1)}h`
                      : '—'}
                  </td>

                  <td>
                    {s.slaCompliance != null
                      ? `${s.slaCompliance}%`
                      : '—'}
                  </td>

                  <td>
                    {s.customerRating != null
                      ? `${s.customerRating.toFixed(1)} / 5`
                      : '—'}
                  </td>
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
// Analytics
// ---------------------------------------------------------------------------

interface OverviewLite {
  categoryDistribution: Array<{
    name: string
    count: number
  }>
  priorityDistribution: Array<{
    name: string
    count: number
  }>
  departmentStatistics: Array<{
    name: string
    total: number
    open: number
    resolved: number
  }>
  trend: Array<{
    day: string
    received: number
    resolved: number
  }>
  slaCompliance: number | null
  averageResolutionHours: number | null
  customerSatisfaction: number | null
}

export function AnalyticsView({
  overview,
}: {
  overview: OverviewLite | null
}) {
  const maxCat = Math.max(
    1,
    ...(overview?.categoryDistribution.map((c) => c.count) ?? [1])
  )

  const maxTrend = Math.max(
    1,
    ...(overview?.trend.map((d) =>
      Math.max(d.received, d.resolved)
    ) ?? [1])
  )

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Operations / Analytics</div>
          <h1>Analytics</h1>
          <p>
            Computed from real complaints, resolutions and feedback — no estimates.
          </p>
        </div>
      </div>

      <div
        className="metric-grid"
        style={{ gridTemplateColumns: 'repeat(3,1fr)' }}
      >
        <div className="metric-card">
          <div className="metric-head">
            <span>SLA compliance</span>
          </div>
          <div className="metric-value">
            {overview?.slaCompliance != null
              ? `${Math.round(overview.slaCompliance)}%`
              : '—'}
          </div>
          <div className="metric-foot">
            <span className="delta">resolved within SLA</span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-head">
            <span>Avg. resolution</span>
          </div>
          <div className="metric-value">
            {overview?.averageResolutionHours != null
              ? overview.averageResolutionHours < 1
                ? `${Math.round(overview.averageResolutionHours * 60)}m`
                : `${overview.averageResolutionHours.toFixed(1)}h`
              : '—'}
          </div>
          <div className="metric-foot">
            <span className="delta">last 30 days</span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-head">
            <span>Customer satisfaction</span>
          </div>
          <div className="metric-value">
            {overview?.customerSatisfaction != null
              ? `${overview.customerSatisfaction.toFixed(1)} / 5`
              : '—'}
          </div>
          <div className="metric-foot">
            <span className="delta">from customer feedback</span>
          </div>
        </div>
      </div>

      <div className="dashboard-grid" style={{ marginTop: 14 }}>
        <div className="trend-card">
          <div className="card-heading">
            <div>
              <h3>Weekly volume</h3>
              <p>Received vs. resolved per day</p>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              marginTop: 20,
            }}
          >
            {(overview?.trend ?? []).map((d) => (
              <div
                key={d.day}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '44px 1fr',
                  gap: 10,
                  alignItems: 'center',
                }}
              >
                <span style={{ fontSize: 9.5, color: '#a7b0be' }}>
                  {new Date(d.day).toLocaleDateString('en-IN', {
                    weekday: 'short',
                  })}
                </span>

                <div
                  style={{
                    display: 'flex',
                    gap: 4,
                    alignItems: 'center',
                  }}
                >
                  <div
                    style={{
                      width: `${(d.received / maxTrend) * 70}%`,
                      minWidth: d.received ? 8 : 0,
                      height: 7,
                      borderRadius: 4,
                      background: '#3578ee',
                    }}
                  />

                  <div
                    style={{
                      width: `${(d.resolved / maxTrend) * 70}%`,
                      minWidth: d.resolved ? 8 : 0,
                      height: 7,
                      borderRadius: 4,
                      background: '#a78bfa',
                    }}
                  />

                  <span
                    style={{
                      fontSize: 9,
                      color: '#9aa5b3',
                      marginLeft: 4,
                    }}
                  >
                    {d.received} / {d.resolved}
                  </span>
                </div>
              </div>
            ))}

            {(!overview || overview.trend.length === 0) && (
              <div style={{ color: '#a2adba', fontSize: 11 }}>
                Trend data appears as complaints arrive.
              </div>
            )}
          </div>
        </div>

        <div className="ai-card">
          <div className="ai-card-top">
            <div className="ai-icon">
              <MessageCircle size={18} />
            </div>
            <span>Breakdown</span>
          </div>

          <h3>By category &amp; priority</h3>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 7,
              marginTop: 16,
            }}
          >
            {(overview?.categoryDistribution ?? [])
              .slice(0, 6)
              .map((c) => (
                <div
                  key={c.name}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 34px',
                    gap: 8,
                    alignItems: 'center',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <div
                      style={{
                        flex: 1,
                        height: 7,
                        background: '#dce5f7',
                        borderRadius: 4,
                      }}
                    >
                      <div
                        style={{
                          width: `${(c.count / maxCat) * 100}%`,
                          height: '100%',
                          borderRadius: 4,
                          background: '#6b8ee7',
                        }}
                      />
                    </div>

                    <span
                      style={{
                        fontSize: 9.5,
                        color: 'var(--muted-foreground)',
                        minWidth: 70,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.name}
                    </span>
                  </div>

                  <strong style={{ fontSize: 11 }}>{c.count}</strong>
                </div>
              ))}

            {(!overview ||
              overview.categoryDistribution.length === 0) && (
              <div style={{ color: '#a2adba', fontSize: 10.5 }}>
                Categories appear after complaints are classified.
              </div>
            )}
          </div>

          <div
            style={{
              display: 'flex',
              gap: 7,
              marginTop: 16,
              flexWrap: 'wrap',
            }}
          >
            {(overview?.priorityDistribution ?? []).map((p) => (
              <span
                key={p.name}
                className={`status-badge ${priorityTone(p.name)}`}
                style={{ fontSize: 9.5 }}
              >
                {priorityLabel(p.name)}: {p.count}
              </span>
            ))}

            {(!overview ||
              overview.priorityDistribution.length === 0) && (
              <div style={{ color: '#a2adba', fontSize: 10.5 }}>
                No complaints yet.
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        className="table-card complaints-table"
        style={{ marginTop: 14 }}
      >
        <div className="table-head">
          <div>
            <h3>Department statistics</h3>
            <p>Volume, load and throughput per team</p>
          </div>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Department</th>
                <th>Total</th>
                <th>Open</th>
                <th>Resolved</th>
                <th>Resolution rate</th>
              </tr>
            </thead>

            <tbody>
              {(!overview ||
                overview.departmentStatistics.length === 0) && (
                <tr>
                  <td colSpan={5}>
                    <div
                      style={{
                        padding: 20,
                        color: '#a2adba',
                        fontSize: 11,
                      }}
                    >
                      Departments appear as complaints are routed.
                    </div>
                  </td>
                </tr>
              )}

              {(overview?.departmentStatistics ?? []).map((d) => (
                <tr key={d.name}>
                  <td>
                    <strong style={{ fontSize: 11 }}>{d.name}</strong>
                  </td>
                  <td>{d.total}</td>
                  <td>
                    <StatusBadge
                      kind={d.open > 0 ? 'in-progress' : 'resolved'}
                    >
                      {d.open}
                    </StatusBadge>
                  </td>
                  <td>{d.resolved}</td>
                  <td>
                    {d.total > 0
                      ? `${Math.round((d.resolved / d.total) * 100)}%`
                      : '—'}
                  </td>
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
// Departments
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

export function DepartmentsView({ role }: { role: string }) {
  const canManage =
    role === 'ORGANIZATION_ADMIN' || role === 'SUPER_ADMIN'

  const [rows, setRows] = useState<DepartmentStatRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  async function loadDepartments() {
    setLoading(true)
    setError(null)

    try {
      const data = await api.get<{
        departments: DepartmentStatRow[]
      }>('/api/departments')

      setRows(data.departments ?? [])
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Could not load departments.'
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadDepartments()
  }, [])

  function resetForm() {
    setName('')
    setDescription('')
    setEditingId(null)
    setShowForm(false)
  }

  function startEdit(department: DepartmentStatRow) {
    setEditingId(department.id)
    setName(department.name)
    setDescription(department.description ?? '')
    setShowForm(true)
    setError(null)
    setSuccess(null)
  }

  async function handleSubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault()

    if (!name.trim()) {
      setError('Department name is required.')
      return
    }

    setSaving(true)
    setError(null)
    setSuccess(null)

    const payload = {
      name: name.trim(),
      description: description.trim(),
    }

    try {
      if (editingId) {
        await api.patch(
          `/api/departments/${encodeURIComponent(editingId)}`,
          payload
        )

        setSuccess('Department updated successfully.')
      } else {
        await api.post('/api/departments', payload)

        setSuccess('Department created successfully.')
      }

      resetForm()
      await loadDepartments()
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Could not save department.'
      )
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(department: DepartmentStatRow) {
    const confirmed = window.confirm(
      `Delete the department "${department.name}"? This action cannot be undone.`
    )

    if (!confirmed) return

    setSaving(true)
    setError(null)
    setSuccess(null)

    try {
      await api.delete(
        `/api/departments/${encodeURIComponent(department.id)}`
      )

      setSuccess('Department deleted successfully.')
      await loadDepartments()
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Could not delete department. Check whether complaints are assigned to it.'
      )
    } finally {
      setSaving(false)
    }
  }

  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 7,
    border: '1px solid var(--border)',
    background: 'var(--background)',
    color: 'var(--foreground)',
    fontSize: 12,
  } as const

  return (
    <div className="page-content">
      {/* Header */}
      <div className="page-header">
        <div>
          <div className="eyebrow">Operations / Departments</div>
          <h1>Departments</h1>
          <p>
            Organize teams, assign responsibilities and track department performance.
          </p>
        </div>

        {canManage && (
          <button
            type="button"
            className="auth-button"
            onClick={() => {
              if (showForm) {
                resetForm()
              } else {
                setEditingId(null)
                setName('')
                setDescription('')
                setShowForm(true)
              }

              setError(null)
              setSuccess(null)
            }}
          >
            {showForm ? (
              <X size={15} style={{ marginRight: 7 }} />
            ) : (
              <UserPlus size={15} style={{ marginRight: 7 }} />
            )}

            {showForm ? 'Close' : 'Add Department'}
          </button>
        )}
      </div>

      {/* Feedback */}
      {error && (
        <div className="auth-error" role="alert">
          {error}
        </div>
      )}

      {success && (
        <div
          role="status"
          style={{
            padding: 12,
            marginBottom: 14,
            borderRadius: 8,
            background: 'var(--sidebar-accent)',
            color: 'var(--foreground)',
            fontSize: 12,
          }}
        >
          {success}
        </div>
      )}

      {/* Create / Edit Form */}
      {canManage && showForm && (
        <div
          className="table-card"
          style={{ padding: 20, marginBottom: 20 }}
        >
          <div style={{ marginBottom: 18 }}>
            <div className="eyebrow">Department configuration</div>

            <h2 style={{ fontSize: 16, margin: '5px 0' }}>
              {editingId ? 'Edit Department' : 'Create Department'}
            </h2>

            <p
              style={{
                fontSize: 12,
                color: 'var(--muted-foreground)',
              }}
            >
              Provide a name and an optional description for this department.
            </p>
          </div>

          <form onSubmit={handleSubmit}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 14,
              }}
            >
              <label>
                <span className="eyebrow">Department name *</span>

                <input
                  type="text"
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Customer Support"
                  style={inputStyle}
                />
              </label>

              <label>
                <span className="eyebrow">Description</span>

                <input
                  type="text"
                  maxLength={300}
                  value={description}
                  onChange={(event) =>
                    setDescription(event.target.value)
                  }
                  placeholder="Describe this department"
                  style={inputStyle}
                />
              </label>
            </div>

            <div
              style={{
                display: 'flex',
                gap: 10,
                marginTop: 18,
              }}
            >
              <button
                type="submit"
                className="auth-button"
                disabled={saving}
              >
                <Save size={14} style={{ marginRight: 7 }} />

                {saving
                  ? 'Saving...'
                  : editingId
                    ? 'Save Changes'
                    : 'Create Department'}
              </button>

              <button
                type="button"
                className="icon-button"
                onClick={resetForm}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Summary Cards */}
      <div
        className="metric-grid"
        style={{
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          marginBottom: 18,
        }}
      >
        <div className="metric-card">
          <div className="metric-head">
            <span>Total Departments</span>
          </div>
          <div className="metric-value">{rows.length}</div>
          <div className="metric-foot">
            <span className="delta">Organization teams</span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-head">
            <span>Total Staff</span>
          </div>
          <div className="metric-value">
            {rows.reduce(
              (total, item) => total + item.staffCount,
              0
            )}
          </div>
          <div className="metric-foot">
            <span className="delta">Across departments</span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-head">
            <span>Open Complaints</span>
          </div>
          <div className="metric-value">
            {rows.reduce(
              (total, item) => total + item.openComplaints,
              0
            )}
          </div>
          <div className="metric-foot">
            <span className="delta">Current department workload</span>
          </div>
        </div>
      </div>

      {/* Department Table */}
      <div className="table-card complaints-table">
        <div
          className="table-head"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <h3>All Departments</h3>
            <p>Department workload and performance</p>
          </div>

          <button
            type="button"
            className="icon-button"
            aria-label="Refresh departments"
            onClick={() => void loadDepartments()}
            disabled={loading}
          >
            <RefreshCw size={15} />
          </button>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Department</th>
                <th>Staff</th>
                <th>Total complaints</th>
                <th>Open</th>
                <th>Resolved</th>
                <th>Resolution rate</th>
                {canManage && <th>Actions</th>}
              </tr>
            </thead>

            <tbody>
              {loading && (
                <tr>
                  <td colSpan={canManage ? 7 : 6}>
                    <div
                      style={{
                        padding: 20,
                        color: '#a2adba',
                        fontSize: 11,
                      }}
                    >
                      Loading departments...
                    </div>
                  </td>
                </tr>
              )}

              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={canManage ? 7 : 6}>
                    <div
                      style={{
                        padding: 30,
                        textAlign: 'center',
                        color: 'var(--muted-foreground)',
                      }}
                    >
                      <h3>No departments yet</h3>
                      <p style={{ fontSize: 12, marginTop: 7 }}>
                        Create your first department to organize your team.
                      </p>
                    </div>
                  </td>
                </tr>
              )}

              {rows.map((department) => (
                <tr key={department.id}>
                  <td>
                    <div className="customer-cell">
                      <div
                        className="avatar avatar-violet"
                        style={{
                          background: '#f0ecff',
                          color: '#8067d5',
                        }}
                      >
                        {initialsOf(department.name)}
                      </div>

                      <div>
                        <strong>{department.name}</strong>
                        <span>
                          {department.description || 'No description'}
                        </span>
                      </div>
                    </div>
                  </td>

                  <td>{department.staffCount}</td>

                  <td>{department.complaintCount}</td>

                  <td>
                    <StatusBadge
                      kind={
                        department.openComplaints > 0
                          ? 'in-progress'
                          : 'resolved'
                      }
                    >
                      {department.openComplaints}
                    </StatusBadge>
                  </td>

                  <td>{department.resolvedComplaints}</td>

                  <td>
                    {department.complaintCount > 0
                      ? `${Math.round(
                          (department.resolvedComplaints /
                            department.complaintCount) *
                            100
                        )}%`
                      : '—'}
                  </td>

                  {canManage && (
                    <td>
                      <div
                        style={{
                          display: 'flex',
                          gap: 8,
                        }}
                      >
                        <button
                          type="button"
                          className="icon-button"
                          title="Edit department"
                          aria-label={`Edit ${department.name}`}
                          disabled={saving}
                          onClick={() => startEdit(department)}
                        >
                          <Save size={15} />
                        </button>

                        <button
                          type="button"
                          className="icon-button"
                          title="Delete department"
                          aria-label={`Delete ${department.name}`}
                          disabled={saving}
                          onClick={() => void handleDelete(department)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
