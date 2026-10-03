'use client'

import { Activity, AlertCircle, ArrowUpRight, CheckCircle2, Clock3, Inbox, ShieldCheck, Ticket, Bot, ChevronDown, TrendingUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DashboardOverview, ComplaintRow } from '@/lib/api'
import { StatusBadge, ComplaintsTable } from './complaints-view'
import { greetingForHour, relativeTime, slaLabel, priorityTone, priorityLabel, initialsOf } from './display'

/**
 * Dashboard (spec §39): every metric, trend point, table row and activity
 * item comes from GET /api/analytics/overview — computed from the database.
 * Visual structure mirrors the original SmartServe dashboard exactly.
 */

export function Dashboard({ user, overview, loading, error, onRetry, onSelect, onCreate }: {
  user: { name?: string | null }
  overview: DashboardOverview | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onSelect: (id: string) => void
  onCreate: () => void
}) {
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const firstName = user.name?.split(' ')[0] ?? 'there'

  if (error) {
    return (
      <div className="page-content">
        <div className="detail-card" style={{ padding: 40, textAlign: 'center' }}>
          <AlertCircle size={26} style={{ color: '#d64b60', marginBottom: 10 }} />
          <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Dashboard unavailable</h3>
          <p style={{ color: 'var(--muted-foreground)', fontSize: 11.5, margin: '0 0 16px' }}>{error}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">{today}</div>
          <h1>{greetingForHour()}, {firstName} <span className="wave">✦</span></h1>
          <p>Here&apos;s what&apos;s happening with your complaints today.</p>
        </div>
        <div className="header-actions">
          <Button variant="outline"><span className="date-dot" />Last 7 days<ChevronDown data-icon="inline-end" /></Button>
          <Button onClick={onCreate}><Ticket data-icon="inline-start" />Create complaint</Button>
        </div>
      </div>

      <div className="metric-grid">
        <MetricCard label="Complaints today" value={overview ? String(overview.complaintsToday) : '—'} delta={overview?.complaintsToday ? `${overview.complaintsToday} received today` : 'No complaints yet today'} icon={Inbox} color="blue" positive />
        <MetricCard label="Open complaints" value={overview ? String(overview.openComplaints) : '—'} delta={overview ? `${overview.resolvedComplaints} resolved all-time` : '—'} icon={Ticket} color="violet" positive />
        <MetricCard label="Avg. resolution time" value={overview ? (overview.averageResolutionHours != null ? formatHours(overview.averageResolutionHours) : '—') : '—'} delta={overview?.averageResolutionHours != null ? 'based on resolved tickets' : 'resolves will populate this'} icon={Clock3} color="green" positive />
        <MetricCard label="SLA compliance" value={overview ? (overview.slaCompliance != null ? `${Math.round(overview.slaCompliance)}%` : '—') : '—'} delta={overview?.slaCompliance != null ? 'resolved within SLA' : 'no resolved tickets yet'} icon={ShieldCheck} color="amber" positive />
      </div>

      <div className="dashboard-grid">
        <div className="trend-card">
          <div className="card-heading">
            <div><h3>Complaints trend</h3><p>Volume received vs. resolved</p></div>
            <div className="legend"><span><i className="legend-blue" />Received</span><span><i className="legend-purple" />Resolved</span></div>
          </div>
          <TrendChart trend={overview?.trend ?? []} />
        </div>
        <AICard overview={overview} />
      </div>

      <div className="dashboard-bottom">
        <ComplaintsTable
          complaints={overview?.recentComplaints ?? []}
          loading={loading && !overview}
          onSelect={onSelect}
          onViewAll={() => onSelect('all')}
        />
        <ActivityCard activities={overview?.liveActivity ?? []} />
      </div>
    </div>
  )
}

function formatHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 48) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(1)}d`
}

function MetricCard({ label, value, delta, icon: Icon, color, positive }: {
  label: string
  value: string
  delta: string
  icon: typeof Ticket
  color: string
  positive?: boolean
}) {
  return (
    <div className="metric-card">
      <div className="metric-head"><span>{label}</span><div className={`metric-icon ${color}`}><Icon size={17} /></div></div>
      <div className="metric-value">{value}</div>
      <div className="metric-foot"><span className={positive ? 'delta' : 'delta down'}>{delta}</span></div>
    </div>
  )
}

function TrendChart({ trend }: { trend: Array<{ day: string; received: number; resolved: number }> }) {
  const days = trend.length === 7 ? trend : []
  const labels = days.length > 0
    ? days.map((d) => new Date(d.day).toLocaleDateString('en-IN', { weekday: 'short' }))
    : []
  const maxVal = Math.max(4, ...days.map((d) => Math.max(d.received, d.resolved)))
  const W = 700
  const H = 210

  const toPath = (values: number[], close: boolean): string => {
    if (values.length < 2) return ''
    const step = W / (values.length - 1)
    const pts = values.map((v, i) => {
      const x = i * step
      const y = H - 26 - (v / maxVal) * (H - 60)
      return [x, y] as const
    })
    let d = `M${pts[0][0]},${pts[0][1]}`
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i - 1]
      const [cx, cy] = pts[i]
      const mx = (px + cx) / 2
      d += ` C${mx},${py} ${mx},${cy} ${cx},${cy}`
    }
    if (close) d += ` L${W},${H - 26} L0,${H - 26} Z`
    return d
  }

  if (days.length === 0) {
    return (
      <div className="chart-wrap">
        <div className="chart-y"><span>0</span></div>
        <div className="chart-main">
          <div className="chart-grid"><i /><i /><i /><i /><i /></div>
          <div style={{ position: 'absolute', inset: '0 0 26px', display: 'grid', placeItems: 'center', color: '#a7b0be', fontSize: 10.5 }}>
            <div style={{ textAlign: 'center', display: 'grid', gap: 6, justifyItems: 'center' }}>
              <TrendingUp size={18} />
              Complaint trends will appear as messages arrive
            </div>
          </div>
          <div className="chart-x"><span> </span></div>
        </div>
      </div>
    )
  }

  return (
    <div className="chart-wrap">
      <div className="chart-y"><span>{maxVal}</span><span>{Math.round(maxVal * 0.75)}</span><span>{Math.round(maxVal * 0.5)}</span><span>{Math.round(maxVal * 0.25)}</span><span>0</span></div>
      <div className="chart-main">
        <div className="chart-grid"><i /><i /><i /><i /><i /></div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Complaints trend chart">
          <defs>
            <linearGradient id="fillBlue" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#3578ee" stopOpacity=".18" />
              <stop offset="1" stopColor="#3578ee" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={toPath(days.map((d) => d.received), true)} fill="url(#fillBlue)" />
          <path d={toPath(days.map((d) => d.received), false)} fill="none" stroke="#3578ee" strokeWidth="3" strokeLinecap="round" />
          <path d={toPath(days.map((d) => d.resolved), false)} fill="none" stroke="#a78bfa" strokeWidth="2.5" strokeDasharray="5 6" strokeLinecap="round" />
        </svg>
        <div className="chart-x">{labels.map((l, i) => <span key={i}>{l}</span>)}</div>
      </div>
    </div>
  )
}

function AICard({ overview }: { overview: DashboardOverview | null }) {
  const totalToday = overview?.complaintsToday ?? 0
  const routed = overview?.departmentStatistics.reduce((a, d) => a + (d.total > 0 ? 1 : 0), 0) ?? 0
  const topCategories = overview?.categoryDistribution.slice(0, 3) ?? []
  return (
    <div className="ai-card">
      <div className="ai-card-top">
        <div className="ai-icon"><Bot size={18} /></div>
        <span>AI operations</span>
        <span className="live-pill"><i /> Live</span>
      </div>
      <h3>SmartServe AI is on top of it.</h3>
      <p>
        AI has analyzed <strong>{totalToday} complaint{totalToday === 1 ? '' : 's'}</strong> today
        {topCategories.length > 0 ? <> — top categories: {topCategories.map((c) => c.name).join(', ')}</> : ' and will route each new ticket to the right team'}.
      </p>
      <div className="ai-progress">
        <div><span>Departments routing</span><strong>{routed > 0 ? `${routed} active` : 'Configure departments'}</strong></div>
        <div className="progress-track"><i style={{ width: `${Math.min(96, routed * 24)}%` }} /></div>
      </div>
      <div className="ai-stat-row">
        <div><strong>{overview?.priorityDistribution.find((p) => p.name === 'CRITICAL')?.count ?? 0}</strong><span>Critical tickets</span></div>
        <div><strong>{overview?.staffWorkload.length ?? 0}</strong><span>Staff on duty</span></div>
        <div><strong>{overview?.categoryDistribution.length ?? 0}</strong><span>Categories</span></div>
      </div>
    </div>
  )
}

function ActivityCard({ activities }: { activities: DashboardOverview['liveActivity'] }) {
  return (
    <div className="activity-card">
      <div className="card-heading">
        <div><h3>Live activity</h3><p>Real-time workspace updates</p></div>
        <Activity size={17} className="muted-icon" />
      </div>
      <div className="activity-list">
        {activities.length === 0 && (
          <div style={{ color: '#a2adba', fontSize: 10.5, lineHeight: 1.6 }}>
            Activity will appear here as complaints are created, assigned and resolved.
          </div>
        )}
        {activities.map((a) => {
          const tone = a.action.includes('sla') || a.action.includes('breach') ? 'amber'
            : a.action.includes('resolved') || a.action.includes('status') ? 'green'
            : a.action.includes('assign') ? 'violet' : 'blue'
          const Icon = tone === 'green' ? CheckCircle2 : tone === 'amber' ? AlertCircle : tone === 'violet' ? Bot : Inbox
          return (
            <div className="activity-item" key={a.id}>
              <div className={`activity-icon ${tone}`}><Icon size={14} /></div>
              <div>
                <p><strong>{a.actor}</strong> {a.description}</p>
                <span>{relativeTime(a.createdAt)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export { StatusBadge }
