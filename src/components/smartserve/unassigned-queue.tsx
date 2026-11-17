
'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  Clock3,
  Inbox,
  Loader2,
  RefreshCw,
  UserRoundCheck,
} from 'lucide-react'

import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { StatusBadge } from './complaints-view'
import {
  priorityLabel,
  priorityTone,
  statusLabel,
  statusKind,
  formatDateTime,
} from './display'

interface QueueComplaint {
  id: string
  ticketNumber: string
  title: string
  description?: string | null
  status: string
  priority: string
  createdAt: string
  slaState?: string
  customer: {
    id: string
    name: string | null
    phoneNumber: string
  }
  category?: {
    id: string
    name: string
  } | null
  department?: {
    id: string
    name: string
  } | null
}

interface QueueResponse {
  items: QueueComplaint[]
  total: number
}

export function UnassignedQueue({
  onSelect,
}: {
  onSelect: (id: string) => void
}) {
  const [items, setItems] = useState<QueueComplaint[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [claimingId, setClaimingId] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const loadQueue = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const result = await api.get<QueueResponse>(
        '/api/complaints/unassigned',
      )

      setItems(result.items ?? [])
      setTotal(result.total ?? 0)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to load department complaints.',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadQueue()
  }, [loadQueue])

  async function handleClaim(complaintId: string) {
    setClaimingId(complaintId)
    setError(null)
    setSuccessMessage(null)

    try {
      await api.post(
        `/api/complaints/${encodeURIComponent(complaintId)}/claim`,
      )

      setItems((previous) =>
        previous.filter((item) => item.id !== complaintId),
      )

      setTotal((previous) => Math.max(0, previous - 1))

      setSuccessMessage('Complaint successfully claimed.')
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to claim this complaint.',
      )

      // Refresh because another staff member may have claimed it.
      await loadQueue()
    } finally {
      setClaimingId(null)
    }
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">Workspace / Department Queue</div>
          <h1>Unassigned complaints</h1>
          <p>
            Review complaints assigned to your department and claim
            the ones you can handle.
          </p>
        </div>

        <Button
          variant="outline"
          onClick={() => void loadQueue()}
          disabled={loading}
        >
          <RefreshCw
            size={15}
            className={loading ? 'animate-spin' : ''}
          />
          Refresh
        </Button>
      </div>

      <div className="metric-grid">
        <div className="metric-card">
          <div className="metric-head">
            <span>Waiting for staff</span>
            <div className="metric-icon blue">
              <Inbox size={17} />
            </div>
          </div>
          <strong className="metric-value">
            {loading ? '—' : total}
          </strong>
          <span className="metric-delta">
            Unassigned department complaints
          </span>
        </div>
      </div>

      {successMessage && (
        <div
          role="status"
          style={{
            padding: 12,
            marginBottom: 16,
            borderRadius: 10,
            background: 'var(--muted)',
            color: 'var(--foreground)',
            fontSize: 13,
          }}
        >
          {successMessage}
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            padding: 14,
            marginBottom: 16,
            borderRadius: 10,
            border: '1px solid var(--border)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 8,
            }}
          >
            <AlertCircle size={17} />
            <strong>Something went wrong</strong>
          </div>

          <p style={{ fontSize: 13, marginBottom: 12 }}>
            {error}
          </p>

          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadQueue()}
          >
            Try again
          </Button>
        </div>
      )}

      <div className="table-card">
        <div className="table-head">
          <div>
            <h3>Available complaints</h3>
            <p>
              Claim a complaint to take responsibility for resolving it.
            </p>
          </div>

          <span className="category-chip">
            {total} waiting
          </span>
        </div>

        {loading ? (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: 'var(--muted-foreground)',
            }}
          >
            <Loader2
              size={22}
              className="animate-spin"
              style={{ margin: '0 auto 10px' }}
            />
            Loading complaints...
          </div>
        ) : items.length === 0 ? (
          <div
            style={{
              padding: 48,
              textAlign: 'center',
            }}
          >
            <UserRoundCheck
              size={34}
              style={{
                margin: '0 auto 12px',
                color: 'var(--muted-foreground)',
              }}
            />

            <h3 style={{ marginBottom: 6 }}>
              All caught up!
            </h3>

            <p
              style={{
                fontSize: 13,
                color: 'var(--muted-foreground)',
              }}
            >
              There are no unassigned complaints in your department.
            </p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Customer</th>
                  <th>Category</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Received</th>
                  <th>Action</th>
                </tr>
              </thead>

              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <button
                        type="button"
                        className="ticket-id"
                        onClick={() => onSelect(item.id)}
                      >
                        {item.ticketNumber}
                      </button>
                    </td>

                    <td>
                      <strong>
                        {item.customer?.name ??
                          item.customer?.phoneNumber ??
                          'Unknown customer'}
                      </strong>
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--muted-foreground)',
                        }}
                      >
                        {item.title}
                      </div>
                    </td>

                    <td>
                      <span className="category-chip">
                        {item.category?.name ??
                          item.department?.name ??
                          'Uncategorized'}
                      </span>
                    </td>

                    <td>
                      <StatusBadge kind={priorityTone(item.priority)}>
                        {priorityLabel(item.priority)}
                      </StatusBadge>
                    </td>

                    <td>
                      <StatusBadge kind={statusKind(item.status)}>
                        {statusLabel(item.status)}
                      </StatusBadge>
                    </td>

                    <td>
                      <span className="sla">
                        <Clock3 size={13} />
                        {formatDateTime(item.createdAt)}
                      </span>
                    </td>

                    <td>
                      <div
                        style={{
                          display: 'flex',
                          gap: 7,
                          alignItems: 'center',
                        }}
                      >
                        <Button
                          size="sm"
                          disabled={claimingId !== null}
                          onClick={() => void handleClaim(item.id)}
                        >
                          {claimingId === item.id ? (
                            <>
                              <Loader2
                                size={13}
                                className="animate-spin"
                              />
                              Claiming
                            </>
                          ) : (
                            <>
                              Claim
                              <ArrowRight size={13} />
                            </>
                          )}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
