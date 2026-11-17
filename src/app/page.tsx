
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import {
  Bell,
  Command,
  Inbox,
  LayoutDashboard,
  Menu,
  Search,
  Ticket,
} from 'lucide-react'

import {
  api,
  ApiClientError,
  type ConnectionSummary,
  type DashboardOverview,
  type MemberRow,
  type OrganizationInfo,
} from '@/lib/api'

import { useRealtime } from '@/hooks/use-realtime'
import { Sidebar } from '@/components/smartserve/sidebar'
import { Dashboard } from '@/components/smartserve/dashboard'

import {
  ComplaintsView,
  type ComplaintFilters,
} from '@/components/smartserve/complaints-view'

import { ComplaintDetail } from '@/components/smartserve/complaint-detail'
import { UnassignedQueue } from '@/components/smartserve/unassigned-queue'

import {
  ConversationsView,
  CustomersView,
  StaffView,
  AnalyticsView,
  DepartmentsView,
} from '@/components/smartserve/workspace-views'

import {
  NotificationsView,
  SettingsView,
  WhatsAppView,
  ProfileView,
  useNotifications,
} from '@/components/smartserve/section-views'

import { SearchModal } from '@/components/smartserve/search-modal'
import { CreateComplaintDialog } from '@/components/smartserve/create-complaint-dialog'

/**
 * SmartServe workspace shell.
 *
 * Includes:
 * - Dashboard
 * - Complaints
 * - Department unassigned queue
 * - Conversations
 * - Customers
 * - Staff
 * - Departments
 * - Analytics
 * - WhatsApp
 * - Notifications
 * - Settings
 * - Profile
 */

type ActiveView =
  | 'Overview'
  | 'Complaints'
  | 'Unassigned Queue'
  | 'Conversations'
  | 'Customers'
  | 'Staff'
  | 'Departments'
  | 'Analytics'
  | 'WhatsApp'
  | 'Notifications'
  | 'Settings'
  | 'Profile'

interface ComplaintListState {
  items: DashboardOverview['recentComplaints']
  total: number
  page: number
  pages: number
}

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
  const [connection, setConnection] =
    useState<ConnectionSummary | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)

  // Dashboard data
  const [overview, setOverview] =
    useState<DashboardOverview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [overviewError, setOverviewError] = useState<string | null>(null)

  // Complaint list data
  const [listRows, setListRows] = useState<ComplaintListState>({
    items: [],
    total: 0,
    page: 1,
    pages: 1,
  })

  const [listLoading, setListLoading] = useState(false)

  const [filters, setFilters] = useState<
    ComplaintFilters & { page: number }
  >({
    search: '',
    status: '',
    priority: '',
    assignedTo: '',
    page: 1,
  })

  const notifications = useNotifications(org?.id)

  // Load organization and workspace context
  const loadContext = useCallback(async () => {
    try {
      const orgsData = await api.get<{
        organizations: OrganizationInfo[]
        role: string | null
      }>('/api/organizations')

      if (orgsData.organizations.length === 0) {
        router.replace('/onboarding')
        return
      }

      const current = orgsData.organizations[0]

      setOrg(current)
      setRole(orgsData.role ?? 'VIEWER')

      const [currentData, connectionData, membersData] =
        await Promise.all([
          api.get<{
            organization: OrganizationInfo
            role: string
            memberCount: number
          }>('/api/organizations/current'),

          api.get<{
            accounts: Array<{
              id: string
              label: string
              phoneNumber: string | null
              status: string
            }>
          }>('/api/whatsapp/accounts'),

          api
            .get<{ members: MemberRow[] }>('/api/members')
            .catch(() => ({
              members: [] as MemberRow[],
            })),
        ])

      setOrg({
        ...current,
        ...currentData.organization,
      })

      setRole(currentData.role)

      const connectedAccount = connectionData.accounts.find(
        (account) => account.status === 'CONNECTED',
      )

      setConnection({
        id: connectedAccount?.id ?? '',
        status: connectedAccount ? 'CONNECTED' : 'NOT_CONNECTED',
        mode: 'baileys',
        displayPhoneNumber: connectedAccount?.phoneNumber
          ? `+${connectedAccount.phoneNumber}`
          : null,
        phoneNumberId: null,
        wabaId: null,
        statusMessage: null,
        lastVerifiedAt: null,
        createdAt: new Date().toISOString(),
      })

      setMembers(membersData.members)
      setContextError(null)
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        router.replace('/login')
        return
      }

      if (
        err instanceof ApiClientError &&
        err.code === 'NO_ORGANIZATION'
      ) {
        router.replace('/onboarding')
        return
      }

      setContextError(
        'Workspace could not be loaded. Please retry.',
      )
    }
  }, [router])

  // Load dashboard overview
  const loadOverview = useCallback(async () => {
    setOverviewLoading(true)
    setOverviewError(null)

    try {
      const data = await api.get<DashboardOverview>(
        '/api/analytics/overview',
      )

      setOverview(data)
    } catch (err) {
      setOverviewError(
        err instanceof ApiClientError
          ? err.message
          : 'Dashboard metrics unavailable',
      )
    } finally {
      setOverviewLoading(false)
    }
  }, [])

  // Load complaints with filters and pagination
  const loadComplaintList = useCallback(async () => {
    setListLoading(true)

    try {
      const params = new URLSearchParams({
        page: String(filters.page),
        pageSize: '10',
      })

      if (filters.search) {
        params.set('search', filters.search)
      }

      if (filters.status) {
        params.set('status', filters.status)
      }

      if (filters.priority) {
        params.set('priority', filters.priority)
      }

      if (filters.assignedTo) {
        params.set('assignedTo', filters.assignedTo)
      }

      const data = await api.get<{
        items: ComplaintListState['items']
        total: number
        page: number
        pages: number
      }>(`/api/complaints?${params.toString()}`)

      setListRows(data)
    } catch {
      // Preserve previous rows when the request fails.
    } finally {
      setListLoading(false)
    }
  }, [
    filters.search,
    filters.status,
    filters.priority,
    filters.assignedTo,
    filters.page,
  ])

  // Initial workspace loading
  useEffect(() => {
    if (status === 'loading') return
    if (!session) return

    void loadContext()
  }, [status, session, loadContext])

  // Load overview when organization becomes available
  useEffect(() => {
    if (!org) return

    void loadOverview()
  }, [org, loadOverview])

  // Load complaints when filters change
  useEffect(() => {
    if (!org) return

    const timeout = setTimeout(() => {
      void loadComplaintList()
    }, 250)

    return () => clearTimeout(timeout)
  }, [org, loadComplaintList])

  // Realtime updates
  const realtime = useRealtime(
    org?.id,
    useCallback(
      (event: string) => {
        if (
          event === 'realtime.reconnected' ||
          event.startsWith('complaint.') ||
          event.startsWith('sla.') ||
          event === 'dashboard.refresh' ||
          event === 'whatsapp.status_changed' ||
          event === 'member.updated' ||
          event === 'organization.updated'
        ) {
          void loadOverview()
          void loadComplaintList()
          void notifications.reload()

          if (
            event === 'whatsapp.status_changed' ||
            event === 'member.updated'
          ) {
            void loadContext()
          }
        }
      },
      [
        loadOverview,
        loadComplaintList,
        loadContext,
        notifications.reload,
      ],
    ),
  )

  // Keyboard shortcut: Ctrl/Cmd + K
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault()
        setSearchOpen(true)
      }
    }

    window.addEventListener('keydown', onKey)

    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // Sidebar counters
  const counts = useMemo(
    () => ({
      openComplaints: overview?.openComplaints ?? null,
      conversations: null as number | null,
      notifications: notifications.unread,
      whatsappConnected: connection?.status === 'CONNECTED',
    }),
    [overview, notifications.unread, connection],
  )

  // Loading state
  if (status === 'loading' || (!org && !contextError)) {
    return (
      <div
        className="app-shell"
        style={{
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <div
          style={{
            color: '#8b97a8',
            fontSize: 12,
          }}
        >
          Loading SmartServe…
        </div>
      </div>
    )
  }

  // Workspace error state
  if (contextError) {
    return (
      <div
        className="app-shell"
        style={{
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <p
            style={{
              fontSize: 12.5,
              color: 'var(--muted-foreground)',
              marginBottom: 12,
            }}
          >
            {contextError}
          </p>

          <button
            className="auth-button"
            style={{
              width: 160,
              margin: '0 auto',
            }}
            onClick={() => void loadContext()}
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  // Complaint navigation
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

  // Refresh shared data after complaint changes
  const refreshWorkspace = () => {
    void loadOverview()
    void loadComplaintList()
    void notifications.reload()
  }

  // Active page content
  const content = selectedId ? (
    <ComplaintDetail
      complaintId={selectedId}
      onBack={() => setSelectedId(null)}
      onOpenComplaint={openDetail}
      members={members}
      role={role}
      connection={connection}
      onChanged={refreshWorkspace}
    />
  ) : active === 'Complaints' ? (
    <ComplaintsView
      rows={listRows.items}
      loading={listLoading}
      total={listRows.total}
      page={listRows.page}
      pages={listRows.pages}
      filters={filters}
      onFilters={(patch) =>
        setFilters((previous) => ({
          ...previous,
          ...patch,
          page: patch.page ?? 1,
        }))
      }
      onSelect={openDetail}
      onCreate={() => setCreateOpen(true)}
    />
  ) : active === 'Unassigned Queue' && role === 'STAFF' ? (
    <UnassignedQueue
      onSelect={openDetail}
    />
  ) : active === 'Conversations' ? (
    <ConversationsView
      onRefresh={() => void loadOverview()}
    />
  ) : active === 'Customers' ? (
    <CustomersView />
  ) : active === 'Staff' ? (
    <StaffView />
  ) : active === 'Departments' ? (
    <DepartmentsView role={role} />
  ) : active === 'Analytics' ? (
    <AnalyticsView overview={overview} />
  ) : active === 'WhatsApp' ? (
    <WhatsAppView
      org={org}
      role={role}
      onChanged={() => void loadContext()}
    />
  ) : active === 'Notifications' ? (
    <NotificationsView
      notifications={notifications}
      onOpenComplaint={openDetail}
    />
  ) : active === 'Settings' ? (
    <SettingsView
      org={org}
      role={role}
      onChanged={() => void loadContext()}
    />
  ) : active === 'Profile' ? (
    <ProfileView
      user={{
        id: session?.user?.id,
        name: session?.user?.name,
        email: session?.user?.email,
        image: session?.user?.image,
      }}
      members={members}
    />
  ) : (
    <Dashboard
      user={{
        name: session?.user?.name,
      }}
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
        setActive={(value) => {
          setActive(value as ActiveView)
          setSelectedId(null)
          setSidebarOpen(false)
        }}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        org={org}
        role={role}
        user={{
          name: session?.user?.name,
          email: session?.user?.email,
        }}
        counts={counts}
      />

      {sidebarOpen && (
        <button
          className="sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close navigation overlay"
        />
      )}

      <main className="main-shell">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <Menu size={20} />
          </button>

          <button
            className="global-search"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={17} />
            <span>Search anything...</span>
            <kbd>
              <Command size={11} /> K
            </kbd>
          </button>

          <div className="topbar-actions">
            <button
              className="icon-button theme-toggle"
              onClick={() => setDark((previous) => !previous)}
              aria-label="Toggle theme"
            >
              <span className={dark ? 'sun' : 'moon'}>
                {dark ? '☼' : '◐'}
              </span>
            </button>

            <button
              className="icon-button notification-button"
              onClick={() => {
                setActive('Notifications')
                setSelectedId(null)
              }}
              aria-label="Notifications"
            >
              <Bell size={18} />
              {notifications.unread > 0 && <i />}
            </button>

            <div
              className="top-avatar"
              title={session?.user?.name ?? ''}
            >
              {(session?.user?.name ?? 'U')
                .split(/\s+/)
                .map((part) => part[0])
                .slice(0, 2)
                .join('')
                .toUpperCase()}
            </div>
          </div>
        </header>

        {content}
      </main>

      {searchOpen && (
        <SearchModal
          onClose={() => setSearchOpen(false)}
          onSelectComplaint={openDetail}
        />
      )}

      {createOpen && (
        <CreateComplaintDialog
          members={members}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false)
            openDetail(id)
            refreshWorkspace()
          }}
        />
      )}

      <nav className="mobile-nav">
        <button
          className={active === 'Overview' ? 'active' : ''}
          onClick={() => {
            setActive('Overview')
            setSelectedId(null)
          }}
        >
          <LayoutDashboard size={18} />
          <span>Overview</span>
        </button>

        <button
          className={active === 'Complaints' ? 'active' : ''}
          onClick={() => {
            setActive('Complaints')
            setSelectedId(null)
          }}
        >
          <Ticket size={18} />
          <span>Complaints</span>
        </button>

        {role === 'STAFF' && (
          <button
            className={active === 'Unassigned Queue' ? 'active' : ''}
            onClick={() => {
              setActive('Unassigned Queue')
              setSelectedId(null)
            }}
          >
            <Inbox size={18} />
            <span>Queue</span>
          </button>
        )}

        <button onClick={() => setSearchOpen(true)}>
          <Search size={18} />
          <span>Search</span>
        </button>

        <button
          onClick={() => {
            setActive('Notifications')
            setSelectedId(null)
          }}
        >
          <Bell size={18} />
          <span>Alerts</span>
        </button>
      </nav>

      {/* Realtime connection state for debugging */}
      <span
        data-realtime={
          realtime.connected
            ? 'connected'
            : realtime.error ?? 'offline'
        }
        style={{ display: 'none' }}
      />
    </div>
  )
}
