import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { ApiError } from '@/server/errors'

/**
 * Attachment storage (spec §36). Large binaries never live in PostgreSQL —
 * metadata goes to the DB, bytes go to object storage.
 *
 * Default adapter: local disk (./storage). The S3StorageAdapter implements
 * the same interface for S3-compatible production storage (set
 * STORAGE_ENDPOINT / STORAGE_BUCKET / STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY
 * and swap the adapter in production deployments).
 */

const ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
  'video/mp4', 'video/quicktime', 'video/webm',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/opus',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
]
export const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB

export function validateFileMeta(fileName: string, mimeType: string, size: number): void {
  if (!fileName || fileName.length > 255) throw ApiError.badRequest('Invalid file name')
  if (!ALLOWED_MIME.includes(mimeType)) throw ApiError.badRequest(`File type ${mimeType} is not allowed`)
  if (size <= 0 || size > MAX_FILE_SIZE) throw ApiError.badRequest('File exceeds the 20MB size limit')
}

export interface StorageAdapter {
  put(key: string, data: Buffer): Promise<void>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
}

export class LocalDiskStorageAdapter implements StorageAdapter {
  private baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir || process.env.STORAGE_LOCAL_DIR || path.join(process.cwd(), 'storage')
    fs.mkdirSync(this.baseDir, { recursive: true })
  }

  private resolve(key: string): string {
    // Path traversal guard
    const safe = path.normalize(key).replace(/^(\.\.[/\\])+/, '')
    const full = path.join(this.baseDir, safe)
    if (!full.startsWith(this.baseDir)) throw ApiError.badRequest('Invalid storage key')
    return full
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, data)
  }

  async get(key: string): Promise<Buffer> {
    const full = this.resolve(key)
    if (!fs.existsSync(full)) throw ApiError.notFound('File not found')
    return fs.readFileSync(full)
  }

  async delete(key: string): Promise<void> {
    const full = this.resolve(key)
    if (fs.existsSync(full)) fs.unlinkSync(full)
  }
}

/** S3 adapter interface — wire up in production via signed URLs (spec §36). */
export class S3StorageAdapter implements StorageAdapter {
  constructor(
    private readonly endpoint: string,
    private readonly bucket: string,
    private readonly _accessKey: string,
    private readonly _secretKey: string,
  ) {
    void this.endpoint
    void this.bucket
    void this._accessKey
    void this._secretKey
    throw new Error('S3StorageAdapter requires wiring to your S3 provider SDK before production use — see README §Attachments')
  }
  async put(): Promise<void> { throw new Error('not implemented') }
  async get(): Promise<Buffer> { throw new Error('not implemented') }
  async delete(): Promise<void> { throw new Error('not implemented') }
}

let storage: StorageAdapter | null = null

export function getStorage(): StorageAdapter {
  if (!storage) storage = new LocalDiskStorageAdapter()
  return storage
}

/** Org-scoped storage key: org/complaintId/uuid.ext */
export function buildStorageKey(organizationId: string, complaintId: string, fileName: string): string {
  const ext = path.extname(fileName).slice(0, 12)
  return `${organizationId}/${complaintId}/${crypto.randomUUID()}${ext}`
}
