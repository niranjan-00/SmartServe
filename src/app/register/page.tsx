'use client'

import { useEffect, useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Sparkles, Loader2 } from 'lucide-react'
import { api, ApiClientError } from '@/lib/api'

/** Registration (spec §8): email/password + configured OAuth providers. */
export default function RegisterPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [oauthProviders, setOauthProviders] = useState<string[]>([])

  useEffect(() => {
    fetch('/api/auth/providers')
      .then((r) => r.json())
      .then((providers: Record<string, { id: string }>) => {
        setOauthProviders(Object.values(providers ?? {}).filter((p) => p.id !== 'credentials').map((p) => p.id))
      })
      .catch(() => setOauthProviders([]))
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await api.post('/api/auth/register', { name, email, password })
      const result = await signIn('credentials', { email, password, redirect: false })
      if (result?.error) {
        setError('Account created — please sign in.')
        router.push('/login')
        return
      }
      router.push('/onboarding')
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Registration failed. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark"><Sparkles size={16} strokeWidth={2.5} /></div>
          <span>Smart<span>Serve</span></span>
        </div>
        <h1 className="auth-title">Create your account</h1>
        <p className="auth-sub">Start resolving complaints in minutes.</p>

        {error && <div className="auth-error" role="alert">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="name">Full name</label>
            <input id="name" type="text" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Admin Mehta" />
          </div>
          <div className="auth-field">
            <label htmlFor="email">Work email</label>
            <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </div>
          <div className="auth-field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
          </div>
          <button className="auth-button" type="submit" disabled={loading}>
            {loading ? <Loader2 size={15} className="animate-spin" /> : null}
            {loading ? 'Creating account...' : 'Create account'}
          </button>
        </form>

        {oauthProviders.length > 0 && (
          <>
            <div className="auth-divider">or sign up with</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {oauthProviders.includes('google') && (
                <button type="button" className="auth-button ghost" onClick={() => signIn('google', { callbackUrl: '/onboarding' })}>
                  Continue with Google
                </button>
              )}
              {oauthProviders.includes('github') && (
                <button type="button" className="auth-button ghost" onClick={() => signIn('github', { callbackUrl: '/onboarding' })}>
                  Continue with GitHub
                </button>
              )}
            </div>
          </>
        )}

        <div className="auth-alt">
          Already have an account? <a href="/login">Sign in</a>
        </div>
      </div>
    </div>
  )
}
