import { describe, it, expect } from 'vitest'
import { encryptSecret, decryptSecret, safeEqual } from '../../src/server/crypto'

describe('Baileys credential security primitives', () => {
  it('encrypts and decrypts session material using AES-256-GCM', () => {
    const secret = JSON.stringify({ registered: true, secretKey: 'example-private-key' })
    const encrypted = encryptSecret(secret)
    expect(encrypted).not.toContain(secret)
    expect(decryptSecret(encrypted)).toBe(secret)
  })

  it('uses timing-safe equality for worker authentication', () => {
    expect(safeEqual('same-secret', 'same-secret')).toBe(true)
    expect(safeEqual('same-secret', 'different-secret')).toBe(false)
  })
})
