'use client'

import { useEffect, useState } from 'react'
import {
  AlertCircle, ArrowUpRight, Bot, CheckCircle2, Clock3, MessageCircle, MoreHorizontal, Paperclip, Send, Sparkles, UserRound,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api, ApiClientError, type MemberRow, type ConnectionSummary } from '@/lib/api'
import { StatusBadge } from './complaints-view'
import {
  initialsOf, priorityTone, priorityLabel, statusKind, statusLabel, slaLabel, slaIsCritical,
  formatDateTime, formatTime, relativeTime,
} from './display'
import type { ComplaintStatus } from '@/lib/types'

/**
 * Complaint detail (spec §41): customer, conversation, AI analysis, AI
 * suggestion, related complaints, SLA, status history, comments and every
 * mutation action — all through the backend.
 */

interface DetailComplaint {
  id: string
  ticketNumber: string
  title: string
  description: string | null
  status: string
  priority: string
  source: string
  aiStatus: string
  aiError: string | null
  createdAt: string
  acknowledgedAt: string | null
  assignedAt: string | null
  resolvedAt: string | null
  closedAt: string | null
  slaDueAt: string | null
  slaState: string
  customer: { id: string; name: string | null; phoneNumber: string; email: string | null }
  conversation?: { id: string; status: string } | null
  category?: { id: string; name: string } | null
  department?: { id: string; name: string } | null
  location?: { id: string; name: string } | null
  assignee?: { id: string; name: string | null } | null
  attachments: Array<{ id: string; fileName: string; mimeType: string; size: number; createdAt: string }>
  comments: Array<{ id: string; content: string; visibility: string; createdAt: string; author: { id: string; name: string | null; image: string | null } }>
  statusHistory: Array<{ id: string; fromStatus: string | null; toStatus: string; changedBy: string | null; reason: string | null; createdAt: string }>
  assignments: Array<{ id: string; assignedTo: string; assignedBy: string | null; assignedAt: string; unassignedAt: string | null; reason: string | null; actor?: { name: string | null } | null }>
  aiAnalyses: Array<{ id: string; status: string; category: string | null; department: string | null; location: string | null; priority: string | null; sentiment: string | null; intent: string | null; confidence: number | null; error: string | null }>
  aiSuggestions: Array<{ id: string; suggestion: string; confidence: number | null; estimatedResolutionTime: string | null; status: string }>
  feedbacks: Array<{ id: string; rating: number; comment: string | null; createdAt: string }>
  escalations: Array<{ id: string; level: number; trigger: string; resolvedAt: string | null; createdAt: string }>
  relatedComplaints: Array<{ id: string; similarity: number; reason: string | null; status: string; complaint: { id: string; ticketNumber: string; title: string; status: string }; relatedComplaint: { id: string; ticketNumber: string; title: string; status: string } }>
  messages: Array<{ id: string; direction: string; senderType: string; content: string | null; status: string; createdAt: string }>
}

const NEXT_STATUS_ACTIONS: Record<string, { to: ComplaintStatus; label: string }[]> = {
  NEW: [{ to: 'ACKNOWLEDGED', label: 'Acknowledge' }],
  ACKNOWLEDGED: [{ to: 'IN_PROGRESS', label: 'Start progress' }],
  ASSIGNED: [{ to: 'IN_PROGRESS', label: 'Start progress' }],
  IN_PROGRESS: [{ to: 'RESOLVED', label: 'Resolve complaint' }],
  RESOLVED: [{ to: 'CLOSED', label: 'Close complaint' }, { to: 'REOPENED', label: 'Reopen' }],
  CLOSED: [{ to: 'REOPENED', label: 'Reopen' }],
  REOPENED: [{ to: 'IN_PROGRESS', label: 'Start progress' }],
}

export function ComplaintDetail({ complaintId, onBack, onOpenComplaint, members, role, connection, onChanged }: {
  complaintId: string
  onBack: () => void
  onOpenComplaint: (id: string) => void
  members: MemberRow[]
  role: string
  connection: ConnectionSummary | null
  onChanged: () => void
}) {
  const [complaint, setComplaint] = useState<DetailComplaint | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState('')
  const [comment, setComment] = useState('')
  const [showAssign, setShowAssign] = useState(false)
  const [suggestion, setSuggestion] = useState<{ suggestion: string; confidence: number | null; estimatedResolutionTime: string | null } | null>(null)
  const [suggestionLoading, setSuggestionLoading] = useState(false)

  const canAssign = role === 'ORGANIZATION_ADMIN' || role === 'SUPERVISOR' || role === 'SUPER_ADMIN'
  const canComment = role !== 'VIEWER'

  const load = async () => {
    try {
      const data = await api.get<{ complaint: DetailComplaint }>(`/api/complaints/${complaintId}`)
      setComplaint(data.complaint)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load this complaint')
    }
  }

   
  useEffect(() => { void load() }, [complaintId])

  // AI suggested resolution is generated when staff opens a complaint (§25)
  useEffect(() => {
    let cancelled = false
    setSuggestionLoading(true)
    api.get<{ suggestion: { suggestion: string; confidence: number | null; estimatedResolutionTime: string | null } }>(`/api/complaints/${complaintId}/suggestion`)
      .then((d) => { if (!cancelled) setSuggestion(d.suggestion) })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setSuggestionLoading(false) })
    return () => { cancelled = true }
  }, [complaintId])

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    try {
      await fn()
      await load()
      onChanged()
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const changeStatus = (status: ComplaintStatus, reason?: string) =>
    act(() => api.post(`/api/complaints/${complaintId}/status`, { status, reason }))

  const assign = (userId: string) =>
    act(() => api.post(`/api/complaints/${complaintId}/assign`, { assignedTo: userId, reason: 'MANUAL' })).then(() => setShowAssign(false))

  const changePriority = (priority: string) =>
    act(() => api.patch(`/api/complaints/${complaintId}`, { priority }))

  const sendReply = async () => {
    if (!complaint?.conversation || !reply.trim()) return
    setBusy(true)
    try {
      await api.post(`/api/conversations/${complaint.conversation.id}/messages`, { content: reply.trim() })
      setReply('')
      await load()
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Reply failed — WhatsApp connection required')
    } finally {
      setBusy(false)
    }
  }

  const addComment = async () => {
    if (!comment.trim()) return
    await act(() => api.post(`/api/complaints/${complaintId}/comments`, { content: comment.trim() }))
    setComment('')
  }

  const ai = complaint?.aiAnalyses?.[0]
  const relatedCount = complaint?.relatedComplaints.filter((m) => m.status === 'PENDING').length ?? 0

  if (error && !complaint) {
    return (
      <div className="page-content">
        <button className="back-link" onClick={onBack}>← Back to complaints</button>
        <div className="detail-card" style={{ padding: 40, textAlign: 'center' }}>
          <AlertCircle size={24} style={{ color: '#d64b60', marginBottom: 10 }} />
          <h3 style={{ fontSize: 14, margin: '0 0 6px' }}>Complaint unavailable</h3>
          <p style={{ fontSize: 11.5, color: 'var(--muted-foreground)' }}>{error}</p>
        </div>
      </div>
    )
  }

  if (!complaint) {
    return (
      <div className="page-content">
        <button className="back-link" onClick={onBack}>← Back to complaints</button>
        <div style={{ color: '#a2adbb', fontSize: 11.5 }}>Loading complaint…</div>
      </div>
    )
  }

  const timeline = (() => {
    const rows: Array<{ key: string; done: boolean; current: boolean; title: string; meta: string }> = []
    rows.push({ key: 'created', done: true, current: false, title: 'Complaint created', meta: `${formatTime(complaint.createdAt)} · ${complaint.source === 'WHATSAPP' ? 'WhatsApp' : 'Dashboard'}` })
    if (complaint.acknowledgedAt) rows.push({ key: 'ack', done: true, current: false, title: 'Complaint acknowledged', meta: formatDateTime(complaint.acknowledgedAt) })
    const assignment = complaint.assignments[0]
    if (assignment) rows.push({ key: 'assigned', done: true, current: false, title: `Assigned to ${members.find((m) => m.user.id === assignment.assignedTo)?.user.name ?? 'staff'}`, meta: `${formatDateTime(assignment.assignedAt)}${assignment.reason === 'AUTO_RULE' ? ' · Auto' : ''}` })
    if (ai && ai.status === 'COMPLETED') rows.push({ key: 'ai', done: true, current: false, title: 'AI analysis completed', meta: `SmartServe AI · ${Math.round((ai.confidence ?? 0) * 100)}% confidence` })
    for (const h of complaint.statusHistory) {
      rows.push({
        key: h.id,
        done: true,
        current: false,
        title: `Status changed to ${statusLabel(h.toStatus)}`,
        meta: `${formatDateTime(h.createdAt)}${h.reason ? ` · ${h.reason}` : ''}`,
      })
    }
    if (complaint.resolvedAt) rows.push({ key: 'resolved', done: true, current: complaint.status === 'RESOLVED', title: 'Complaint resolved', meta: formatDateTime(complaint.resolvedAt) })
    const last = rows[rows.length - 1]
    if (last) last.current = complaint.status === 'IN_PROGRESS'
    return rows.reverse()
  })()

  return (
    <div className="page-content">
      <button className="back-link" onClick={onBack}>← Back to complaints</button>
      <div className="detail-header">
        <div>
          <div className="eyebrow">Complaint / {complaint.ticketNumber}</div>
          <h1>{complaint.title}</h1>
          <div className="detail-meta">
            <span className="ticket-id">{complaint.ticketNumber}</span>
            <StatusBadge kind={statusKind(complaint.status)}>{statusLabel(complaint.status)}</StatusBadge>
            <StatusBadge kind={priorityTone(complaint.priority)}>{priorityLabel(complaint.priority)} priority</StatusBadge>
          </div>
        </div>
        <div className="header-actions">
          {canAssign && (
            <Button variant="outline" disabled={busy} onClick={() => setShowAssign((v) => !v)}><UserRound data-icon="inline-start" />{complaint.assignee ? 'Reassign' : 'Assign'}</Button>
          )}
          {(NEXT_STATUS_ACTIONS[complaint.status] ?? []).map((action) => (
            <Button key={action.to} disabled={busy} onClick={() => changeStatus(action.to)}>{action.label}</Button>
          ))}
        </div>
      </div>

      {error && <div className="auth-error" role="alert" style={{ marginBottom: 14 }}>{error}</div>}

      {showAssign && canAssign && (
        <div className="detail-card" style={{ padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 11.5, fontWeight: 650, marginBottom: 10 }}>Assign to staff member</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {members
              .filter((m) => ['STAFF', 'SUPERVISOR', 'ORGANIZATION_ADMIN'].includes(m.role) && m.status === 'ACTIVE')
              .map((m) => (
                <button key={m.id} className="onboard-choice" style={{ padding: '9px 12px', flexDirection: 'row', alignItems: 'center', gap: 8 }} onClick={() => assign(m.user.id)}>
                  <span className="assignee-dot">{initialsOf(m.user.name ?? m.user.email)}</span>
                  <span style={{ fontSize: 11 }}>{m.user.name ?? m.user.email}</span>
                </button>
              ))}
            {members.filter((m) => ['STAFF', 'SUPERVISOR', 'ORGANIZATION_ADMIN'].includes(m.role)).length === 0 && (
              <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>No assignable staff yet — invite team members first.</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <span style={{ fontSize: 10.5, color: 'var(--muted-foreground)' }}>Priority:</span>
            {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((p) => (
              <button key={p} onClick={() => changePriority(p)} disabled={busy} className={`status-badge ${priorityTone(p)}`} style={{ cursor: 'pointer', border: complaint.priority === p ? '1px solid currentColor' : '1px solid transparent' }}>{priorityLabel(p)}</button>
            ))}
          </div>
        </div>
      )}

      <div className="detail-grid">
        <div className="detail-main">
          <div className="detail-card">
            <div className="detail-card-title">
              <h3>Complaint details</h3>
              <button className="icon-button"><MoreHorizontal size={18} /></button>
            </div>
            <div className="customer-profile">
              <div className={`avatar avatar-${priorityTone(complaint.priority)}`}>{initialsOf(complaint.customer.name ?? complaint.customer.phoneNumber)}</div>
              <div>
                <strong>{complaint.customer.name ?? 'Unknown customer'}</strong>
                <span>{complaint.customer.phoneNumber} · WhatsApp</span>
              </div>
            </div>
            <div className="detail-fields">
              <div><span>Location</span><strong>{complaint.location?.name ?? '—'}</strong></div>
              <div><span>Department</span><strong>{complaint.department?.name ?? '—'}</strong></div>
              <div><span>Created</span><strong>{formatDateTime(complaint.createdAt)}</strong></div>
              <div><span>Source</span><strong><MessageCircle size={14} /> {complaint.source === 'WHATSAPP' ? 'WhatsApp' : 'Dashboard'}</strong></div>
            </div>
            <div className="description">
              <span>Description</span>
              <p>{complaint.description ?? 'No description provided.'}</p>
            </div>
            {complaint.attachments.length > 0 && (
              <div className="description">
                <span>Attachments</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 8 }}>
                  {complaint.attachments.map((a) => (
                    <a key={a.id} href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" className="category-chip" style={{ display: 'flex', gap: 6, alignItems: 'center', background: 'var(--muted)', padding: '6px 10px', borderRadius: 7, fontSize: 10.5, color: '#3975dc', textDecoration: 'none' }}>
                      <Paperclip size={12} /> {a.fileName}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>

          {complaint.conversation ? (
            <div className="detail-card conversation-card">
              <div className="detail-card-title">
                <div><h3>Conversation</h3><p>WhatsApp thread with {complaint.customer.name ?? complaint.customer.phoneNumber}</p></div>
                <StatusBadge kind={connection?.status === 'CONNECTED' ? 'resolved' : 'new'}>
                  {connection?.status === 'CONNECTED' ? (connection.mode === 'development' ? 'Connected · dev' : 'Connected') : 'Not connected'}
                </StatusBadge>
              </div>
              <div className="messages">
                {complaint.messages.length === 0 && <div style={{ color: '#a2adba', fontSize: 10.5 }}>No messages in this thread yet.</div>}
                {complaint.messages.map((m) => {
                  const outbound = m.direction === 'OUTBOUND'
                  const isBot = m.senderType === 'BOT'
                  return (
                    <div key={m.id} className={`message ${outbound ? 'agent-message' : 'customer-message'}`}>
                      <span>{isBot ? <><Bot size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />{m.content}</> : m.content}</span>
                      <time>{formatTime(m.createdAt)}{outbound ? (m.status === 'FAILED' ? ' · failed' : m.status === 'READ' ? ' · ✓✓' : ' · ✓') : ''}</time>
                    </div>
                  )
                })}
              </div>
              {canComment && connection?.status === 'CONNECTED' && (
                <div className="reply-box">
                  <input placeholder="Reply to customer..." aria-label="Reply to customer" value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendReply()} />
                  <button aria-label="Send reply" onClick={sendReply} disabled={busy || !reply.trim()}><Send size={15} /></button>
                </div>
              )}
              {canComment && connection?.status !== 'CONNECTED' && (
                <div style={{ marginTop: 12, fontSize: 10.5, color: '#a2adba' }}>Connect WhatsApp Business to reply to the customer directly.</div>
              )}
            </div>
          ) : (
            <div className="detail-card conversation-card">
              <div className="detail-card-title">
                <div><h3>Conversation</h3><p>No WhatsApp conversation linked</p></div>
                <StatusBadge kind="new">Dashboard</StatusBadge>
              </div>
            </div>
          )}

          <div className="detail-card">
            <div className="detail-card-title">
              <div><h3>Internal comments</h3><p>Visible to staff only — never sent to the customer</p></div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
              {complaint.comments.length === 0 && <div style={{ color: '#a2adba', fontSize: 10.5 }}>No internal comments yet.</div>}
              {complaint.comments.map((c) => (
                <div key={c.id} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                  <span className="assignee-dot">{initialsOf(c.author.name)}</span>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 11, margin: 0 }}><strong>{c.author.name ?? 'Staff'}</strong> · <span style={{ color: '#a2adba', fontSize: 9.5 }}>{relativeTime(c.createdAt)}</span></p>
                    <p style={{ fontSize: 11, margin: '3px 0 0', color: 'var(--muted-foreground)', lineHeight: 1.5 }}>{c.content}</p>
                  </div>
                </div>
              ))}
            </div>
            {canComment && (
              <div className="reply-box" style={{ marginTop: 14 }}>
                <input placeholder="Add an internal comment..." aria-label="Internal comment" value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addComment()} />
                <button aria-label="Add comment" onClick={addComment} disabled={busy || !comment.trim()}><Send size={15} /></button>
              </div>
            )}
          </div>
        </div>

        <div className="detail-side">
          <div className="ai-analysis">
            <div className="ai-card-top">
              <div className="ai-icon"><Bot size={17} /></div>
              <span>AI analysis</span>
              {ai?.status === 'COMPLETED' && ai.confidence != null && (
                <span className="confidence">{Math.round(ai.confidence * 100)}% confidence</span>
              )}
              {ai?.status === 'FAILED' && <span className="confidence" style={{ color: '#d64b60' }}>unavailable</span>}
              {complaint.aiStatus === 'PENDING' && <span className="confidence">queued…</span>}
            </div>
            {ai?.status === 'COMPLETED' ? (
              <>
                <div className="analysis-grid">
                  <div><span>Category</span><strong>{ai.category ?? '—'}</strong></div>
                  <div><span>Department</span><strong>{ai.department ?? '—'}</strong></div>
                  <div><span>Priority</span><strong className={ai.priority === 'CRITICAL' || ai.priority === 'HIGH' ? 'critical-text' : ''}>{ai.priority ? priorityLabel(ai.priority) : '—'}</strong></div>
                  <div><span>Sentiment</span><strong className={ai.sentiment === 'NEGATIVE' ? 'negative-text' : ''}>{ai.sentiment ? ai.sentiment.charAt(0) + ai.sentiment.slice(1).toLowerCase() : '—'}</strong></div>
                </div>
                {ai.intent && (
                  <div className="ai-suggestion" style={{ marginTop: 18 }}>
                    <span><Sparkles size={13} /> Intent</span>
                    <p>{ai.intent}</p>
                  </div>
                )}
              </>
            ) : ai?.status === 'FAILED' ? (
              <>
                <p style={{ fontSize: 10.5, color: 'var(--muted-foreground)', margin: '14px 0 8px' }}>AI analysis unavailable — the complaint is unaffected.</p>
                <Button variant="outline" size="sm" onClick={() => act(() => api.post(`/api/complaints/${complaint.id}/ai-retry`))} disabled={busy}>Retry AI analysis</Button>
              </>
            ) : (
              <p style={{ fontSize: 10.5, color: 'var(--muted-foreground)', margin: '14px 0 0' }}>AI analysis is processing… this section updates automatically.</p>
            )}

            <div className="ai-suggestion">
              <span><Sparkles size={13} /> AI-generated suggestion</span>
              {suggestionLoading ? (
                <p>Suggesting a resolution…</p>
              ) : suggestion ? (
                <>
                  <p>{suggestion.suggestion}</p>
                  {suggestion.estimatedResolutionTime && (
                    <p style={{ marginTop: 6, fontSize: 9.5, color: '#9aa5b3' }}>Estimated resolution: {suggestion.estimatedResolutionTime}{suggestion.confidence != null ? ` · ${Math.round(suggestion.confidence * 100)}% confidence` : ''}</p>
                  )}
                </>
              ) : (
                <p>AI suggestion unavailable.</p>
              )}
            </div>
          </div>

          <div className="sla-card">
            <div className="sla-card-head">
              <div>
                <span>SLA countdown</span>
                <strong>{slaLabel(complaint.slaState, complaint.slaDueAt)}</strong>
              </div>
              <div className="sla-clock"><Clock3 size={18} /></div>
            </div>
            <div className="progress-track"><i style={{ width: `${slaProgress(complaint.createdAt, complaint.slaDueAt)}%`, background: slaIsCritical(complaint.slaState) ? '#d65661' : '#e0a734' }} /></div>
            <div className="sla-card-foot">
              <span>Due {complaint.slaDueAt ? formatDateTime(complaint.slaDueAt) : '—'}</span>
              <span style={{ textTransform: 'capitalize' }}>{complaint.slaState.replace('_', ' ').toLowerCase()}</span>
            </div>
          </div>

          {relatedCount > 0 && (
            <div className="detail-card" style={{ padding: 16 }}>
              <div className="detail-card-title"><div><h3>Potential Related Incident</h3><p>{relatedCount} similar complaint{relatedCount === 1 ? '' : 's'} detected</p></div></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 12 }}>
                {complaint.relatedComplaints.filter((m) => m.status === 'PENDING').map((m) => {
                  const other = m.complaint.id === complaint.id ? m.relatedComplaint : m.complaint
                  return (
                    <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <button onClick={() => onOpenComplaint(other.id)} style={{ fontSize: 10.5, color: '#3975dc', fontWeight: 650, border: 0, background: 'transparent', cursor: 'pointer', padding: 0 }}>{other.ticketNumber}</button>
                        <p style={{ fontSize: 10, color: 'var(--muted-foreground)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{other.title}</p>
                        <span style={{ fontSize: 9, color: '#9aa5b3' }}>{Math.round(m.similarity * 100)}% similar</span>
                      </div>
                      {canAssign && (
                        <div style={{ display: 'flex', gap: 5 }}>
                          <button className="status-badge assigned" style={{ cursor: 'pointer', border: 0 }} onClick={() => act(() => api.post(`/api/complaints/${complaintId}/similar`, { matchId: m.id, action: 'LINK' }))}>Link</button>
                          <button className="status-badge new" style={{ cursor: 'pointer', border: 0 }} onClick={() => act(() => api.post(`/api/complaints/${complaintId}/similar`, { matchId: m.id, action: 'DISMISS' }))}>Dismiss</button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {complaint.feedbacks.length > 0 && (
            <div className="detail-card" style={{ padding: 16 }}>
              <div className="detail-card-title"><div><h3>Customer feedback</h3><p>Submitted after resolution</p></div></div>
              {complaint.feedbacks.map((f) => (
                <div key={f.id} style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 13, color: '#c58618', letterSpacing: 2 }}>{'★'.repeat(f.rating)}{'☆'.repeat(5 - f.rating)}</div>
                  {f.comment && <p style={{ fontSize: 10.5, color: 'var(--muted-foreground)', marginTop: 6 }}>{f.comment}</p>}
                  <span style={{ fontSize: 9, color: '#a2adba' }}>{formatDateTime(f.createdAt)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="detail-card timeline-card">
            <div className="detail-card-title"><h3>Activity</h3><span className="muted-text">{complaint.statusHistory.length > 0 ? 'History' : 'Today'}</span></div>
            <div className="timeline">
              {timeline.map((t, i) => (
                <div key={t.key}>
                  <i className={t.current ? 'current' : 'done'} />
                  <p>
                    <strong>{t.title}</strong>
                    <span>{t.meta}</span>
                  </p>
                  {i === 0 && <span style={{ display: 'none' }} />}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function slaProgress(createdAt: string, dueAt: string | null): number {
  if (!dueAt) return 0
  const start = new Date(createdAt).getTime()
  const end = new Date(dueAt).getTime()
  if (end <= start) return 100
  const pct = ((Date.now() - start) / (end - start)) * 100
  return Math.max(2, Math.min(100, Math.round(pct)))
}

export { ArrowUpRight, CheckCircle2 }
