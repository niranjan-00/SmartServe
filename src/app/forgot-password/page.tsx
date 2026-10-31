
'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Mail,
  Sparkles,
} from 'lucide-react'
import { api, ApiClientError } from '@/lib/api'

function ForgotPasswordContent() {
  const params = useSearchParams()

  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setEmail(params.get('email') ?? '')
  }, [params])

  async function handleSubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault()

    setError(null)
    setLoading(true)

    try {
      await api.post('/api/auth/password', {
        email: email.trim().toLowerCase(),
      })

      setSent(true)
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 503) {
          setError(
            'Email service is not configured. Please contact your administrator.'
          )
        } else {
          setError(
            err.message || 'Unable to process your request. Please try again.'
          )
        }
      } else {
        setError(
          'Unable to connect to the server. Please try again.'
        )
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="auth-shell recovery-shell">
      <section className="auth-card recovery-card">

        {/* Brand */}
        <Link
          href="/login"
          className="recovery-brand"
          aria-label="SmartServe sign in"
        >
          <span className="recovery-brand-mark">
            <Sparkles size={19} strokeWidth={2.4} />
          </span>

          <span>
            Smart<span>Serve</span>
          </span>
        </Link>

        {!sent ? (
          <>
            {/* Recovery Icon */}
            <div className="recovery-icon">
              <Mail size={25} />
            </div>

            <p className="recovery-eyebrow">
              ACCOUNT RECOVERY
            </p>

            <h1 className="recovery-title">
              Forgot your password?
            </h1>

            <p className="recovery-description">
              Don't worry! Enter your registered email address.
              We'll send you a secure link to reset your password.
            </p>

            {/* Error */}
            {error && (
              <div
                className="recovery-error"
                role="alert"
              >
                {error}
              </div>
            )}

            {/* Form */}
            <form
              onSubmit={handleSubmit}
              className="recovery-form"
            >
              <label htmlFor="recovery-email">
                Work email
              </label>

              <input
                id="recovery-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) =>
                  setEmail(event.target.value)
                }
                placeholder="you@company.com"
              />

              <button
                className="recovery-submit"
                type="submit"
                disabled={loading || !email.trim()}
              >
                {loading ? (
                  <>
                    <Loader2
                      size={17}
                      className="animate-spin"
                    />
                    Sending reset link...
                  </>
                ) : (
                  'Send reset link'
                )}
              </button>
            </form>

            <p className="recovery-hint">
              For your security, we won't reveal whether
              an email address has an account.
            </p>
          </>
        ) : (
          /* Success */
          <div
            className="recovery-success"
            role="status"
          >
            <div className="recovery-success-icon">
              <CheckCircle2 size={30} />
            </div>

            <p className="recovery-eyebrow">
              REQUEST SUBMITTED
            </p>

            <h1 className="recovery-title">
              Check your inbox
            </h1>

            <p className="recovery-description">
              If an account exists for{' '}
              <strong>{email}</strong>, and email delivery
              is configured, a password reset link will
              arrive shortly. The link expires in 30 minutes.
            </p>

            <button
              type="button"
              className="recovery-secondary"
              onClick={() => {
                setSent(false)
                setError(null)
              }}
            >
              Try another email
            </button>
          </div>
        )}

        {/* Back to Login */}
        <div className="recovery-footer">
          <Link href="/login">
            <ArrowLeft size={16} />
            Back to sign in
          </Link>
        </div>

      </section>

      <p className="recovery-copyright">
        Secure access to your SmartServe workspace
      </p>
    </main>
  )
}

export default function ForgotPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="auth-shell">
          <section className="auth-card recovery-card">
            Loading...
          </section>
        </main>
      }
    >
      <ForgotPasswordContent />
    </Suspense>
  )
}
