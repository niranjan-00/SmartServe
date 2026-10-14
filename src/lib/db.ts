import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'
import { createClient } from '@libsql/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  const url = process.env.TURSO_DATABASE_URL?.trim()
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim()

  if (!url) {
    throw new Error(
      'TURSO_DATABASE_URL is missing. Check your project .env file.'
    )
  }

  if (!url.startsWith('libsql://') && !url.startsWith('https://')) {
    throw new Error(
      'TURSO_DATABASE_URL must contain your valid Turso database URL.'
    )
  }

  const client = createClient({ url, authToken })
  const adapter = new PrismaLibSQL(client)

  return new PrismaClient({ adapter })
}

export const prisma =
  globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

export const db = prisma