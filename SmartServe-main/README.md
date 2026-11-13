# SmartServe

**From complaint to resolution.** A production-ready, multi-tenant SaaS platform for AI-powered WhatsApp complaint & ticket resolution — built on the existing SmartServe frontend with a complete real backend.

Organizations receive customer complaints over WhatsApp; SmartServe captures, classifies, assigns, tracks, escalates, resolves and analyzes them. Colleges, hospitals, apartment communities, hotels, service teams.

---

## Architecture

```
Customer → WhatsApp → Meta Cloud API → /api/webhooks/whatsapp
    → verify signature → phone_number_id → WhatsAppConnection → organizationId
    → customer + conversation + message (transaction) → bot flow → complaint (SS-10001…)
    → async AI classification → auto-assignment → PostgreSQL
    → realtime event → staff dashboard → resolution → WhatsApp update → feedback → analytics
```

- **Existing UI preserved** — the original SmartServe dashboard, complaint views, AI cards, SLA indicators, dark mode and responsive layout are untouched visually; every surface is now backed by real APIs.
- **Backend** — Next.js App Router route handlers, service modules (`src/server/services/*`), Zod validation on every endpoint, centralized error handling, rate limiting, structured logs, immutable audit log.
- **Multi-tenancy** — every query is scoped by `organizationId` server-side; organization identification over WhatsApp is authoritative: `phone_number_id → WhatsAppConnection → organizationId`.
- **RBAC** — `SUPER_ADMIN / ORGANIZATION_ADMIN / SUPERVISOR / STAFF / VIEWER` enforced in the API layer (`src/server/authz.ts`), never in the UI.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, existing shadcn-style components |
| Backend | Next.js Route Handlers, service architecture, Zod, rate limiting |
| Database | **PostgreSQL** (production) via Prisma — SQLite for zero-config local development |
| Auth | Auth.js (NextAuth v4): credentials (bcrypt) + Google OAuth + GitHub OAuth (auto-enabled when configured) |
| WhatsApp | Meta WhatsApp Business Cloud API (`meta-provider.ts`) + explicit development adapter (`dev-provider.ts`) |
| AI | Provider abstraction: LLM (z-ai SDK) → deterministic rules fallback; async job queue; AI never blocks ticket creation |
| Realtime | Socket.IO mini-service (`mini-services/realtime-service/`), org-scoped rooms, signed room tokens; reconnect + refetch reconciliation |
| Storage | Local disk adapter + S3 adapter interface (metadata in DB, bytes in object storage) |
| Tests | Vitest (30 unit tests: status machine, webhook security, SLA, AI fallback, assignment scoring) |

## Quick start (development)

```bash
bun install                 # or npm install / pnpm install
bun run db:push             # create schema on SQLite (db/custom.db)
bun run realtime:dev        # terminal 2 — realtime service on :3030
bun run dev                 # terminal 1 — app on :3000
bun run test                # unit tests
```

Open http://localhost:3000 → register → create an organization → follow the 7-step onboarding (details → departments → invite staff → connect WhatsApp → SLA → done).

### Testing the WhatsApp pipeline without Meta credentials

`WHATSAPP_MODE` defaults to `development`, which activates the **development adapter** (clearly labelled in the UI — it never claims to be production-connected):

1. Settings → WhatsApp → connect with placeholder credentials (any values).
2. Use **“Simulate inbound message”** on the same page with a customer phone + text.
3. The message runs the **exact production webhook pipeline**: customer/conversation/message creation → bot conversation flow → complaint + ticket number → AI classification → auto-assignment → realtime dashboard updates.
4. Try `STATUS SS-10001` or `RATE SS-10001 5` as a simulated message to test status lookup and feedback.

## Production deployment (PostgreSQL)

1. **Switch the Prisma datasource** — copy the Postgres variant over the main schema:

   ```bash
   cp prisma/schema.postgres.prisma prisma/schema.prisma
   ```

   (Identical models; only `provider = "postgresql"` differs. No Prisma enums/Json are used, so the schema is portable.)

2. **Configure environment** — copy `.env.example` to `.env` and fill in: `DATABASE_URL` (Postgres), `AUTH_SECRET` (`openssl rand -base64 32`), `NEXTAUTH_URL`, WhatsApp credentials, OAuth keys, storage, email.

3. **Migrations** (never `db push` in production):

   ```bash
   npx prisma migrate dev      # development — creates migration files
   npx prisma migrate deploy   # production — applies them
   ```

4. **Meta app configuration**

   - Webhook URL: `https://YOUR_DOMAIN/api/webhooks/whatsapp`
   - Verify token: value of `WHATSAPP_VERIFY_TOKEN`
   - App secret: set as `WHATSAPP_APP_SECRET` (enables `x-hub-signature-256` verification)
   - Set `WHATSAPP_MODE=production` — connection credentials are then verified against the Graph API before a connection is marked CONNECTED.

5. **OAuth callback URLs**

   - Google: `https://YOUR_DOMAIN/api/auth/callback/google`
   - GitHub: `https://YOUR_DOMAIN/api/auth/callback/github`

6. **Realtime service** — run alongside the web app and proxy it (e.g. nginx path or subdomain → port 3030). Set `NEXT_PUBLIC_REALTIME_URL` accordingly (`/?XTransformPort=3030` behind the included gateway; `/realtime` behind a path proxy). If the service is unreachable the app still works — dashboards fall back to periodic reconciliation, and the database remains the source of truth.

7. **Deploy targets** — Vercel (web app) or Render/Docker (web app + realtime service + Postgres). `bun run build` produces the standalone build; `bun run start` runs it.

## Environment variables

See **`.env.example`** for the full annotated list (DATABASE_URL, AUTH_SECRET, OAuth, `WHATSAPP_*`, `AI_API_KEY`, `STORAGE_*`, `EMAIL_*`, realtime). Never commit real secrets.

## API surface

```
/api/auth/*                    register, password reset, NextAuth
/api/organizations             create / list / current / join / onboarding state
/api/members                   list / invite / role & status management
/api/departments  /api/locations  /api/categories
/api/customers                 list + detail (tickets, conversations, satisfaction)
/api/conversations             list; /:id/messages (GET history, POST staff reply)
/api/complaints                server-side search/filter/sort/pagination, create
/api/complaints/[id]           full detail bundle; PATCH priority
  .../assign  .../status  .../comments  .../attachments  .../suggestion  .../similar  .../ai-retry
/api/analytics/overview        dashboard metrics (all computed from the DB)
/api/staff                     operational staff metrics
/api/notifications             list / unread / mark read / mark all
/api/whatsapp/connection       connect / status / disconnect
/api/webhooks/whatsapp         GET hub verification, POST inbound pipeline
/api/sla  /api/escalations  /api/feedback  /api/feedback/submit
/api/audit-logs  /api/search  /api/health  /api/attachments/[id]
```

Every endpoint enforces: authentication → organization authorization → RBAC → Zod input validation → safe error handling.

## Key guarantees

- Ticket numbers (`SS-10001…`) are generated from a counter incremented inside the creation transaction — concurrency-safe.
- Duplicate webhook deliveries are ignored (unique `WebhookEvent.eventId` + payload hash) — no duplicate messages/complaints.
- Complaint creation never depends on AI or outbound WhatsApp: both failures degrade gracefully (`aiStatus=FAILED`, message `FAILED`) and support retry.
- Status transitions are validated server-side; every change writes `ComplaintStatusHistory` + audit log.
- SLA is monitored continuously by a background scheduler (not on page load): `WITHIN_SLA / APPROACHING / BREACHED`, with level 1→3 escalations.
- WhatsApp access tokens are AES-256-GCM encrypted at rest and never sent to the browser.
- Audit logs are append-only; normal users cannot modify them.
- No demo/seed data is shipped — every dashboard metric is computed from your organization's real records.

## Project layout

```
src/app/                    Next.js app (dashboard shell, auth, onboarding, API routes)
src/components/smartserve/  Original UI components wired to real data
src/server/                 auth, authz (RBAC), api helpers, jobs, crypto, audit, realtime
src/server/services/        organization, complaint, whatsapp (meta+dev+bot), ai, sla,
                            assignment, notification, analytics, feedback, search, storage
prisma/                     schema.prisma (SQLite dev) + schema.postgres.prisma (prod)
mini-services/realtime-service/  socket.io fan-out (clients :3030, emit :3031 loopback)
tests/unit/                 vitest suites
```
