'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import {
  Sparkles, Building2, ClipboardList, UsersRound, Wifi, TimerReset, CheckCircle2,
  Loader2, ArrowRight, Plus, X, Copy, KeyRound,
} from 'lucide-react'
import { api, ApiClientError, type OrganizationInfo } from '@/lib/api'

/**
 * Organization onboarding (spec §66): persistent, resumable steps.
 *  1 Create org (or join with code) → 2 Details → 3 Departments →
 *  4 Invite staff → 5 Connect WhatsApp → 6 Configure SLA → 7 Complete
 */

interface SlaPolicy { priority: string; firstResponseMinutes: number; resolutionMinutes: number; escalationMinutes: number | null; enabled: boolean }
interface DepartmentRow { id: string; name: string; description: string | null }
interface InviteRow { id: string; email: string; role: string; code?: string }

const STEP_LABELS = ['Organization', 'Details', 'Departments', 'Team', 'WhatsApp', 'SLA', 'Ready']

export default function OnboardingPage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [org, setOrg] = useState<OrganizationInfo | null>(null)
  const [step, setStep] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refreshContext = useCallback(async () => {
    try {
      const data = await api.get<{ organizations: OrganizationInfo[] }>('/api/organizations')
      if (data.organizations.length > 0) {
        setOrg(data.organizations[0])
        const onboarding = await api.get<{ step: number }>('/api/organizations/onboarding')
        setStep(onboarding.step)
      } else {
        setOrg(null)
        setStep(0)
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.isAuthError) router.push('/login')
      else setError('Could not load your workspace. Please retry.')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    if (status === 'loading') return
    if (!session) return
    void refreshContext()
  }, [status, session, refreshContext])

  async function persistStep(next: number) {
    setStep(next)
    if (org) {
      await api.patch('/api/organizations/onboarding', { step: next }).catch(() => undefined)
    }
  }

  if (loading || status === 'loading') {
    return (
      <div className="auth-shell">
        <Loader2 size={22} className="animate-spin" style={{ color: '#3578ee' }} />
      </div>
    )
  }

  return (
    <div className="auth-shell">
      <div className="auth-card wide">
        <div className="auth-brand">
          <div className="brand-mark"><Sparkles size={16} strokeWidth={2.5} /></div>
          <span>Smart<span>Serve</span></span>
        </div>

        {org && step > 0 && (
          <div className="auth-steps" aria-label="Onboarding progress">
            {STEP_LABELS.map((label, i) => (
              <i key={label} className={i < step ? 'on' : ''} title={label} />
            ))}
          </div>
        )}

        {error && <div className="auth-error" role="alert">{error}</div>}

        {step === 0 && (org ? <StepChoice existing onDone={() => setStep(1)} /> : <StepChoice existing={false} onDone={() => void refreshContext()} />)}
        {step === 1 && <StepDetails org={org!} onDone={async () => { await persistStep(2) }} />}
        {step === 2 && <StepDepartments onDone={async () => { await persistStep(3) }} />}
        {step === 3 && <StepInvite onDone={async () => { await persistStep(4) }} />}
        {step === 4 && <StepWhatsApp onDone={async () => { await persistStep(5) }} onSkip={async () => { await persistStep(5) }} />}
        {step === 5 && <StepSla onDone={async () => { await persistStep(6) }} />}
        {step >= 6 && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <CheckCircle2 size={40} style={{ color: '#35966c' }} />
            <h1 className="auth-title" style={{ marginTop: 14 }}>You&apos;re all set, {session?.user?.name?.split(' ')[0]}!</h1>
            <p className="auth-sub">Your organization is configured. Open the dashboard to start resolving complaints.</p>
            <button className="auth-button" style={{ maxWidth: 240, margin: '0 auto' }} onClick={() => { router.push('/'); router.refresh() }}>
              Open dashboard <ArrowRight size={14} />
            </button>
          </div>
        )}

        {org && step > 0 && step < 6 && (
          <button className="auth-link" style={{ display: 'block', margin: '16px auto 0', fontSize: 11, border: 0, background: 'transparent', cursor: 'pointer' }} onClick={() => { router.push('/'); router.refresh() }}>
            Finish later — go to dashboard
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 0: create or join
// ---------------------------------------------------------------------------

function StepChoice({ existing, onDone }: { existing: boolean; onDone: () => void }) {
  const router = useRouter()
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>(existing ? 'create' : 'choose')
  const [name, setName] = useState('')
  const [industry, setIndustry] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function createOrg() {
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/organizations', { name, industry: industry || undefined })
      onDone()
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not create the organization')
    } finally {
      setBusy(false)
    }
  }

  async function joinOrg() {
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/organizations/join', { code })
      onDone()
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not join with this code')
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'choose') {
    return (
      <div>
        <h1 className="auth-title">Set up your workspace</h1>
        <p className="auth-sub">Create a new organization or join an existing one with an invitation code.</p>
        <div className="onboard-grid">
          <button type="button" className="onboard-choice" onClick={() => setMode('create')}>
            <div className="choice-icon"><Building2 size={16} /></div>
            <strong>Create an organization</strong>
            <span>Set up complaint resolution for your company, college, hospital or community.</span>
          </button>
          <button type="button" className="onboard-choice" onClick={() => setMode('join')}>
            <div className="choice-icon"><KeyRound size={16} /></div>
            <strong>Join an organization</strong>
            <span>Have an invitation code from your team? Join their SmartServe workspace.</span>
          </button>
        </div>
      </div>
    )
  }

  if (mode === 'join') {
    return (
      <div>
        <h1 className="auth-title">Join an organization</h1>
        <p className="auth-sub">Paste the invitation code your admin shared with you.</p>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <div className="auth-field">
          <label htmlFor="code">Invitation code</label>
          <input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. xK9mP2vQ7aRw" required />
        </div>
        <button className="auth-button" onClick={joinOrg} disabled={busy || code.length < 4}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={14} />}
          Join organization
        </button>
      </div>
    )
  }

  return (
    <div>
      <h1 className="auth-title">Create your organization</h1>
      <p className="auth-sub">This is the workspace your team and customers will use.</p>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <div className="auth-field">
        <label htmlFor="orgname">Organization name</label>
        <input id="orgname" value={name} onChange={(e) => setName(e.target.value)} placeholder="ABC College" required minLength={2} />
      </div>
      <div className="auth-field">
        <label htmlFor="industry">Industry (optional)</label>
        <input id="industry" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="Education, Healthcare, Hospitality..." />
      </div>
      <button className="auth-button" onClick={createOrg} disabled={busy || name.trim().length < 2}>
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Building2 size={14} />}
        Create organization
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step: organization details
// ---------------------------------------------------------------------------

function StepDetails({ org, onDone }: { org: OrganizationInfo; onDone: () => void }) {
  const [email, setEmail] = useState(org.email ?? '')
  const [phone, setPhone] = useState(org.phone ?? '')
  const [website, setWebsite] = useState(org.website ?? '')
  const [address, setAddress] = useState(org.address ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await api.patch('/api/organizations/current', { email, phone, website, address })
      onDone()
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not save details')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h1 className="auth-title">Organization details</h1>
      <p className="auth-sub">Contact information shown to your team. You can update these anytime in Settings.</p>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <div className="auth-field"><label htmlFor="d-email">Contact email</label><input id="d-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="support@abccollege.edu" /></div>
      <div className="auth-field"><label htmlFor="d-phone">Phone</label><input id="d-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" /></div>
      <div className="auth-field"><label htmlFor="d-web">Website</label><input id="d-web" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://..." /></div>
      <div className="auth-field"><label htmlFor="d-addr">Address</label><input id="d-addr" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Mumbai, India" /></div>
      <button className="auth-button" onClick={save} disabled={busy}>
        {busy ? <Loader2 size={15} className="animate-spin" /> : null}
        Continue <ArrowRight size={14} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step: departments
// ---------------------------------------------------------------------------

function StepDepartments({ onDone }: { onDone: () => void }) {
  const [departments, setDepartments] = useState<DepartmentRow[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get<{ departments: DepartmentRow[] }>('/api/departments').then((d) => setDepartments(d.departments)).catch(() => undefined)
  }, [])

  async function add() {
    if (!name.trim()) return
    setBusy(true)
    try {
      const data = await api.post<{ department: DepartmentRow }>('/api/departments', { name: name.trim() })
      setDepartments((prev) => [...prev, data.department])
      setName('')
    } catch {
      // duplicate name — ignore silently
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h1 className="auth-title">Create departments</h1>
      <p className="auth-sub">Complaints are routed to the right team via departments (e.g. IT, Facilities, Finance). Add your first ones now — more can be added later.</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <div className="auth-field" style={{ flex: 1, marginBottom: 10 }}>
          <label htmlFor="dept">Department name</label>
          <input id="dept" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. IT Support" onKeyDown={(e) => e.key === 'Enter' && add()} />
        </div>
        <button type="button" className="auth-button" style={{ width: 90, alignSelf: 'flex-end' }} onClick={add} disabled={busy || !name.trim()}>
          <Plus size={14} /> Add
        </button>
      </div>
      {departments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, margin: '8px 0 16px' }}>
          {departments.map((d) => (
            <span key={d.id} className="category-chip" style={{ background: '#eaf2ff', color: '#2b66d6', padding: '5px 10px', borderRadius: 7, fontSize: 11, fontWeight: 600 }}>{d.name}</span>
          ))}
        </div>
      )}
      <button className="auth-button" onClick={onDone}>
        Continue <ArrowRight size={14} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step: invite staff
// ---------------------------------------------------------------------------

function StepInvite({ onDone }: { onDone: () => void }) {
  const [invites, setInvites] = useState<InviteRow[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('STAFF')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function invite() {
    setBusy(true)
    setError(null)
    try {
      const data = await api.post<{ invitation: InviteRow }>('/api/members', { email, role })
      setInvites((prev) => [...prev, data.invitation])
      setEmail('')
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not create the invitation')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h1 className="auth-title">Invite your team</h1>
      <p className="auth-sub">Invite staff and supervisors. Each invitation generates a join code to share.</p>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <div className="auth-field" style={{ flex: 1 }}>
          <label htmlFor="inv-email">Email</label>
          <input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="staff@abccollege.edu" />
        </div>
        <div className="auth-field" style={{ width: 130 }}>
          <label htmlFor="inv-role">Role</label>
          <select id="inv-role" value={role} onChange={(e) => setRole(e.target.value)} style={{ height: 38, border: '1px solid var(--input)', borderRadius: 8, background: 'var(--background)', color: 'var(--foreground)', fontSize: 12, padding: '0 8px' }}>
            <option value="STAFF">Staff</option>
            <option value="SUPERVISOR">Supervisor</option>
            <option value="VIEWER">Viewer</option>
            <option value="ORGANIZATION_ADMIN">Admin</option>
          </select>
        </div>
        <button type="button" className="auth-button" style={{ width: 90, alignSelf: 'flex-end' }} onClick={invite} disabled={busy || !email.includes('@')}>
          <Plus size={14} /> Add
        </button>
      </div>

      {invites.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '10px 0 14px' }}>
          {invites.map((inv) => (
            <div key={inv.id} className="auth-code-box">
              <UsersRound size={14} style={{ color: '#7a8699' }} />
              <span style={{ fontSize: 11, color: 'var(--foreground)', fontWeight: 600 }}>{inv.email}</span>
              <span style={{ fontSize: 9, color: 'var(--muted-foreground)', textTransform: 'uppercase' }}>{inv.role.replace('_', ' ')}</span>
              {inv.code && (
                <>
                  <code>{inv.code}</code>
                  <button aria-label="Copy invite code" style={{ border: 0, background: 'transparent', cursor: 'pointer', color: '#7a8699' }} onClick={() => navigator.clipboard?.writeText(inv.code!)}>
                    <Copy size={13} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <button className="auth-button" onClick={onDone}>
        Continue <ArrowRight size={14} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step: connect WhatsApp
// ---------------------------------------------------------------------------

function StepWhatsApp({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [wabaId, setWabaId] = useState('')
  const [phoneNumberId, setPhoneNumberId] = useState('')
  const [displayPhoneNumber, setDisplayPhoneNumber] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function connect() {
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/whatsapp/connection', { wabaId, phoneNumberId, displayPhoneNumber, accessToken })
      onDone()
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Connection failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h1 className="auth-title">Connect WhatsApp Business</h1>
      <p className="auth-sub">
        Enter the credentials from your Meta for Developers app (WhatsApp &gt; API Setup). Your access token is encrypted and never exposed.
        In development mode SmartServe uses a local adapter and simulates inbound messages until real credentials are provided.
      </p>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <div className="auth-field"><label htmlFor="w-waba">WhatsApp Business Account ID (WABA)</label><input id="w-waba" value={wabaId} onChange={(e) => setWabaId(e.target.value)} placeholder="1024578..." /></div>
      <div className="auth-field"><label htmlFor="w-pn">Phone number ID</label><input id="w-pn" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="106540..." /></div>
      <div className="auth-field"><label htmlFor="w-disp">Display phone number</label><input id="w-disp" value={displayPhoneNumber} onChange={(e) => setDisplayPhoneNumber(e.target.value)} placeholder="+91 98765 43210" /></div>
      <div className="auth-field"><label htmlFor="w-token">Permanent access token</label><input id="w-token" type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="EAAG..." /></div>
      <button className="auth-button" onClick={connect} disabled={busy || !wabaId || !phoneNumberId || !displayPhoneNumber || accessToken.length < 8}>
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Wifi size={14} />}
        Connect WhatsApp Business
      </button>
      <button type="button" className="auth-button ghost" style={{ marginTop: 9 }} onClick={onSkip}>
        Configure later <ArrowRight size={14} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step: SLA configuration
// ---------------------------------------------------------------------------

function StepSla({ onDone }: { onDone: () => void }) {
  const [policies, setPolicies] = useState<SlaPolicy[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get<{ policies: Record<string, Omit<SlaPolicy, 'priority'>> }>('/api/sla').then(({ policies: p }) => {
      setPolicies(
        ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((priority) => ({
          priority,
          firstResponseMinutes: p[priority]?.firstResponseMinutes ?? 60,
          resolutionMinutes: p[priority]?.resolutionMinutes ?? 480,
          escalationMinutes: p[priority]?.escalationMinutes ?? null,
          enabled: p[priority]?.enabled ?? true,
        })),
      )
    }).catch(() => undefined)
  }, [])

  function update(priority: string, patch: Partial<SlaPolicy>) {
    setPolicies((prev) => prev.map((p) => (p.priority === priority ? { ...p, ...patch } : p)))
  }

  async function save() {
    setBusy(true)
    try {
      await api.put('/api/sla', { policies })
      onDone()
    } catch {
      // fall through — SLA defaults already active
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h1 className="auth-title">Configure SLA</h1>
      <p className="auth-sub">Resolution time targets per priority. SmartServe warns before breach and escalates automatically.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        {policies.map((p) => (
          <div key={p.priority} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr', gap: 9, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 9, padding: '11px 13px' }}>
            <strong style={{ fontSize: 11, color: p.priority === 'CRITICAL' ? '#d64b60' : p.priority === 'HIGH' ? '#d6683f' : 'var(--foreground)' }}>{p.priority}</strong>
            <label style={{ fontSize: 10, color: 'var(--muted-foreground)', display: 'flex', flexDirection: 'column', gap: 4 }}>
              Resolution (minutes)
              <input type="number" min={1} value={p.resolutionMinutes} onChange={(e) => update(p.priority, { resolutionMinutes: Number(e.target.value) || 1 })} style={{ height: 32, border: '1px solid var(--input)', borderRadius: 7, padding: '0 8px', fontSize: 12, background: 'var(--background)', color: 'var(--foreground)' }} />
            </label>
            <label style={{ fontSize: 10, color: 'var(--muted-foreground)', display: 'flex', flexDirection: 'column', gap: 4 }}>
              First response (minutes)
              <input type="number" min={1} value={p.firstResponseMinutes} onChange={(e) => update(p.priority, { firstResponseMinutes: Number(e.target.value) || 1 })} style={{ height: 32, border: '1px solid var(--input)', borderRadius: 7, padding: '0 8px', fontSize: 12, background: 'var(--background)', color: 'var(--foreground)' }} />
            </label>
          </div>
        ))}
      </div>
      <button className="auth-button" onClick={save} disabled={busy || policies.length === 0}>
        {busy ? <Loader2 size={15} className="animate-spin" /> : <TimerReset size={14} />}
        Save &amp; finish
      </button>
    </div>
  )
}

void X
void ClipboardList
