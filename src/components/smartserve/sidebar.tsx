'use client'

import { useState } from 'react'
import {
  BarChart3, Bell, Building2, ChevronDown, LayoutDashboard,
  MessageCircle, MoreHorizontal, Settings2, Sparkles, Ticket, UserRound, Users, Wifi, X, LogOut,
} from 'lucide-react'
import { signIn, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { initialsOf } from './display'
import type { OrganizationInfo } from '@/lib/api'

/**
 * Sidebar — identical visual structure to the original UI; counts, org
 * identity, WhatsApp status and profile come from real backend data.
 */

export interface NavCounts {
  openComplaints: number | null
  conversations: number | null
  notifications: number | null
  whatsappConnected: boolean
}

export function Sidebar({ active, setActive, open, onClose, org, role, user, counts }: {
  active: string
  setActive: (v: string) => void
  open: boolean
  onClose: () => void
  org: OrganizationInfo | null
  role: string
  user: { name?: string | null; email?: string | null }
  counts: NavCounts
}) {
  const router = useRouter()
  const [signingOut, setSigningOut] = useState(false)

  const navGroups = [
    { label: 'Workspace', items: [
      { label: 'Overview', icon: LayoutDashboard },
      { label: 'Complaints', icon: Ticket, count: counts.openComplaints },
      { label: 'Conversations', icon: MessageCircle, count: counts.conversations },
      { label: 'Customers', icon: Users },
    ] },
    { label: 'Operations', items: [
      { label: 'Staff', icon: UserRound },
      { label: 'Departments', icon: Building2 },
      { label: 'Analytics', icon: BarChart3 },
    ] },
    { label: 'Connect', items: [
      { label: 'WhatsApp', icon: Wifi, status: counts.whatsappConnected ? undefined : 'Not connected' },
    ] },
  ]

  async function signOutNow() {
    setSigningOut(true)
    await signOut({ redirect: false }).catch(() => undefined)
    router.push('/login')
    router.refresh()
  }

  return (
    <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="sidebar-top"><Brand /><button className="icon-button sidebar-close" onClick={onClose} aria-label="Close navigation"><X size={18} /></button></div>
      <div className="workspace-switcher" title={org ? `${org.name} — ${org.slug}` : ''}>
        <div className="workspace-avatar">{org ? initialsOf(org.name) : '—'}</div>
        <div className="workspace-copy">
          <strong>{org?.name ?? 'No organization'}</strong>
          <span>{org?.industry ?? (role ? role.replace('_', ' ').toLowerCase() : 'workspace')}</span>
        </div>
        <ChevronDown size={15} />
      </div>
      <nav className="nav-area" aria-label="Main navigation">
        {navGroups.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-label">{group.label}</div>
            {group.items.map((item) => {
              const Icon = item.icon
              return (
                <button
                  className={`nav-item ${active === item.label ? 'active' : ''}`}
                  key={item.label}
                  onClick={() => { setActive(item.label); onClose() }}
                >
                  <Icon size={17} />
                  <span>{item.label}</span>
                  {typeof item.count === 'number' && item.count > 0 && <b>{item.count > 99 ? '99+' : item.count}</b>}
                  {item.status && <i aria-label={item.status} />}
                </button>
              )
            })}
          </div>
        ))}
        <div className="nav-group">
          <div className="nav-label">Management</div>
          <button className="nav-item" onClick={() => setActive('Notifications')}>
            <Bell size={17} /><span>Notifications</span>
            {typeof counts.notifications === 'number' && counts.notifications > 0 && <b className="notification-count">{counts.notifications > 99 ? '99+' : counts.notifications}</b>}
          </button>
          <button className="nav-item" onClick={() => setActive('Settings')}><Settings2 size={17} /><span>Settings</span></button>
        </div>
      </nav>
      <div className="sidebar-bottom">
        <button className="nav-item" onClick={signOutNow} disabled={signingOut}><LogOut size={17} /><span>Sign out</span></button>
        <button className="profile-mini" onClick={() => { setActive('Profile'); onClose() }}>
          <div className="avatar avatar-blue">{initialsOf(user.name ?? user.email)}</div>
          <div>
            <strong>{user.name ?? 'Signed in'}</strong>
            <span>{role ? role.replace('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : 'Member'}</span>
          </div>
          <MoreHorizontal size={16} />
        </button>
      </div>
    </aside>
  )
}

export function Brand() {
  return <div className="brand"><div className="brand-mark"><Sparkles size={16} strokeWidth={2.5} /></div><span>Smart<span>Serve</span></span></div>
}

