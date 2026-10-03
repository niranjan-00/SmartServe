'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Building2, Search, Ticket, UserRound } from 'lucide-react'
import { api } from '@/lib/api'
import { statusLabel } from './display'

/**
 * Global search modal (spec §40/§47) — real server-side search across
 * tickets, customers, departments and staff, respecting org + role scoping.
 */

interface SearchResults {
  complaints: Array<{ id: string; ticketNumber: string; title: string; status: string; customer: { name: string | null } }>
  customers: Array<{ id: string; name: string | null; phoneNumber: string; _count?: { complaints?: number } }>
  departments: Array<{ id: string; name: string; _count?: { complaints?: number } }>
  staff: Array<{ id: string; name: string | null; email: string; role: string }>
}

const EMPTY: SearchResults = { complaints: [], customers: [], departments: [], staff: [] }

export function SearchModal({ onClose, onSelectComplaint }: {
  onClose: () => void
  onSelectComplaint: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults>(EMPTY)
  const [loading, setLoading] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      timer.current = setTimeout(() => {
        setResults(EMPTY)
        setLoading(false)
      }, 0)
      return () => {
        if (timer.current) clearTimeout(timer.current)
      }
    }
    // Set loading inside a microtask timer so no setState runs synchronously
    timer.current = setTimeout(() => {
      setLoading(true)
      api.get<SearchResults>(`/api/search?q=${encodeURIComponent(q)}`)
        .then(setResults)
        .catch(() => setResults(EMPTY))
        .finally(() => setLoading(false))
    }, 250)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [query])

  const total = results.complaints.length + results.customers.length + results.departments.length + results.staff.length

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-search">
          <Search size={18} />
          <input
            autoFocus
            placeholder="Search SmartServe..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search"
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
          />
          <kbd>ESC</kbd>
        </div>

        {query.trim().length >= 2 ? (
          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            {loading && <div className="recent-title">{/* keep spacing */}Searching…</div>}
            {!loading && total === 0 && <div className="recent-title">No matches found</div>}

            {results.complaints.length > 0 && <div className="recent-title">Complaints</div>}
            {results.complaints.map((c) => (
              <button key={c.id} className="search-result" onClick={() => { onSelectComplaint(c.id); onClose() }}>
                <div className="result-icon blue"><Ticket size={15} /></div>
                <div>
                  <strong>{c.ticketNumber}</strong>
                  <span>{c.title} · {statusLabel(c.status)} · {c.customer.name ?? 'Unknown'}</span>
                </div>
                <ArrowUpRight size={15} />
              </button>
            ))}

            {results.customers.length > 0 && <div className="recent-title">Customers</div>}
            {results.customers.map((c) => (
              <div key={c.id} className="search-result" style={{ cursor: 'default' }}>
                <div className="result-icon violet"><UserRound size={15} /></div>
                <div>
                  <strong>{c.name ?? c.phoneNumber}</strong>
                  <span>{c.phoneNumber}{c._count?.complaints ? ` · ${c._count.complaints} open` : ''}</span>
                </div>
              </div>
            ))}

            {results.departments.length > 0 && <div className="recent-title">Departments</div>}
            {results.departments.map((d) => (
              <div key={d.id} className="search-result" style={{ cursor: 'default' }}>
                <div className="result-icon green"><Building2 size={15} /></div>
                <div>
                  <strong>{d.name}</strong>
                  <span>{d._count?.complaints ?? 0} complaints</span>
                </div>
              </div>
            ))}

            {results.staff.length > 0 && <div className="recent-title">Staff</div>}
            {results.staff.map((s) => (
              <div key={s.id} className="search-result" style={{ cursor: 'default' }}>
                <div className="result-icon violet"><UserRound size={15} /></div>
                <div>
                  <strong>{s.name ?? s.email}</strong>
                  <span>{s.role.replace('_', ' ').toLowerCase()}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="recent-title">Search tickets, customers, departments or staff</div>
        )}

        <div className="search-footer">
          <span><kbd>↑↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>ESC</kbd> Close</span>
        </div>
      </div>
    </div>
  )
}
