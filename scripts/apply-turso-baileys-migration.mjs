import { createClient } from '@libsql/client'
import { readFile } from 'node:fs/promises'

const url = process.env.TURSO_DATABASE_URL
const authToken = process.env.TURSO_AUTH_TOKEN
if (!url || !authToken) throw new Error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN before running this migration')

const client = createClient({ url, authToken })
const migration = await readFile(new URL('../prisma/migrations/20261112000000_baileys_multi_account/migration.sql', import.meta.url), 'utf8')
const statements = migration
  .split(';')
  .map((statement) => statement.trim())
  .filter(Boolean)

try {
  for (const statement of statements) {
    if (/^ALTER\s+TABLE\s+"Conversation"\s+ADD\s+COLUMN/i.test(statement)) {
      const columns = await client.execute('PRAGMA table_info("Conversation")')
      if (columns.rows.some((row) => row.name === 'whatsappAccountId')) {
        console.log('Conversation.whatsappAccountId already exists; skipping')
        continue
      }
    }
    await client.execute(statement)
    console.log(`Applied: ${statement.split('\n').at(-1)?.slice(0, 100) || statement.slice(0, 100)}`)
  }
  console.log('Baileys multi-account Turso migration completed.')
} finally {
  await client.close()
}
