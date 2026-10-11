'use client'

import { useEffect, useState } from 'react'
import { Loader2, Ticket, X } from 'lucide-react'
import { api, ApiClientError, type CategoryRow, type CustomerListRow } from '@/lib/api'

/**
 * Manual complaint creation from the dashboard (spec §40) — goes through
 * POST /api/complaints with full server-side validation; staff-only.
 */

interface MemberLite { id: string; user: { id: string; name: string | null; email: string } }

export function CreateComplaintDialog({ onClose, onCreated, members }: {
  onClose: () => void
  onCreated: (id: string) => void
  members: MemberLite[]
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [priority, setPriority] = useState('MEDIUM')
  const [categoryId, setCategoryId] = useState('')
  const [locationName, setLocationName] = useState('')
  const [categories, setCategories] = useState<CategoryRow[]>([])
  const [knownCustomers, setKnownCustomers] = useState<CustomerListRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.get<{ categories: CategoryRow[] }>('/api/categories').then((d) => setCategories(d.categories.filter((c) => c.status === 'ACTIVE'))).catch(() => undefined)
    api.get<{ customers: CustomerListRow[] }>('/api/customers?pageSize=30').then((d) => setKnownCustomers(d.customers)).catch(() => undefined)
  }, [])

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const data = await api.post<{ complaint: { id: string } }>('/api/complaints', {
        title,
        description: description || undefined,
        priority,
        categoryId: categoryId || undefined,
        customerPhone: customerPhone || undefined,
        customerName: customerName || undefined,
      })
      onCreated(data.complaint.id)
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not create the complaint')
      setBusy(false)
    }
  }

  const valid = title.trim().length >= 3 && customerPhone.trim().length >= 6

  return (
    <div className="search-overlay" onClick={onClose} style={{ paddingTop: 80 }}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <div className="modal-search" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Ticket size={16} />
            <strong style={{ fontSize: 12.5 }}>Create complaint</strong>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ border: 0, background: 'transparent', cursor: 'pointer', color: '#8c99aa', display: 'grid', placeItems: 'center' }}><X size={16} /></button>
        </div>
        <div style={{ padding: '16px 18px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {error && <div className="auth-error" style={{ marginBottom: 0 }}>{error}</div>}
          <div className="auth-field" style={{ marginBottom: 0 }}>
            <label htmlFor="cc-title">Complaint title *</label>
            <input id="cc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary, e.g. AC not working in Room 204" autoFocus />
          </div>
          <div className="auth-field" style={{ marginBottom: 0 }}>
            <label htmlFor="cc-desc">Description</label>
            <textarea id="cc-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Details shared by the customer..." style={{ border: '1px solid var(--input)', borderRadius: 8, padding: '8px 11px', fontSize: 12, background: 'var(--background)', color: 'var(--foreground)', resize: 'vertical' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="auth-field" style={{ marginBottom: 0 }}>
              <label htmlFor="cc-phone">Customer phone *</label>
              <input id="cc-phone" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="919876543210" list="cc-known-customers" />
              <datalist id="cc-known-customers">
                {knownCustomers.map((c) => <option key={c.id} value={c.phoneNumber}>{c.name ?? 'Customer'}</option>)}
              </datalist>
            </div>
            <div className="auth-field" style={{ marginBottom: 0 }}>
              <label htmlFor="cc-name">Customer name</label>
              <input id="cc-name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Rahul Kumar" />
            </div>
            <div className="auth-field" style={{ marginBottom: 0 }}>
              <label htmlFor="cc-cat">Category</label>
              <select id="cc-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={{ height: 38, border: '1px solid var(--input)', borderRadius: 8, background: 'var(--background)', color: 'var(--foreground)', fontSize: 12, padding: '0 8px' }}>
                <option value="">AI will classify</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="auth-field" style={{ marginBottom: 0 }}>
              <label htmlFor="cc-pri">Priority</label>
              <select id="cc-pri" value={priority} onChange={(e) => setPriority(e.target.value)} style={{ height: 38, border: '1px solid var(--input)', borderRadius: 8, background: 'var(--background)', color: 'var(--foreground)', fontSize: 12, padding: '0 8px' }}>
                {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
          <div className="auth-field" style={{ marginBottom: 0 }}>
            <label htmlFor="cc-loc">Location</label>
            <input id="cc-loc" value={locationName} onChange={(e) => setLocationName(e.target.value)} placeholder="e.g. Block B Room 302 (AI can also extract this)" />
          </div>
          <button className="auth-button" onClick={submit} disabled={busy || !valid} style={{ marginTop: 4 }}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Ticket size={14} />}
            {busy ? 'Creating…' : 'Create complaint'}
          </button>
          <span style={{ fontSize: 10, color: 'var(--muted-foreground)', textAlign: 'center' }}>
            Ticket number is generated automatically. AI analysis and auto-assignment run in the background.
          </span>
        </div>
      </div>
    </div>
  )
}
