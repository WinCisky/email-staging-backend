# Mock smtp server for dev

I hate emails.

Two small processes sharing one SQLite database:

- `smtp-mock-server.js` – SMTP server that **stores** (never delivers) every message. The SMTP
  username + password used to send it identify the inbox it lands in: any credentials work.
- `api.js` – HTTP API used by the web client ([stg-email](https://github.com/WinCisky/stg-email)) to
  read the inboxes. Emails older than 30 days are deleted automatically.

Requires **Node.js 24 LTS** or newer (uses the built-in `node:sqlite`: no native modules, no build tools).

## Run locally

```sh
nvm use            # Node.js 24
npm ci
npm run dev        # SMTP on :2525 (plain text in dev), API on http://localhost:3628
npm run send-test-email -- my_user my_password
curl 'http://localhost:3628/emails?username=my_user&password=my_password'
npm test
```

## Configuration

Environment variables, or a `.env` file next to `package.json` (copy [`.env.example`](.env.example),
which documents every option). Environment variables win over `.env`. The defaults match the original
deployment, so an existing setup keeps working without any configuration.

| Variable | Default | |
| --- | --- | --- |
| `SMTP_PORT` / `API_PORT` | `2525` / `3628` | |
| `SMTP_TLS_KEY` / `SMTP_TLS_CERT` | `/etc/letsencrypt/live/test.opentrust.it/{privkey,fullchain}.pem` | reloaded automatically when renewed |
| `SMTP_SECURE` | `true` | implicit TLS; `false` only for local development |
| `API_HOST` | `localhost` | keep the API behind the reverse proxy |
| `CORS_ORIGIN` | `*` | e.g. `https://wincisky.github.io` |
| `RETENTION_DAYS` | `30` | |
| `MAX_STORAGE_MB` | `2048` | above it new messages get `452` (retry later) |
| `SMTP_MAX_MESSAGE_MB`, `SMTP_RATE_LIMIT`, `API_RATE_LIMIT`, ... | | see `.env.example` |

## Deploy on a VPS with pm2

Run everything as an **unprivileged user**, never as root: the app doesn't need any privilege
(ports > 1024, TLS files copied for it, see below).

```sh
# 1. Service user (no password: it can't log in, use `sudo -iu mailcatcher`)
sudo useradd --system --create-home --shell /bin/bash mailcatcher
sudo -iu mailcatcher

# 2. As mailcatcher: Node.js 24 (e.g. `nvm install 24`) and the latest pm2
npm install -g pm2@latest

# 3. The app
git clone https://github.com/WinCisky/email-staging-backend.git && cd email-staging-backend
npm ci --omit=dev
cp .env.example .env          # set SMTP_TLS_KEY / SMTP_TLS_CERT, CORS_ORIGIN...

# 4. TLS certificates readable by mailcatcher: see below

# 5. Start, and start again at boot
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup                   # run the `sudo ...` command it prints
pm2 install pm2-logrotate     # otherwise the logs grow forever
```

Update: `git pull && npm ci --omit=dev && pm2 restart ecosystem.config.cjs`.
Useful: `pm2 ls`, `pm2 logs`, `pm2 monit`.

### 4. TLS certificates

Let's Encrypt keys are only readable by root. Copy them for the service user with a certbot deploy hook,
`/etc/letsencrypt/renewal-hooks/deploy/email-staging.sh` (`sudo chmod 755` it):

```sh
#!/bin/sh
set -e
[ "$RENEWED_LINEAGE" = /etc/letsencrypt/live/test.opentrust.it ] || exit 0
install -d -o mailcatcher -g mailcatcher -m 700 /home/mailcatcher/certs
install -o mailcatcher -g mailcatcher -m 600 "$RENEWED_LINEAGE/privkey.pem" /home/mailcatcher/certs/
install -o mailcatcher -g mailcatcher -m 644 "$RENEWED_LINEAGE/fullchain.pem" /home/mailcatcher/certs/
```

Run it once: `sudo RENEWED_LINEAGE=/etc/letsencrypt/live/test.opentrust.it /etc/letsencrypt/renewal-hooks/deploy/email-staging.sh`,
then in `.env`:

```sh
SMTP_TLS_KEY=/home/mailcatcher/certs/privkey.pem
SMTP_TLS_CERT=/home/mailcatcher/certs/fullchain.pem
```

The SMTP server checks the files every 6 hours and switches to a renewed certificate without restarting
(right away: `pm2 sendSignal SIGHUP email-staging-smtp`). It warns in the logs 7 days before expiry.

### Ports and firewall

Expose only SSH, 80/443 (nginx) and the SMTP port. Clients use port 465 (see the stg-email Laravel snippet):
redirect it to 2525 instead of running as root, e.g. `sudo iptables -t nat -A PREROUTING -p tcp --dport 465 -j REDIRECT --to-ports 2525`
(same with `ip6tables`; persist the rules, e.g. `netfilter-persistent save`). On Oracle Cloud, open the
ports in the security list too. Port 3628 must never be public (the API only listens on localhost).

### nginx (HTTPS for the API)

Older web clients send the inbox credentials in query strings: keep them out of the access log, and pass
the client address (used by the rate limiter).

```nginx
# http context, e.g. /etc/nginx/conf.d/noquery-log.conf
log_format noquery '$remote_addr - [$time_local] "$request_method $uri $server_protocol" $status $body_bytes_sent "$http_user_agent"';

server {
    server_name test.opentrust.it;
    # listen 443 ssl + certificates as configured by certbot
    server_tokens off;
    access_log /var/log/nginx/access.log noquery;
    client_max_body_size 64k;

    location / {
        proxy_pass http://127.0.0.1:3628;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The existing `/var/log/nginx/access.log*` files contain inbox passwords: delete them once this is active.

### Migrating from the previous version

A plain update keeps working with the defaults (even as root, with a warning in the logs): first
`npm install -g pm2@latest && pm2 update` (pm2 ≥ 7 is required: the `require-in-the-middle` dependency,
a workaround for older pm2, is gone), then `git pull && npm ci --omit=dev` and restart. Check that:

- the database is now always `<project dir>/emails.sql`, while before it was relative to the directory pm2
  was started from: if yours is elsewhere, set `DB_PATH` or move it (with any `emails.sql-wal`/`-shm` file);
- on the first start the retention job deletes everything older than 30 days (it never ran before).

Moving to the setup above (unprivileged user) is strongly recommended:

1. Old processes probably run under root's pm2: `sudo pm2 ls`, `sudo pm2 delete <their names>`, `sudo pm2 save`
   (and `sudo pm2 unstartup systemd` if nothing else uses root's pm2).
2. Keep the data: move `emails.sql` into the new checkout and `sudo chown mailcatcher:mailcatcher emails.sql*`.
   The schema is migrated (indexes added) on first start; permissions are tightened to `600`.

## HTTP API

Inbox credentials: for `GET`, an `Authorization: Basic base64(username:password)` header (UTF-8; keeps them
out of URLs and logs) or, for older clients, `username`/`password` query parameters; for `POST`/`PATCH`, the
JSON body. Errors are `{ "error": "..." }`.

| Method | Path | Input | Returns |
| --- | --- | --- | --- |
| GET | `/emails` | credentials, `page` (default 1) | 10 emails, newest first |
| GET | `/emails/:id` | credentials | the email, or 404 |
| GET | `/emails/delta` | credentials, `latest` (id) | emails with id > `latest`, oldest first (max 50) |
| PATCH | `/emails/read/:id` | `{ username, password }` | `{ success }`, or 404 |
| PATCH | `/emails/read/all` | `{ username, password }` | `{ success, updated }` |
| POST | `/emails/stats` | `[{ username, password }]` (max 100) | `[{ username, password, totalEmails, lastEmailDate }]` |
| POST | `/emails/burn` | `{ username, password }` | `{ success, deletedEmails }`, or 404 |

Security notes and the audit of this version: [SECURITY-AUDIT.md](SECURITY-AUDIT.md).
