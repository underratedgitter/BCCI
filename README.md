# BCCI Bharuch — Membership Portal

Membership system for the **Bharuch Chamber of Commerce & Industry**: public site, email-verified applications, secretariat review portal, digital membership cards with QR, events and board-meeting attendance.

Vanilla JS frontend (no build step) · Vercel serverless functions in `api/` · Upstash Redis · SMTP via Nodemailer. `server.js` serves the same handlers locally.

## Quick start

```bash
npm install
cp .env.example .env.local   # fill it in
npm run dev                  # http://localhost:3000
```

No credentials? `npm run dev:sandbox` runs the full app on in-memory Redis and a local SMTP catcher. Emails, including OTP codes, print to the console.

`/api/health` reports whether Redis, SMTP and admin auth are configured. The server refuses to start if a required variable is missing.

## Configuration

`.env.example` lists every variable; [`DEPLOYMENT.md`](DEPLOYMENT.md) explains them.

- **Required:** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `ADMIN_EMAILS`, `ADMIN_PASSWORD`, `SMTP_USER`, `SMTP_PASS`
- **Recommended:** `ALLOWED_ORIGIN`, `EMAIL_FROM`, `INTERNAL_API_SECRET`

SMTP mode follows `SMTP_PORT` (465 = implicit TLS, 587 = STARTTLS, required for remote hosts). Check it with `npm run mail:test` (sends nothing) or `npm run mail:test -- you@example.com`.

## API

| Route | Access |
|---|---|
| `/api/health` | public |
| `/api/send-otp`, `/api/verify-otp` | public, rate-limited |
| `/api/applicant-auth` | public (login, register, password reset) |
| `/api/applications` | admin, or the owning applicant |
| `/api/enquiries` | public POST, admin GET |
| `/api/admin-auth` | public login, own-session logout |
| `/api/membership-plans` | public GET, admin write |
| `/api/events` | public read/register, admin write |
| `/api/board` | board members via OTP, plus admin actions |
| `/api/send-email`, `/api/email-retries` | internal secret or admin |

Sessions are opaque server-side tokens. Rate limits apply per email and per network.

## Tests and checks

```bash
npm run check   # syntax check
npm test        # 12 suites, no network or credentials needed
```

Run one suite with `npm run test:api`, `test:data`, `test:client`, `test:auth`, `test:events`, `test:board`, `test:purge`, `test:e2e`, `test:email` or `test:smtp`.

**Changing a JS or CSS file:** bump its `?v=` wherever it is loaded (`index.html` or the importing module), then run `npm run versions:update`. `npm test` fails if a file changed without a version bump.

Browser smoke tests (need Chrome): `npm run test:browser`, `npm run test:leadership-browser` (run `npm run dev:sandbox` first; set `SITE_URL` / `CHROME_PATH` if needed).

## Deploying

Vercel production deploys with `npm run deploy` (a push alone does not deploy). Security headers and CSP live in `vercel.json` and `api/_lib/security.js`. Details and the Redis key layout are in [`DEPLOYMENT.md`](DEPLOYMENT.md).

```bash
curl https://<domain>/api/health            # expect {"status":"ok"}
curl -i https://<domain>/api/applications   # expect 401
```

`npm run purge:data` permanently deletes membership data (dry run by default; `-- --confirm` to delete).

## Layout

```
api/        one handler per route; _lib/ holds shared code
js/         browser code (app.js, store.js, board-*.js, checkin.js)
css/        styles
scripts/    dev sandbox, mail test, test runner, data purge
tests/      suites plus mock Redis and SMTP
server.js   local server
```
