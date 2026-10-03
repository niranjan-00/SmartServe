'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Bell, Command, LayoutDashboard, Menu, Search, Ticket } from 'lucide-react'
import { api, ApiClientError, type ConnectionSummary, type DashboardOverview, type MemberRow, type OrganizationInfo } from '@/lib/api'
import { useRealtime } from '@/hooks/use-realtime'
import { Sidebar } from '@/components/smartserve/sidebar'
import { Dashboard } from '@/components/smartserve/dashboard'
import { ComplaintsView, type ComplaintFilters } from '@/components/smartserve/complaints-view'
import { ComplaintDetail } from '@/components/smartserve/complaint-detail'
import { ConversationsView, CustomersView, StaffView, AnalyticsView, DepartmentsView } from '@/components/smartserve/workspace-views'
import { NotificationsView, SettingsView, WhatsAppView, ProfileView, useNotifications } from '@/components/smartserve/section-views'
import { SearchModal } from '@/components/smartserve/search-modal'
import { CreateComplaintDialog } from '@/components/smartserve/create-complaint-dialog'

/**
 * SmartServe workspace shell — preserves the original app structure
 * (sidebar / topbar / views) with every surface wired to the real backend.
 */

type ActiveView = 'Overview' | 'Complaints' | 'Conversations' | 'Customers' | 'Staff' | 'Departments' | 'Analytics' | 'WhatsApp' | 'Notifications' | 'Settings' | 'Profile'

const SECTION_VIEWS: ActiveView[] = ['WhatsApp', 'Notifications', 'Settings', 'Profile']

export default function Page() {
  const { data: session, status } = useSession()
  const router = useRouter()

  const [active, setActive] = useState<ActiveView>('Overview')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [dark, setDark] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  // Workspace context
  const [org, setOrg] = useState<OrganizationInfo | null>(null)
  const [role, setRole] = useState<string>('VIEWER')
  const [members, setMembers] = useState<MemberRow[]>([])
  const [connection, setConnection] = useState<ConnectionSummary | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)

  // Dashboard + complaints data
  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [overviewError, setOverviewError] = useState<string | null>(null)

  const [complaintRows, setComplaintRows] = useState<DashboardOverview['recentComplaints']>([])
  const [listRows, setListRows] = useState<ComplaintListState>({ items: [], total: 0, page: 1, pages: 1 })
  const [listLoading, setListLoading] = useState(false)
  const [filters, setFilters] = useState<ComplaintFilters & { page: number }>({ search: '', status: '', priority: '', assignedTo: '', page: 1 })

  const notifications = useNotifications(org?.id)

  const loadContext = useCallback(async () => {
    try {
      const orgsData = await api.get<{ organizations: OrganizationInfo[]; role: string | null }>('/api/organizations')
      if (orgsData.organizations.length === 0) {
        router.replace('/onboarding')
        return
      }
      const current = orgsData.organizations[0]
      setOrg(current)
      setRole(orgsData.role ?? 'VIEWER')

      const [currentData, connectionData, membersData] = await Promise.all([
        api.get<{ organization: OrganizationInfo; role: string; memberCount: number }>('/api/organizations/current'),
        api.get<{ connection: ConnectionSummary }>('/api/whatsapp/connection'),
        api.get<{ members: MemberRow[] }>('/api/members').catch(() => ({ members: [] as MemberRow[] })),
      ])
      setOrg({ ...current, ...currentData.organization })
      setRole(currentData.role)
      setConnection(connectionData.connection)
      setMembers(membersData.members)
      setContextError(null)
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        router.replace('/login')
        return
      }
      if (err instanceof ApiClientError && err.code === 'NO_ORGANIZATION') {
        router.replace('/onboarding')
        return
      }
      setContextError('Workspace could not be loaded. Please retry.')
    }
  }, [router])

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true)
    setOverviewError(null)
    try {
      const data = await api.get<DashboardOverview>('/api/analytics/overview')
      setOverview(data)
      setComplaintRows(data.recentComplaints)
    } catch (err) {
      setOverviewError(err instanceof ApiClientError ? err.message : 'Dashboard metrics unavailable')
    } finally {
      setOverviewLoading(false)
    }
  }, [])

  const loadComplaintList = useCallback(async () => {
    setListLoading(true)
    try {
      const params = new URLSearchParams({ page: String(filters.page), pageSize: '10' })
      if (filters.search) params.set('search', filters.search)
      if (filters.status) params.set('status', filters.status)
      if (filters.priority) params.set('priority', filters.priority)
      if (filters.assignedTo) params.set('assignedTo', filters.assignedTo)
      const data = await api.get<{ items: typeof listRows.items; total: number; page: number; pages: number }>(`/api/complaints?${params.toString()}`)
      setListRows(data)
    } catch {
      // table keeps previous rows; errors surface on overview
    } finally {
      setListLoading(false)
    }
     
  }, [filters.search, filters.status, filters.priority, filters.assignedTo, filters.page])

  useEffect(() => {
    if (status === 'loading') return
    if (!session) return
    void loadContext()
  }, [status, session, loadContext])

  useEffect(() => {
    if (!org) return
    void loadOverview()
  }, [org, loadOverview])

  useEffect(() => {
    if (!org) return
    const t = setTimeout(() => void loadComplaintList(), 250)
    return () => clearTimeout(t)
  }, [org, loadComplaintList])

  // Realtime — database stays source of truth; events just refetch (spec §34/§67)
  const realtime = useRealtime(org?.id, useCallback((event: string) => {
    if (event === 'realtime.reconnected' || event.startsWith('complaint.') || event.startsWith('sla.') || event === 'dashboard.refresh' || event === 'whatsapp.status_changed' || event === 'member.updated' || event === 'organization.updated') {
      void loadOverview()
      void loadComplaintList()
      void notifications.reload()
      if (event === 'whatsapp.status_changed') void loadContext()
      if (event === 'member.updated') void loadContext()
    }
  }, [loadOverview, loadComplaintList, loadContext, notifications]))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const counts = useMemo(() => ({
    openComplaints: overview?.openComplaints ?? null,
    conversations: null as number | null,
    notifications: notifications.unread,
    whatsappConnected: connection?.status === 'CONNECTED',
  }), [overview, notifications.unread, connection])

  if (status === 'loading' || (!org && !contextError)) {
    return (
      <div className="app-shell" style={{ display: 'grid', placeItems: 'center' }}>
        <div style={{ color: '#8b97a8', fontSize: 12 }}>Loading SmartServe…</div>
      </div>
    )
  }

  if (contextError) {
    return (
      <div className="app-shell" style={{ display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 12.5, color: 'var(--muted-foreground)', marginBottom: 12 }}>{contextError}</p>
          <button className="auth-button" style={{ width: 160, margin: '0 auto' }} onClick={() => void loadContext()}>Retry</button>
        </div>
      </div>
    )
  }

  const openDetail = (id: string) => {
    if (id === 'all') {
      setActive('Complaints')
      setSelectedId(null)
      return
    }
    if (id === 'create') {
      setCreateOpen(true)
      return
    }
    setSelectedId(id)
  }

  const content = selectedId ? (
    <ComplaintDetail
      complaintId={selectedId}
      onBack={() => setSelectedId(null)}
      onOpenComplaint={openDetail}
      members={members}
      role={role}
      connection={connection}
      onChanged={() => {
        void loadOverview()
        void loadComplaintList()
        void notifications.reload()
      }}
    />
  ) : active === 'Complaints' ? (
    <ComplaintsView
      rows={listRows.items}
      loading={listLoading}
      total={listRows.total}
      page={listRows.page}
      pages={listRows.pages}
      filters={filters}
      onFilters={(patch) => setFilters((prev) => ({ ...prev, ...patch, page: patch.page ?? 1 }))}
      onSelect={openDetail}
      onCreate={() => setCreateOpen(true)}
    />
  ) : active === 'Conversations' ? (
    <ConversationsView onRefresh={() => void loadOverview()} />
  ) : active === 'Customers' ? (
    <CustomersView />
  ) : active === 'Staff' ? (
    <StaffView />
  ) : active === 'Departments' ? (
    <DepartmentsView />
  ) : active === 'Analytics' ? (
    <AnalyticsView overview={overview} />
  ) : active === 'WhatsApp' ? (
    <WhatsAppView org={org} role={role} onChanged={() => void loadContext()} />
  ) : active === 'Notifications' ? (
    <NotificationsView notifications={notifications} onOpenComplaint={openDetail} />
  ) : active === 'Settings' ? (
    <SettingsView org={org} role={role} onChanged={() => void loadContext()} />
  ) : active === 'Profile' ? (
    <ProfileView user={{ name: session?.user?.name, email: session?.user?.email, image: session?.user?.image }} members={members} />
  ) : (
    <Dashboard
      user={{ name: session?.user?.name }}
      overview={overview}
      loading={overviewLoading}
      error={overviewError}
      onRetry={() => void loadOverview()}
      onSelect={openDetail}
      onCreate={() => setCreateOpen(true)}
    />
  )

  return (
    <div className={dark ? 'app-shell dark-mode' : 'app-shell'}>
      <Sidebar
        active={active}
        setActive={(value) => { setActive(value as ActiveView); setSelectedId(null) }}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        org={org}
        role={role}
        user={{ name: session?.user?.name, email: session?.user?.email }}
        counts={counts}
      />
      {sidebarOpen && <button className="sidebar-overlay" onClick={() => setSidebarOpen(false)} aria-label="Close navigation overlay" />}
      <main className="main-shell">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu size={20} /></button>
          <button className="global-search" onClick={() => setSearchOpen(true)}>
            <Search size={17} />
            <span>Search anything...</span>
            <kbd><Command size={11} /> K</kbd>
          </button>
          <div className="topbar-actions">
            <button className="icon-button theme-toggle" onClick={() => setDark(!dark)} aria-label="Toggle theme">
              <span className={dark ? 'sun' : 'moon'}>{dark ? '☼' : '◐'}</span>
            </button>
            <button className="icon-button notification-button" onClick={() => { setActive('Notifications'); setSelectedId(null) }} aria-label="Notifications">
              <Bell size={18} />
              {notifications.unread > 0 && <i />}
            </button>
            <div className="top-avatar" title={session?.user?.name ?? ''}>
              {(session?.user?.name ?? 'U').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
            </div>
          </div>
        </header>
        {content}
      </main>
      {searchOpen && (
        <SearchModal onClose={() => setSearchOpen(false)} onSelectComplaint={openDetail} />
      )}
      {createOpen && (
        <CreateComplaintDialog
          members={members}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => { setCreateOpen(false); openDetail(id); void loadOverview(); void loadComplaintList() }}
        />
      )}
      <nav className="mobile-nav">
        <button className={active === 'Overview' ? 'active' : ''} onClick={() => { setActive('Overview'); setSelectedId(null) }}><LayoutDashboard size={18} /><span>Overview</span></button>
        <button className={active === 'Complaints' ? 'active' : ''} onClick={() => { setActive('Complaints'); setSelectedId(null) }}><Ticket size={18} /><span>Complaints</span></button>
        <button onClick={() => setSearchOpen(true)}><Search size={18} /><span>Search</span></button>
        <button onClick={() => { setActive('Notifications'); setSelectedId(null) }}><Bell size={18} /><span>Alerts</span></button>
      </nav>
      {/* keep realtime connection state accessible for debugging */}
      <span data-realtime={realtime.connected ? 'connected' : realtime.error ?? 'offline'} style={{ display: 'none' }} />
    </div>
  )
}

interface ComplaintListState {
  items: DashboardOverview['recentComplaints']
  total: number
  page: number
  pages: number
}
