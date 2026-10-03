'use client'

import { Suspense, useEffect, useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Sparkles, Loader2 } from 'lucide-react'

/**
 * Sign-in page.
 * Credentials + OAuth providers.
 * OAuth buttons render only when configured server-side.
 */

function LoginContent() {
  const router = useRouter()
  const params = useSearchParams()

  const callbackUrl = params.get('callbackUrl') || '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [oauthProviders, setOauthProviders] = useState<string[]>([])

  useEffect(() => {
    fetch('/api/auth/providers')
      .then((r) => r.json())
      .then((providers: Record<string, { id: string }>) => {
        setOauthProviders(
          Object.values(providers ?? {})
            .filter((p) => p.id !== 'credentials')
            .map((p) => p.id)
        )
      })
      .catch(() => setOauthProviders([]))
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    setError(null)
    setLoading(true)

    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
      })

      if (result?.error) {
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

  return (
    <div className="auth-shell">
      <div className="auth-card">

        <div className="auth-brand">
          <div className="brand-mark">
            <Sparkles size={16} strokeWidth={2.5} />
          </div>

          <span>
            Smart<span>Serve</span>
          </span>
        </div>

        <h1 className="auth-title">
          Welcome back
        </h1>

        <p className="auth-sub">
          Sign in to your SmartServe workspace.
        </p>

        {error && (
          <div
            className="auth-error"
            role="alert"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>

          <div className="auth-field">
            <label htmlFor="email">
              Work email
            </label>

            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>

          <div className="auth-field">
            <label htmlFor="password">
              Password
            </label>

            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

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

            {loading
              ? 'Signing in...'
              : 'Sign in'}
          </button>

        </form>

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
                  onClick={() =>
                    signIn('google', {
                      callbackUrl,
                    })
                  }
                >
                  Continue with Google
                </button>
              )}

              {oauthProviders.includes('github') && (
                <button
                  type="button"
                  className="auth-button ghost"
                  onClick={() =>
                    signIn('github', {
                      callbackUrl,
                    })
                  }
                >
                  Continue with GitHub
                </button>
              )}

            </div>
          </>
        )}

        <div className="auth-alt">
          New to SmartServe?{' '}
          <a href="/register">
            Create an account
          </a>
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