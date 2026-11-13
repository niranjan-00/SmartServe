# SmartServe

**From complaint to resolution.** A production-ready, multi-tenant SaaS platform for AI-powered WhatsApp complaint & ticket resolution — built on the existing SmartServe frontend with a complete real backend.

Organizations receive customer complaints over WhatsApp; SmartServe captures, classifies, assigns, tracks, escalates, resolves and analyzes them. Colleges, hospitals, apartment communities, hotels, service teams.

---

## Architecture

```
Customer → WhatsApp → Baileys worker → authenticated internal inbound endpoint
    → WhatsAppAccount → organizationId
    → customer + conversation + message (transaction) → bot flow → complaint (SS-10001…)
    → async AI classification → auto-assignment → Turso / libSQL
    → realtime event → staff dashboard → resolution → Baileys reply → feedback → analytics
```

- **Existing UI preserved and extended** — the SmartServe dashboard, complaint views, AI cards, SLA indicators, dark mode and responsive layout remain; WhatsApp settings and onboarding now support Baileys QR sessions and multiple numbers.
- **Backend** — Next.js App Router route handlers, service modules (`src/server/services/*`), Zod validation on every endpoint, centralized error handling, rate limiting, structured logs, immutable audit log.
- **Multi-tenancy** — every query is scoped by `organizationId` server-side; each Baileys linked device belongs to one `WhatsAppAccount` and organization.
- **RBAC** — `SUPER_ADMIN / ORGANIZATION_ADMIN / SUPERVISOR / STAFF / VIEWER` enforced in the API layer (`src/server/authz.ts`), never in the UI.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, existing shadcn-style components |
| Backend | Next.js Route Handlers, service architecture, Zod, rate limiting |
| Database | **Turso / libSQL** via Prisma LibSQL adapter |
| Auth | Auth.js (NextAuth v4): credentials (bcrypt) + Google OAuth + GitHub OAuth (auto-enabled when configured) |
| WhatsApp | Baileys multi-session worker with encrypted Turso-backed credentials and Signal keys |
| AI | Provider abstraction: LLM (z-ai SDK) → deterministic rules fallback; async job queue; AI never blocks ticket creation |
| Realtime | Socket.IO mini-service (`mini-services/realtime-service/`), org-scoped rooms, signed room tokens; reconnect + refetch reconciliation |
| Storage | Local disk adapter + S3 adapter interface (metadata in DB, bytes in object storage) |
| Tests | Vitest unit tests: status machine, encrypted credentials, SLA, AI fallback, assignment scoring |

## Quick start (development)

```bash
npm install                  # syncs package-lock with the Baileys worker dependencies
npm run db:migrate:baileys   # additive Turso schema update (after setting Turso env vars)
bun run realtime:dev        # terminal 2 — realtime service on :3030
npm run whatsapp:worker    # terminal 3 — Baileys worker on :3020
bun run dev                 # terminal 1 — app on :3000
bun run test                # unit tests
```

Open http://localhost:3000 → register → create an organization → follow the 7-step onboarding (details → departments → invite staff → connect WhatsApp → SLA → done).

### WhatsApp QR onboarding

1. Run the additive Turso migration once with `npm run db:migrate:baileys`, after backing up the database.
2. Start the Baileys worker with `npm run whatsapp:worker`.
3. Configure `WHATSAPP_WORKER_URL`, `WHATSAPP_WORKER_PORT`, `WHATSAPP_WORKER_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `AUTH_SECRET`.
4. Open Settings → WhatsApp → Add WhatsApp number.
5. Scan the QR using WhatsApp → Linked Devices → Link a Device.
6. Credentials and Signal keys are encrypted with `AUTH_SECRET` and stored in Turso. The worker restores saved sessions at startup.

Each organization can connect multiple independent numbers. Conversations retain the account ID that received the message so replies use the same WhatsApp number.

## Production deployment (Render + Turso)

Deploy two separate Render services from this repository:

1. **Web service** — build with `npm install && npm run build`; start using the existing web start command. Configure Turso credentials, `AUTH_SECRET`, `NEXTAUTH_URL`, `NEXT_APP_URL`, and the worker URL/secret.
2. **Private service** (not a Render Background Worker, because the web app must call its internal HTTP API) — runtime Node.js 20+, build/install with `npm install`; start command `npm run whatsapp:worker`. Configure the same `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `AUTH_SECRET`, `WHATSAPP_WORKER_SECRET`, plus `WHATSAPP_WORKER_PORT=3020` and the public `NEXT_APP_URL` of the web service.
3. Generate one strong random `WHATSAPP_WORKER_SECRET` and set exactly the same value on both services. Keep `AUTH_SECRET` identical on both services because the worker encrypts credentials and Signal keys with it.
4. Back up Turso, then apply the additive migration with `npm run db:migrate:baileys`. It creates the account/auth-key tables and adds the nullable conversation account link; it does not delete existing conversations, messages or complaints. Do not run `db:push --accept-data-loss` against production.
5. Keep the worker as a single active instance for now. Running multiple workers without distributed session ownership can start the same WhatsApp account more than once.

The Baileys worker stores authentication credentials and Signal keys in Turso, not in an ephemeral Render filesystem. Configure `WHATSAPP_WORKER_URL` on the web service with the private internal address Render provides for the worker service. Never commit those credentials or the worker secret.

## Environment variables

See **`.env.example`** for the required Turso, authentication, Baileys worker and realtime variables. Keep `AUTH_SECRET` and `WHATSAPP_WORKER_SECRET` consistent between web and worker services. Never commit real secrets.

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
/api/whatsapp/accounts        list / create multiple Baileys QR sessions; /:id status / disconnect
/api/internal/whatsapp/inbound worker-authenticated inbound message pipeline
/api/sla  /api/escalations  /api/feedback  /api/feedback/submit
/api/audit-logs  /api/search  /api/health  /api/attachments/[id]
```

Every endpoint enforces: authentication → organization authorization → RBAC → Zod input validation → safe error handling.

## Key guarantees

- Ticket numbers (`SS-10001…`) are generated from a counter incremented inside the creation transaction — concurrency-safe.
- Duplicate inbound Baileys message events are ignored using the unique `WebhookEvent.eventId`; failed, unprocessed events can be retried.
- Complaint creation never depends on AI or outbound WhatsApp: both failures degrade gracefully (`aiStatus=FAILED`, message `FAILED`) and support retry.
- Status transitions are validated server-side; every change writes `ComplaintStatusHistory` + audit log.
- SLA is monitored continuously by a background scheduler (not on page load): `WITHIN_SLA / APPROACHING / BREACHED`, with level 1→3 escalations.
- Baileys credentials and Signal Protocol keys are AES-256-GCM encrypted at rest in Turso and never sent to the browser.
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
