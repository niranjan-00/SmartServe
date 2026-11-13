-- SmartServe Baileys multi-account migration for SQLite / Turso libSQL.
-- Non-destructive: keeps legacy WhatsAppConnection rows and all existing messages.

CREATE TABLE IF NOT EXISTS "WhatsAppAccount" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "label" TEXT NOT NULL DEFAULT 'WhatsApp',
  "phoneNumber" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
  "credsEncrypted" TEXT,
  "lastConnectedAt" DATETIME,
  "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "WhatsAppAccount_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "WhatsAppAccount_organizationId_idx"
  ON "WhatsAppAccount"("organizationId");
CREATE INDEX IF NOT EXISTS "WhatsAppAccount_status_idx"
  ON "WhatsAppAccount"("status");

CREATE TABLE IF NOT EXISTS "WhatsAppAuthKey" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "WhatsAppAuthKey_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "WhatsAppAuthKey_accountId_keyId_key"
  ON "WhatsAppAuthKey"("accountId", "keyId");
CREATE INDEX IF NOT EXISTS "WhatsAppAuthKey_accountId_idx"
  ON "WhatsAppAuthKey"("accountId");

ALTER TABLE "Conversation" ADD COLUMN "whatsappAccountId" TEXT REFERENCES "WhatsAppAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "Conversation_whatsappAccountId_idx"
  ON "Conversation"("whatsappAccountId");
