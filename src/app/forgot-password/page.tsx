
'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, Mail, Sparkles, CheckCircle2 } from 'lucide-react'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    setLoading(true)
    setMessage('')
    setError('')

    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Unable to process your request.')
      }

      setMessage(
        data.message ||
        'If an account exists with this email, a password reset link will be sent.'
      )
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
            <Mail size={26} className="text-blue-500" />
          </div>
        </div>

        <h1 className="auth-title">
          Forgot password?
        </h1>

        <p className="auth-sub">
          No worries! Enter your registered email address
          and we'll help you reset your password.
        </p>

        {message && (
          <div
            className="mb-4 p-3 rounded-lg bg-green-500/10 text-green-600 text-sm flex gap-2 items-start"
            role="status"
          >
            <CheckCircle2 size={18} className="shrink-0" />
            {message}
          </div>
        )}

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
              Registered email
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

          <button
            type="submit"
            className="auth-button"
            disabled={loading}
          >
            {loading && (
              <Loader2
                size={16}
                className="animate-spin"
              />
            )}

            {loading ? 'Sending...' : 'Send reset link'}
          </button>

        </form>

        <div className="auth-alt">
          <Link
            href="/login"
            className="inline-flex items-center gap-2"
          >
            <ArrowLeft size={15} />
            Back to login
          </Link>
        </div>

      </div>
    </div>
  )
}
