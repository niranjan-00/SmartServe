-- Additive SQLite/Turso migration for organization-specific WAHA sessions.
-- Back up the database before applying this migration.
ALTER TABLE "WhatsAppConnection" ADD COLUMN "wahaSessionName" TEXT;
UPDATE "WhatsAppConnection"
SET "wahaSessionName" = 'smartserve_org_' || "organizationId"
WHERE "statusMessage" LIKE 'waha-adapter%'
  AND "wahaSessionName" IS NULL;
CREATE UNIQUE INDEX "WhatsAppConnection_wahaSessionName_key"
  ON "WhatsAppConnection"("wahaSessionName");

-- Legacy connection rows receive a new dedicated session name, but the old
-- shared WAHA login is not copied; each organization must scan its own QR once.
