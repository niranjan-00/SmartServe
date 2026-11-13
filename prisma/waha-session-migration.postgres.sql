-- Additive PostgreSQL migration for organization-specific WAHA sessions.
ALTER TABLE "WhatsAppConnection" ADD COLUMN "wahaSessionName" TEXT;
UPDATE "WhatsAppConnection"
SET "wahaSessionName" = 'smartserve_org_' || "organizationId"
WHERE "statusMessage" LIKE 'waha-adapter%'
  AND "wahaSessionName" IS NULL;
CREATE UNIQUE INDEX "WhatsAppConnection_wahaSessionName_key"
  ON "WhatsAppConnection"("wahaSessionName");
