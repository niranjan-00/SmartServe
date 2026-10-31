
'use client'

import { Suspense, useEffect, useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Sparkles, Loader2 } from 'lucide-react'

/**
 * SmartServe Sign-in page.
 * Supports Credentials + OAuth providers.
 * Shows Forgot Password only after failed login.
 */

function LoginContent() {
  const router = useRouter()
  const params = useSearchParams()

  const callbackUrl = params.get('callbackUrl') || '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loginAttemptFailed, setLoginAttemptFailed] = useState(false)
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
    setLoginAttemptFailed(false)
    setLoading(true)

    try {
      const result = await signIn('credentials', {
        email: email.trim(),
        password,
        redirect: false,
      })

      if (!result || result.error || !result.ok) {
        setError('Incorrect email or password.')
        setLoginAttemptFailed(true)
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

        {/* Error Message */}
        {error && (
          <div
            className="auth-error"
            role="alert"
          >
            {error}
          </div>
        )}

        {/* Login Form */}
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
              onChange={(e) => {
                setEmail(e.target.value)
                setLoginAttemptFailed(false)
                setError(null)
              }}
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
              onChange={(e) => {
                setPassword(e.target.value)
                setLoginAttemptFailed(false)
                setError(null)
              }}
              placeholder="••••••••"
            />
          </div>

          {/* Forgot Password - Only after failed login */}
          {loginAttemptFailed && (
            <div className="flex justify-end -mt-2 mb-4">
              <a
                href={`/forgot-password?email=${encodeURIComponent(email.trim())}`}
                className="text-sm text-blue-500 hover:text-blue-600 font-semibold transition-colors"
              >
                Forgot password? Reset here
              </a>
            </div>
          )}

          {/* Submit */}
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

        {/* OAuth Providers */}
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

        {/* Registration */}
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
