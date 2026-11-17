
'use client'

import { useState } from 'react'
import {
  BarChart3,
  Bell,
  Building2,
  ChevronDown,
  Inbox,
  LayoutDashboard,
  MessageCircle,
  MoreHorizontal,
  Settings2,
  Sparkles,
  Ticket,
  UserRound,
  Users,
  Wifi,
  X,
  LogOut,
} from 'lucide-react'
import { signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { initialsOf } from './display'
import type { OrganizationInfo } from '@/lib/api'

/**
 * Sidebar
 *
 * - Preserves the existing SmartServe sidebar UI.
 * - Displays organization and user information.
 * - Displays live navigation counts and WhatsApp status.
 * - Shows Unassigned Queue only to STAFF members.
 */

export interface NavCounts {
  openComplaints: number | null
  conversations: number | null
  notifications: number | null
  whatsappConnected: boolean
}

interface SidebarProps {
  active: string
  setActive: (value: string) => void
  open: boolean
  onClose: () => void
  org: OrganizationInfo | null
  role: string
  user: {
    name?: string | null
    email?: string | null
  }
  counts: NavCounts
}

export function Sidebar({
  active,
  setActive,
  open,
  onClose,
  org,
  role,
  user,
  counts,
}: SidebarProps) {
  const router = useRouter()
  const [signingOut, setSigningOut] = useState(false)

  const isStaff = role === 'STAFF'

  const navigate = (view: string) => {
    setActive(view)
    onClose()
  }

  const navGroups = [
    {
      label: 'Workspace',
      items: [
        { label: 'Overview', icon: LayoutDashboard },
        { label: 'Complaints', icon: Ticket, count: counts.openComplaints },
        { label: 'Conversations', icon: MessageCircle, count: counts.conversations },

        // Staff members can access the department's unassigned queue.
        ...(isStaff
          ? [{ label: 'Unassigned Queue', icon: Inbox }]
          : []),

        { label: 'Customers', icon: Users },
      ],
    },
    {
      label: 'Operations',
      items: [
        { label: 'Staff', icon: UserRound },
        { label: 'Departments', icon: Building2 },
        { label: 'Analytics', icon: BarChart3 },
      ],
    },
    {
      label: 'Connect',
      items: [
        {
          label: 'WhatsApp',
          icon: Wifi,
          status: counts.whatsappConnected ? undefined : 'Not connected',
        },
      ],
    },
  ]

  async function signOutNow() {
    if (signingOut) return

    setSigningOut(true)

    try {
      await signOut({ redirect: false })
      router.push('/login')
      router.refresh()
    } catch (error) {
      console.error('Sign out failed:', error)
      setSigningOut(false)
    }
  }

  return (
    <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      {/* Sidebar header */}
      <div className="sidebar-top">
        <Brand />

        <button
          className="icon-button sidebar-close"
          onClick={onClose}
          aria-label="Close navigation"
          type="button"
        >
          <X size={18} />
        </button>
      </div>

      {/* Organization switcher */}
      <div
        className="workspace-switcher"
        title={org ? `${org.name} — ${org.slug}` : ''}
      >
        <div className="workspace-avatar">
          {org ? initialsOf(org.name) : '—'}
        </div>

        <div className="workspace-copy">
          <strong>{org?.name ?? 'No organization'}</strong>
          <span>
            {org?.industry ??
              (role
                ? role.replace('_', ' ').toLowerCase()
                : 'workspace')}
          </span>
        </div>

        <ChevronDown size={15} />
      </div>

      {/* Main navigation */}
      <nav className="nav-area" aria-label="Main navigation">
        {navGroups.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-label">{group.label}</div>

            {group.items.map((item) => {
              const Icon = item.icon
              const isActive = active === item.label

              return (
                <button
                  className={`nav-item ${isActive ? 'active' : ''}`}
                  key={item.label}
                  onClick={() => navigate(item.label)}
                  type="button"
                  aria-current={isActive ? 'page' : undefined}
                >
                  <Icon size={17} />

                  <span>{item.label}</span>

                  {'count' in item &&
                    typeof item.count === 'number' &&
                    item.count > 0 && (
                      <b>
                        {item.count > 99 ? '99+' : item.count}
                      </b>
                    )}

                  {'status' in item &&
                    item.status && (
                      <i aria-label={item.status} />
                    )}
                </button>
              )
            })}
          </div>
        ))}

        {/* Management */}
        <div className="nav-group">
          <div className="nav-label">Management</div>

          <button
            className={`nav-item ${
              active === 'Notifications' ? 'active' : ''
            }`}
            onClick={() => navigate('Notifications')}
            type="button"
            aria-current={
              active === 'Notifications' ? 'page' : undefined
            }
          >
            <Bell size={17} />
            <span>Notifications</span>

            {typeof counts.notifications === 'number' &&
              counts.notifications > 0 && (
                <b className="notification-count">
                  {counts.notifications > 99
                    ? '99+'
                    : counts.notifications}
                </b>
              )}
          </button>

          <button
            className={`nav-item ${
              active === 'Settings' ? 'active' : ''
            }`}
            onClick={() => navigate('Settings')}
            type="button"
            aria-current={
              active === 'Settings' ? 'page' : undefined
            }
          >
            <Settings2 size={17} />
            <span>Settings</span>
          </button>
        </div>
      </nav>

      {/* Sidebar footer */}
      <div className="sidebar-bottom">
        <button
          className="nav-item"
          onClick={signOutNow}
          disabled={signingOut}
          type="button"
        >
          <LogOut size={17} />
          <span>{signingOut ? 'Signing out...' : 'Sign out'}</span>
        </button>

        {/* User profile */}
        <button
          className={`profile-mini ${
            active === 'Profile' ? 'active' : ''
          }`}
          onClick={() => navigate('Profile')}
          type="button"
        >
          <div className="avatar avatar-blue">
            {initialsOf(user.name ?? user.email)}
          </div>

          <div>
            <strong>{user.name ?? 'Signed in'}</strong>
            <span>
              {role
                ? role
                    .replace('_', ' ')
                    .toLowerCase()
                    .replace(/\b\w/g, (c) => c.toUpperCase())
                : 'Member'}
            </span>
          </div>

          <MoreHorizontal size={16} />
        </button>
      </div>
    </aside>
  )
}

export function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark">
        <Sparkles size={16} strokeWidth={2.5} />
      </div>

      <span>
        Smart<span>Serve</span>
      </span>
    </div>
  )
}
