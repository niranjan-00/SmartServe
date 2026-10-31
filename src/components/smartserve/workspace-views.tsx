
'use client'

import { useEffect, useState, type FormEvent } from 'react'
import {
  Search,
  Send,
  MessageCircle,
  Wifi,
  UserPlus,
  RefreshCw,
  Trash2,
  Copy,
} from 'lucide-react'

import {
  api,
  ApiClientError,
  type StaffMetricRow,
  type MemberRow,
} from '@/lib/api'

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
  customer: {
    id: string
    name: string | null
    phoneNumber: string
  }
  lastMessage: string | null
  lastMessageAt: string | null
  messageCount: number
  connection?: {
    displayPhoneNumber: string | null
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
  const [connected, setConnected] = useState(false)

  const loadList = async () => {
    try {
      const q = search ? `&search=${encodeURIComponent(search)}` : ''

      const data = await api.get<{
        conversations: ConversationRow[]
      }>(`/api/conversations?pageSize=50${q}`)

      setRows(data.conversations)

      if (!activeId && data.conversations.length > 0) {
        setActiveId(
          defaultConversationId ?? data.conversations[0].id
        )
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadList()
  }, [search])

  useEffect(() => {
    if (!activeId) return

    api.get<{
      conversation: {
        customer: {
          name: string | null
          phoneNumber: string
        }
        messages: MessageRow[]
        whatsapp?: {
          status: string
        } | null
      }
    }>(`/api/conversations/${activeId}/messages`)
      .then((data) => {
        setMessages(data.conversation.messages)
        setActiveCustomer(data.conversation.customer)
        setConnected(
          data.conversation.whatsapp?.status === 'CONNECTED'
        )
        setError(null)
      })
      .catch(() => undefined)
  }, [activeId])

  async function send() {
    if (!activeId || !reply.trim()) return

    setSending(true)
    setError(null)

    try {
      await api.post(
        `/api/conversations/${activeId}/messages`,
        { content: reply.trim() }
      )

      setReply('')
      onRefresh()

      const data = await api.get<{
        conversation: {
          messages: MessageRow[]
        }
      }>(`/api/conversations/${activeId}/messages`)

      setMessages(data.conversation.messages)
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Could not send — WhatsApp connection required'
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

        <StatusBadge kind={connected ? 'resolved' : 'new'}>
          <Wifi size={11} style={{ marginRight: 4 }} />
          {connected
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
            onChange={(event) => setSearch(event.target.value)}
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
        <div
          className="table-card"
          style={{ maxHeight: 620, overflowY: 'auto' }}
        >
          {loading && (
            <div style={{ padding: 18, fontSize: 11, color: '#a2adba' }}>
              Loading…
            </div>
          )}

          {!loading && rows.length === 0 && (
            <div style={{ padding: 18, fontSize: 11, color: '#a2adba' }}>
              No conversations yet. Incoming WhatsApp messages appear here.
            </div>
          )}

          {rows.map((conversation) => (
            <button
              key={conversation.id}
              onClick={() => setActiveId(conversation.id)}
              style={{
                display: 'flex',
                gap: 9,
                width: '100%',
                textAlign: 'left',
                padding: '12px 14px',
                background:
                  activeId === conversation.id
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
                {initialsOf(
                  conversation.customer.name ??
                    conversation.customer.phoneNumber
                )}
              </span>

              <span style={{ flex: 1, minWidth: 0 }}>
                <strong
                  style={{
                    display: 'block',
                    fontSize: 11.5,
                    color: 'var(--foreground)',
                  }}
                >
                  {conversation.customer.name ??
                    conversation.customer.phoneNumber}
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
                  {conversation.lastMessage ?? 'No messages'}
                </span>
              </span>

              <span
                style={{
                  fontSize: 9,
                  color: '#a2adba',
                  whiteSpace: 'nowrap',
                }}
              >
                {conversation.lastMessageAt
                  ? relativeTime(conversation.lastMessageAt)
                  : ''}
              </span>
            </button>
          ))}
        </div>

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
                    {activeCustomer.name ??
                      activeCustomer.phoneNumber}
                  </h3>
                  <p>
                    {activeCustomer.phoneNumber} · WhatsApp thread
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
                {messages.map((message) => {
                  const outbound =
                    message.direction === 'OUTBOUND'

                  return (
                    <div
                      key={message.id}
                      className={`message ${
                        outbound
                          ? 'agent-message'
                          : 'customer-message'
                      }`}
                    >
                      <span>{message.content}</span>

                      <time>
                        {formatDateTime(message.createdAt)}
                        {outbound
                          ? message.status === 'FAILED'
                            ? ' · failed'
                            : message.status === 'READ'
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
                    connected
                      ? 'Reply to customer...'
                      : 'Connect WhatsApp Business to reply...'
                  }
                  disabled={!connected}
                  value={reply}
                  onChange={(event) =>
                    setReply(event.target.value)
                  }
                  onKeyDown={(event) =>
                    event.key === 'Enter' && void send()
                  }
                  aria-label="Reply"
                />

                <button
                  aria-label="Send"
                  onClick={() => void send()}
                  disabled={
                    !connected || sending || !reply.trim()
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
                Select a conversation to view the full thread.
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
    const q = search
      ? `&search=${encodeURIComponent(search)}`
      : ''

    api.get<{
      customers: CustomerListRow[]
    }>(`/api/customers?pageSize=50${q}`)
      .then((data) => setRows(data.customers))
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
            onChange={(event) => setSearch(event.target.value)}
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
                      No customers yet — they are created automatically
                      from WhatsApp conversations.
                    </div>
                  </td>
                </tr>
              )}

              {rows.map((customer) => (
                <tr key={customer.id}>
                  <td>
                    <div className="customer-cell">
                      <div className="avatar avatar-blue">
                        {initialsOf(
                          customer.name ?? customer.phoneNumber
                        )}
                      </div>
                      <div>
                        <strong>
                          {customer.name ?? 'Unknown'}
                        </strong>
                        <span>WhatsApp customer</span>
                      </div>
                    </div>
                  </td>

                  <td style={{ fontSize: 11 }}>
                    {customer.phoneNumber}
                  </td>

                  <td>
                    <StatusBadge
                      kind={
                        customer.openTickets > 0
                          ? 'in-progress'
                          : 'resolved'
                      }
                    >
                      {customer.openTickets}
                    </StatusBadge>
                  </td>

                  <td>{customer.totalTickets}</td>

                  <td>
                    {customer.satisfaction != null
                      ? `${customer.satisfaction.toFixed(1)} / 5`
                      : '—'}
                  </td>

                  <td
                    style={{
                      fontSize: 10.5,
                      color: 'var(--muted-foreground)',
                    }}
                  >
                    {formatDateTime(customer.createdAt)}
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
// Staff Management
// ---------------------------------------------------------------------------

interface StaffInvitationRow {
  id: string
  email: string
  role: string
  status: string
  createdAt: string
}

interface StaffDepartmentOption {
  id: string
  name: string
}

export function StaffView({
  role = 'VIEWER',
}: {
  role?: string
}) {
  const [rows, setRows] = useState<StaffMetricRow[]>([])
  const [members, setMembers] = useState<MemberRow[]>([])
  const [invitations, setInvitations] = useState<StaffInvitationRow[]>([])
  const [departments, setDepartments] = useState<StaffDepartmentOption[]>([])

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [showInvite, setShowInvite] = useState(false)
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('STAFF')
  const [departmentId, setDepartmentId] = useState('')
  const [inviteCode, setInviteCode] = useState<string | null>(null)

  const canManage =
    role === 'ORGANIZATION_ADMIN' ||
    role === 'SUPER_ADMIN'

  const canViewMembers =
    canManage || role === 'SUPERVISOR'

  async function loadStaff() {
    setLoading(true)
    setError(null)

    try {
      const [staffData, memberData, departmentData] =
        await Promise.all([
          api.get<{
            staff: StaffMetricRow[]
          }>('/api/staff'),

          canViewMembers
            ? api.get<{
                members: MemberRow[]
                invitations: StaffInvitationRow[]
              }>('/api/members')
            : Promise.resolve({
                members: [],
                invitations: [],
              }),

          api.get<{
            departments: StaffDepartmentOption[]
          }>('/api/departments'),
        ])

      setRows(staffData.staff)
      setMembers(memberData.members)
      setInvitations(memberData.invitations)
      setDepartments(departmentData.departments)
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Could not load staff management data.'
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadStaff()
  }, [])

  const query = search.trim().toLowerCase()

  const filteredMembers = members.filter((member) => {
    if (!query) return true

    return (
      (member.user.name ?? '')
        .toLowerCase()
        .includes(query) ||
      member.user.email
        .toLowerCase()
        .includes(query) ||
      member.role.toLowerCase().includes(query) ||
      (member.department?.name ?? '')
        .toLowerCase()
        .includes(query)
    )
  })

  async function inviteStaff(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault()

    setSaving(true)
    setError(null)
    setSuccess(null)
    setInviteCode(null)

    try {
      const result = await api.post<{
        invitation: {
          id: string
          email: string
          role: string
          code: string
        }
      }>('/api/members', {
        email: email.trim(),
        role: inviteRole,
        ...(departmentId ? { departmentId } : {}),
      })

      setInviteCode(result.invitation.code)
      setSuccess(
        'Invitation created. Share the code with the new team member.'
      )
      setEmail('')

      await loadStaff()
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Could not create the invitation.'
      )
    } finally {
      setSaving(false)
    }
  }

  async function updateMember(
    memberId: string,
    changes: {
      role?: string
      status?: string
      departmentId?: string | null
    }
  ) {
    setError(null)
    setSuccess(null)

    try {
      await api.patch('/api/members', {
        memberId,
        ...changes,
      })

      setSuccess('Staff member updated successfully.')
      await loadStaff()
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Could not update this staff member.'
      )
    }
  }

  async function removeMember(member: MemberRow) {
    const confirmed = window.confirm(
      `Remove ${
        member.user.name ?? member.user.email
      } from this organization?`
    )

    if (!confirmed) return

    setError(null)
    setSuccess(null)

    try {
      await api.delete(
        `/api/members?memberId=${encodeURIComponent(member.id)}`
      )

      setSuccess('Staff member removed successfully.')
      await loadStaff()
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Could not remove this staff member.'
      )
    }
  }

  async function copyInvitationCode() {
    if (!inviteCode) return

    try {
      await navigator.clipboard.writeText(inviteCode)
      setSuccess('Invitation code copied.')
    } catch {
      setError(
        'Could not copy the invitation code. You can select and copy it manually.'
      )
    }
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Operations / Staff</div>
          <h1>Staff Management</h1>
          <p>
            Manage team members, invitations, roles and department
            assignments.
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <button
            className="auth-button"
            type="button"
            onClick={() => void loadStaff()}
            disabled={loading}
          >
            <RefreshCw
              size={14}
              style={{ marginRight: 6 }}
            />
            Refresh
          </button>

          {canManage && (
            <button
              className="auth-button"
              type="button"
              onClick={() => {
                setShowInvite((value) => !value)
                setError(null)
                setSuccess(null)
              }}
            >
              <UserPlus
                size={14}
                style={{ marginRight: 6 }}
              />
              Add staff
            </button>
          )}
        </div>
      </div>

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
            background: '#ecfdf5',
            color: '#047857',
            fontSize: 12,
          }}
        >
          {success}
        </div>
      )}

      {showInvite && canManage && (
        <div
          className="detail-card"
          style={{ marginBottom: 16 }}
        >
          <div className="detail-card-title">
            <div>
              <h3>Invite a team member</h3>
              <p>
                Create a one-time invitation code for a new team
                member.
              </p>
            </div>
          </div>

          <form
            onSubmit={inviteStaff}
            style={{
              display: 'grid',
              gridTemplateColumns:
                'repeat(auto-fit,minmax(180px,1fr))',
              gap: 12,
            }}
          >
            <input
              className="search-field"
              style={{ minWidth: 0, padding: 12 }}
              type="email"
              placeholder="Staff email address"
              value={email}
              onChange={(event) =>
                setEmail(event.target.value)
              }
              required
            />

            <select
              className="search-field"
              style={{ padding: 12 }}
              value={inviteRole}
              onChange={(event) =>
                setInviteRole(event.target.value)
              }
            >
              <option value="STAFF">Staff</option>
              <option value="SUPERVISOR">Supervisor</option>
              <option value="VIEWER">Viewer</option>
              <option value="ORGANIZATION_ADMIN">
                Organization Admin
              </option>
            </select>

            <select
              className="search-field"
              style={{ padding: 12 }}
              value={departmentId}
              onChange={(event) =>
                setDepartmentId(event.target.value)
              }
            >
              <option value="">No department</option>

              {departments.map((department) => (
                <option
                  key={department.id}
                  value={department.id}
                >
                  {department.name}
                </option>
              ))}
            </select>

            <button
              className="auth-button"
              type="submit"
              disabled={saving}
            >
              <Send
                size={14}
                style={{ marginRight: 6 }}
              />
              {saving ? 'Creating…' : 'Create invitation'}
            </button>
          </form>

          {inviteCode && (
            <div
              style={{
                marginTop: 16,
                padding: 14,
                borderRadius: 8,
                border: '1px solid var(--border)',
              }}
            >
              <strong style={{ fontSize: 12 }}>
                Invitation code
              </strong>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginTop: 8,
                  flexWrap: 'wrap',
                }}
              >
                <code
                  style={{
                    fontSize: 13,
                    overflowWrap: 'anywhere',
                  }}
                >
                  {inviteCode}
                </code>

                <button
                  type="button"
                  className="auth-button"
                  onClick={() => void copyInvitationCode()}
                >
                  <Copy
                    size={13}
                    style={{ marginRight: 5 }}
                  />
                  Copy code
                </button>
              </div>

              <p
                style={{
                  fontSize: 11,
                  color: 'var(--muted-foreground)',
                  marginTop: 8,
                }}
              >
                Share this code with the invited person. Your current
                invitation API returns a join code; it does not send
                an email.
              </p>
            </div>
          )}
        </div>
      )}

      <div
        className="metric-grid"
        style={{
          gridTemplateColumns:
            'repeat(auto-fit,minmax(150px,1fr))',
        }}
      >
        <div className="metric-card">
          <div className="metric-head">
            <span>Total members</span>
          </div>
          <div className="metric-value">
            {members.length}
          </div>
          <div className="metric-foot">
            <span className="delta">Organization team</span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-head">
            <span>Active members</span>
          </div>
          <div className="metric-value">
            {
              members.filter(
                (member) => member.status === 'ACTIVE'
              ).length
            }
          </div>
          <div className="metric-foot">
            <span className="delta">Currently active</span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-head">
            <span>Pending invitations</span>
          </div>
          <div className="metric-value">
            {invitations.length}
          </div>
          <div className="metric-foot">
            <span className="delta">Awaiting acceptance</span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-head">
            <span>Departments</span>
          </div>
          <div className="metric-value">
            {departments.length}
          </div>
          <div className="metric-foot">
            <span className="delta">Organization teams</span>
          </div>
        </div>
      </div>

      <div className="filter-bar">
        <div className="search-field">
          <Search size={16} />
          <input
            placeholder="Search staff by name, email, role or department..."
            value={search}
            onChange={(event) =>
              setSearch(event.target.value)
            }
            aria-label="Search staff"
          />
        </div>
      </div>

      <div className="table-card complaints-table">
        <div className="table-head">
          <div>
            <h3>Organization members</h3>
            <p>
              Manage team roles, departments and account status.
            </p>
          </div>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Staff member</th>
                <th>Role</th>
                <th>Department</th>
                <th>Status</th>
                {canManage && <th>Actions</th>}
              </tr>
            </thead>

            <tbody>
              {loading && (
                <tr>
                  <td colSpan={canManage ? 5 : 4}>
                    <div
                      style={{
                        padding: 20,
                        color: '#a2adba',
                        fontSize: 11,
                      }}
                    >
                      Loading staff…
                    </div>
                  </td>
                </tr>
              )}

              {!loading && filteredMembers.length === 0 && (
                <tr>
                  <td colSpan={canManage ? 5 : 4}>
                    <div
                      style={{
                        padding: 20,
                        color: '#a2adba',
                        fontSize: 11,
                      }}
                    >
                      No matching staff members found.
                    </div>
                  </td>
                </tr>
              )}

              {!loading &&
                filteredMembers.map((member) => (
                  <tr key={member.id}>
                    <td>
                      <div className="customer-cell">
                        <div className="avatar avatar-blue">
                          {initialsOf(
                            member.user.name ??
                              member.user.email
                          )}
                        </div>

                        <div>
                          <strong>
                            {member.user.name ??
                              'Unnamed member'}
                          </strong>
                          <span>{member.user.email}</span>
                        </div>
                      </div>
                    </td>

                    <td>
                      {canManage ? (
                        <select
                          value={member.role}
                          disabled={member.role === 'SUPER_ADMIN'}
                          aria-label={`Role for ${member.user.email}`}
                          onChange={(event) =>
                            void updateMember(member.id, {
                              role: event.target.value,
                            })
                          }
                        >
                          <option value="ORGANIZATION_ADMIN">
                            Organization Admin
                          </option>
                          <option value="SUPERVISOR">
                            Supervisor
                          </option>
                          <option value="STAFF">Staff</option>
                          <option value="VIEWER">Viewer</option>
                        </select>
                      ) : (
                        member.role.replaceAll('_', ' ')
                      )}
                    </td>

                    <td>
                      {canManage ? (
                        <select
                          value={member.departmentId ?? ''}
                          aria-label={`Department for ${member.user.email}`}
                          onChange={(event) =>
                            void updateMember(member.id, {
                              departmentId:
                                event.target.value || null,
                            })
                          }
                        >
                          <option value="">No department</option>

                          {departments.map((department) => (
                            <option
                              key={department.id}
                              value={department.id}
                            >
                              {department.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        member.department?.name ?? '—'
                      )}
                    </td>

                    <td>
                      <StatusBadge
                        kind={
                          member.status === 'ACTIVE'
                            ? 'resolved'
                            : 'new'
                        }
                      >
                        {member.status}
                      </StatusBadge>
                    </td>

                    {canManage && (
                      <td>
                        <div
                          style={{
                            display: 'flex',
                            gap: 6,
                            flexWrap: 'wrap',
                          }}
                        >
                          {member.status === 'SUSPENDED' ? (
                            <button
                              type="button"
                              className="auth-button"
                              onClick={() =>
                                void updateMember(member.id, {
                                  status: 'ACTIVE',
                                })
                              }
                            >
                              Activate
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="auth-button"
                              disabled={
                                member.role === 'SUPER_ADMIN'
                              }
                              onClick={() =>
                                void updateMember(member.id, {
                                  status: 'SUSPENDED',
                                })
                              }
                            >
                              Suspend
                            </button>
                          )}

                          <button
                            type="button"
                            className="auth-button"
                            title="Remove staff member"
                            aria-label={`Remove ${member.user.email}`}
                            disabled={
                              member.role === 'SUPER_ADMIN'
                            }
                            onClick={() =>
                              void removeMember(member)
                            }
                          >
                            <Trash2 size={13} />
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

      <div
        className="table-card complaints-table"
        style={{ marginTop: 16 }}
      >
        <div className="table-head">
          <div>
            <h3>Staff workload</h3>
            <p>
              Operational performance and complaint metrics.
            </p>
          </div>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Staff</th>
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
                  <td colSpan={7}>
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
                  <td colSpan={7}>
                    <div
                      style={{
                        padding: 20,
                        color: '#a2adba',
                        fontSize: 11,
                      }}
                    >
                      No staff workload data available yet.
                    </div>
                  </td>
                </tr>
              )}

              {!loading &&
                rows.map((staff) => (
                  <tr key={staff.userId}>
                    <td>
                      <div className="customer-cell">
                        <div className="avatar avatar-blue">
                          {initialsOf(
                            staff.name ?? staff.email
                          )}
                        </div>
                        <div>
                          <strong>
                            {staff.name ?? staff.email}
                          </strong>
                          <span>{staff.email}</span>
                        </div>
                      </div>
                    </td>

                    <td>
                      <StatusBadge
                        kind={
                          staff.openTickets > 0
                            ? 'in-progress'
                            : 'resolved'
                        }
                      >
                        {staff.openTickets}
                      </StatusBadge>
                    </td>

                    <td>{staff.assigned}</td>
                    <td>{staff.resolved}</td>

                    <td>
                      {staff.averageResolutionHours != null
                        ? staff.averageResolutionHours < 1
                          ? `${Math.round(
                              staff.averageResolutionHours * 60
                            )}m`
                          : `${staff.averageResolutionHours.toFixed(
                              1
                            )}h`
                        : '—'}
                    </td>

                    <td>
                      {staff.slaCompliance != null
                        ? `${staff.slaCompliance}%`
                        : '—'}
                    </td>

                    <td>
                      {staff.customerRating != null
                        ? `${staff.customerRating.toFixed(1)} / 5`
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
    ...(overview?.categoryDistribution.map(
      (category) => category.count
    ) ?? [1])
  )

  const maxTrend = Math.max(
    1,
    ...(overview?.trend.map((day) =>
      Math.max(day.received, day.resolved)
    ) ?? [1])
  )

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Operations / Analytics</div>
          <h1>Analytics</h1>
          <p>
            Computed from real complaints, resolutions and feedback —
            no estimates.
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
                ? `${Math.round(
                    overview.averageResolutionHours * 60
                  )}m`
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

      <div
        className="dashboard-grid"
        style={{ marginTop: 14 }}
      >
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
            {(overview?.trend ?? []).map((day) => (
              <div
                key={day.day}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '44px 1fr',
                  gap: 10,
                  alignItems: 'center',
                }}
              >
                <span
                  style={{
                    fontSize: 9.5,
                    color: '#a7b0be',
                  }}
                >
                  {new Date(day.day).toLocaleDateString(
                    'en-IN',
                    { weekday: 'short' }
                  )}
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
                      width: `${
                        (day.received / maxTrend) * 70
                      }%`,
                      minWidth: day.received ? 8 : 0,
                      height: 7,
                      borderRadius: 4,
                      background: '#3578ee',
                    }}
                  />

                  <div
                    style={{
                      width: `${
                        (day.resolved / maxTrend) * 70
                      }%`,
                      minWidth: day.resolved ? 8 : 0,
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
                    {day.received} / {day.resolved}
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
              .map((category) => (
                <div
                  key={category.name}
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
                          width: `${
                            (category.count / maxCat) * 100
                          }%`,
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
                      {category.name}
                    </span>
                  </div>

                  <strong style={{ fontSize: 11 }}>
                    {category.count}
                  </strong>
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
            {(overview?.priorityDistribution ?? []).map(
              (priority) => (
                <span
                  key={priority.name}
                  className={`status-badge ${priorityTone(
                    priority.name
                  )}`}
                  style={{ fontSize: 9.5 }}
                >
                  {priorityLabel(priority.name)}: {priority.count}
                </span>
              )
            )}

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

              {(overview?.departmentStatistics ?? []).map(
                (department) => (
                  <tr key={department.name}>
                    <td>
                      <strong style={{ fontSize: 11 }}>
                        {department.name}
                      </strong>
                    </td>

                    <td>{department.total}</td>

                    <td>
                      <StatusBadge
                        kind={
                          department.open > 0
                            ? 'in-progress'
                            : 'resolved'
                        }
                      >
                        {department.open}
                      </StatusBadge>
                    </td>

                    <td>{department.resolved}</td>

                    <td>
                      {department.total > 0
                        ? `${Math.round(
                            (department.resolved /
                              department.total) *
                              100
                          )}%`
                        : '—'}
                    </td>
                  </tr>
                )
              )}
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

export function DepartmentsView() {
  const [rows, setRows] = useState<DepartmentStatRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get<{
      departments: DepartmentStatRow[]
    }>('/api/departments')
      .then((data) => setRows(data.departments))
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
            <thead>
              <tr>
                <th>Department</th>
                <th>Staff</th>
                <th>Total complaints</th>
                <th>Open</th>
                <th>Resolved</th>
                <th>Resolution rate</th>
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
                      No departments yet — create them in Settings
                      → Departments.
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
                          {department.description ?? 'Team'}
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
