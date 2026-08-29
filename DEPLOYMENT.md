# Deploying the BCCI portal

The app runs in two places without code changes:

- **Vercel** — `api/*.js` are serverless functions; `vercel.json` supplies headers, the SPA rewrite and the daily cron.
- **Any Node host (VPS, Docker, Render, Railway)** — `server.js` serves the same handlers plus the static site, applies the same security headers in code, and runs the daily job in-process.

Nothing host-specific lives in the application logic. Moving from Vercel to a VPS is: set the same environment variables, run `node server.js`, put TLS in front.

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
| `CRON_SECRET` | Authorises the renewal job. Without it, renewal reminders are disabled. `openssl rand -hex 32` |
| `INTERNAL_API_SECRET` | Authorises server-to-server calls to `/api/send-email`. `openssl rand -hex 32` |
| `EMAIL_FROM` | The From address recipients see, e.g. `BCCI Bharuch <noreply@bccibharuch.in>` |

### SMTP transport

Defaults suit Gmail on port 465. For any other relay:

| Variable | Default | Notes |
|---|---|---|
| `SMTP_HOST` | `smtp.gmail.com` | |
| `SMTP_PORT` | `465` | |
| `SMTP_SECURE` | `true` when port is 465 | Set `false` for 587/25 (STARTTLS) |
| `SMTP_ALLOW_SELF_SIGNED` | unset | Only for a local MTA on the same box |

A local MTA on `localhost` needs no `SMTP_USER` / `SMTP_PASS`.

### VPS-only

| Variable | Notes |
|---|---|
| `PORT` | Default `3000` |
| `HOST` | Default `0.0.0.0` |
| `TRUST_PROXY` | **Set to `1` behind nginx/Caddy.** Otherwise every visitor is seen as `127.0.0.1` and they all share one rate-limit bucket. |
| `BEHIND_TLS` | `1` to send HSTS. Implied by `TRUST_PROXY`. |
| `RENEWAL_HOUR` | Hour (server local time) for the daily renewal job. Default `9`. |
| `DISABLE_CRON` | `1` to skip the in-process scheduler, e.g. if you run it from system cron. |

---

## Vercel

Set the variables in **Settings → Environment Variables**, then push to `main`.

Two settings to check:

1. **Deployment Protection** (Settings → Deployment Protection). If Vercel Authentication is on, every visitor is redirected to a Vercel SSO login and the site is unusable by the public. Turn it off for Production when you go live.
2. **GitHub Pages.** This repo also carries `.github/workflows/static.yml`, now set to manual-only. Leave it that way — Pages cannot run `/api/*`, so a Pages copy of this site has no working forms.

Verify a deploy with `curl https://<your-domain>/api/health`.

---

## VPS

```bash
git clone https://github.com/underratedgitter/BCCI.git
cd BCCI
npm install --omit=dev
cp .env.example .env.local     # then edit it

node --env-file=.env.local server.js
```

Node 20+ supports `--env-file` natively; no dotenv needed.

### systemd

`/etc/systemd/system/bcci.service`:

```ini
[Unit]
Description=BCCI Bharuch portal
After=network.target

[Service]
Type=simple
User=bcci
WorkingDirectory=/srv/bcci
Environment=NODE_ENV=production
Environment=TRUST_PROXY=1
EnvironmentFile=/srv/bcci/.env.local
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/bcci

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now bcci
sudo systemctl status bcci
```

Keep `.env.local` at mode `600`, owned by the service user:

```bash
sudo chown bcci:bcci /srv/bcci/.env.local
sudo chmod 600 /srv/bcci/.env.local
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name bccibharuch.in;

    ssl_certificate     /etc/letsencrypt/live/bccibharuch.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bccibharuch.in/privkey.pem;

    client_max_body_size 2m;   # payment receipts

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name bccibharuch.in;
    return 301 https://$host$request_uri;
}
```

The app sets its own security headers, so don't duplicate them here — two `Content-Security-Policy` headers is not the same as one.

### Docker

```bash
docker build -t bcci-portal .
docker run -d --name bcci -p 3000:3000 --env-file .env.local \
  -e TRUST_PROXY=1 --restart unless-stopped bcci-portal
```

---

## After any deploy

```bash
curl https://<your-domain>/api/health          # expect {"status":"ok"}
curl -i https://<your-domain>/api/applications # expect 401, NOT data
```

The second one matters. If it returns application records, the build is old — that endpoint was world-readable before v5.0.0.

---

## Data

Everything lives in Upstash Redis:

| Key | Contents |
|---|---|
| `bcci:app:<id>` | One application |
| `bcci:app_index` | Sorted set of application ids by submission time |
| `bcci:app_email:<email>` | Email → application id |
| `bcci:enq:<id>`, `bcci:enq_index` | Enquiries (newest 1000 kept) |
| `admin:<token>`, `applicant:<token>` | Sessions, TTL-expired |
| `bcci:otp:<email>` | Pending OTP, 10-minute TTL |
| `bcci:email_log` | Last 300 send attempts |
| `bcci:applications`, `bcci:enquiries` | **Legacy blobs**, kept as a backup after migration |

Records were previously stored as one JSON blob per collection. On first read after upgrading, they migrate to the per-record layout above; the old blobs are left untouched. The migration is idempotent and guarded, so it runs once.

At 20–30 members a month, expect well under 1 MB of data in the first year and comfortably inside the Upstash free tier.

### Backups

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
