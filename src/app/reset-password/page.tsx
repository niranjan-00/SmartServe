
'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  Sparkles,
  LockKeyhole,
  Loader2,
  ArrowLeft,
  Eye,
  EyeOff,
  CheckCircle2,
} from 'lucide-react'

function ResetPasswordContent() {
  const router = useRouter()
  const params = useSearchParams()

  const token = params.get('token') || ''

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    setError('')

    if (!token) {
      setError('Invalid password reset link. Please request a new one.')
      return
    }

    if (password.length < 8) {
      setError('Password must contain at least 8 characters.')
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)

    try {
      const response = await fetch('/api/auth/password', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token,
          password,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(
          data.message || data.error || 'Unable to reset password.'
        )
      }

      setSuccess(true)

      setTimeout(() => {
        router.push('/login')
      }, 2500)

    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Something went wrong. Please try again.'
      )
    } finally {
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

        <div className="flex justify-center my-6">
          <div className="w-14 h-14 rounded-full bg-blue-500/10 flex items-center justify-center">
            <LockKeyhole size={26} className="text-blue-500" />
          </div>
        </div>

        <h1 className="auth-title">
          Reset your password
        </h1>

        <p className="auth-sub">
          Create a new secure password for your SmartServe account.
        </p>

        {success ? (
          <div className="text-center py-5">
            <CheckCircle2
              size={42}
              className="text-green-500 mx-auto mb-3"
            />

            <h2 className="font-semibold text-lg mb-2">
              Password updated!
            </h2>

            <p className="text-sm opacity-70">
              Your password has been changed successfully.
              Redirecting you to login...
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>

            {error && (
              <div className="auth-error mb-4" role="alert">
                {error}
              </div>
            )}

            <div className="auth-field">
              <label htmlFor="password">
                New password
              </label>

              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter new password"
                  className="w-full pr-11"
                />

                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 opacity-60 hover:opacity-100"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <div className="auth-field">
              <label htmlFor="confirmPassword">
                Confirm new password
              </label>

              <div className="relative">
                <input
                  id="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  className="w-full pr-11"
                />

                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 opacity-60 hover:opacity-100"
                  aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                >
                  {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <p className="text-xs opacity-60 mb-4">
              Use at least 8 characters.
            </p>

            <button
              type="submit"
              className="auth-button"
              disabled={loading || !token}
            >
              {loading && (
                <Loader2 size={16} className="animate-spin" />
              )}

              {loading ? 'Updating password...' : 'Reset password'}
            </button>

          </form>
        )}

        <div className="auth-alt">
          <Link href="/login" className="inline-flex items-center gap-2">
            <ArrowLeft size={15} />
            Back to login
          </Link>
        </div>

      </div>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ResetPasswordContent />
    </Suspense>
  )
}
