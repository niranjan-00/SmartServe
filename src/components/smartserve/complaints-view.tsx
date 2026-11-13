'use client'

import { ArrowUpRight, ChevronLeft, ChevronRight, Clock3, MoreHorizontal, Search, Ticket } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ComplaintRow } from '@/lib/api'
import { initialsOf, priorityTone, priorityLabel, statusKind, statusLabel, slaLabel, slaIsCritical, formatDateTime } from './display'

/**
 * Complaint table + badges — identical visual language to the original UI,
 * now rendering real API rows with server-side filters and pagination (§40).
 */

export interface ComplaintFilters {
  search: string
  status: string
  priority: string
  assignedTo: string
}

export interface ComplaintsViewProps {
  rows: ComplaintRow[]
  loading: boolean
  total: number
  page: number
  pages: number
  filters: ComplaintFilters
  onFilters: (patch: Partial<ComplaintFilters> & { page?: number }) => void
  onSelect: (id: string) => void
  onCreate: () => void
}

export function StatusBadge({ children, kind = 'neutral' }: { children: React.ReactNode; kind?: string }) {
  return <span className={`status-badge ${kind}`}>{children}</span>
}

interface ComplaintRowLike {
  id: string
  ticketNumber: string
  title: string
  status: string
  priority: string
  createdAt: string
  slaState: string
  slaDueAt: string | null
  customer: { id: string; name: string | null; phoneNumber: string }
  category?: { name: string } | null
  department?: { name: string } | null
  assignee?: { name: string | null; image?: string | null } | null
}

export function ComplaintsTable({ complaints, loading, onSelect, onViewAll, compact }: {
  complaints: ComplaintRowLike[]
  loading?: boolean
  onSelect: (id: string) => void
  onViewAll?: () => void
  compact?: boolean
}) {
  return (
    <div className="table-card">
      <div className="table-head">
        <div>
          <h3>{compact ? 'Recent complaints' : 'Complaints'}</h3>
          <p>{compact ? 'Stay on top of every customer request.' : 'Filter, search and open any ticket.'}</p>
        </div>
        {onViewAll && (
          <Button variant="outline" size="sm" onClick={onViewAll}>View all <ArrowUpRight data-icon="inline-end" /></Button>
        )}
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Customer &amp; complaint</th>
              <th>Category</th>
              <th>Priority</th>
              <th>Assignee</th>
              <th>Status</th>
              <th>SLA</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7}><div style={{ padding: '26px 0', textAlign: 'center', color: '#a2adbb', fontSize: 11 }}>Loading complaints…</div></td></tr>
            )}
            {!loading && complaints.length === 0 && (
              <tr><td colSpan={7}><div style={{ padding: '26px 0', textAlign: 'center', color: '#a2adbb', fontSize: 11 }}>No complaints yet. Incoming WhatsApp messages will create tickets here automatically.</div></td></tr>
            )}
            {complaints.map((item) => (
              <tr key={item.id} onClick={() => onSelect(item.id)}>
                <td>
                  <strong className="ticket-id">{item.ticketNumber}</strong>
                  <span className="row-date">{formatDateTime(item.createdAt)}</span>
                </td>
                <td>
                  <div className="customer-cell">
                    <div className={`avatar avatar-${priorityTone(item.priority)}`}>{initialsOf(item.customer.name ?? item.customer.phoneNumber)}</div>
                    <div>
                      <strong>{item.customer.name ?? item.customer.phoneNumber}</strong>
                      <span>{item.title}</span>
                    </div>
                  </div>
                </td>
                <td><span className="category-chip">{item.category?.name ?? item.department?.name ?? '—'}</span></td>
                <td><StatusBadge kind={priorityTone(item.priority)}>{priorityLabel(item.priority)}</StatusBadge></td>
                <td>
                  <span className="assignee">
                    <span className="assignee-dot">{item.assignee?.name ? item.assignee.name.slice(0, 1) : '?'}</span>
                    {item.assignee?.name ?? 'Unassigned'}
                  </span>
                </td>
                <td><StatusBadge kind={statusKind(item.status)}>{statusLabel(item.status)}</StatusBadge></td>
                <td>
                  <span className={`sla ${slaIsCritical(item.slaState) ? 'sla-critical' : ''}`}>
                    <Clock3 size={13} />
                    {slaLabel(item.slaState, item.slaDueAt)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function ComplaintsView({ rows, loading, total, page, pages, filters, onFilters, onSelect, onCreate }: ComplaintsViewProps) {
  const withinSla = rows.filter((r) => r.slaState === 'WITHIN_SLA' || r.slaState === 'MET').length

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Workspace / Complaints</div>
          <h1>Complaints</h1>
          <p>Manage, assign and resolve customer complaints.</p>
        </div>
        <Button onClick={onCreate}><Ticket data-icon="inline-start" />Create complaint</Button>
      </div>
      <div className="filter-bar">
        <div className="search-field">
          <Search size={16} />
          <input aria-label="Search complaints" placeholder="Search tickets, customers..." value={filters.search} onChange={(e) => onFilters({ search: e.target.value })} />
        </div>
        <select aria-label="Filter by status" className="filter-select" value={filters.status} onChange={(e) => onFilters({ status: e.target.value })}>
          <option value="">All statuses</option>
          {['NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED'].map((s) => (
            <option key={s} value={s}>{statusLabel(s)}</option>
          ))}
        </select>
        <select aria-label="Filter by priority" className="filter-select" value={filters.priority} onChange={(e) => onFilters({ priority: e.target.value })}>
          <option value="">All priorities</option>
          {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((p) => (
            <option key={p} value={p}>{priorityLabel(p)}</option>
          ))}
        </select>
        <select aria-label="Filter by assignee" className="filter-select" value={filters.assignedTo} onChange={(e) => onFilters({ assignedTo: e.target.value })}>
          <option value="">Everyone</option>
          <option value="unassigned">Unassigned</option>
        </select>
      </div>
      <div className="complaints-summary">
        <span><strong>{loading ? '…' : rows.length}</strong> of {total} complaint{total === 1 ? '' : 's'}</span>
        <span className="summary-sla"><i />{total > 0 && rows.length > 0 ? `${Math.round((withinSla / rows.length) * 100)}% within SLA on this page` : 'SLA tracked on every ticket'}</span>
      </div>
      <div className="table-card complaints-table">
        <ComplaintsTable complaints={rows} loading={loading} onSelect={onSelect} />
        <div className="pagination">
          <span>Showing page {page} of {pages}</span>
          <div>
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onFilters({ page: page - 1 })}>
              <ChevronLeft size={13} /> Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onFilters({ page: page + 1 })}>
              Next <ChevronRight size={13} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function RowMenuButton() {
  return (
    <button className="row-menu" aria-label="More actions" onClick={(e) => e.stopPropagation()}>
      <MoreHorizontal size={17} />
    </button>
  )
}
