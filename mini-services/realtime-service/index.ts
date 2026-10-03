import { createServer } from 'http'
import { Server } from 'socket.io'
import crypto from 'crypto'

/**
 * SmartServe RealtimeService — socket.io fan-out (spec §34/§65).
 *
 * Architecture:
 *   Browsers ◀──socket.io (path "/", port 3030)──▶ org rooms
 *   Next.js  ──POST 127.0.0.1:3031/emit──▶ fan-out to org rooms
 *
 * Security:
 *   Clients must present a signed room token from POST /api/realtime/verify
 *   (Next.js validates the session + membership). Tokens are HMAC-signed
 *   with the shared AUTH_SECRET; expiry is enforced server-side.
 *   The emit endpoint is loopback-only and secret-protected.
 *
 * The database remains the source of truth: clients refetch on reconnect.
 */

const CLIENT_PORT = Number(process.env.REALTIME_PORT || 3030)
const EMIT_PORT = Number(process.env.REALTIME_EMIT_PORT || 3031)
const SECRET = process.env.REALTIME_SECRET || process.env.AUTH_SECRET || 'smartserve-development-secret-change-me'
const NEXT_APP_URL = process.env.NEXT_APP_URL || 'http://localhost:3000'

// ---------------------------------------------------------------------------
// Client-facing socket.io server
// ---------------------------------------------------------------------------

const httpServer = createServer()

const io = new Server(httpServer, {
  // Path '/' is forwarded by the sandbox gateway via XTransformPort
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60_000,
  pingInterval: 25_000,
})

function verifyRoomToken(token) {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [userId, organizationId, expires, signature] = parts
  const payload = `${userId}.${organizationId}.${expires}`
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  if (Number(expires) < Date.now()) return null
  return { userId, organizationId }
}

io.on('connection', (socket) => {
  socket.on('auth', ({ token } = {}) => {
    const session = verifyRoomToken(token)
    if (!session) {
      socket.emit('auth.error', { message: 'Invalid or expired realtime token' })
      return
    }
    socket.data.userId = session.userId
    socket.data.organizationId = session.organizationId
    socket.join(`org:${session.organizationId}`)
    socket.emit('auth.ok', { organizationId: session.organizationId })
  })

  socket.on('ping', (cb) => {
    if (typeof cb === 'function') cb({ ts: Date.now() })
  })
})

httpServer.listen(CLIENT_PORT, () => {
  console.log(`SmartServe realtime client socket listening on :${CLIENT_PORT} (next app: ${NEXT_APP_URL})`)
})

// ---------------------------------------------------------------------------
// Loopback emit server (Next.js → rooms)
// ---------------------------------------------------------------------------

const emitServer = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/emit') {
    if (req.headers['x-realtime-secret'] !== SECRET) {
      res.writeHead(401).end('unauthorized')
      return
    }
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      try {
        const { organizationId, event, data } = JSON.parse(body)
        if (!organizationId || !event) {
          res.writeHead(400).end('bad request')
          return
        }
        io.to(`org:${organizationId}`).emit(event, { ...(data ?? {}), ts: Date.now() })
        res.writeHead(200).end('ok')
      } catch {
        res.writeHead(400).end('bad json')
      }
    })
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'healthy', clients: io.engine.clientsCount, ts: new Date().toISOString() }))
    return
  }

  res.writeHead(404).end('not found')
})

emitServer.listen(EMIT_PORT, '127.0.0.1', () => {
  console.log(`SmartServe realtime emit endpoint listening on 127.0.0.1:${EMIT_PORT}`)
})

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0))
})
