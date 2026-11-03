# Deploying the BCCI portal

Production runs on **Vercel**: `api/*.js` are serverless functions, `vercel.json` supplies the security headers and the SPA rewrite, and Upstash Redis holds the data. Pushing to `main` deploys.

`server.js` serves the same handlers and the static site for local development (`npm run dev`) and the end-to-end tests.

---

## Environment variables

Copy `.env.example` to `.env.local` and fill it in. Never commit it — `.gitignore` already covers it.

### Required

| Variable | What it does |
|---|---|
| `UPSTASH_REDIS_REST_URL` | Upstash database endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash token |
| `ADMIN_EMAILS` | Comma-separated addresses allowed to sign in as admin. Also where new-application alerts go. |
| `ADMIN_PASSWORD` | Admin password. Use ≥ 20 random characters: `openssl rand -base64 24` |
| `SMTP_USER` / `SMTP_PASS` | Mailbox credentials. For Gmail this must be an [App Password](https://myaccount.google.com/apppasswords), not the account password. |

### Strongly recommended

| Variable | What it does |
|---|---|
| `ALLOWED_ORIGIN` | Comma-separated origins allowed to call the API from a browser. Set this to your real domain(s). |
| `INTERNAL_API_SECRET` | Authorises server-to-server calls to `/api/send-email`. `openssl rand -hex 32` |
| `EMAIL_FROM` | The From address recipients see, e.g. `BCCI Bharuch <noreply@bccibharuch.in>` |

### SMTP transport

| Variable | Default | Notes |
|---|---|---|
| `SMTP_HOST` | `smtp.gmail.com` | |
| `SMTP_PORT` | `465` | 465 = SSL, 587 = TLS/STARTTLS |
| `SMTP_SECURE` | `true` when port is 465 | Derived from the port; override only if your relay is unusual |
| `SMTP_ALLOW_SELF_SIGNED` | unset | Only for a local MTA on the same box |

**465 vs 587.** Port 465 is implicit TLS — encrypted from the first byte. Port 587 connects in plaintext and upgrades via STARTTLS. Both are fine; the app derives the right mode from the port, so setting `SMTP_PORT` is enough.

On any non-465 remote port the app sets `requireTLS`, so it **refuses to send** if the server will not upgrade, rather than falling back to plaintext and leaking the password. TLS 1.2 is the floor. A local MTA on `localhost` is exempt (traffic never leaves the machine) and needs no credentials.

**The From address.** Gmail and Google Workspace only honour a From header that is the authenticated account or a verified *Send mail as* alias on it. Anything else is silently rewritten back to the account — mail still arrives, but not from the address you configured. Same domain is not sufficient; the alias has to be verified in Gmail settings. Keep `EMAIL_FROM` matching `SMTP_USER` unless you have set that up.

Check the whole thing without sending anything:

```bash
npm run mail:test                       # resolve config, connect, authenticate
npm run mail:test -- you@example.com    # also send one of each template
```

### Local server only

| Variable | Notes |
|---|---|
| `PORT` | Default `3000` |
| `HOST` | Default `0.0.0.0` |

---

## Vercel

Set the variables in **Settings → Environment Variables**, then push to `main`.

Two settings to check:

1. **Deployment Protection** (Settings → Deployment Protection). If Vercel Authentication is on, every visitor is redirected to a Vercel SSO login and the site is unusable by the public. Turn it off for Production when you go live.
2. **GitHub Pages.** This repo also carries `.github/workflows/static.yml`, now set to manual-only. Leave it that way — Pages cannot run `/api/*`, so a Pages copy of this site has no working forms.

Verify a deploy with `curl https://<your-domain>/api/health`.

---

## After any deploy

```bash
curl https://<your-domain>/api/health          # expect {"status":"ok"}
curl -i https://<your-domain>/api/applications # expect 401, NOT data
```

The second one matters. If it returns application records, the build is old — that endpoint was world-readable before v5.0.0.

---

## Data

Everything (records, accounts, OTP codes, sessions, rate limits, the email log) lives in Upstash Redis:

| Key | Contents |
|---|---|
| `bcci:app:<id>` | One application |
| `bcci:app_index` | Sorted set of application ids by submission time |
| `bcci:app_email:<email>` | Email → application id |
| `bcci:enq:<id>`, `bcci:enq_index` | Enquiries (newest 1000 kept) |
| `admin:<token>`, `applicant:<token>` | Sessions, TTL-expired |
| `bcci:otp:<email>` | Pending OTP, 10-minute TTL |
| `bcci:board:member:<id>`, `bcci:board:member_email:<email>` | Board profiles and their email index |
| `bcci:board:meeting:<id>`, `bcci:board:open_meeting` | Board meetings and the one currently taking attendance |
| `bcci:board:att:<meeting>:<member>` | Attendance marks |
| `bcci:board:pin:<meeting>`, `bcci:board:pin_fails:<meeting>` | The open meeting's PIN and its wrong-guess count |
| `bcci:board:pin_version:<meeting>` | Attendance-pass generation, renewed with each PIN and reopening |
| `bcci:board:name_pass:<token>`, `bcci:board:device:<meeting>:<hash>` | Short-lived mark-by-name pass and one-mark-per-phone record |
| `board:<token>` | Board portal sessions, TTL-expired |
| `bcci:email_log` | Last 300 send attempts |
| `bcci:applications`, `bcci:enquiries` | **Legacy blobs**, kept as a backup after migration |

Records were previously stored as one JSON blob per collection. On first read after upgrading, they migrate to the per-record layout above; the old blobs are left untouched. The migration is idempotent and guarded, so it runs once.

At 20–30 members a month, expect well under 1 MB of data in the first year and comfortably inside the Upstash free tier.

### Backups

Export the data as an admin:

```bash
# Applications and enquiries, as an admin
TOKEN=$(curl -s -X POST https://<domain>/api/admin-auth \
  -H 'Content-Type: application/json' \
  -d '{"username":"<admin email>","password":"<password>"}' | jq -r .session.token)

curl -s https://<domain>/api/applications -H "Authorization: Bearer $TOKEN" > backup-applications.json
curl -s https://<domain>/api/enquiries    -H "Authorization: Bearer $TOKEN" > backup-enquiries.json
```

The admin portal's **Export CSV** button does the same thing from the browser.

---

## Tests

```bash
npm test
```

- `tests/e2e.test.mjs` — boots the real `server.js` against a mock Upstash and a real SMTP server, then runs a member end to end: OTP → application → admin approval → renewal.
- `tests/api.test.mjs` — auth, ownership, rate limits, approval flow.
- `tests/data.test.mjs` — legacy migration and concurrent writes.
- `tests/client.test.mjs` — XSS escaping and static sweeps of the render paths.

No network access and no live database is used, so this is safe to run in CI.
