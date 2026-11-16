
import crypto from 'crypto'

/**
 * Secret management helpers.
 * Encryption derives from AUTH_SECRET.
 * Used for WhatsApp access tokens at rest.
 */

function keyBytes(): Buffer {
  const secret =
    process.env.AUTH_SECRET ||
    'smartserve-development-secret-change-me'

  return crypto
    .createHash('sha256')
    .update(secret)
    .digest()
}

/**
 * AES-256-GCM encryption.
 * Format: base64(iv + authentication tag + ciphertext)
 */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12)

  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    keyBytes(),
    iv,
  )

  const encrypted = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ])

  const tag = cipher.getAuthTag()

  return Buffer.concat([
    iv,
    tag,
    encrypted,
  ]).toString('base64')
}

/**
 * Decrypts an AES-256-GCM encrypted secret.
 */
export function decryptSecret(payload: string): string {
  const buffer = Buffer.from(payload, 'base64')

  if (buffer.length < 29) {
    throw new Error('Invalid encrypted secret')
  }

  const iv = buffer.subarray(0, 12)
  const tag = buffer.subarray(12, 28)
  const ciphertext = buffer.subarray(28)

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyBytes(),
    iv,
  )

  decipher.setAuthTag(tag)

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * Generates a SHA-256 hexadecimal hash.
 */
export function sha256Hex(input: string): string {
  return crypto
    .createHash('sha256')
    .update(input)
    .digest('hex')
}

/**
 * Timing-safe comparison of two strings.
 */
export function safeEqual(
  a: string,
  b: string,
): boolean {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)

  if (bufferA.length !== bufferB.length) {
    return false
  }

  return crypto.timingSafeEqual(bufferA, bufferB)
}

/**
 * HMAC token generator used for realtime room auth
 * and invite tokens.
 */
export function signPayload(payload: string): string {
  const secret =
    process.env.AUTH_SECRET ||
    'smartserve-development-secret-change-me'

  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
}

/**
 * Verifies SmartServe internal HMAC-signed payloads.
 */
export function verifySignedPayload(
  payload: string,
  signature: string,
): boolean {
  return safeEqual(
    signPayload(payload),
    signature,
  )
}

/**
 * Verifies Meta WhatsApp webhook signatures.
 *
 * Meta signature format:
 * sha256=<64-character hexadecimal HMAC>
 *
 * HMAC algorithm: SHA-256
 * HMAC key: Meta App Secret
 * HMAC input: Exact raw HTTP request body
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret?: string | null,
): boolean {
  if (
    !rawBody ||
    !signatureHeader ||
    !appSecret
  ) {
    return false
  }

  const separatorIndex = signatureHeader.indexOf('=')

  if (separatorIndex === -1) {
    return false
  }

  const algorithm = signatureHeader
    .slice(0, separatorIndex)
    .trim()

  const suppliedSignature = signatureHeader
    .slice(separatorIndex + 1)
    .trim()

  if (
    algorithm !== 'sha256' ||
    !/^[a-f0-9]{64}$/i.test(suppliedSignature)
  ) {
    return false
  }

  const expectedSignature = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody, 'utf8')
    .digest('hex')

  return safeEqual(
    expectedSignature.toLowerCase(),
    suppliedSignature.toLowerCase(),
  )
}

/**
 * Generates a cryptographically secure random token.
 */
export function randomToken(
  bytes = 24,
): string {
  return crypto
    .randomBytes(bytes)
    .toString('base64url')
}
