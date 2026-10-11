import crypto from 'crypto'

/**
 * Secret management helpers. All encryption derives from AUTH_SECRET.
 * Used for WhatsApp access tokens at rest (spec §12/§46/§51).
 */

function keyBytes(): Buffer {
  const secret = process.env.AUTH_SECRET || 'smartserve-development-secret-change-me'
  return crypto.createHash('sha256').update(secret).digest()
}

/** AES-256-GCM encryption → base64(iv.tag.ciphertext) */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

export function decryptSecret(payload: string): string {
  const buf = Buffer.from(payload, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ciphertext = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

/** Timing-safe string comparison for secrets/tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/** Meta webhook signature: sha256=HMAC(appSecret, rawBody) (spec §15). */
export function verifyMetaSignature(rawBody: string, header: string | null, appSecret: string | undefined | null): boolean {
  if (!header || !appSecret) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')
  return safeEqual(expected, header)
}

/** HMAC token generator/verifier used for realtime room auth + invite tokens. */
export function signPayload(payload: string): string {
  const secret = process.env.AUTH_SECRET || 'smartserve-development-secret-change-me'
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

export function verifySignedPayload(payload: string, signature: string): boolean {
  return safeEqual(signPayload(payload), signature)
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url')
}
