# BCCI Bharuch — Membership Portal

The membership system for the **Bharuch Chamber of Commerce & Industry**: a public site, an application flow gated by email verification, a secretariat review portal, and digital membership cards with a scannable QR.

Runs as serverless functions on Vercel, or as a single Node process on any VPS. Same code either way.

---

## What it does

**For a prospective member**
Verify an email address with a one-time code, fill in an 18-field application with company details, GSTIN, PAN and a payment receipt, then track its status. The form saves itself as you type, so a closed tab or a dropped connection does not cost you the work.

**For the secretariat**
Review pending applications, inspect submitted documents and payment receipts, approve or decline with a reason. Every decision emails the applicant automatically. Export the register as CSV.

**For an approved member**
A digital membership card with a QR code that encodes the member ID for verification, valid-until date, and one-click annual renewal against a UPI payment reference.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vanilla JS, no framework, no build step |
| API | Serverless functions in `api/` (Vercel), or `server.js` on any Node host |
| Storage | Upstash Redis, one key per record with a sorted-set index |
| Email | SMTP via Nodemailer — OTP, confirmations, approvals, declines |

Two runtime dependencies: `@upstash/redis` and `nodemailer`.

---

## Running it

```bash
git clone https://github.com/underratedgitter/BCCI.git
cd BCCI
npm install
cp .env.example .env.local     # then fill it in

npm run dev                    # node --env-file=.env.local server.js
```

Then open <http://localhost:3000>. `/api/health` reports whether Redis, SMTP and admin auth are configured and reachable.

### No credentials to hand?

```bash
node scripts/dev-sandbox.mjs
```

Boots the whole thing against an in-memory Redis and a local SMTP catcher — no Upstash account, no Gmail app password. Emails are printed to the console instead of sent, **including OTP codes**, so you can walk the entire flow offline. Seeded with sample applications.

---

## Configuration

Everything is set through environment variables; see `.env.example` for the annotated list and [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full reference.

**Required:** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `ADMIN_EMAILS`, `ADMIN_PASSWORD`, `SMTP_USER`, `SMTP_PASS`

**Worth setting:** `ALLOWED_ORIGIN`, `EMAIL_FROM`, `INTERNAL_API_SECRET`

The server refuses to start when a required value is missing, rather than failing later at a form submission:

```
[config] ERROR: UPSTASH_REDIS_REST_URL is not set — applications and sessions cannot be saved.
Refusing to start with missing required settings.
```

### SMTP

Port 465 is implicit TLS; 587 negotiates STARTTLS. The right mode is derived from `SMTP_PORT`, so setting the port is enough. On any non-465 remote port the app **requires** the STARTTLS upgrade and refuses to send if the server will not do it — a password is never transmitted in the clear. A local MTA on `localhost` is exempt and needs no credentials.

```bash
npm run mail:test                     # resolve config, connect, send nothing
npm run mail:test -- you@example.com  # send one of each template
```

---

## API

| Route | Method | Access |
|---|---|---|
| `/api/health` | GET | public |
| `/api/send-otp` | POST | public, rate-limited |
| `/api/verify-otp` | POST / DELETE | public / own session |
| `/api/applications` | GET | admin (list) or the owning applicant (`?email=`) |
| `/api/applications` | POST | verified applicant |
| `/api/applications` | PATCH | admin (review) or owner (`action: "renew"`) |
| `/api/enquiries` | GET / POST | admin / public |
| `/api/admin-auth` | POST / DELETE | public / own session |
| `/api/admin-stats` | GET | admin |
| `/api/send-email` | POST | internal secret or admin |

Sessions are opaque tokens held in Redis, not signed blobs the browser can forge. Rate limits apply per email address and per network across OTP requests, sign-in attempts, applications and enquiries.

---

## Data

| Key | Holds |
|---|---|
| `bcci:app:<id>` | one application |
| `bcci:app_index` | sorted set of application ids by submission time |
| `bcci:app_email:<email>` | email → application id |
| `bcci:enq:<id>`, `bcci:enq_index` | enquiries, newest 1000 kept |
| `admin:<token>`, `applicant:<token>` | sessions, TTL-expired |
| `bcci:otp:<email>` | pending code, 10-minute TTL |

Records are stored one per key rather than as a single JSON document, so two applicants submitting at the same moment cannot overwrite each other. An older single-blob layout migrates automatically on first read; the original is left untouched as a backup.

```bash
npm run purge:data              # dry run — shows what would go
npm run purge:data -- --confirm # actually delete
```

---

## Tests

```bash
npm test
```

209 assertions across six suites, with no network access and no live database:

| Suite | Covers |
|---|---|
| `e2e` | the real server against a mock Upstash and a **real SMTP server** — OTP, application, approval, renewal, 30 concurrent submissions |
| `api` | authentication, ownership, rate limits, the approval flow |
| `data` | legacy migration, concurrent writes |
| `client` | XSS escaping, form drafts, accessibility |
| `smtp-config` | TLS mode per port, From-address resolution |
| `purge` | that a dry run deletes nothing |

---

## Deploying

Both hosts are covered in [`DEPLOYMENT.md`](DEPLOYMENT.md) — environment variables, a systemd unit, an nginx config, Docker, backups and the Redis key layout.

Security headers, the CSP and configuration validation live in `api/_lib/security.js` rather than in `vercel.json`, so they travel with the app to whatever host it lands on.

```bash
curl https://<domain>/api/health          # expect {"status":"ok"}
curl -i https://<domain>/api/applications # expect 401, never data
```

---

## Layout

```
api/            serverless handlers, one file per route
  _lib/         shared: redis, http, email, security  (underscore = not a route)
js/             app.js (UI and routing), store.js (API client)
css/            styles.css, membership-card.css
scripts/        dev-sandbox, mail:test, purge:data
tests/          six suites plus mock Redis and mock SMTP
server.js       standalone Node server for non-Vercel hosts
```
