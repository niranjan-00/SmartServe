
'use client'

import { Suspense, useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Sparkles, Loader2 } from 'lucide-react'

/**
 * SmartServe Sign-in Page
 * Supports:
 * - Email and password authentication
 * - Google OAuth
 * - GitHub OAuth
 * - Forgot password navigation
 */

function LoginContent() {
  const router = useRouter()
  const params = useSearchParams()

  // Only allow internal callback URLs.
  const requestedCallbackUrl = params.get('callbackUrl') || '/'
  const callbackUrl =
    requestedCallbackUrl.startsWith('/') &&
    !requestedCallbackUrl.startsWith('//')
      ? requestedCallbackUrl
      : '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [oauthProviders, setOauthProviders] = useState<string[]>([])

  // Detect configured OAuth providers.
  useEffect(() => {
    let active = true

    async function loadProviders() {
      try {
        const response = await fetch('/api/auth/providers')

        if (!response.ok) {
          throw new Error('Unable to load authentication providers')
        }

        const providers: Record<string, { id: string }> =
          await response.json()

        if (!active) return

        setOauthProviders(
          Object.values(providers ?? {})
            .filter((provider) => provider.id !== 'credentials')
            .map((provider) => provider.id)
        )
      } catch {
        if (active) {
          setOauthProviders([])
        }
      }
    }

    loadProviders()

    return () => {
      active = false
    }
  }, [])

  // Credentials login.
  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()

    if (loading) return

    setError(null)
    setLoading(true)

    try {
      const result = await signIn('credentials', {
        email: email.trim().toLowerCase(),
        password,
        redirect: false,
        callbackUrl,
      })

      if (!result || result.error) {
        setError('Incorrect email or password.')
        setLoading(false)
        return
      }

      router.push(callbackUrl)
      router.refresh()
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  // OAuth login.
  async function handleOAuth(provider: string) {
    if (loading) return

    setError(null)
    setLoading(true)

    try {
      await signIn(provider, {
        callbackUrl,
      })
    } catch {
      setError(`Unable to sign in with ${provider}. Please try again.`)
      setLoading(false)
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">

        {/* Brand */}
        <div className="auth-brand">
          <div className="brand-mark">
            <Sparkles size={16} strokeWidth={2.5} />
          </div>

          <span>
            Smart<span>Serve</span>
          </span>
        </div>

        {/* Heading */}
        <h1 className="auth-title">
          Welcome back
        </h1>

        <p className="auth-sub">
          Sign in to your SmartServe workspace.
        </p>

        {/* Error message */}
        {error && (
          <div
            className="auth-error"
            role="alert"
            aria-live="polite"
          >
            {error}
          </div>
        )}

        {/* Credentials form */}
        <form onSubmit={handleSubmit}>

          <div className="auth-field">
            <label htmlFor="email">
              Work email
            </label>

            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              disabled={loading}
            />
          </div>

          <div className="auth-field">
            <label htmlFor="password">
              Password
            </label>

            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={loading}
            />

            {/* Forgot password link */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                marginTop: 8,
              }}
            >
              <Link
                href={`/forgot-password?email=${encodeURIComponent(email.trim())}`}
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  textDecoration: 'none',
                }}
              >
                Forgot password?
              </Link>
            </div>
          </div>

          {/* Sign in button */}
          <button
            className="auth-button"
            type="submit"
            disabled={loading}
          >
            {loading && (
              <Loader2
                size={15}
                className="animate-spin"
              />
            )}

            {loading ? 'Signing in...' : 'Sign in'}
          </button>

        </form>

        {/* OAuth providers */}
        {oauthProviders.length > 0 && (
          <>
            <div className="auth-divider">
              or continue with
            </div>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 9,
              }}
            >

              {oauthProviders.includes('google') && (
                <button
                  type="button"
                  className="auth-button ghost"
                  disabled={loading}
                  onClick={() => handleOAuth('google')}
                >
                  Continue with Google
                </button>
              )}

              {oauthProviders.includes('github') && (
                <button
                  type="button"
                  className="auth-button ghost"
                  disabled={loading}
                  onClick={() => handleOAuth('github')}
                >
                  Continue with GitHub
                </button>
              )}

            </div>
          </>
        )}

        {/* Registration link */}
        <div className="auth-alt">
          New to SmartServe?{' '}
          <Link href="/register">
            Create an account
          </Link>
        </div>

      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <LoginContent />
    </Suspense>
  )
}
