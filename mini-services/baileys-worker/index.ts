
import { createServer } from 'node:http'
import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import pino from 'pino'
import { db } from '../../src/lib/db'
import { decryptSecret, encryptSecret, safeEqual } from '../../src/server/crypto'

const PORT = Number(process.env.WHATSAPP_WORKER_PORT || 3020)
const SECRET = process.env.WHATSAPP_WORKER_SECRET || ''
const APP_URL = (process.env.NEXT_APP_URL || 'http://localhost:3000').replace(/\/$/, '')
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

const sockets = new Map<string, any>()
const qrCache = new Map<string, { dataUrl: string; expiresAt: number }>()
const starting = new Set<string>()

if (!SECRET) throw new Error('WHATSAPP_WORKER_SECRET is required')

if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32)
) {
  throw new Error('AUTH_SECRET must be a strong random value of at least 32 characters in production')
}

function authorized(req: any) {
  const supplied = String(req.headers['x-worker-secret'] || '')
  return supplied && safeEqual(supplied, SECRET)
}

function json(res: any, status: number, data: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(data))
}

async function readBody(req: any): Promise<any> {
  const chunks: Buffer[] = []

  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk))
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function setStatus(
  accountId: string,
  status: string,
  extra: Record<string, unknown> = {}
) {
  await db.whatsAppAccount.updateMany({
    where: { id: accountId },
    data: { status, ...extra },
  })
}

function createAuthState(accountId: string, storedCreds: string | null) {
  const creds = storedCreds
    ? JSON.parse(decryptSecret(storedCreds), BufferJSON.reviver)
    : initAuthCreds()

  const keys = {
    get: async (type: string, ids: string[]) => {
      if (!ids.length) return {}

      const rows = await db.whatsAppAuthKey.findMany({
        where: {
          accountId,
          keyId: { in: ids.map((id) => `${type}:${id}`) },
        },
      })

      const result: Record<string, unknown> = {}

      for (const row of rows) {
        const id = row.keyId.slice(type.length + 1)

        let value = JSON.parse(
          decryptSecret(row.value),
          BufferJSON.reviver
        )

        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value)
        }

        result[id] = value
      }

      return result
    },

    set: async (data: Record<string, Record<string, unknown>>) => {
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries)) {
          const keyId = `${type}:${id}`

          if (value == null) {
            await db.whatsAppAuthKey.deleteMany({
              where: { accountId, keyId },
            })
          } else {
            const encrypted = encryptSecret(
              JSON.stringify(value, BufferJSON.replacer)
            )

            await db.whatsAppAuthKey.upsert({
              where: {
                accountId_keyId: { accountId, keyId },
              },
              create: { accountId, keyId, value: encrypted },
              update: { value: encrypted },
            })
          }
        }
      }
    },

    clear: async () => {
      await db.whatsAppAuthKey.deleteMany({
        where: { accountId },
      })
    },
  }

  return { creds, keys }
}

async function notifyInbound(payload: Record<string, unknown>) {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      logger.info(
        {
          accountId: payload.accountId,
          messageId: payload.whatsappMessageId,
          attempt: attempt + 1,
        },
        'Forwarding incoming message to SmartServe'
      )

      const response = await fetch(
        `${APP_URL}/api/internal/whatsapp/inbound`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-worker-secret': SECRET,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        }
      )

      const responseText = await response.text()

      if (response.ok) {
        logger.info(
          {
            accountId: payload.accountId,
            messageId: payload.whatsappMessageId,
            status: response.status,
            response: responseText.slice(0, 500),
          },
          'SmartServe accepted incoming message'
        )

        return
      }

      const error = new Error(
        `Inbound handler returned ${response.status}: ${responseText.slice(0, 500)}`
      )

      if (response.status < 500) throw error

      lastError = error
    } catch (error) {
      lastError = error instanceof Error
        ? error
        : new Error('Inbound forwarding failed')

      logger.error(
        {
          accountId: payload.accountId,
          messageId: payload.whatsappMessageId,
          attempt: attempt + 1,
          error: lastError.message,
        },
        'Inbound forwarding attempt failed'
      )

      if (
        lastError.message.includes('Inbound handler rejected message')
      ) {
        throw lastError
      }
    }

    if (attempt < 2) {
      await new Promise((resolve) =>
        setTimeout(resolve, 400 * (attempt + 1))
      )
    }
  }

  throw lastError || new Error('Inbound forwarding failed')
}

function unwrapMessage(message: any): any {
  let current = message?.message || {}

  for (let i = 0; i < 5; i++) {
    const wrapper =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.documentWithCaptionMessage?.message

    if (!wrapper) break

    current = wrapper
  }

  return current
}

function messageText(message: any): { text: string; type: string } {
  const m = unwrapMessage(message)

  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    ''

  const type =
    m.conversation || m.extendedTextMessage
      ? 'TEXT'
      : m.imageMessage
        ? 'IMAGE'
        : m.videoMessage
          ? 'VIDEO'
          : m.audioMessage
            ? 'AUDIO'
            : m.documentMessage
              ? 'DOCUMENT'
              : m.stickerMessage
                ? 'STICKER'
                : m.locationMessage
                  ? 'LOCATION'
                  : m.contactMessage
                    ? 'CONTACT'
                    : 'TEXT'

  return { text, type }
}

async function startSession(accountId: string) {
  if (sockets.has(accountId) || starting.has(accountId)) return

  starting.add(accountId)

  try {
    const account = await db.whatsAppAccount.findUnique({
      where: { id: accountId },
    })

    if (!account) throw new Error('WhatsApp account not found')

    await setStatus(accountId, 'CONNECTING', { lastError: null })

    const auth = createAuthState(accountId, account.credsEncrypted)

    const sock = makeWASocket({
      auth: {
        creds: auth.creds,
        keys: makeCacheableSignalKeyStore(auth.keys as any, logger),
      },
      logger: logger.child({ accountId }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    })

    sockets.set(accountId, sock)

    sock.ev.on('creds.update', async () => {
      try {
        await db.whatsAppAccount.update({
          where: { id: accountId },
          data: {
            credsEncrypted: encryptSecret(
              JSON.stringify(auth.creds, BufferJSON.replacer)
            ),
          },
        })
      } catch (error) {
        logger.error(
          { accountId, error },
          'Could not persist Baileys credentials'
        )
      }
    })

    sock.ev.on('connection.update', async ({
      connection,
      qr,
      lastDisconnect,
    }: any) => {
      if (qr) {
        logger.info({ accountId }, 'New WhatsApp QR generated')

        const dataUrl = await QRCode.toDataURL(qr, {
          width: 280,
          margin: 2,
        })

        qrCache.set(accountId, {
          dataUrl,
          expiresAt: Date.now() + 55_000,
        })

        await setStatus(accountId, 'QR_PENDING')
      }

      if (connection === 'open') {
        qrCache.delete(accountId)

        const rawJid = sock.user?.id || ''

        const phoneNumber =
          rawJid.split(':')[0].split('@')[0].replace(/\D/g, '') || null

        await setStatus(accountId, 'CONNECTED', {
          phoneNumber,
          lastConnectedAt: new Date(),
          lastError: null,
        })

        logger.info(
          { accountId, phoneNumber },
          'WhatsApp connection opened successfully'
        )
      }

      if (connection === 'close') {
        sockets.delete(accountId)
        qrCache.delete(accountId)

        const code = (lastDisconnect?.error as Boom)?.output?.statusCode

        const loggedOut = code === DisconnectReason.loggedOut

        await setStatus(
          accountId,
          loggedOut ? 'LOGGED_OUT' : 'DISCONNECTED',
          {
            lastError: loggedOut
              ? 'WhatsApp logged out this linked device. Reconnect with a new QR code.'
              : `Connection closed (${code ?? 'unknown'}). Reconnecting…`,
            ...(loggedOut
              ? { credsEncrypted: null, phoneNumber: null }
              : {}),
          }
        )

        logger.warn(
          { accountId, code, loggedOut },
          'WhatsApp connection closed'
        )

        if (loggedOut) {
          await db.whatsAppAuthKey.deleteMany({
            where: { accountId },
          })
        } else {
          setTimeout(
            () => void startSession(accountId),
            2500
          )
        }
      }
    })

    // INCOMING MESSAGE DIAGNOSTICS AND PROCESSING
    sock.ev.on('messages.upsert', async ({
      messages,
      type,
    }: any) => {
      logger.info(
        {
          accountId,
          eventType: type,
          messageCount: messages?.length ?? 0,
        },
        'Baileys messages.upsert received'
      )

      if (type !== 'notify') {
        logger.debug(
          { accountId, eventType: type },
          'Non-notify message event; not forwarding'
        )
        return
      }

      for (const message of messages || []) {
        try {
          const remoteJid = message?.key?.remoteJid
          const messageId = message?.key?.id

          logger.info(
            {
              accountId,
              messageId,
              remoteJid,
              fromMe: message?.key?.fromMe,
              pushName: message?.pushName,
            },
            'Incoming WhatsApp message event'
          )

          if (!remoteJid || message.key.fromMe) {
            logger.debug(
              { accountId, messageId },
              'Skipping outgoing or unidentified message'
            )
            continue
          }

          // Group and broadcast messages are not treated as direct customer chats.
          if (
            remoteJid.endsWith('@g.us') ||
            remoteJid.endsWith('@broadcast')
          ) {
            logger.info(
              { accountId, remoteJid },
              'Skipping group or broadcast message'
            )
            continue
          }

          const customerJid = remoteJid.endsWith('@s.whatsapp.net')
            ? remoteJid
            : String(message.key.remoteJidAlt || '')

          if (!customerJid.endsWith('@s.whatsapp.net')) {
            logger.warn(
              { accountId, remoteJid },
              'Could not resolve customer WhatsApp number'
            )
            continue
          }

          if (!messageId) {
            logger.warn(
              { accountId, remoteJid },
              'Message has no WhatsApp message ID'
            )
            continue
          }

          const { text, type: messageType } = messageText(message)

          const from = customerJid.split('@')[0]

          logger.info(
            {
              accountId,
              from,
              messageId,
              messageType,
              hasText: Boolean(text),
            },
            'Preparing inbound message'
          )

          await notifyInbound({
            accountId,
            from,
            profileName: message.pushName || null,
            whatsappMessageId: messageId,
            timestamp: new Date(
              Number(
                message.messageTimestamp ||
                Math.floor(Date.now() / 1000)
              ) * 1000
            ).toISOString(),
            messageType,
            text,
          })

          logger.info(
            { accountId, from, messageId },
            'Inbound message processed by SmartServe'
          )

          await sock.readMessages([message.key]).catch(() => undefined)
        } catch (error) {
          logger.error(
            {
              accountId,
              messageId: message?.key?.id,
              error: error instanceof Error
                ? error.message
                : String(error),
            },
            'Failed to process incoming WhatsApp message'
          )
        }
      }
    })

    // MESSAGE DELIVERY STATUS
    sock.ev.on('messages.update', async (updates: any[]) => {
      const statusMap: Record<number, string> = {
        2: 'SENT',
        3: 'DELIVERED',
        4: 'READ',
        5: 'READ',
      }

      for (const update of updates || []) {
        const messageId = update.key?.id
        const mapped = statusMap[Number(update.update?.status)]

        if (messageId && mapped) {
          await db.message.updateMany({
            where: { whatsappMessageId: messageId },
            data: { status: mapped },
          }).catch((error) => {
            logger.error(
              { accountId, messageId, error },
              'Could not update message delivery status'
            )
          })
        }
      }
    })
  } catch (error) {
    sockets.delete(accountId)

    await setStatus(accountId, 'ERROR', {
      lastError: error instanceof Error
        ? error.message
        : 'Could not start WhatsApp session',
    })

    throw error
  } finally {
    starting.delete(accountId)
  }
}

async function stopSession(accountId: string, logout = false) {
  const sock = sockets.get(accountId)

  sockets.delete(accountId)
  qrCache.delete(accountId)

  if (sock) {
    try {
      if (logout) {
        await sock.logout()
      } else {
        sock.end(undefined)
      }
    } catch {
      // Best effort
    }
  }

  if (logout) {
    const account = await db.whatsAppAccount.findUnique({
      where: { id: accountId },
    })

    if (account) {
      await db.whatsAppAccount.update({
        where: { id: accountId },
        data: {
          credsEncrypted: null,
          phoneNumber: null,
          status: 'DISCONNECTED',
        },
      })

      await db.whatsAppAuthKey.deleteMany({
        where: { accountId },
      })
    }
  } else {
    await setStatus(accountId, 'DISCONNECTED')
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(
    req.url || '/',
    `http://127.0.0.1:${PORT}`
  )

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true })
  }

  if (!authorized(req)) {
    return json(res, 401, { error: 'Unauthorized' })
  }

  try {
    if (req.method === 'POST' && url.pathname === '/sessions') {
      const body = await readBody(req)

      if (!body.accountId) {
        return json(res, 400, {
          error: 'accountId is required',
        })
      }

      await startSession(String(body.accountId))

      return json(res, 202, { started: true })
    }

    const match = url.pathname.match(
      /^\/sessions\/([^/]+)(?:\/(qr|send|logout))?$/
    )

    if (match) {
      const accountId = decodeURIComponent(match[1])
      const action = match[2]

      if (req.method === 'GET' && !action) {
        const account = await db.whatsAppAccount.findUnique({
          where: { id: accountId },
          select: {
            id: true,
            status: true,
            phoneNumber: true,
            lastError: true,
          },
        })

        const qr = qrCache.get(accountId)

        return json(res, 200, {
          account,
          qr: qr && qr.expiresAt > Date.now()
            ? qr.dataUrl
            : null,
          qrExpiresAt: qr?.expiresAt ?? null,
        })
      }

      if (req.method === 'GET' && action === 'qr') {
        const qr = qrCache.get(accountId)

        return json(res, 200, {
          qr: qr && qr.expiresAt > Date.now()
            ? qr.dataUrl
            : null,
          expiresAt: qr?.expiresAt ?? null,
        })
      }

      if (req.method === 'POST' && action === 'send') {
        const body = await readBody(req)
        const sock = sockets.get(accountId)

        if (!sock || !sock.user) {
          return json(res, 409, {
            error: 'WhatsApp account is not connected',
          })
        }

        const digits = String(body.to || '').replace(/\D/g, '')

        if (digits.length < 6 || !body.text) {
          return json(res, 400, {
            error: 'Valid recipient and text are required',
          })
        }

        const result = await sock.sendMessage(
          `${digits}@s.whatsapp.net`,
          { text: String(body.text) }
        )

        return json(res, 200, {
          ok: true,
          messageId: result?.key?.id,
        })
      }

      if (req.method === 'POST' && action === 'logout') {
        await stopSession(accountId, true)

        return json(res, 200, { disconnected: true })
      }

      if (req.method === 'DELETE' && !action) {
        await stopSession(accountId, false)

        return json(res, 200, { disconnected: true })
      }
    }

    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    logger.error({ error }, 'Worker request failed')

    return json(res, 500, {
      error: error instanceof Error
        ? error.message
        : 'Internal worker error',
    })
  }
})

server.listen(PORT, '0.0.0.0', async () => {
  logger.info(
    { port: PORT },
    'SmartServe Baileys worker listening'
  )

  try {
    const accounts = await db.whatsAppAccount.findMany({
      where: {
        OR: [
          { credsEncrypted: { not: null } },
          { status: { in: ['CONNECTING', 'QR_PENDING'] } },
        ],
      },
      select: { id: true },
    })

    logger.info(
      { accountCount: accounts.length },
      'Restoring WhatsApp sessions'
    )

    for (const account of accounts) {
      void startSession(account.id).catch((error) => {
        logger.error(
          { accountId: account.id, error },
          'Session restore failed'
        )
      })
    }
  } catch (error) {
    logger.error(
      { error },
      'Could not restore WhatsApp sessions'
    )
  }
})

async function shutdown() {
  logger.info('Shutting down Baileys worker')

  for (const accountId of sockets.keys()) {
    await stopSession(accountId, false)
  }

  server.close(() => process.exit(0))
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
