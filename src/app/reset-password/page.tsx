
'use client'

import { Suspense, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  Sparkles,
} from 'lucide-react'
import { api, ApiClientError } from '@/lib/api'

function ResetPasswordContent() {
  const params = useSearchParams()
  const token = params.get('token')?.trim() ?? ''

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (loading) return

    setError(null)

    if (!token) {
      setError('Invalid or missing reset link. Please request a new one.')
      return
    }

    if (password.length < 8) {
      setError('Password must contain at least 8 characters.')
      return
    }

    if (password.length > 128) {
      setError('Password cannot exceed 128 characters.')
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)

    try {
      await api.put('/api/auth/password', {
        token,
        password,
      })

      setDone(true)
      setPassword('')
      setConfirmPassword('')
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(
          err.message || 'Unable to reset password. Please request a new link.'
        )
      } else {
        setError('Unable to connect to the server. Please try again.')
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

        {done ? (
          /* Success Screen */
          <div className="recovery-success" role="status">

            <div className="recovery-success-icon">
              <CheckCircle2 size={30} />
            </div>

            <p className="recovery-eyebrow">
              PASSWORD UPDATED
            </p>

            <h1 className="recovery-title">
              You're all set!
            </h1>

            <p className="recovery-description">
              Your SmartServe password has been changed
              successfully. You can now sign in using
              your new password.
            </p>

            <Link
              href="/login"
              className="recovery-submit recovery-submit-link"
            >
              Continue to sign in
            </Link>

          </div>
        ) : (
          <>
            {/* Reset Password Header */}
            <div className="recovery-icon">
              <LockKeyhole size={25} />
            </div>

            <p className="recovery-eyebrow">
              ACCOUNT SECURITY
            </p>

            <h1 className="recovery-title">
              Create a new password
            </h1>

            <p className="recovery-description">
              Choose a strong password to secure
              your SmartServe account.
            </p>

            {/* Error Message */}
            {(error || !token) && (
              <div className="recovery-error" role="alert">
                {error ||
                  'This reset link is invalid or incomplete. Please request a new password reset link.'}
              </div>
            )}

            {/* Reset Password Form */}
            <form
              onSubmit={handleSubmit}
              className="recovery-form"
            >

              {/* New Password */}
              <label htmlFor="new-password">
                New password
              </label>

              <div className="recovery-password-wrap">
                <input
                  id="new-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={128}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    setError(null)
                  }}
                  placeholder="Enter new password"
                  disabled={loading || !token}
                />

                <button
                  type="button"
                  className="recovery-eye"
                  onClick={() =>
                    setShowPassword((value) => !value)
                  }
                  aria-label={
                    showPassword ? 'Hide password' : 'Show password'
                  }
                  disabled={loading}
                >
                  {showPassword ? (
                    <EyeOff size={18} />
                  ) : (
                    <Eye size={18} />
                  )}
                </button>
              </div>

              <p className="recovery-hint">
                Minimum 8 characters, maximum 128 characters.
              </p>

              {/* Confirm Password */}
              <label htmlFor="confirm-password">
                Confirm new password
              </label>

              <div className="recovery-password-wrap">
                <input
                  id="confirm-password"
                  name="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={128}
                  value={confirmPassword}
                  onChange={(event) => {
                    setConfirmPassword(event.target.value)
                    setError(null)
                  }}
                  placeholder="Re-enter new password"
                  disabled={loading || !token}
                />

                <button
                  type="button"
                  className="recovery-eye"
                  onClick={() =>
                    setShowConfirmPassword((value) => !value)
                  }
                  aria-label={
                    showConfirmPassword
                      ? 'Hide password'
                      : 'Show password'
                  }
                  disabled={loading}
                >
                  {showConfirmPassword ? (
                    <EyeOff size={18} />
                  ) : (
                    <Eye size={18} />
                  )}
                </button>
              </div>

              {/* Password Match Feedback */}
              {confirmPassword.length > 0 && (
                <p className="recovery-hint">
                  {password === confirmPassword
                    ? 'Passwords match.'
                    : 'Passwords do not match.'}
                </p>
              )}

              {/* Submit */}
              <button
                type="submit"
                className="recovery-submit"
                disabled={loading || !token}
              >
                {loading ? (
                  <>
                    <Loader2
                      size={17}
                      className="animate-spin"
                    />
                    Updating password...
                  </>
                ) : (
                  'Update password'
                )}
              </button>

            </form>
          </>
        )}

        {/* Back to Login */}
        {!done && (
          <div className="recovery-footer">
            <Link href="/login">
              <ArrowLeft size={16} />
              Back to sign in
            </Link>
          </div>
        )}

      </section>

      <p className="recovery-copyright">
        Secure access to your SmartServe workspace
      </p>
    </main>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="auth-shell recovery-shell">
          <section className="auth-card recovery-card">
            Loading...
          </section>
        </main>
      }
    >
      <ResetPasswordContent />
    </Suspense>
  )
}
