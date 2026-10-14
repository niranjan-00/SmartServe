
import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  const url = process.env.TURSO_DATABASE_URL?.trim()
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim()

  if (!url) {
    throw new Error('TURSO_DATABASE_URL is missing')
  }

  if (!url.startsWith('libsql://') && !url.startsWith('https://')) {
    throw new Error('TURSO_DATABASE_URL has an invalid format')
  }

  const adapter = new PrismaLibSQL({
    url,
    authToken,
  })

  return new PrismaClient({ adapter })
}

export const prisma =
  globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

export const db = prisma
