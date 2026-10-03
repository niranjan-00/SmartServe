import { useEffect, useState, useRef, useCallback } from 'react'
import { io, type Socket } from 'socket.io-client'

/**
 * Realtime hook (spec §34/§67):
 *   connect → auth (signed org room token) → receive events
 *   on disconnect → reconnect → caller refetches latest state.
 * The database remains the source of truth; realtime only accelerates UI.
 */

export type RealtimeEventHandler = (event: string, data: unknown) => void

interface RealtimeState {
  connected: boolean
  error: string | null
}

export function useRealtime(organizationId: string | null | undefined, onEvent: RealtimeEventHandler) {
  const [state, setState] = useState<RealtimeState>({ connected: false, error: null })
  const socketRef = useRef<Socket | null>(null)
  const handlerRef = useRef(onEvent)
  useEffect(() => {
    handlerRef.current = onEvent
  }, [onEvent])

  const reconnectTick = useCallback(() => undefined, [])

  useEffect(() => {
    if (!organizationId) return

    const url = process.env.NEXT_PUBLIC_REALTIME_URL || '/?XTransformPort=3030'
    const socket = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 1500,
      timeout: 8000,
    })
    socketRef.current = socket

    let authed = false
    let cancelled = false

    const authenticate = async () => {
      try {
        const res = await fetch('/api/realtime/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ organizationId }),
        })
        const json = await res.json()
        if (!res.ok || !json?.ok) {
          setState({ connected: false, error: 'realtime-unauthorized' })
          return
        }
        socket.emit('auth', { token: json.data.token })
      } catch {
        setState({ connected: false, error: 'realtime-unreachable' })
      }
    }

    socket.on('connect', () => {
      authed = false
      void authenticate()
    })

    socket.on('auth.ok', () => {
      authed = true
      if (!cancelled) setState({ connected: true, error: null })
      // Reconnected → refetch to synchronize with DB state (spec §67)
      handlerRef.current('realtime.reconnected', null)
    })

    socket.on('auth.error', () => {
      setState({ connected: false, error: 'realtime-unauthorized' })
    })

    socket.on('disconnect', () => {
      authed = false
      if (!cancelled) setState({ connected: false, error: null })
    })

    socket.on('connect_error', () => {
      if (!cancelled) setState({ connected: false, error: 'realtime-unreachable' })
    })

    const events = [
      'complaint.created',
      'complaint.updated',
      'complaint.assigned',
      'complaint.status_changed',
      'message.created',
      'comment.created',
      'notification.created',
      'sla.warning',
      'sla.breached',
      'whatsapp.status_changed',
      'organization.updated',
      'member.updated',
      'dashboard.refresh',
    ]
    const forward = (event: string) => (data: unknown) => {
      if (authed) handlerRef.current(event, data)
    }
    const cleanups = events.map((event) => {
      const fn = forward(event)
      socket.on(event, fn)
      return () => socket.off(event, fn)
    })

    return () => {
      cancelled = true
      cleanups.forEach((fn) => fn())
      socket.disconnect()
      socketRef.current = null
    }
  }, [organizationId, reconnectTick])

  return state
}
